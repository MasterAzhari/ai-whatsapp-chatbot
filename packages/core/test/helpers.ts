import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { createPool, type Db } from '../src/db.js';
import { migrate } from '../src/migrate.js';

/**
 * Creates a throwaway database owned by a NON-superuser role, because superusers
 * bypass row-level security and would hide isolation bugs. Needs TEST_ADMIN_URL
 * pointing at a Postgres superuser (default: local postgres on 127.0.0.1).
 */
export async function freshDb(): Promise<{ db: Db; drop: () => Promise<void> }> {
  const adminUrl = process.env.TEST_ADMIN_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres';
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const name = `chatbot_test_${randomBytes(4).toString('hex')}`;
  await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chatbot_test') THEN
        CREATE ROLE chatbot_test LOGIN PASSWORD 'chatbot_test' NOSUPERUSER NOBYPASSRLS;
      END IF; END $$`);
  await admin.query(`CREATE DATABASE ${name} OWNER chatbot_test`);
  await admin.end();

  const u = new URL(adminUrl);
  u.username = 'chatbot_test';
  u.password = 'chatbot_test';
  u.pathname = `/${name}`;
  const db = createPool(u.toString());
  await migrate(db);
  return {
    db,
    drop: async () => {
      await db.end();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
