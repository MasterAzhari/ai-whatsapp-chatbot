import type { Db } from './db.js';
import { drainOnce, type AdapterResolver } from './outbox.js';

export interface WorkerOptions {
  intervalMs?: number;
  log?: (msg: string) => void;
}

/**
 * Polls the durable outbox. Runs as its own process (never inside a request
 * handler) and stops cleanly: stop() waits for the current batch to finish.
 */
export function startWorker(db: Db, resolve: AdapterResolver, opts: WorkerOptions = {}) {
  const interval = opts.intervalMs ?? 1000;
  const log = opts.log ?? ((m: string) => console.log(`[worker] ${m}`));
  let stopping = false;
  let wake: (() => void) | null = null;

  const done = (async () => {
    while (!stopping) {
      try {
        const c = await drainOnce(db, resolve);
        const total = Object.values(c).reduce((a, b) => a + b, 0);
        if (total) log(`processed ${JSON.stringify(c)}`);
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
