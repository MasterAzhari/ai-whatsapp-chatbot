import { createHash, randomInt } from 'node:crypto';
import { z } from 'zod';
import { withSystem, type Db } from '../db.js';
import { ForbiddenError, hashPassword, verifyPassword, type SessionUser } from '../auth.js';
import { exportBotTemplate, importBotTemplate } from './template.js';

/**
 * Agents: the platform owner gives each agent their own workspace and login, optionally
 * starting from a copy of an existing workspace's bot setup. Data stays per workspace.
 */

function requirePlatformOwner(user: SessionUser): void {
  if (!user.isPlatformOwner) throw new ForbiddenError('only the platform owner can manage agents');
}

/** Readable one-time password (no look-alike characters) for the owner to pass on. */
export function tempPassword(len = 12): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from({ length: len }, () => chars[randomInt(chars.length)]).join('');
}

export interface AgentWorkspace {
  tenantId: string;
  slug: string;
  name: string;
  createdAt: string;
  admins: Array<{ userId: string; email: string; name: string; disabled: boolean; isOwner: boolean }>;
  channels: number;
  connectedChannels: number;
}

export async function listAgentWorkspaces(db: Db, owner: SessionUser): Promise<AgentWorkspace[]> {
  requirePlatformOwner(owner);
  return withSystem(db, async (tx) => {
    const { rows } = await tx.query(
      `SELECT t.id, t.slug, t.name, t.created_at,
              coalesce((SELECT json_agg(json_build_object('userId', u.id, 'email', u.email, 'name', u.name, 'disabled', u.disabled_at IS NOT NULL, 'isOwner', u.is_platform_owner) ORDER BY u.email)
                          FROM tenant_memberships m JOIN users u ON u.id = m.user_id
                         WHERE m.tenant_id = t.id AND m.role = 'admin'), '[]') AS admins,
              (SELECT count(*)::int FROM channels c WHERE c.tenant_id = t.id) AS channels,
              (SELECT count(*)::int FROM channels c WHERE c.tenant_id = t.id AND c.status = 'connected') AS connected
         FROM tenants t ORDER BY t.created_at`,
    );
    return rows.map((r) => ({
      tenantId: r.id,
      slug: r.slug,
      name: r.name,
      createdAt: r.created_at.toISOString(),
      admins: r.admins,
      channels: r.channels,
      connectedChannels: r.connected,
    }));
  });
}

export const NewAgentInput = z.object({
  workspaceName: z.string().trim().min(2).max(200),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'slug: huruf kecil, nombor dan tanda sempang sahaja'),
  agentName: z.string().trim().min(1).max(200),
  agentEmail: z.string().trim().toLowerCase().email(),
  copyFromSlug: z.string().trim().nullable().optional(),
});

export interface NewAgentResult {
  slug: string;
  email: string;
  /** Set only when a new login was made; shown once to the owner, never stored in plain text. */
  tempPassword: string | null;
  rulesCopied: number | null;
}

