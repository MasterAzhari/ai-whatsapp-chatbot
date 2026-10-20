import type { Tx } from './db.js';
import type { DeliveryStatusEvent, InboundMessageEvent, NormalizedEvent } from './channels/adapter.js';
import { cancelPendingAutomated } from './outbox.js';

export type IngestResult =
  | { kind: 'stored'; messageId: string; conversationId: string; contactId: string }
  | { kind: 'duplicate'; messageId: string }
  | { kind: 'ignored'; reason: string }
  | { kind: 'status'; matched: boolean }
  | { kind: 'human_reply'; messageId: string; conversationId: string };

/**
 * Stores one normalised provider event durably. Must run inside withTenant for the
 * channel's tenant. Safe to call repeatedly with the same event: a repeated
 * webhook never creates a second message, conversation or reply trigger.
 * Routing (keyword, flow, AI) happens after this returns 'stored'.
 */
export async function ingestEvent(tx: Tx, tenantId: string, channelId: string, ev: NormalizedEvent): Promise<IngestResult> {
  if (ev.type === 'status') return applyStatus(tx, tenantId, channelId, ev);
  if (ev.isGroup) return { kind: 'ignored', reason: 'group chats not supported' };
  if (ev.isHistoryReplay) return { kind: 'ignored', reason: 'history replay' };
  if (!ev.providerMessageId) return { kind: 'ignored', reason: 'missing provider message id' };
  if (ev.fromMe) return recordPhoneReply(tx, tenantId, channelId, ev);

  const dup = await tx.query<{ id: string }>(
    'SELECT id FROM messages WHERE channel_id = $1 AND provider_message_id = $2',
    [channelId, ev.providerMessageId],
  );
  if (dup.rows[0]) return { kind: 'duplicate', messageId: dup.rows[0].id };

  const contactId = await resolveContact(tx, tenantId, channelId, ev);
  const conv = await tx.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, channel_id, contact_id, last_message_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (channel_id, contact_id) DO UPDATE
       SET last_message_at = greatest(conversations.last_message_at, EXCLUDED.last_message_at),
           status = CASE WHEN conversations.status = 'resolved' THEN 'open' ELSE conversations.status END
     RETURNING id`,
    [tenantId, channelId, contactId, ev.timestamp],
  );
  const conversationId = conv.rows[0]!.id;

  // ON CONFLICT covers the race where two deliveries of the same webhook pass the
  // SELECT above concurrently.
  const msg = await tx.query<{ id: string }>(
    `INSERT INTO messages (tenant_id, conversation_id, channel_id, direction, origin, body, attachments,
                           provider_message_id, status, provider_timestamp)
     VALUES ($1, $2, $3, 'inbound', 'customer', $4, $5, $6, 'received', $7)
     ON CONFLICT (channel_id, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [tenantId, conversationId, channelId, ev.text ?? null, JSON.stringify(withoutData(ev.attachments)), ev.providerMessageId, ev.timestamp],
  );
  if (!msg.rows[0]) {
    const again = await tx.query<{ id: string }>(
      'SELECT id FROM messages WHERE channel_id = $1 AND provider_message_id = $2',
      [channelId, ev.providerMessageId],
    );
    return { kind: 'duplicate', messageId: again.rows[0]!.id };
  }
  await tx.query('UPDATE contacts SET last_inbound_at = greatest(last_inbound_at, $2) WHERE id = $1', [contactId, ev.timestamp]);
  const media = ev.attachments?.find((a) => a.data && (a.kind === 'audio' || a.kind === 'image'));
  if (media) {
    await tx.query('INSERT INTO message_media (message_id, tenant_id, kind, mime_type, data) VALUES ($1, $2, $3, $4, $5)', [
      msg.rows[0].id, tenantId, media.kind, media.mimeType?.split(';')[0]?.trim() || (media.kind === 'audio' ? 'audio/ogg' : 'image/jpeg'), Buffer.from(media.data!, 'base64'),
    ]);
  }
  return { kind: 'stored', messageId: msg.rows[0].id, conversationId, contactId };
}

/**
 * A message the business sent from its own WhatsApp (the phone or WhatsApp Web), not
 * through this system: a person is answering, so it is stored as a human reply and
 * the bot stands down for that conversation. Replies this system sent itself are
 * filtered out by the gateway, and matched here by provider id as a second guard.
 */
