import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import makeWASocket, { Browsers, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, generateMessageIDV2, useMultiFileAuthState, type WAMessage, type WASocket } from 'baileys';
import type { InboundSink, OutgoingImage, SessionDriver } from './sessions.js';
import { isLiveOwnMessage, normalizeMessage, normalizeStatus, phoneFromJid, READABLE_MEDIA, readableAttachment, type GatewayEvent } from './normalize.js';

type State = ReturnType<SessionDriver['status']>;

/** Minimal logger so Baileys stays quiet except for warnings, without adding pino as our dependency. */
function quietLogger(prefix: string): any {
  const out = (lvl: string) => (obj: unknown, msg?: string) => console.log(`[gateway ${prefix}] ${lvl} ${msg ?? ''} ${typeof obj === 'string' ? obj : ''}`.trim());
  const noop = () => {};
  const l: any = { level: 'warn', trace: noop, debug: noop, info: noop, warn: out('warn'), error: out('error') };
  l.child = () => l;
  return l;
}

/**
 * QR / linked-device WhatsApp session using Baileys. Not an official Meta
 * connection: the owner accepts the risk of the number being restricted.
 * Login state lives in its own folder on the gateway volume and never leaves it.
 */
export class BaileysSessionDriver implements SessionDriver {
  private sock: WASocket | null = null;
  private state: State = { state: 'disconnected' };
  private starting = false;
  private stopped = true;
  private retries = 0;
  private readonly sentByKey = new Map<string, string>();
  /** Ids of messages this gateway sent, so their echoes are not mistaken for a person typing on the phone. */
  private readonly ownIds = new Set<string>();
  /** Inbound batches are handled one at a time so a media download never reorders messages. */
  private inbound: Promise<void> = Promise.resolve();

  constructor(
    private readonly channelId: string,
    private readonly dir: string,
    private readonly sink: InboundSink,
  ) {}

  status(): State {
    return this.state;
  }

  async connect(): Promise<void> {
    this.stopped = false;
    if (this.sock || this.starting) return;
    this.starting = true;
    try {
      await this.start();
    } finally {
      this.starting = false;
    }
  }

  private async start() {
    const { state, saveCreds } = await useMultiFileAuthState(this.dir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    const sock = makeWASocket({
      auth: state,
      ...(version ? { version } : {}),
      browser: Browsers.ubuntu('Chatbot'),
      logger: quietLogger(this.channelId.slice(0, 8)),
      markOnlineOnConnect: false, // the owner's phone keeps receiving notifications
      syncFullHistory: false, // recent history still syncs; it arrives as 'append' and the app ignores it
    });
    this.sock = sock;
    if (this.state.state !== 'connected') this.state = { state: 'pairing' };

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => {
      if (u.qr) this.state = { state: 'pairing', qr: u.qr };
      if (u.connection === 'open') {
        this.retries = 0;
        this.state = { state: 'connected', displayNumber: phoneFromJid(sock.user?.id) ?? sock.user?.id?.split(':')[0] };
      }
      if (u.connection === 'close') {
        this.sock = null;
        const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden) {
          // Unlinked from the phone (or banned): forget the login so a new QR is needed.
          this.stopped = true;
          this.state = { state: 'disconnected', reason: code === DisconnectReason.forbidden ? 'WhatsApp menolak sambungan (403)' : 'Dinyahpaut dari telefon' };
          void rm(this.dir, { recursive: true, force: true });
          return;
        }
        if (this.stopped) return;
        // Restart required after pairing, network drops, etc.: reconnect with backoff.
        const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(60_000, 2_000 * 2 ** this.retries++);
        if (this.state.state === 'connected') this.state = { state: 'error', reason: `sambungan terputus (${code ?? 'tiada kod'}), cuba semula` };
        setTimeout(() => void this.connect().catch((e) => (this.state = { state: 'error', reason: (e as Error).message })), delay).unref();
      }
    });
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      this.inbound = this.inbound
        .then(async () => {
          const events: GatewayEvent[] = [];
          for (const m of messages) {
            if (m.key.fromMe && m.key.id && this.ownIds.has(m.key.id)) continue;
            // Messages typed on the business phone may arrive as 'append'; recent ones are live, not history.
            const e = normalizeMessage(m as any, type !== 'notify' && !isLiveOwnMessage(m as any));
            if (!e) continue;
            await this.attachMedia(sock, m, e);
            events.push(e);
          }
          if (events.length) await this.sink(this.channelId, events);
        })
        .catch((err) => console.log(`[gateway ${this.channelId.slice(0, 8)}] inbound failed: ${(err as Error).message}`));
    });
    sock.ev.on('messages.update', (updates) => {
      const events = updates.map((u) => normalizeStatus(u as any)).filter((e): e is GatewayEvent => !!e);
      if (events.length) void this.sink(this.channelId, events);
    });
  }

  /**
   * Downloads a customer's voice note or picture so the app can turn it into text.
   * Best effort: on failure or timeout the message still goes through without it.
   */
  private async attachMedia(sock: WASocket, raw: WAMessage, e: GatewayEvent) {
    const a = readableAttachment(e);
    if (!a) return;
    try {
      const buf = await Promise.race([
        downloadMediaMessage(raw, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage, logger: quietLogger(this.channelId.slice(0, 8)) }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('download timed out')), 20_000).unref()),
      ]);
      if (buf.length <= (READABLE_MEDIA[a.kind] ?? 0)) a.data = buf.toString('base64');
    } catch (err) {
      console.log(`[gateway ${this.channelId.slice(0, 8)}] media download failed: ${(err as Error).message}`);
    }
  }

  async logout(): Promise<void> {
    this.stopped = true;
    const sock = this.sock;
    this.sock = null;
    try {
      await sock?.logout();
    } catch {
      sock?.end(undefined);
    }
    await rm(this.dir, { recursive: true, force: true });
    this.state = { state: 'disconnected' };
  }

  async sendText(to: string, text: string, idempotencyKey: string, typingMs = 0, image?: OutgoingImage): Promise<{ providerMessageId: string }> {
    const done = this.sentByKey.get(idempotencyKey);
    if (done) return { providerMessageId: done };
    if (!this.sock || this.state.state !== 'connected') throw Object.assign(new Error('session not connected'), { status: 409 });
    if (!/@(s\.whatsapp\.net|lid)$/.test(to)) throw Object.assign(new Error('unsupported recipient'), { status: 400 });
    if (typingMs > 0) {
      // Best effort: a failed presence update must not stop the reply.
      await this.sock.sendPresenceUpdate('composing', to).catch(() => {});
      await new Promise((r) => setTimeout(r, typingMs));
      await this.sock?.sendPresenceUpdate('paused', to).catch(() => {});
      if (!this.sock || this.state.state !== 'connected') throw Object.assign(new Error('session not connected'), { status: 409 });
    }
    const ownId = generateMessageIDV2(this.sock.user?.id);
    this.ownIds.add(ownId);
    if (this.ownIds.size > 5000) this.ownIds.delete(this.ownIds.values().next().value!);
    const content = image ? { image: image.data, mimetype: image.mimeType, ...(text ? { caption: text } : {}) } : { text };
    const sent = await this.sock.sendMessage(to, content, { messageId: ownId });
    const id = sent?.key.id;
    if (id) this.ownIds.add(id);
    if (!id) throw new Error('WhatsApp did not return a message id');
    this.sentByKey.set(idempotencyKey, id);
    if (this.sentByKey.size > 5000) this.sentByKey.delete(this.sentByKey.keys().next().value!);
    return { providerMessageId: id };
  }
}

export const sessionDir = (root: string, channelId: string) => join(root, channelId);