/** Creates the workspace, the agent's login (or reuses an existing one) and admin access in one transaction. */
export async function createAgentWorkspace(db: Db, owner: SessionUser, input: z.input<typeof NewAgentInput>): Promise<NewAgentResult> {
  requirePlatformOwner(owner);
  const v = NewAgentInput.parse(input);
  const pw = tempPassword();
  const hash = await hashPassword(pw);
  const made = await withSystem(db, async (tx) => {
    const exists = await tx.query('SELECT 1 FROM tenants WHERE slug = $1', [v.slug]);
    if (exists.rowCount) throw Object.assign(new Error(`slug "${v.slug}" sudah digunakan`), { status: 409 });
    const t = await tx.query<{ id: string }>('INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id', [v.slug, v.workspaceName]);
    const tenantId = t.rows[0]!.id;
    const existing = await tx.query<{ id: string; is_platform_owner: boolean }>('SELECT id, is_platform_owner FROM users WHERE lower(email) = $1', [v.agentEmail]);
    let userId = existing.rows[0]?.id;
    if (existing.rows[0]?.is_platform_owner) throw Object.assign(new Error('emel ini akaun pemilik platform'), { status: 409 });
    const isNew = !userId;
    if (!userId) {
      userId = (await tx.query<{ id: string }>('INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id', [v.agentEmail, v.agentName, hash])).rows[0]!.id;
    }
    await tx.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [tenantId, userId]);
    await tx.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_id, action, target_type, target_id, after, source)
       VALUES ($1, 'user', $2, 'agent.create', 'tenant', $3, $4, 'web')`,
      [tenantId, owner.id, tenantId, JSON.stringify({ slug: v.slug, name: v.workspaceName, agentEmail: v.agentEmail, newLogin: isNew })],
    );
    return { tenantId, isNew };
  });

  let rulesCopied: number | null = null;
  if (v.copyFromSlug) {
    const from = await sourceContext(db, owner, v.copyFromSlug);
    const to = { tenantId: made.tenantId, user: owner, role: 'platform_owner' as const };
    rulesCopied = (await importBotTemplate(db, to, await exportBotTemplate(db, from, v.copyFromSlug), { replaceRules: true })).rulesAdded;
  }
  return { slug: v.slug, email: v.agentEmail, tempPassword: made.isNew ? pw : null, rulesCopied };
}

async function sourceContext(db: Db, owner: SessionUser, slug: string) {
  const t = await withSystem(db, (tx) => tx.query<{ id: string }>('SELECT id FROM tenants WHERE slug = $1', [slug]));
  if (!t.rows[0]) throw new Error('workspace sumber tidak dijumpai');
  return { tenantId: t.rows[0].id, user: owner, role: 'platform_owner' as const };
}

/** Gives an agent a new one-time password and signs them out everywhere. */
export async function resetAgentPassword(db: Db, owner: SessionUser, userId: string): Promise<string> {
  requirePlatformOwner(owner);
  const pw = tempPassword();
  const hash = await hashPassword(pw);
  await withSystem(db, async (tx) => {
    const r = await tx.query('UPDATE users SET password_hash = $2 WHERE id = $1 AND NOT is_platform_owner RETURNING id', [userId, hash]);
    if (!r.rowCount) throw new Error('akaun agent tidak dijumpai');
    await tx.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    await tx.query(
      `INSERT INTO audit_events (actor_type, actor_id, action, target_type, target_id, source) VALUES ('user', $1, 'agent.password_reset', 'user', $2, 'web')`,
      [owner.id, userId],
    );
  });
  return pw;
}

/** Blocks or restores an agent's login. Blocking also ends their sessions. */
export async function setAgentDisabled(db: Db, owner: SessionUser, userId: string, disabled: boolean): Promise<void> {
  requirePlatformOwner(owner);
  await withSystem(db, async (tx) => {
    const r = await tx.query(
      `UPDATE users SET disabled_at = CASE WHEN $2 THEN coalesce(disabled_at, now()) ELSE NULL END WHERE id = $1 AND NOT is_platform_owner RETURNING id`,
      [userId, disabled],
    );
    if (!r.rowCount) throw new Error('akaun agent tidak dijumpai');
    if (disabled) await tx.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    await tx.query(
      `INSERT INTO audit_events (actor_type, actor_id, action, target_type, target_id, source) VALUES ('user', $1, $3, 'user', $2, 'web')`,
      [owner.id, userId, disabled ? 'agent.disable' : 'agent.enable'],
    );
  });
}

/** Any signed-in user changes their own password; other sessions are signed out. */
export async function changeOwnPassword(db: Db, user: SessionUser, current: string, next: string, keepSessionToken?: string): Promise<void> {
  const keep = keepSessionToken ? createHash('sha256').update(keepSessionToken).digest('hex') : null;
  const v = z.string().min(10, 'kata laluan baru sekurang-kurangnya 10 aksara').max(200).parse(next);
  await withSystem(db, async (tx) => {
    const { rows } = await tx.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    if (!rows[0] || !(await verifyPassword(current, rows[0].password_hash))) throw new Error('kata laluan semasa salah');
    await tx.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(v)]);
    await tx.query('DELETE FROM sessions WHERE user_id = $1 AND id_hash IS DISTINCT FROM $2', [user.id, keep]);
    await tx.query(`INSERT INTO audit_events (actor_type, actor_id, action, source) VALUES ('user', $1, 'auth.password_change', 'web')`, [user.id]);
  });
}

export const RenameWorkspaceInput = NewAgentInput.pick({ workspaceName: true, slug: true });

/** Renames a workspace (name and web address). Old links with the previous slug stop working. */
export async function renameWorkspace(db: Db, owner: SessionUser, tenantId: string, input: z.input<typeof RenameWorkspaceInput>): Promise<{ slug: string }> {
  requirePlatformOwner(owner);
  const v = RenameWorkspaceInput.parse(input);
  await withSystem(db, async (tx) => {
    const before = await tx.query<{ slug: string; name: string }>('SELECT slug, name FROM tenants WHERE id = $1 FOR UPDATE', [tenantId]);
    if (!before.rows[0]) throw new Error('workspace tidak dijumpai');
    const taken = await tx.query('SELECT 1 FROM tenants WHERE slug = $1 AND id <> $2', [v.slug, tenantId]);
    if (taken.rowCount) throw Object.assign(new Error(`slug "${v.slug}" sudah digunakan`), { status: 409 });
    await tx.query('UPDATE tenants SET name = $2, slug = $3 WHERE id = $1', [tenantId, v.workspaceName, v.slug]);
    await tx.query(
      `INSERT INTO audit_events (tenant_id, actor_type, actor_id, action, target_type, target_id, before, after, source)
       VALUES ($1, 'user', $2, 'workspace.rename', 'tenant', $3, $4, $5, 'web')`,
      [tenantId, owner.id, tenantId, JSON.stringify(before.rows[0]), JSON.stringify({ slug: v.slug, name: v.workspaceName })],
    );
  });
  return { slug: v.slug };
}

/** Any signed-in user changes the name shown for them. */
export async function changeOwnName(db: Db, user: SessionUser, name: string): Promise<void> {
  const v = z.string().trim().min(1, 'nama diperlukan').max(200).parse(name);
  await withSystem(db, (tx) => tx.query('UPDATE users SET name = $2 WHERE id = $1', [user.id, v]));
}

/**
 * Sample data made when the server was first set up: mock (pretend) WhatsApp channels
 * with their synthetic chats, and sample workspaces that are left with no channel.
 * Real QR / official channels and their chats are never touched.
 */
export interface DemoData {
  mockChannels: number;
  conversations: number;
  sampleWorkspaces: string[];
}

const SAMPLE_WORKSPACE = `t.name LIKE '%(data sintetik)'
  AND NOT EXISTS (SELECT 1 FROM channels c WHERE c.tenant_id = t.id AND c.provider <> 'mock')`;

export async function countDemoData(db: Db, owner: SessionUser): Promise<DemoData> {
  requirePlatformOwner(owner);
  return withSystem(db, async (tx) => {
    const c = await tx.query<{ channels: number; conversations: number }>(
      `SELECT count(*)::int AS channels,
              (SELECT count(*)::int FROM conversations v JOIN channels ch ON ch.id = v.channel_id WHERE ch.provider = 'mock') AS conversations
         FROM channels WHERE provider = 'mock'`,
    );
    const t = await tx.query<{ name: string }>(`SELECT t.name FROM tenants t WHERE ${SAMPLE_WORKSPACE} ORDER BY t.created_at`);
    return { mockChannels: c.rows[0]!.channels, conversations: c.rows[0]!.conversations, sampleWorkspaces: t.rows.map((r) => r.name) };
  });
}

export async function purgeDemoData(db: Db, owner: SessionUser): Promise<DemoData> {
  requirePlatformOwner(owner);
  return withSystem(db, async (tx) => {
    const t = await tx.query<{ id: string; name: string }>(`SELECT t.id, t.name FROM tenants t WHERE ${SAMPLE_WORKSPACE}`);
    const contacts = await tx.query<{ contact_id: string }>(
      "SELECT DISTINCT v.contact_id FROM conversations v JOIN channels ch ON ch.id = v.channel_id WHERE ch.provider = 'mock'",
    );
    const conv = await tx.query("SELECT 1 FROM conversations v JOIN channels ch ON ch.id = v.channel_id WHERE ch.provider = 'mock'");
    // Deleting a channel removes its conversations, messages and queued replies (ON DELETE CASCADE).
    const ch = await tx.query("DELETE FROM channels WHERE provider = 'mock'");
    await tx.query(
      'DELETE FROM contacts ct WHERE ct.id = ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM conversations v WHERE v.contact_id = ct.id)',
      [contacts.rows.map((r) => r.contact_id)],
    );
    if (t.rows.length) await tx.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [t.rows.map((r) => r.id)]);
    const result = { mockChannels: ch.rowCount ?? 0, conversations: conv.rowCount ?? 0, sampleWorkspaces: t.rows.map((r) => r.name) };
    await tx.query(`INSERT INTO audit_events (actor_type, actor_id, action, after, source) VALUES ('user', $1, 'platform.purge_demo_data', $2, 'web')`, [
      owner.id, JSON.stringify(result),
    ]);
    return result;
  });
}
