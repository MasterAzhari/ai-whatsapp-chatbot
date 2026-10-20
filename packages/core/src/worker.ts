import type { Db } from './db.js';
import { drainOnce, type AdapterResolver } from './outbox.js';
import { claimJobs, finishJob } from './jobs.js';
import { routeInbound, type RouterDeps } from './routing/router.js';
import { ROUTE_JOB } from './routing/receive.js';
import { followupOnce } from './followup.js';
import { notifyOnce } from './notify.js';

export interface WorkerOptions {
  intervalMs?: number;
  log?: (msg: string) => void;
  /** When given, the worker also routes inbound messages (keyword, AI). */
  router?: RouterDeps;
  /** How often to look for chats that need a follow-up (default one minute). */
  followupEveryMs?: number;
}

/** Routes queued inbound messages. Returns how many jobs were handled. */
export async function routeOnce(db: Db, deps: RouterDeps, log: (m: string) => void = () => {}): Promise<number> {
  const jobs = await claimJobs(db, [ROUTE_JOB], 5);
  await Promise.all(
    jobs.map(async (job) => {
      try {
        const outcome = await routeInbound(db, job.tenantId, String(job.payload.messageId), deps);
        await finishJob(db, job, 'done', outcome);
      } catch (err) {
        log(`route ${job.id} failed: ${(err as Error).message}`);
        await finishJob(db, job, 'pending', (err as Error).message, 5_000 * job.attempts);
      }
    }),
  );
  return jobs.length;
}

/**
 * Polls routing jobs and the durable outbox. Runs as its own process (never inside
 * a request handler) and stops cleanly: stop() waits for the current batch to finish.
 */
export function startWorker(db: Db, resolve: AdapterResolver, opts: WorkerOptions = {}) {
  const interval = opts.intervalMs ?? 1000;
  const log = opts.log ?? ((m: string) => console.log(`[worker] ${m}`));
  let stopping = false;
  let wake: (() => void) | null = null;
  const followupEvery = opts.followupEveryMs ?? 60_000;
  let nextFollowup = 0;

  const done = (async () => {
    while (!stopping) {
      try {
        const routed = opts.router ? await routeOnce(db, opts.router, log) : 0;
        let followups = 0;
        if (opts.router && Date.now() >= nextFollowup) {
          nextFollowup = Date.now() + followupEvery;
          followups = await followupOnce(db, opts.router, log);
        }
        const c = await drainOnce(db, resolve);
        const alerts = await notifyOnce(db, resolve, log);
        const total = routed + followups + alerts + Object.values(c).reduce((a, b) => a + b, 0);
        if (total) log(`routed ${routed}, follow-ups ${followups}, staff alerts ${alerts}, outbox ${JSON.stringify(c)}`);
        if (total) continue; // more may be due
      } catch (err) {
        log(`error: ${(err as Error).message}`);
      }
      await new Promise<void>((r) => {
        const t = setTimeout(r, interval);
        wake = () => {
          clearTimeout(t);
          r();
        };
      });
      wake = null;
    }
  })();

  return {
    async stop() {
      stopping = true;
      (wake as (() => void) | null)?.();
      await done;
    },
  };
}
