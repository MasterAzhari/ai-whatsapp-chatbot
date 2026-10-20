import { createPool } from '../db.js';
import { assertSafeDbRole, migrate } from '../migrate.js';

const db = createPool();
try {
  await assertSafeDbRole(db);
  const applied = await migrate(db, undefined, (m) => console.log(m));
  console.log(applied.length ? `migrations applied: ${applied.length}` : 'database is up to date');
} finally {
  await db.end();
}
