import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { withSystem, withTenant, type Db } from './db.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;

export type Role = 'platform_owner' | 'admin' | 'operator';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  isPlatformOwner: boolean;
}

export interface TenantContext {
  tenantId: string;
  user: SessionUser;
  role: Role;
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) throw new Error('password must be at least 10 characters');
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return timingSafeEqual(actual, expected);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// Used to equalise timing when the email does not exist.
const DUMMY_HASH = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** Returns a new opaque session token, or null when credentials are wrong. */
export async function login(db: Db, email: string, password: string, userAgent?: string): Promise<string | null> {
  return withSystem(db, async (tx) => {
    const { rows } = await tx.query<{ id: string; password_hash: string; disabled_at: Date | null }>(
      'SELECT id, password_hash, disabled_at FROM users WHERE lower(email) = lower($1)',
      [email.trim()],
    );
    const user = rows[0];
    const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok || user.disabled_at) return null;
    const token = randomBytes(32).toString('base64url');
    await tx.query(
      'INSERT INTO sessions (id_hash, user_id, expires_at, user_agent) VALUES ($1, $2, $3, $4)',
      [sha256(token), user.id, new Date(Date.now() + SESSION_TTL_MS), userAgent?.slice(0, 300) ?? null],
    );
    await tx.query(
      "INSERT INTO audit_events (actor_type, actor_id, action, source) VALUES ('user', $1, 'auth.login', 'web')",
      [user.id],
    );
    return token;
  });
}

export async function logout(db: Db, token: string): Promise<void> {
  await withSystem(db, (tx) => tx.query('DELETE FROM sessions WHERE id_hash = $1', [sha256(token)]));
}

export async function getSessionUser(db: Db, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  return withSystem(db, async (tx) => {
    const { rows } = await tx.query(
      `SELECT u.id, u.email, u.name, u.is_platform_owner
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id_hash = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`,
      [sha256(token)],
    );
    const r = rows[0];
    return r ? { id: r.id, email: r.email, name: r.name, isPlatformOwner: r.is_platform_owner } : null;
  });
}

export interface Membership {
  tenantId: string;
  slug: string;
  name: string;
  role: Role;
}

export async function listMemberships(db: Db, user: SessionUser): Promise<Membership[]> {
  return withSystem(db, async (tx) => {
    const { rows } = user.isPlatformOwner
      ? await tx.query(`SELECT id AS tenant_id, slug, name, 'platform_owner' AS role FROM tenants ORDER BY name`)
      : await tx.query(
          `SELECT t.id AS tenant_id, t.slug, t.name, m.role
             FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id
            WHERE m.user_id = $1 ORDER BY t.name`,
          [user.id],
        );
    return rows.map((r) => ({ tenantId: r.tenant_id, slug: r.slug, name: r.name, role: r.role }));
  });
}

/** Resolves the caller's role in a tenant. Throws when the user has no access. */
export async function resolveTenantContext(db: Db, user: SessionUser, tenantSlug: string): Promise<TenantContext> {
  const m = (await listMemberships(db, user)).find((x) => x.slug === tenantSlug);
  if (!m) throw new ForbiddenError('no access to this workspace');
  return { tenantId: m.tenantId, user, role: m.role };
}

const RANK: Record<Role, number> = { operator: 1, admin: 2, platform_owner: 3 };

export function requireRole(ctx: TenantContext, min: Role): void {
  if (RANK[ctx.role] < RANK[min]) throw new ForbiddenError(`requires ${min} role`);
}

export class ForbiddenError extends Error {
  readonly status = 403;
}

/** Convenience: run a tenant-scoped transaction for an authorised context. */
export function inTenant<T>(db: Db, ctx: TenantContext, fn: Parameters<typeof withTenant<T>>[2]): Promise<T> {
  return withTenant(db, ctx.tenantId, fn);
}
