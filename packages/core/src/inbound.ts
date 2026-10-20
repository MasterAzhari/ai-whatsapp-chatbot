import type { Tx } from './db.js';
import type { DeliveryStatusEvent, InboundMessageEvent, NormalizedEvent } from './channels/adapter.js';

export type IngestResult =
  | { kind: 'stored'; messageId: string; conversationId: string; contactId: string }
  | { kind: 'duplicate'; messageId: string }
  | { kind: 'ignored'; reason: string }
  | { kind: 'status'; matched: boolean };

/**
 * Stores one normalised provider event durably. Must run inside withTenant for the
 * channel's tenant. Safe to call repeatedly with the same event: a repeated
 * webhook never creates a second message, conversation or reply trigger.
 * Routing (keyword, flow, AI) happens after this returns 'stored'.
 */
export async function ingestEvent(tx: Tx, tenantId: string, channelId: string, ev: NormalizedEvent): Promise<IngestResult> {
  if (ev.type === 'status') return applyStatus(tx, tenantId, channelId, ev);
  if (ev.fromMe) return { kind: 'ignored', reason: 'own message' };
  if (ev.isGroup) return { kind: 'ignored', reason: 'group chats not supported' };
  if (ev.isHistoryReplay) return { kind: 'ignored', reason: 'history replay' };
  if (!ev.providerMessageId) return { kind: 'ignored', reason: 'missing provider message id' };

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
    [tenantId, conversationId, channelId, ev.text ?? null, JSON.stringify(ev.attachments ?? []), ev.providerMessageId, ev.timestamp],
  );
  if (!msg.rows[0]) {
    const again = await tx.query<{ id: string }>(
      'SELECT id FROM messages WHERE channel_id = $1 AND provider_message_id = $2',
      [channelId, ev.providerMessageId],
    );
    return { kind: 'duplicate', messageId: again.rows[0]!.id };
  }
  await tx.query('UPDATE contacts SET last_inbound_at = greatest(last_inbound_at, $2) WHERE id = $1', [contactId, ev.timestamp]);
  return { kind: 'stored', messageId: msg.rows[0].id, conversationId, contactId };
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
