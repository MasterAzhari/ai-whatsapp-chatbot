import { z } from 'zod';
import type { Db, Tx } from '../db.js';
import { inTenant, requireRole, type TenantContext } from '../auth.js';
import type { KeywordRule } from '../routing/match.js';
import { audit } from './audit.js';
import { VersionConflictError } from './settings.js';

export interface KeywordRuleView extends KeywordRule {
  version: number;
  updatedAt: string;
}

function fromRow(r: Record<string, any>): KeywordRuleView {
  return {
    id: r.id,
    name: r.name,
    matchType: r.match_type,
    patterns: r.patterns,
    priority: r.priority,
    enabled: r.enabled,
    channelId: r.channel_id,
    replyText: r.reply_text,
    setLabel: r.set_label,
    handover: r.handover,
    cooldownSeconds: r.cooldown_seconds,
    version: r.version,
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function loadRules(tx: Tx): Promise<KeywordRuleView[]> {
  const { rows } = await tx.query('SELECT * FROM keyword_rules ORDER BY priority, name');
  return rows.map(fromRow);
}

export async function listKeywordRules(db: Db, ctx: TenantContext): Promise<KeywordRuleView[]> {
  return inTenant(db, ctx, loadRules);
}

export const RuleInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    matchType: z.enum(['exact', 'phrase']),
    patterns: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
    priority: z.number().int().min(0).max(10000).default(100),
    enabled: z.boolean().default(true),
    channelId: z.string().uuid().nullable().default(null),
    replyText: z.string().trim().max(4096).nullable().default(null),
    setLabel: z.string().trim().max(60).nullable().default(null),
    handover: z.boolean().default(false),
    cooldownSeconds: z.number().int().min(0).max(30 * 24 * 3600).default(0),
  })
  .refine((r) => r.replyText || r.setLabel || r.handover, 'a rule needs a reply, a label or handover');

export async function createKeywordRule(db: Db, ctx: TenantContext, input: z.input<typeof RuleInput>, source: 'web' | 'mcp' = 'web') {
  requireRole(ctx, 'admin');
  const v = RuleInput.parse(input);
  return inTenant(db, ctx, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO keyword_rules (tenant_id, channel_id, name, match_type, patterns, priority, enabled, reply_text, set_label, handover, cooldown_seconds)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [ctx.tenantId, v.channelId, v.name, v.matchType, v.patterns, v.priority, v.enabled, v.replyText, v.setLabel, v.handover, v.cooldownSeconds],
    );
    const rule = fromRow(rows[0]);
    await audit(tx, ctx, 'keyword_rule.create', 'keyword_rule', rule.id, null, rule, source);
    return rule;
  });
}

export async function updateKeywordRule(
  db: Db,
  ctx: TenantContext,
  id: string,
  expectedVersion: number,
  input: z.input<typeof RuleInput>,
  source: 'web' | 'mcp' = 'web',
) {
  requireRole(ctx, 'admin');
  const v = RuleInput.parse(input);
  return inTenant(db, ctx, async (tx) => {
    const before = await tx.query('SELECT * FROM keyword_rules WHERE id = $1 FOR UPDATE', [id]);
    if (!before.rows[0]) throw new Error('rule not found');
    const { rows } = await tx.query(
      `UPDATE keyword_rules SET channel_id = $3, name = $4, match_type = $5, patterns = $6, priority = $7, enabled = $8,
              reply_text = $9, set_label = $10, handover = $11, cooldown_seconds = $12, version = version + 1, updated_at = now()
        WHERE id = $1 AND version = $2 RETURNING *`,
      [id, expectedVersion, v.channelId, v.name, v.matchType, v.patterns, v.priority, v.enabled, v.replyText, v.setLabel, v.handover, v.cooldownSeconds],
    );
    if (!rows[0]) throw new VersionConflictError('rule changed since you loaded it; reload and try again');
    const rule = fromRow(rows[0]);
    await audit(tx, ctx, 'keyword_rule.update', 'keyword_rule', id, fromRow(before.rows[0]), rule, source);
    return rule;
  });
}

export async function setKeywordRuleEnabled(db: Db, ctx: TenantContext, id: string, enabled: boolean, source: 'web' | 'mcp' = 'web') {
  requireRole(ctx, 'admin');
  await inTenant(db, ctx, async (tx) => {
    const r = await tx.query(
      'UPDATE keyword_rules SET enabled = $2, version = version + 1, updated_at = now() WHERE id = $1 RETURNING id',
      [id, enabled],
    );
    if (!r.rowCount) throw new Error('rule not found');
    await audit(tx, ctx, enabled ? 'keyword_rule.enable' : 'keyword_rule.disable', 'keyword_rule', id, null, { enabled }, source);
  });
}

export async function deleteKeywordRule(db: Db, ctx: TenantContext, id: string) {
  requireRole(ctx, 'admin');
  await inTenant(db, ctx, async (tx) => {
    const before = await tx.query('DELETE FROM keyword_rules WHERE id = $1 RETURNING *', [id]);
    if (!before.rows[0]) throw new Error('rule not found');
    await audit(tx, ctx, 'keyword_rule.delete', 'keyword_rule', id, fromRow(before.rows[0]), null);
  });
}
