import { createPool } from '../db.js';
import { createAdapterResolver } from '../channels/registry.js';
import { startWorker } from '../worker.js';
import { assertSafeDbRole } from '../migrate.js';
import { createAiResolver } from '../routing/ai-resolver.js';

const db = createPool();
await assertSafeDbRole(db);
const worker = startWorker(db, createAdapterResolver(db), { router: { aiFor: createAiResolver(db) } });
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
