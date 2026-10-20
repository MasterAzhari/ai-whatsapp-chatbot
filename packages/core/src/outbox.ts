import type { Db, Tx } from './db.js';
import { withSystem, withTenant } from './db.js';
import type { ChannelAdapter } from './channels/adapter.js';

export interface EnqueueReplyInput {
  tenantId: string;
  conversationId: string;
  text: string;
  origin: 'keyword' | 'flow' | 'ai' | 'human' | 'system' | 'followup';
  authorUserId?: string;
  idempotencyKey: string;
  expiresInMs?: number; // automated replies go stale; human replies default to 24h
  delayMs?: number; // wait before the first send attempt (reply pacing)
  imageAssetId?: string | null; // picture sent with the text as its caption
}

/**
 * Records an outbound message and its outbox entry in the caller's transaction, so
 * either both exist or neither does. Repeating the same idempotency key returns the
 * original message instead of queueing a duplicate.
 */
export async function enqueueReply(tx: Tx, input: EnqueueReplyInput): Promise<{ messageId: string; duplicate: boolean }> {
  const existing = await tx.query<{ message_id: string }>(
    'SELECT message_id FROM outbox WHERE tenant_id = $1 AND idempotency_key = $2',
    [input.tenantId, input.idempotencyKey],
  );
  if (existing.rows[0]) return { messageId: existing.rows[0].message_id, duplicate: true };

  const conv = await tx.query<{ channel_id: string }>(
    'SELECT channel_id FROM conversations WHERE id = $1',
    [input.conversationId],
  );
  if (!conv.rows[0]) throw new Error('conversation not found');
  const channelId = conv.rows[0].channel_id;

  const msg = await tx.query<{ id: string }>(
    `INSERT INTO messages (tenant_id, conversation_id, channel_id, direction, origin, body, status, author_user_id, image_asset_id)
     VALUES ($1, $2, $3, 'outbound', $4, $5, 'queued', $6, $7) RETURNING id`,
    [input.tenantId, input.conversationId, channelId, input.origin, input.text || null, input.authorUserId ?? null, input.imageAssetId ?? null],
  );
  const messageId = msg.rows[0]!.id;
  const ttl = input.expiresInMs ?? (input.origin === 'human' ? 24 * 3600_000 : 15 * 60_000);
  await tx.query(
    `INSERT INTO outbox (tenant_id, channel_id, conversation_id, message_id, idempotency_key, expires_at, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' milliseconds')::interval, now() + ($7 || ' milliseconds')::interval)`,
    [input.tenantId, channelId, input.conversationId, messageId, input.idempotencyKey, String(ttl), String(Math.max(0, Math.round(input.delayMs ?? 0)))],
  );
  await tx.query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [input.conversationId]);
  return { messageId, duplicate: false };
}

/** Cancels queued automated replies, e.g. when a human takes over. Returns how many. */
export async function cancelPendingAutomated(tx: Tx, conversationId: string): Promise<number> {
  const res = await tx.query(
    `WITH c AS (
       UPDATE outbox o SET state = 'cancelled', updated_at = now(), last_error = 'cancelled: human takeover'
         FROM messages m
        WHERE o.message_id = m.id AND o.conversation_id = $1 AND o.state = 'pending' AND m.origin <> 'human'
       RETURNING o.message_id)
     UPDATE messages SET status = 'failed', status_detail = 'cancelled: human takeover'
      WHERE id IN (SELECT message_id FROM c)`,
    [conversationId],
  );
  return res.rowCount ?? 0;
}

export interface OutboxJob {
  id: string;
  tenantId: string;
  channelId: string;
  conversationId: string;
  messageId: string;
  idempotencyKey: string;
  attempts: number;
  maxAttempts: number;
}

const LEASE_MS = 60_000;

/**
 * Claims due outbox rows across tenants with a lease. SKIP LOCKED lets several
 * workers run without sending the same row twice.
 */
export async function claimDue(db: Db, limit = 20): Promise<OutboxJob[]> {
  return withSystem(db, async (tx) => {
    // A lease that ran out means a worker died mid-send: we cannot know whether the
    // provider got it, so mark it unknown for a human to check instead of resending.
    await tx.query(
      `WITH s AS (
         UPDATE outbox SET state = 'unknown', updated_at = now(), last_error = 'worker lease expired during send'
          WHERE state = 'sending' AND lease_until < now() RETURNING message_id)
       UPDATE messages SET status = 'unknown', status_detail = 'delivery unknown (worker interrupted)'
        WHERE id IN (SELECT message_id FROM s)`,
    );
    const { rows } = await tx.query(
      `UPDATE outbox SET state = 'sending', attempts = attempts + 1, lease_until = now() + ($2 || ' milliseconds')::interval,
              updated_at = now()
        WHERE id IN (SELECT id FROM outbox WHERE state = 'pending' AND next_attempt_at <= now()
                      ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING id, tenant_id, channel_id, conversation_id, message_id, idempotency_key, attempts, max_attempts`,
      [limit, String(LEASE_MS)],
    );
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      channelId: r.channel_id,
      conversationId: r.conversation_id,
      messageId: r.message_id,
      idempotencyKey: r.idempotency_key,
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
    }));
  });
}

export type AdapterResolver = (tenantId: string, channelId: string) => Promise<ChannelAdapter | null>;

export type ProcessOutcome = 'sent' | 'retry' | 'failed' | 'unknown' | 'cancelled';

