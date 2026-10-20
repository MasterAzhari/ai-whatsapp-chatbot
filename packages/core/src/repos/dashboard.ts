import type { Db } from '../db.js';
import { inTenant, type TenantContext } from '../auth.js';

export interface DashboardStats {
  conversations: { open: number; pendingHuman: number; resolved: number; newToday: number };
  repliesByOrigin: Record<'keyword' | 'flow' | 'ai' | 'human', number>;
  messageStatus: Record<string, number>;
  outbox: Record<string, number>;
  channels: Array<{ id: string; name: string; provider: string; status: string; automationEnabled: boolean; aiEnabled: boolean }>;
}

/** Counts for the last `days` days, in the tenant's own data only. */
export async function getDashboard(db: Db, ctx: TenantContext, days = 7): Promise<DashboardStats> {
  return inTenant(db, ctx, async (tx) => {
    const conv = await tx.query(
      `SELECT count(*) FILTER (WHERE c.status = 'open') AS open,
              count(*) FILTER (WHERE c.status = 'pending_human') AS pending_human,
              count(*) FILTER (WHERE c.status = 'resolved') AS resolved,
              count(*) FILTER (WHERE c.created_at >= date_trunc('day', now() AT TIME ZONE t.timezone) AT TIME ZONE t.timezone) AS new_today
         FROM conversations c JOIN tenants t ON t.id = c.tenant_id`,
    );
    const origin = await tx.query(
      `SELECT origin, count(*)::int AS n FROM messages
        WHERE direction = 'outbound' AND created_at > now() - ($1 || ' days')::interval GROUP BY origin`,
      [String(days)],
    );
    const status = await tx.query(
      `SELECT status, count(*)::int AS n FROM messages
        WHERE direction = 'outbound' AND created_at > now() - ($1 || ' days')::interval GROUP BY status`,
      [String(days)],
    );
    const outbox = await tx.query(`SELECT state, count(*)::int AS n FROM outbox GROUP BY state`);
    const channels = await tx.query(
      `SELECT id, name, provider, status, automation_enabled, ai_enabled FROM channels ORDER BY name`,
    );
    const c = conv.rows[0];
    const byOrigin = { keyword: 0, flow: 0, ai: 0, human: 0 };
    for (const r of origin.rows) if (r.origin in byOrigin) byOrigin[r.origin as keyof typeof byOrigin] = r.n;
    return {
      conversations: { open: +c.open, pendingHuman: +c.pending_human, resolved: +c.resolved, newToday: +c.new_today },
      repliesByOrigin: byOrigin,
      messageStatus: Object.fromEntries(status.rows.map((r) => [r.status, r.n])),
      outbox: Object.fromEntries(outbox.rows.map((r) => [r.state, r.n])),
      channels: channels.rows.map((r) => ({
        id: r.id,
        name: r.name,
        provider: r.provider,
        status: r.status,
        automationEnabled: r.automation_enabled,
        aiEnabled: r.ai_enabled,
      })),
    };
  });
}