async function recordPhoneReply(tx: Tx, tenantId: string, channelId: string, ev: InboundMessageEvent): Promise<IngestResult> {
  const own = await tx.query<{ id: string }>('SELECT id FROM messages WHERE channel_id = $1 AND provider_message_id = $2', [channelId, ev.providerMessageId]);
  if (own.rows[0]) return { kind: 'duplicate', messageId: own.rows[0].id };
  const contactId = await resolveContact(tx, tenantId, channelId, { ...ev, profileName: undefined });
  const conv = await tx.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, channel_id, contact_id, last_message_at, human_takeover, status)
     VALUES ($1, $2, $3, $4, true, 'pending_human')
     ON CONFLICT (channel_id, contact_id) DO UPDATE
       SET last_message_at = greatest(conversations.last_message_at, EXCLUDED.last_message_at),
           human_takeover = true, status = 'pending_human'
     RETURNING id`,
    [tenantId, channelId, contactId, ev.timestamp],
  );
  const conversationId = conv.rows[0]!.id;
  const msg = await tx.query<{ id: string }>(
    `INSERT INTO messages (tenant_id, conversation_id, channel_id, direction, origin, body, attachments,
                           provider_message_id, status, provider_timestamp)
     VALUES ($1, $2, $3, 'outbound', 'human', $4, $5, $6, 'sent', $7)
     ON CONFLICT (channel_id, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [tenantId, conversationId, channelId, ev.text ?? null, JSON.stringify(withoutData(ev.attachments)), ev.providerMessageId, ev.timestamp],
  );
  if (!msg.rows[0]) return { kind: 'ignored', reason: 'already stored' };
  await cancelPendingAutomated(tx, conversationId);
  return { kind: 'human_reply', messageId: msg.rows[0].id, conversationId };
}

/** Media bytes go to message_media (deleted after routing), never into the message row. */
function withoutData(attachments: InboundMessageEvent['attachments']) {
  return (attachments ?? []).map(({ data: _d, ...a }) => a);
}

async function resolveContact(tx: Tx, tenantId: string, channelId: string, ev: InboundMessageEvent): Promise<string> {
  const mapped = await tx.query<{ contact_id: string }>(
    'SELECT contact_id FROM provider_identity_mappings WHERE channel_id = $1 AND provider_identity = $2',
    [channelId, ev.providerIdentity],
  );
  if (mapped.rows[0]) return mapped.rows[0].contact_id;
  const created = await tx.query<{ id: string }>(
    'INSERT INTO contacts (tenant_id, display_name, phone_e164) VALUES ($1, $2, $3) RETURNING id',
    [tenantId, ev.profileName ?? null, ev.phoneE164 ?? null],
  );
  const contactId = created.rows[0]!.id;
  const ins = await tx.query<{ contact_id: string }>(
    `INSERT INTO provider_identity_mappings (tenant_id, channel_id, provider_identity, contact_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (channel_id, provider_identity) DO NOTHING RETURNING contact_id`,
    [tenantId, channelId, ev.providerIdentity, contactId],
  );
  if (ins.rows[0]) return contactId;
  // Lost a race with a concurrent first message from the same sender.
  await tx.query('DELETE FROM contacts WHERE id = $1', [contactId]);
  const winner = await tx.query<{ contact_id: string }>(
    'SELECT contact_id FROM provider_identity_mappings WHERE channel_id = $1 AND provider_identity = $2',
    [channelId, ev.providerIdentity],
  );
  return winner.rows[0]!.contact_id;
}

const STATUS_RANK: Record<string, number> = { queued: 0, accepted: 1, sent: 2, delivered: 3, read: 4 };

async function applyStatus(tx: Tx, tenantId: string, channelId: string, ev: DeliveryStatusEvent): Promise<IngestResult> {
  await tx.query(
    `INSERT INTO delivery_events (tenant_id, channel_id, provider_message_id, status, detail, provider_timestamp)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, channelId, ev.providerMessageId, ev.status, ev.detail ?? null, ev.timestamp],
  );
  const cur = await tx.query<{ id: string; status: string }>(
    'SELECT id, status FROM messages WHERE channel_id = $1 AND provider_message_id = $2 FOR UPDATE',
    [channelId, ev.providerMessageId],
  );
  const row = cur.rows[0];
  if (!row) return { kind: 'status', matched: false };
  // Status events can arrive out of order; never move backwards (read -> delivered).
  const forward = ev.status === 'failed' || (STATUS_RANK[ev.status] ?? -1) > (STATUS_RANK[row.status] ?? -1);
  if (forward) {
    await tx.query('UPDATE messages SET status = $2, status_detail = $3 WHERE id = $1', [row.id, ev.status, ev.detail ?? null]);
  }
  return { kind: 'status', matched: true };
}
