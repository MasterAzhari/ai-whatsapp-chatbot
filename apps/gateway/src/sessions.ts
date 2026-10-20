import { randomUUID } from 'node:crypto';

/**
 * A WhatsApp session driver for one channel. The real QR / linked-device driver
 * (library still to be evaluated for licence and stability, Baileys is the first
 * candidate) plugs in behind this interface in Phase 2, so the library can be
 * swapped without touching the app.
 */
export interface SessionDriver {
  status(): { state: 'disconnected' | 'pairing' | 'connected' | 'error'; reason?: string; displayNumber?: string; qr?: string };
  connect(): Promise<void>;
  logout(): Promise<void>;
  /** Sends text, or a picture with the text as its caption when image is given. */
  sendText(to: string, text: string, idempotencyKey: string, typingMs?: number, image?: OutgoingImage): Promise<{ providerMessageId: string }>;
}

export interface OutgoingImage {
  data: Buffer;
  mimeType: string;
}

export type InboundSink = (channelId: string, events: unknown[]) => Promise<void>;

/** MOCK driver: pretends to pair and send. Never contacts WhatsApp. */
export class MockSessionDriver implements SessionDriver {
  private state: 'disconnected' | 'pairing' | 'connected' = 'disconnected';
  private readonly sentByKey = new Map<string, string>();

  status() {
    return this.state === 'connected'
      ? { state: this.state, displayNumber: '+60000000000 (mock)' }
      : this.state === 'pairing'
        ? { state: this.state, qr: 'MOCK-QR-NOT-A-REAL-PAIRING-CODE' }
        : { state: this.state };
  }

  async connect() {
    this.state = 'pairing';
    // Simulate the owner scanning the code.
    setTimeout(() => (this.state = 'connected'), 50).unref();
  }

  async logout() {
    this.state = 'disconnected';
  }

  async sendText(_to: string, _text: string, key: string) {
    if (this.state !== 'connected') throw Object.assign(new Error('session not connected'), { status: 409 });
    let id = this.sentByKey.get(key);
    if (!id) {
      id = `mockgw-${randomUUID()}`;
      this.sentByKey.set(key, id);
    }
    return { providerMessageId: id };
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionDriver>();
  constructor(private readonly factory: (channelId: string) => SessionDriver) {}

  /** Reconnects sessions that were linked before a restart. */
  async restore(channelIds: string[]): Promise<void> {
    for (const id of channelIds) await this.get(id).connect().catch((e) => console.error(`[gateway] restore ${id}: ${(e as Error).message}`));
  }

  get(channelId: string): SessionDriver {
    let s = this.sessions.get(channelId);
    if (!s) {
      s = this.factory(channelId);
      this.sessions.set(channelId, s);
    }
    return s;
  }
}
