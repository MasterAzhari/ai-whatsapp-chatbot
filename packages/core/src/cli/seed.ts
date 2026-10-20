import { createPool } from '../db.js';
import { seedDemo } from '../seed.js';

const adminEmail = process.env.SEED_ADMIN_EMAIL;
const adminPassword = process.env.SEED_ADMIN_PASSWORD;
if (!adminEmail || !adminPassword) {
  console.error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (min 10 chars) to create the first platform owner.');
  process.exit(1);
}
const db = createPool();
try {
  const r = await seedDemo(db, { adminEmail, adminPassword });
  console.log(r.created ? 'synthetic demo tenants created' : 'demo data already present; nothing changed');
} finally {
  await db.end();
}
