import type { Db } from '../db.js';
import { inTenant, requireRole, type TenantContext } from '../auth.js';
import type { AIProvider, GenerateReplyResult } from '../ai/provider.js';
import { loadRules } from '../repos/keywords.js';
import { loadSettings } from '../repos/settings.js';
import { AI_GUARDRAILS, decide, extractHandover, productNote, ruleProducts, type Route } from './router.js';

export interface PlaygroundResult {
  route: Route;
  ai?: GenerateReplyResult;
  /** The AI asked to hand the chat to staff (its reason), as the live bot would. */
  aiHandover?: string;
  /** The AI moved the chat to this product, as the live bot would. */
  aiProduct?: string;
}

/**
 * Shows what the bot would do with a message, without storing or sending anything.
 * Switches are assumed on so rules can be tried before going live; the AI is only
 * called when asked, and that call is recorded as playground usage.
 */
export async function simulate(
  db: Db,
  ctx: TenantContext,
  input: { text: string; channelId: string; callAi: boolean; isLead?: boolean; product?: string | null },
  aiFor: (tenantId: string) => Promise<AIProvider | null>,
): Promise<PlaygroundResult> {
  requireRole(ctx, 'admin');
  const { settings, rules } = await inTenant(db, ctx, async (tx) => ({
    settings: await loadSettings(tx, ctx.tenantId),
    rules: await loadRules(tx),
  }));
  const route = decide({
    text: input.text,
    channelId: input.channelId,
    automationEnabled: true,
    humanTakeover: false,
    optedOut: false,
    isLead: input.isLead ?? true,
    product: input.product || null,
    aiAllowed: !!settings.aiModel,
    settings,
    rules,
  });
  if (route.route !== 'ai' || !input.callAi) return { route };

  const products = ruleProducts(rules);
  const provider = await aiFor(ctx.tenantId);
  const ai: GenerateReplyResult = provider
    ? await provider.generateReply({
        model: settings.aiModel!,
        systemInstruction: [settings.systemInstruction.trim(), `Your name is ${settings.personaName}.`, productNote(input.product, products), AI_GUARDRAILS].filter(Boolean).join('\n\n'),
        history: [{ role: 'customer', text: input.text }],
        knowledge: [],
        maxOutputTokens: settings.maxOutputTokens,
        temperature: settings.temperature ?? undefined,
        timeoutMs: settings.aiTimeoutMs,
      })
    : { ok: false, reason: 'error', detail: 'AI provider is not configured (no API key)' };
  await inTenant(db, ctx, (tx) =>
    tx.query(
      `INSERT INTO ai_usage_events (tenant_id, provider, model, input_tokens, output_tokens, latency_ms, outcome, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'playground')`,
      [
        ctx.tenantId,
        provider?.name ?? 'none',
        ai.ok ? ai.model : settings.aiModel,
        ai.ok ? ai.usage.inputTokens : null,
        ai.ok ? ai.usage.outputTokens : null,
        ai.ok ? ai.latencyMs : null,
        ai.ok ? 'ok' : ai.reason,
      ],
    ),
  );
  if (!ai.ok) return { route, ai };
  const h = extractHandover(ai.text);
  const moved = h.product ? products.find((p) => p.toLowerCase() === h.product!.toLowerCase()) : undefined;
  return { route, ai: { ...ai, text: h.text }, ...(h.handover ? { aiHandover: h.reason ?? 'needs staff' } : {}), ...(moved ? { aiProduct: moved } : {}) };
}
