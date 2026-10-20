import { z } from 'zod';
import type { Db, Tx } from '../db.js';
import { inTenant, requireRole, type TenantContext } from '../auth.js';
import { decryptSecret, encryptSecret, maskSecret } from '../secrets.js';
import { audit } from './audit.js';

export interface BotSettings {
  version: number;
  personaName: string;
  language: string;
  systemInstruction: string;
  aiEnabled: boolean;
  aiProvider: 'gemini';
  aiModel: string | null;
  maxOutputTokens: number;
  temperature: number | null;
  historyTurns: number;
  aiTimeoutMs: number;
  fallbackReply: string | null;
  handoverReply: string | null;
  stopKeywords: string[];
  humanKeywords: string[];
}

function fromRow(r: Record<string, any>): BotSettings {
  return {
    version: r.version,
    personaName: r.persona_name,
    language: r.language,
    systemInstruction: r.system_instruction,
    aiEnabled: r.ai_enabled,
    aiProvider: r.ai_provider,
    aiModel: r.ai_model,
    maxOutputTokens: r.max_output_tokens,
    temperature: r.temperature == null ? null : Number(r.temperature),
    historyTurns: r.history_turns,
    aiTimeoutMs: r.ai_timeout_ms,
    fallbackReply: r.fallback_reply,
    handoverReply: r.handover_reply,
    stopKeywords: r.stop_keywords,
    humanKeywords: r.human_keywords,
  };
}

/** Reads settings inside an existing tenant transaction, creating defaults on first use. */
export async function loadSettings(tx: Tx, tenantId: string): Promise<BotSettings> {
  await tx.query('INSERT INTO bot_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [tenantId]);
  const { rows } = await tx.query('SELECT * FROM bot_settings WHERE tenant_id = $1', [tenantId]);
  return fromRow(rows[0]!);
}

export async function getBotSettings(db: Db, ctx: TenantContext): Promise<BotSettings & { aiKeyMasked: string | null }> {
  return inTenant(db, ctx, async (tx) => {
    const s = await loadSettings(tx, ctx.tenantId);
    const key = await readCredential(tx, 'gemini_api_key');
    return { ...s, aiKeyMasked: key ? maskSecret(key) : null };
  });
}

const keywordList = z.array(z.string().trim().min(1).max(100)).max(50);

export const SettingsUpdate = z.object({
  expectedVersion: z.number().int(),
  personaName: z.string().trim().min(1).max(80).optional(),
  language: z.string().trim().min(2).max(10).optional(),
  systemInstruction: z.string().max(8000).optional(),
  aiEnabled: z.boolean().optional(),
  aiModel: z.string().trim().regex(/^[a-z0-9][a-z0-9.\-]{1,80}$/i, 'invalid model id').nullable().optional(),
  maxOutputTokens: z.number().int().min(16).max(8192).optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  historyTurns: z.number().int().min(1).max(50).optional(),
  aiTimeoutMs: z.number().int().min(1000).max(120000).optional(),
  fallbackReply: z.string().trim().max(1000).nullable().optional(),
  handoverReply: z.string().trim().max(1000).nullable().optional(),
  stopKeywords: keywordList.optional(),
  humanKeywords: keywordList.optional(),
});

const COLUMNS: Record<string, string> = {
  personaName: 'persona_name',
  language: 'language',
  systemInstruction: 'system_instruction',
  aiEnabled: 'ai_enabled',
  aiModel: 'ai_model',
  maxOutputTokens: 'max_output_tokens',
  temperature: 'temperature',
  historyTurns: 'history_turns',
  aiTimeoutMs: 'ai_timeout_ms',
  fallbackReply: 'fallback_reply',
  handoverReply: 'handover_reply',
  stopKeywords: 'stop_keywords',
  humanKeywords: 'human_keywords',
};

export class VersionConflictError extends Error {
  readonly status = 409;
}

/** Updates settings if nobody changed them since expectedVersion was read. */
export async function updateBotSettings(
  db: Db,
  ctx: TenantContext,
  input: z.input<typeof SettingsUpdate>,
  source: 'web' | 'mcp' = 'web',
): Promise<BotSettings> {
  requireRole(ctx, 'admin');
  const v = SettingsUpdate.parse(input);
  return inTenant(db, ctx, async (tx) => {
    const before = await loadSettings(tx, ctx.tenantId);
    const sets: string[] = [];
    const vals: unknown[] = [ctx.tenantId, v.expectedVersion, ctx.user.id];
    for (const [k, col] of Object.entries(COLUMNS)) {
      const val = (v as Record<string, unknown>)[k];
      if (val === undefined) continue;
      vals.push(val);
      sets.push(`${col} = $${vals.length}`);
    }
    const { rows } = await tx.query(
      `UPDATE bot_settings SET ${[...sets, 'version = version + 1', 'updated_by = $3', 'updated_at = now()'].join(', ')}
        WHERE tenant_id = $1 AND version = $2 RETURNING *`,
      vals,
    );
    if (!rows[0]) throw new VersionConflictError(`settings changed since version ${v.expectedVersion}; reload and try again`);
    const after = fromRow(rows[0]);
    await audit(tx, ctx, 'bot_settings.update', 'bot_settings', ctx.tenantId, before, after, source);
    return after;
  });
}

// ---------------------------------------------------------------- credentials

export async function readCredential(tx: Tx, kind: string): Promise<string | null> {
  const { rows } = await tx.query<{ ciphertext: string }>('SELECT ciphertext FROM credential_references WHERE kind = $1', [kind]);
  return rows[0] ? decryptSecret(rows[0].ciphertext) : null;
}

/** Stores a provider secret encrypted. The value is never returned to the caller again. */
export async function setCredential(db: Db, ctx: TenantContext, kind: 'gemini_api_key', value: string | null): Promise<void> {
  requireRole(ctx, 'admin');
  await inTenant(db, ctx, async (tx) => {
    if (value === null || value.trim() === '') {
      await tx.query('DELETE FROM credential_references WHERE kind = $1', [kind]);
    } else {
      const clean = z.string().trim().min(10).max(500).parse(value);
      await tx.query(
        `INSERT INTO credential_references (tenant_id, kind, ciphertext) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, kind) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, rotated_at = now()`,
        [ctx.tenantId, kind, encryptSecret(clean)],
      );
    }
    // Audit records that the key changed, never the key itself.
    await audit(tx, ctx, value ? 'credential.set' : 'credential.delete', 'credential', kind, null, { kind });
  });
}

// ---------------------------------------------------------------- channel switches

export async function setChannelSwitches(
  db: Db,
  ctx: TenantContext,
  channelId: string,
  input: { automationEnabled?: boolean; aiEnabled?: boolean },
): Promise<void> {
  requireRole(ctx, 'admin');
  await inTenant(db, ctx, async (tx) => {
    const before = await tx.query('SELECT automation_enabled, ai_enabled FROM channels WHERE id = $1 FOR UPDATE', [channelId]);
    if (!before.rows[0]) throw new Error('channel not found');
    await tx.query(
      `UPDATE channels SET automation_enabled = coalesce($2, automation_enabled), ai_enabled = coalesce($3, ai_enabled) WHERE id = $1`,
      [channelId, input.automationEnabled ?? null, input.aiEnabled ?? null],
    );
    await audit(tx, ctx, 'channel.switches', 'channel', channelId, before.rows[0], input);
  });
}
