import type { Db, Tx } from './db.js';
import { withSystem, withTenant } from './db.js';

/**
 * Durable background jobs in PostgreSQL (routing an inbound message, later
 * follow-ups). (tenant, kind, dedupe_key) is unique, so enqueueing the same job
 * twice is harmless.
 */
export async function enqueueJob(
  tx: Tx,
  tenantId: string,
  kind: string,
  dedupeKey: string,
  payload: Record<string, unknown>,
  runAt: Date = new Date(),
): Promise<boolean> {
  const r = await tx.query(
    `INSERT INTO scheduled_jobs (tenant_id, kind, dedupe_key, payload, run_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, kind, dedupe_key) DO NOTHING`,
    [tenantId, kind, dedupeKey, JSON.stringify(payload), runAt],
  );
  return (r.rowCount ?? 0) > 0;
}

export interface Job {
  id: string;
  tenantId: string;
  kind: string;
  payload: Record<string, any>;
  attempts: number;
}

const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;

export async function claimJobs(db: Db, kinds: string[], limit = 10): Promise<Job[]> {
  return withSystem(db, async (tx) => {
    // Jobs whose worker died are retried (routing is idempotent), up to MAX_ATTEMPTS.
    await tx.query(
      `UPDATE scheduled_jobs SET state = CASE WHEN attempts >= $1 THEN 'failed' ELSE 'pending' END,
              result = 'lease expired', lease_until = NULL, updated_at = now()
        WHERE state = 'running' AND lease_until < now()`,
      [MAX_ATTEMPTS],
    );
    const { rows } = await tx.query(
      `UPDATE scheduled_jobs SET state = 'running', attempts = attempts + 1, updated_at = now(),
              lease_until = now() + ($3 || ' milliseconds')::interval
        WHERE id IN (SELECT id FROM scheduled_jobs WHERE state = 'pending' AND run_at <= now() AND kind = ANY($1)
                      ORDER BY run_at LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING id, tenant_id, kind, payload, attempts`,
      [kinds, limit, String(LEASE_MS)],
    );
    return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, kind: r.kind, payload: r.payload, attempts: r.attempts }));
  });
}

export async function finishJob(db: Db, job: Job, state: 'done' | 'skipped' | 'failed' | 'pending', result: string, retryInMs?: number) {
  await withTenant(db, job.tenantId, (tx) =>
    tx.query(
      `UPDATE scheduled_jobs SET state = $2, result = left($3, 500), lease_until = NULL, updated_at = now(),
              run_at = CASE WHEN $4::bigint IS NULL THEN run_at ELSE now() + ($4::bigint || ' milliseconds')::interval END
        WHERE id = $1`,
      [job.id, state === 'pending' && job.attempts >= MAX_ATTEMPTS ? 'failed' : state, result, retryInMs ?? null],
    ),
  );
}
