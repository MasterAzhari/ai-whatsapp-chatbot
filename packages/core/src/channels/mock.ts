import { randomUUID } from 'node:crypto';
import type { Attachment, ChannelAdapter, ChannelStatus, NormalizedEvent, SendResult, SendTextInput } from './adapter.js';

/**
 * MOCK adapter: records sends in memory and never talks to WhatsApp. Used for
 * local development, tests and the synthetic demo tenant. Behaviour can be
 * scripted to simulate failures and timeouts.
 */
export class MockChannelAdapter implements ChannelAdapter {
  readonly kind = 'mock' as const;
  readonly sent: Array<SendTextInput & { providerMessageId: string; attachment?: Attachment }> = [];
  /** Next results to return instead of success, consumed in order. */
  readonly script: SendResult[] = [];
  private readonly byKey = new Map<string, string>();

  getCapabilities() {
    return { connectDisconnect: true, templates: false, serviceWindowHours: null, media: false, deliveryReceipts: true };
  }

  async getStatus(): Promise<ChannelStatus> {
    return { state: 'connected', displayNumber: '+60000000000 (mock)' };
  }

  async sendText(input: SendTextInput): Promise<SendResult> {
    const scripted = this.script.shift();
    if (scripted && !scripted.ok) return scripted;
    // Idempotent on our key, like a provider that supports client message ids.
    const existing = this.byKey.get(input.idempotencyKey);
    if (existing) return { ok: true, providerMessageId: existing, status: 'sent' };
    const providerMessageId = `mock-${randomUUID()}`;
    this.byKey.set(input.idempotencyKey, providerMessageId);
    this.sent.push({ ...input, providerMessageId });
    return { ok: true, providerMessageId, status: 'sent' };
  }

  async sendMedia(input: SendTextInput & { attachment: Attachment }): Promise<SendResult> {
    return this.sendText(input); // recorded with its attachment
  }

  normalizeInboundEvent(raw: unknown): NormalizedEvent[] {
    const r = raw as { id: string; from: string; text?: string; name?: string; ts?: string };
    return [
      {
        type: 'message',
        providerMessageId: r.id,
        providerIdentity: r.from,
        profileName: r.name,
        text: r.text,
        timestamp: r.ts ? new Date(r.ts) : new Date(),
      },
    ];
  }
}
