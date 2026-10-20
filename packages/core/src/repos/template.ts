import { z } from 'zod';
import type { Db } from '../db.js';
import { inTenant, requireRole, type TenantContext } from '../auth.js';
import { audit } from './audit.js';
import { loadRules, RuleInput } from './keywords.js';
import { loadSettings, SETTINGS_COLUMNS, SettingsUpdate } from './settings.js';

/**
 * A bot template: a workspace's bot settings and keyword rules as a JSON file, so an
 * owner can hand the same setup to agents' workspaces. API keys, channels, contacts
 * and conversations are never included; each agent sets their own key.
 */
export const TEMPLATE_FORMAT = 'chatbot-bot-template';

const TemplateSettings = SettingsUpdate.omit({ expectedVersion: true });
const TemplateRule = z.object({
  name: z.string(),
  matchType: z.enum(['exact', 'phrase']),
  patterns: z.array(z.string()),
  priority: z.number().int(),
  enabled: z.boolean(),
  replyText: z.string().nullable(),
  setLabel: z.string().nullable(),
  handover: z.boolean(),
  cooldownSeconds: z.number().int(),
  startsLead: z.boolean().optional(),
});

export const BotTemplate = z.object({
  format: z.literal(TEMPLATE_FORMAT),
  version: z.literal(1),
  exportedAt: z.string(),
  source: z.string().max(200).optional(),
  settings: TemplateSettings,
  keywordRules: z.array(TemplateRule).max(500),
});
export type BotTemplate = z.infer<typeof BotTemplate>;

export async function exportBotTemplate(db: Db, ctx: TenantContext, sourceName?: string): Promise<BotTemplate> {
  requireRole(ctx, 'admin');
  return inTenant(db, ctx, async (tx) => {
    const { version: _v, ...settings } = await loadSettings(tx, ctx.tenantId);
    const rules = await loadRules(tx);
    return {
      format: TEMPLATE_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      ...(sourceName ? { source: sourceName } : {}),
      settings,
      // Rules tied to one channel become workspace-wide: channel ids differ per workspace.
      keywordRules: rules.map(({ id: _id, version: _rv, updatedAt: _u, channelId: _c, ...r }) => r),
    };
  });
}

export interface ImportResult {
  rulesAdded: number;
  rulesRemoved: number;
}

/**
 * Applies a template to this workspace in one transaction: settings are overwritten,
 * keyword rules are added (or replace the existing ones when replaceRules is set).
 */
export async function importBotTemplate(
  db: Db,
  ctx: TenantContext,
  input: unknown,
  opts: { replaceRules: boolean },
): Promise<ImportResult> {
  requireRole(ctx, 'admin');
  const t = BotTemplate.parse(input);
  const rules = t.keywordRules.map((r) => RuleInput.parse(r));
  const { replyDelayMinSec: min, replyDelayMaxSec: max } = t.settings;
  if (min != null && max != null && max < min) throw new Error('template has a maximum reply delay below the minimum');
  return inTenant(db, ctx, async (tx) => {
    const before = await loadSettings(tx, ctx.tenantId);
    const sets: string[] = [];
    const vals: unknown[] = [ctx.tenantId, ctx.user.id];
    for (const [k, col] of Object.entries(SETTINGS_COLUMNS)) {
      const val = (t.settings as Record<string, unknown>)[k];
      if (val === undefined) continue;
      vals.push(val);
      sets.push(`${col} = $${vals.length}`);
    }
    const { rows } = await tx.query(
      `UPDATE bot_settings SET ${[...sets, 'version = version + 1', 'updated_by = $2', 'updated_at = now()'].join(', ')}
        WHERE tenant_id = $1 RETURNING *`,
      vals,
    );
    let rulesRemoved = 0;
    if (opts.replaceRules) rulesRemoved = (await tx.query('DELETE FROM keyword_rules')).rowCount ?? 0;
    for (const v of rules) {
      await tx.query(
        `INSERT INTO keyword_rules (tenant_id, channel_id, name, match_type, patterns, priority, enabled, reply_text, set_label, handover, cooldown_seconds, starts_lead)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [ctx.tenantId, v.name, v.matchType, v.patterns, v.priority, v.enabled, v.replyText, v.setLabel, v.handover, v.cooldownSeconds, v.startsLead],
      );
    }
    const result = { rulesAdded: rules.length, rulesRemoved };
    await audit(tx, ctx, 'bot_template.import', 'bot_settings', ctx.tenantId, before, { source: t.source ?? null, settingsVersion: rows[0]?.version, ...result });
    return result;
  });
}
