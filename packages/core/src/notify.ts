import type { Db, Tx } from './db.js';
import { claimJobs, enqueueJob, finishJob } from './jobs.js';
import type { AdapterResolver } from './outbox.js';
import { loadSettings } from './repos/settings.js';

/**
 * WhatsApp alerts to the workspace's staff numbers when a chat needs a person, sent
 * from the workspace's own WhatsApp channel. Queued in the same transaction as the
 * handover, so an alert goes out exactly when the handover happened.
 */
export const NOTIFY_JOB = 'staff_notify';

const MAX_QUOTE = 300;

/** True when this phone (+60123...) is one of the workspace's staff numbers. */
export function isStaffNumber(phoneE164: string | null | undefined, numbers: string[]): boolean {
  const d = phoneE164?.replace(/\D/g, '');
  return !!d && numbers.includes(d);
}

/**
 * Queues one alert per staff number. dedupeKey makes repeats harmless (one alert per
 * handover message). Does nothing when no staff number is set.
 */
export async function notifyStaff(tx: Tx, tenantId: string, conversationId: string, reason: string, dedupeKey: string): Promise<number> {
  const s = await loadSettings(tx, tenantId);
  if (!s.notifyNumbers.length) return 0;
  const { rows } = await tx.query(
    `SELECT c.channel_id, ct.display_name, ct.phone_e164, t.slug,
            (SELECT body FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'inbound' AND m.body IS NOT NULL
              ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_text
       FROM conversations c JOIN contacts ct ON ct.id = c.contact_id JOIN tenants t ON t.id = c.tenant_id
      WHERE c.id = $1`,
    [conversationId],
  );
  const r = rows[0];
  if (!r) return 0;
  const quote = r.last_text ? (r.last_text.length > MAX_QUOTE ? `${r.last_text.slice(0, MAX_QUOTE)}…` : r.last_text) : null;
  const base = (process.env.APP_PUBLIC_URL ?? '').replace(/\/$/, '');
  const text = [
    '🔔 *Chat perlu staf*',
    `Customer: ${r.display_name ?? 'Tanpa nama'}${r.phone_e164 ? ` (${r.phone_e164})` : ''}`,
    `Sebab: ${reason}`,
    quote ? `Mesej: "${quote}"` : '',
    base ? `Buka chat: ${base}/w/${r.slug}/inbox/${conversationId}` : '',
  ].filter(Boolean).join('\n');
  let n = 0;
  for (const num of s.notifyNumbers) {
    if (await enqueueJob(tx, tenantId, NOTIFY_JOB, `${dedupeKey}:${num}`, { channelId: r.channel_id, to: `${num}@s.whatsapp.net`, text })) n++;
  }
  return n;
}

/** Sends due staff alerts. Returns how many were handled. */
export async function notifyOnce(db: Db, resolve: AdapterResolver, log: (m: string) => void = () => {}): Promise<number> {
  const jobs = await claimJobs(db, [NOTIFY_JOB], 10);
  for (const job of jobs) {
    try {
      const adapter = await resolve(job.tenantId, String(job.payload.channelId));
      if (!adapter) {
        await finishJob(db, job, 'pending', 'channel adapter unavailable', 30_000 * job.attempts);
        continue;
      }
      const r = await adapter.sendText({ to: String(job.payload.to), text: String(job.payload.text), idempotencyKey: `notify:${job.id}` });
      if (r.ok) await finishJob(db, job, 'done', r.providerMessageId);
      // Unknown: it may have gone out, so do not send a second copy.
      else await finishJob(db, job, r.retryable && !r.unknown ? 'pending' : 'failed', r.error, 30_000 * job.attempts);
    } catch (err) {
      log(`staff alert ${job.id} failed: ${(err as Error).message}`);
      await finishJob(db, job, 'pending', (err as Error).message, 30_000 * job.attempts);
    }
  }
  return jobs.length;
}
