import type { Tx } from '../db.js';
import type { TenantContext } from '../auth.js';

export async function audit(
  tx: Tx,
  ctx: TenantContext,
  action: string,
  targetType: string,
  targetId: string,
  before: unknown,
  after: unknown,
  source: 'web' | 'mcp' | 'api' = 'web',
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_events (tenant_id, actor_type, actor_id, action, target_type, target_id, before, after, source)
     VALUES ($1, 'user', $2, $3, $4, $5, $6, $7, $8)`,
    [ctx.tenantId, ctx.user.id, action, targetType, targetId, JSON.stringify(before), JSON.stringify(after), source],
  );
}
