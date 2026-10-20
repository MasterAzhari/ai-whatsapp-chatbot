import { z } from 'zod';
import type { Db, Tx } from '../db.js';
import { inTenant, requireRole, type TenantContext } from '../auth.js';
import type { KeywordRule } from '../routing/match.js';
import { audit } from './audit.js';
import { splitBubbles } from '../outbox.js';
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
    startsLead: r.starts_lead,
    imageAssetId: r.image_asset_id,
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

/** WhatsApp shows the reply as the picture's caption, which has a length limit. */
const MAX_CAPTION = 1000;

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
    startsLead: z.boolean().default(false),
    imageAssetId: z.string().uuid().nullable().default(null),
  })
  .refine((r) => r.replyText || r.setLabel || r.handover || r.imageAssetId, 'a rule needs a reply, a picture, a label or handover')
  .refine((r) => !r.imageAssetId || (splitBubbles(r.replyText ?? '')[0] ?? '').length <= MAX_CAPTION, `balasan bersama gambar maksimum ${MAX_CAPTION} aksara`);

async function checkImage(tx: Tx, id: string | null) {
  if (id && !(await tx.query('SELECT 1 FROM media_assets WHERE id = $1', [id])).rowCount) throw new Error('gambar tidak dijumpai');
}

export async function createKeywordRule(db: Db, ctx: TenantContext, input: z.input<typeof RuleInput>, source: 'web' | 'mcp' = 'web') {
  requireRole(ctx, 'admin');
  const v = RuleInput.parse(input);
  return inTenant(db, ctx, async (tx) => {
    await checkImage(tx, v.imageAssetId);
    const { rows } = await tx.query(
      `INSERT INTO keyword_rules (tenant_id, channel_id, name, match_type, patterns, priority, enabled, reply_text, set_label, handover, cooldown_seconds, starts_lead, image_asset_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [ctx.tenantId, v.channelId, v.name, v.matchType, v.patterns, v.priority, v.enabled, v.replyText, v.setLabel, v.handover, v.cooldownSeconds, v.startsLead, v.imageAssetId],
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
    await checkImage(tx, v.imageAssetId);
    const { rows } = await tx.query(
      `UPDATE keyword_rules SET channel_id = $3, name = $4, match_type = $5, patterns = $6, priority = $7, enabled = $8,
              reply_text = $9, set_label = $10, handover = $11, cooldown_seconds = $12, starts_lead = $13, image_asset_id = $14, version = version + 1, updated_at = now()
        WHERE id = $1 AND version = $2 RETURNING *`,
      [id, expectedVersion, v.channelId, v.name, v.matchType, v.patterns, v.priority, v.enabled, v.replyText, v.setLabel, v.handover, v.cooldownSeconds, v.startsLead, v.imageAssetId],
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

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Stores a picture for keyword replies; returns its id. Only JPEG, PNG or WebP up to 5 MB. */
export async function saveImageAsset(db: Db, ctx: TenantContext, mimeType: string, data: Buffer): Promise<string> {
  requireRole(ctx, 'admin');
  return inTenant(db, ctx, (tx) => insertImage(tx, ctx.tenantId, mimeType, data));
}

export async function insertImage(tx: Tx, tenantId: string, mimeType: string, data: Buffer): Promise<string> {
  if (!(IMAGE_TYPES as readonly string[]).includes(mimeType)) throw new Error('gambar mesti JPG, PNG atau WebP');
  if (!data.length || data.length > MAX_IMAGE_BYTES) throw new Error('gambar mesti 5 MB atau kurang');
  const { rows } = await tx.query<{ id: string }>(
    'INSERT INTO media_assets (tenant_id, mime_type, bytes, data) VALUES ($1, $2, $3, $4) RETURNING id',
    [tenantId, mimeType, data.length, data],
  );
  return rows[0]!.id;
}

/** A stored picture, for showing it in the admin pages. */
export async function getImageAsset(db: Db, ctx: TenantContext, id: string): Promise<{ mimeType: string; data: Buffer } | null> {
  if (!z.string().uuid().safeParse(id).success) return null;
  return inTenant(db, ctx, async (tx) => {
    const { rows } = await tx.query<{ mime_type: string; data: Buffer }>('SELECT mime_type, data FROM media_assets WHERE id = $1', [id]);
    return rows[0] ? { mimeType: rows[0].mime_type, data: rows[0].data } : null;
  });
}
