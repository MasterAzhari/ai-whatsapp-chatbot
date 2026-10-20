import type { ChannelAdapter, ChannelStatus, NormalizedEvent, SendResult, SendTextInput } from './adapter.js';

/**
 * Talks to the separate whatsapp-gateway container (QR / linked-device sessions)
 * over the internal Docker network. Every call carries GATEWAY_TOKEN; the gateway
 * is never exposed to the internet.
 */
export class GatewayChannelAdapter implements ChannelAdapter {
  readonly kind = 'qr' as const;

  constructor(
    private readonly channelId: string,
    private readonly baseUrl = process.env.GATEWAY_URL ?? 'http://whatsapp-gateway:3100',
    private readonly token = process.env.GATEWAY_TOKEN ?? '',
    private readonly timeoutMs = 15_000,
  ) {}

  getCapabilities() {
    return { connectDisconnect: true, templates: false, serviceWindowHours: null, media: true, deliveryReceipts: true };
  }

  private async call(path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}/channels/${encodeURIComponent(this.channelId)}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  async getStatus(): Promise<ChannelStatus> {
    try {
      const res = await this.call('/status');
      if (!res.ok) return { state: 'error', reason: `gateway HTTP ${res.status}` };
      return (await res.json()) as ChannelStatus;
    } catch (err) {
      return { state: 'error', reason: `gateway unreachable: ${(err as Error).message}` };
    }
  }

  async connect(): Promise<ChannelStatus> {
    const res = await this.call('/connect', {});
    return (await res.json()) as ChannelStatus;
  }

  async disconnect(): Promise<void> {
    await this.call('/logout', {});
  }

  async sendText(input: SendTextInput): Promise<SendResult> {
    let res: Response;
    try {
      res = await this.call('/send-text', input);
    } catch (err) {
      // A timeout after the request left means it may or may not have been sent.
      const e = err as Error;
      const connectFailed = /ECONNREFUSED|ENOTFOUND|fetch failed/i.test(`${e.message} ${(e as { cause?: Error }).cause?.message ?? ''}`)
        && e.name !== 'TimeoutError';
      return connectFailed
        ? { ok: false, retryable: true, error: `gateway unreachable: ${e.message}` }
        : { ok: false, retryable: false, unknown: true, error: `gateway timeout: ${e.message}` };
    }
    if (res.ok) return (await res.json()) as SendResult;
    const text = await res.text().catch(() => '');
    return { ok: false, retryable: res.status >= 500 || res.status === 429, error: `gateway HTTP ${res.status}: ${text.slice(0, 200)}` };
  }

  normalizeInboundEvent(raw: unknown): NormalizedEvent[] {
    // The gateway already normalises events before posting them to the app.
    const evs = (Array.isArray(raw) ? raw : [raw]) as Array<NormalizedEvent & { timestamp: string | Date }>;
    return evs.map((e) => ({ ...e, timestamp: new Date(e.timestamp) }));
  }
}
