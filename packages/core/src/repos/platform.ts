import { z } from 'zod';
import { withSystem, withTenant, type Db } from '../db.js';
import { hashPassword } from '../auth.js';

/** Platform-level setup used by the CLI and the platform owner. Not reachable by tenant users. */

export async function createTenant(db: Db, input: { slug: string; name: string; timezone?: string }): Promise<string> {
  const v = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/), name: z.string().min(1).max(200), timezone: z.string().optional() }).parse(input);
  return withSystem(db, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, timezone) VALUES ($1, $2, coalesce($3, 'Asia/Kuala_Lumpur')) RETURNING id`,
      [v.slug, v.name, v.timezone ?? null],
    );
    await tx.query(
      `INSERT INTO audit_events (tenant_id, actor_type, action, target_type, target_id, after, source)
       VALUES ($1, 'system', 'tenant.create', 'tenant', $3, $2, 'system')`,
      [rows[0]!.id, JSON.stringify(v), rows[0]!.id],
    );
    return rows[0]!.id;
  });
}

export async function createUser(db: Db, input: { email: string; name: string; password: string; platformOwner?: boolean }): Promise<string> {
  const v = z.object({ email: z.string().email(), name: z.string().min(1).max(200), password: z.string().min(10) }).parse(input);
  const hash = await hashPassword(v.password);
  return withSystem(db, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      'INSERT INTO users (email, name, password_hash, is_platform_owner) VALUES ($1, $2, $3, $4) RETURNING id',
      [v.email, v.name, hash, input.platformOwner ?? false],
    );
    return rows[0]!.id;
  });
}

export async function addMembership(db: Db, tenantId: string, userId: string, role: 'admin' | 'operator'): Promise<void> {
  await withTenant(db, tenantId, (tx) =>
    tx.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [tenantId, userId, role],
    ),
  );
}

export async function createChannel(
  db: Db,
  tenantId: string,
  input: { name: string; provider: 'official' | 'qr' | 'mock'; status?: string; automationEnabled?: boolean; aiEnabled?: boolean },
): Promise<string> {
  return withTenant(db, tenantId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO channels (tenant_id, name, provider, status, automation_enabled, ai_enabled)
       VALUES ($1, $2, $3, coalesce($4, 'disconnected'), $5, $6) RETURNING id`,
      [tenantId, input.name, input.provider, input.status ?? null, input.automationEnabled ?? false, input.aiEnabled ?? false],
    );
    return rows[0]!.id;
  });
}

export async function findTenantBySlug(db: Db, slug: string): Promise<{ id: string; name: string } | null> {
  return withSystem(db, async (tx) => (await tx.query('SELECT id, name FROM tenants WHERE slug = $1', [slug])).rows[0] ?? null);
}
