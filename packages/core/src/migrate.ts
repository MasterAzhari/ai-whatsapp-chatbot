import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/src/migrate.js -> package root
export const MIGRATIONS_DIR = path.resolve(here, '../../migrations');

/**
 * Row-level security is the tenant boundary, and superusers or BYPASSRLS roles skip
 * it entirely. Refuse to run the app as such a role unless explicitly overridden.
 */
export async function assertSafeDbRole(db: Db): Promise<void> {
  const { rows } = await db.query<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>(
    'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );
  const r = rows[0];
  if (r && (r.rolsuper || r.rolbypassrls) && process.env.ALLOW_UNSAFE_DB_ROLE !== '1') {
    throw new Error(
      `database role "${r.rolname}" is a superuser or has BYPASSRLS, which disables tenant isolation. ` +
        'Connect as a normal role (see docs/DEPLOY.md) or set ALLOW_UNSAFE_DB_ROLE=1 for local experiments only.',
    );
  }
}

/** Applies pending *.sql migrations in filename order, each in its own transaction. */
export async function migrate(db: Db, dir = MIGRATIONS_DIR, log: (m: string) => void = () => {}): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  const client = await db.connect();
  try {
    // Serialise concurrent migrators (e.g. two containers starting together).
    await client.query('SELECT pg_advisory_lock(727274)');
    const done = new Map(
      (await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );
    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = done.get(file);
      if (prior) {
        if (prior !== checksum) throw new Error(`migration ${file} was modified after being applied`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
      log(`applied ${file}`);
      applied.push(file);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
  return applied;
}
