import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString = process.env.DATABASE_URL): Db {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  return new pg.Pool({ connectionString, max: Number(process.env.DB_POOL_MAX ?? 10) });
}

async function inTx<T>(db: Db, setup: (tx: Tx) => Promise<void>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    await setup(tx);
    const result = await fn(tx);
    await tx.query('COMMIT');
    return result;
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

/**
 * Runs fn in a transaction scoped to one tenant. Row-level security policies only
 * expose rows whose tenant_id matches, so a bug in a query cannot leak another
 * tenant's data. The setting is transaction-local and disappears on commit.
 */
export function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new Error('invalid tenant id');
  return inTx(db, (tx) => tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]).then(() => {}), fn);
}

/**
 * Cross-tenant access for system code only (login lookup, worker claiming due work,
 * platform administration). Never call this with input that a tenant user controls
 * as the only guard.
 */
export function withSystem<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return inTx(db, (tx) => tx.query("SELECT set_config('app.system', 'on', true)").then(() => {}), fn);
}
