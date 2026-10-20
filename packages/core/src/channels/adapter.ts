/**
 * Contract every WhatsApp provider adapter implements (official Cloud API, QR
 * gateway, mock). Capabilities differ per provider; callers check
 * getCapabilities() instead of assuming a feature exists.
 */

export type ProviderKind = 'official' | 'qr' | 'mock';

export interface ChannelCapabilities {
  connectDisconnect: boolean; // QR pairing / logout
  templates: boolean; // approved template messages (official only)
  serviceWindowHours: number | null; // official: free-form only inside this window
  media: boolean;
  deliveryReceipts: boolean;
}

export interface ChannelStatus {
  state: 'disconnected' | 'pairing' | 'connected' | 'error';
  reason?: string;
  displayNumber?: string;
  qr?: string; // pairing payload; secret, only shown to authorised admins
}

export interface Attachment {
  kind: 'image' | 'document' | 'audio' | 'video' | 'other';
  mimeType?: string;
  url?: string; // private, short-lived
  fileName?: string;
  data?: string; // base64 bytes of a voice note or picture, for turning into text; never stored with the message
}

/** Provider-agnostic inbound message after normalisation. */
export interface InboundMessageEvent {
  type: 'message';
  providerMessageId: string;
  providerIdentity: string; // sender id as the provider gives it; not assumed to be a phone number
  phoneE164?: string; // only when the provider states it
  profileName?: string;
  text?: string;
  attachments?: Attachment[];
  timestamp: Date;
  fromMe?: boolean;
  isGroup?: boolean;
  isHistoryReplay?: boolean;
}

export interface DeliveryStatusEvent {
  type: 'status';
  providerMessageId: string;
  status: 'accepted' | 'sent' | 'delivered' | 'read' | 'failed';
  detail?: string;
  timestamp: Date;
}

export type NormalizedEvent = InboundMessageEvent | DeliveryStatusEvent;

export type SendResult =
  | { ok: true; providerMessageId: string; status: 'accepted' | 'sent' }
  // retryable=false: the provider definitely rejected it. unknown=true: we cannot tell
  // whether it went out (e.g. timeout after the request was sent) and must not blindly retry.
  | { ok: false; retryable: boolean; unknown?: boolean; error: string };

export interface SendTextInput {
  to: string; // provider identity
  text: string;
  idempotencyKey: string;
  typingMs?: number; // show a typing indicator this long before sending, where the provider supports it
}

export interface ChannelAdapter {
  readonly kind: ProviderKind;
  getCapabilities(): ChannelCapabilities;
  getStatus(): Promise<ChannelStatus>;
  connect?(): Promise<ChannelStatus>;
  disconnect?(): Promise<void>;
  sendText(input: SendTextInput): Promise<SendResult>;
  sendMedia?(input: SendTextInput & { attachment: Attachment }): Promise<SendResult>;
  sendTemplate?(input: { to: string; template: string; language: string; params: string[]; idempotencyKey: string }): Promise<SendResult>;
  /** Turns a raw provider payload into zero or more normalised events. */
  normalizeInboundEvent(raw: unknown): NormalizedEvent[];
}
