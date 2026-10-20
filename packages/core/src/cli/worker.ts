import { createPool } from '../db.js';
import { createAdapterResolver } from '../channels/registry.js';
import { startWorker } from '../worker.js';

const db = createPool();
const worker = startWorker(db, createAdapterResolver(db));
console.log('[worker] started');

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] ${sig}: finishing current batch`);
    await worker.stop();
    await db.end();
    process.exit(0);
  });
}
