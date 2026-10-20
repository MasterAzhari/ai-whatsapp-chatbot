/**
 * Turns raw Baileys events into the app's provider-neutral events. Pure, so it can
 * be tested without a WhatsApp connection.
 */

export interface RawKey {
  remoteJid?: string | null;
  remoteJidAlt?: string;
  fromMe?: boolean | null;
  id?: string | null;
  participant?: string | null;
}

export interface RawMessage {
  key: RawKey;
  message?: Record<string, any> | null;
  messageTimestamp?: number | { toNumber(): number } | string | null;
  pushName?: string | null;
}

export type GatewayEvent =
  | {
      type: 'message';
      providerMessageId: string;
      providerIdentity: string;
      phoneE164?: string;
      profileName?: string;
      text?: string;
      attachments?: Array<{ kind: 'image' | 'document' | 'audio' | 'video' | 'other'; mimeType?: string; fileName?: string; fileLength?: number; data?: string }>;
      timestamp: string;
      fromMe?: boolean;
      isGroup?: boolean;
      isHistoryReplay?: boolean;
    }
  | { type: 'status'; providerMessageId: string; status: 'sent' | 'delivered' | 'read' | 'failed'; timestamp: string };

const isGroup = (jid: string) => jid.endsWith('@g.us');
const isBroadcast = (jid: string) => jid.endsWith('@broadcast') || jid.endsWith('@newsletter');

/** "60123456789@s.whatsapp.net" or "...:12@s.whatsapp.net" → "+60123456789"; LID ids carry no phone number. */
export function phoneFromJid(jid: string | undefined | null): string | undefined {
  const m = jid?.match(/^(\d{7,15})(?::\d+)?@s\.whatsapp\.net$/);
  return m ? `+${m[1]}` : undefined;
}

function seconds(t: RawMessage['messageTimestamp']): number | null {
  if (t == null) return null;
  if (typeof t === 'number') return t;
  if (typeof t === 'string') return Number(t) || null;
  return t.toNumber();
}

function count(n: unknown): number | undefined {
  if (n == null) return undefined;
  const v = typeof n === 'object' && 'toNumber' in (n as object) ? (n as { toNumber(): number }).toNumber() : Number(n);
  return Number.isFinite(v) ? v : undefined;
}

/** Unwraps ephemeral / view-once containers. */
function unwrap(m: Record<string, any> | null | undefined): Record<string, any> | undefined {
  let cur = m ?? undefined;
  for (let i = 0; i < 5 && cur; i++) {
    const inner = cur.ephemeralMessage?.message ?? cur.viewOnceMessage?.message ?? cur.viewOnceMessageV2?.message ?? cur.documentWithCaptionMessage?.message;
    if (!inner) break;
    cur = inner;
  }
  return cur;
}

/** A message sent from the business's own phone within the last two minutes. */
export function isLiveOwnMessage(raw: RawMessage, now = new Date()): boolean {
  const ts = seconds(raw.messageTimestamp);
  return !!raw.key.fromMe && !!ts && now.getTime() - ts * 1000 < 120_000;
}

export function normalizeMessage(raw: RawMessage, history: boolean, now = new Date()): GatewayEvent | null {
  const jid = raw.key.remoteJid ?? '';
  if (!jid || !raw.key.id || isBroadcast(jid)) return null;
  const m = unwrap(raw.message);
  if (!m) return null; // protocol / receipt-only stubs
  if (m.protocolMessage || m.reactionMessage || m.senderKeyDistributionMessage && Object.keys(m).length === 1) return null;

  const attachments: NonNullable<Extract<GatewayEvent, { type: 'message' }>['attachments']> = [];
  const media = (key: string, kind: 'image' | 'document' | 'audio' | 'video') => {
    const v = m[key];
    const size = count(v?.fileLength);
    if (v) attachments.push({ kind, mimeType: v.mimetype ?? undefined, fileName: v.fileName ?? undefined, ...(size != null ? { fileLength: size } : {}) });
    return v;
  };
  const image = media('imageMessage', 'image');
  const video = media('videoMessage', 'video');
  const doc = media('documentMessage', 'document');
  media('audioMessage', 'audio');
  if (m.stickerMessage) attachments.push({ kind: 'other', mimeType: m.stickerMessage.mimetype ?? undefined });

  const text: string | undefined =
    m.conversation ?? m.extendedTextMessage?.text ?? image?.caption ?? video?.caption ?? doc?.caption ?? m.buttonsResponseMessage?.selectedDisplayText ?? m.listResponseMessage?.title ?? undefined;
  if (!text && attachments.length === 0) return null; // calls, polls and other types we do not handle yet

  const ts = seconds(raw.messageTimestamp);
  return {
    type: 'message',
    providerMessageId: raw.key.id,
    providerIdentity: jid,
    phoneE164: phoneFromJid(jid) ?? phoneFromJid(raw.key.remoteJidAlt),
    profileName: raw.pushName ?? undefined,
    text: text || undefined,
    attachments: attachments.length ? attachments : undefined,
    timestamp: new Date(ts ? ts * 1000 : now.getTime()).toISOString(),
    fromMe: !!raw.key.fromMe,
    isGroup: isGroup(jid),
    isHistoryReplay: history,
  };
}

/** Media the app can turn into text (voice notes, pictures), with the most bytes it will fetch. */
export const READABLE_MEDIA: Partial<Record<string, number>> = { audio: 4 * 1024 * 1024, image: 5 * 1024 * 1024 };

/** The first attachment worth downloading for a customer's message, if any. */
export function readableAttachment(e: GatewayEvent) {
  if (e.type !== 'message' || e.fromMe || e.isGroup || e.isHistoryReplay) return undefined;
  return e.attachments?.find((a) => {
    const max = READABLE_MEDIA[a.kind];
    return max != null && (a.fileLength ?? 0) <= max;
  });
}

/** WebMessageInfo.Status: 0 error, 1 pending, 2 server ack, 3 delivered, 4 read, 5 played. */
export function normalizeStatus(u: { key: RawKey; update: { status?: number | null } }, now = new Date()): GatewayEvent | null {
  if (!u.key.fromMe || !u.key.id || u.update.status == null) return null;
  const status = ({ 0: 'failed', 2: 'sent', 3: 'delivered', 4: 'read', 5: 'read' } as const)[u.update.status as 0 | 2 | 3 | 4 | 5];
  if (!status) return null;
  return { type: 'status', providerMessageId: u.key.id, status, timestamp: now.toISOString() };
}