function backoffMs(attempt: number): number {
  return Math.min(15 * 60_000, 2_000 * 2 ** (attempt - 1));
}

/** Re-checks eligibility right before sending, then hands the message to the adapter. */
export async function processJob(db: Db, job: OutboxJob, resolve: AdapterResolver): Promise<ProcessOutcome> {
  const prep = await withTenant(db, job.tenantId, async (tx) => {
    const { rows } = await tx.query(
      `SELECT m.body, m.origin, img.mime_type AS image_type, img.data AS image_data, o.expires_at < now() AS expired, o.state,
              coalesce((SELECT typing_indicator FROM bot_settings b WHERE b.tenant_id = o.tenant_id), false) AS typing,
              c.human_takeover, ch.automation_enabled, ct.opted_out_at IS NOT NULL AS opted_out,
              pim.provider_identity
         FROM outbox o
         JOIN messages m ON m.id = o.message_id
         LEFT JOIN media_assets img ON img.id = m.image_asset_id
         JOIN conversations c ON c.id = o.conversation_id
         JOIN channels ch ON ch.id = o.channel_id
         JOIN contacts ct ON ct.id = c.contact_id
         LEFT JOIN LATERAL (SELECT provider_identity FROM provider_identity_mappings
                             WHERE channel_id = o.channel_id AND contact_id = c.contact_id LIMIT 1) pim ON true
        WHERE o.id = $1`,
      [job.id],
    );
    return rows[0];
  });
  if (!prep || prep.state !== 'sending') return 'cancelled';

  const automated = prep.origin !== 'human';
  // System notices (e.g. "a staff member will reply") are sent as part of a handover,
  // so takeover blocks only bot-generated answers.
  const botAnswer = automated && prep.origin !== 'system';
  const block =
    prep.expired ? 'expired before it could be sent'
    : !prep.provider_identity ? 'no provider identity for contact'
    : botAnswer && prep.human_takeover ? 'human takeover active'
    : automated && !prep.automation_enabled ? 'automation disabled for channel'
    : automated && prep.opted_out ? 'contact opted out'
    : null;
  if (block) {
    await finish(db, job, 'cancelled', { messageStatus: 'failed', detail: `not sent: ${block}` });
    return 'cancelled';
  }

  const adapter = await resolve(job.tenantId, job.channelId);
  if (!adapter) {
    await finish(db, job, 'pending', { detail: 'channel adapter unavailable', retryInMs: backoffMs(job.attempts) });
    return 'retry';
  }

  let result;
  try {
    // Show "typing…" for a time that grows with the length of an automated reply.
    const typingMs = automated && prep.typing ? Math.min(6000, 1000 + (prep.body ?? '').length * 30) : 0;
    const send = { to: prep.provider_identity, text: prep.body ?? '', idempotencyKey: job.idempotencyKey, typingMs };
    result = prep.image_data && adapter.sendMedia
      ? await adapter.sendMedia({ ...send, attachment: { kind: 'image', mimeType: prep.image_type, data: (prep.image_data as Buffer).toString('base64') } })
      : await adapter.sendText(send);
  } catch (err) {
    result = { ok: false as const, retryable: false, unknown: true, error: (err as Error).message };
  }

  if (result.ok) {
    await finish(db, job, 'sent', { messageStatus: result.status, providerMessageId: result.providerMessageId });
    return 'sent';
  }
  if (result.unknown) {
    await finish(db, job, 'unknown', { messageStatus: 'unknown', detail: result.error });
    return 'unknown';
  }
  if (result.retryable && job.attempts < job.maxAttempts) {
    await finish(db, job, 'pending', { detail: result.error, retryInMs: backoffMs(job.attempts) });
    return 'retry';
  }
  await finish(db, job, 'failed', { messageStatus: 'failed', detail: result.error });
  return 'failed';
}

async function finish(
  db: Db,
  job: OutboxJob,
  state: 'sent' | 'pending' | 'failed' | 'unknown' | 'cancelled',
  o: { messageStatus?: string; detail?: string; providerMessageId?: string; retryInMs?: number },
): Promise<void> {
  await withTenant(db, job.tenantId, async (tx) => {
    await tx.query(
      `UPDATE outbox SET state = $2, lease_until = NULL, last_error = $3, updated_at = now(),
              next_attempt_at = CASE WHEN $4::bigint IS NULL THEN next_attempt_at
                                     ELSE now() + ($4::bigint || ' milliseconds')::interval END
        WHERE id = $1 AND state = 'sending'`,
      [job.id, state, o.detail ?? null, o.retryInMs ?? null],
    );
    if (o.messageStatus) {
      await tx.query(
        `UPDATE messages SET status = $2, status_detail = $3, provider_message_id = coalesce($4, provider_message_id)
          WHERE id = $1`,
        [job.messageId, o.messageStatus, o.detail ?? null, o.providerMessageId ?? null],
      );
    }
  });
}

/** Processes everything currently due once. Returns counts per outcome. */
export async function drainOnce(db: Db, resolve: AdapterResolver): Promise<Record<ProcessOutcome, number>> {
  const counts: Record<ProcessOutcome, number> = { sent: 0, retry: 0, failed: 0, unknown: 0, cancelled: 0 };
  for (const job of await claimDue(db)) counts[await processJob(db, job, resolve)]++;
  return counts;
}
