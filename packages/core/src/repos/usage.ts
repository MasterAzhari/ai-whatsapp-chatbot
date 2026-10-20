import type { Db } from '../db.js';
import { inTenant, type TenantContext } from '../auth.js';

export interface UsageRow {
  provider: string;
  model: string;
  source: 'live' | 'playground';
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  unreportedCalls: number; // successful calls where the provider gave no token counts
  estimatedCost: { currency: string; amount: number } | null; // null = no rate on file
}

/** AI usage for the last `days` days. Costs are estimates from pricing_rates, never invoices. */
export async function getUsageSummary(db: Db, ctx: TenantContext, days = 30): Promise<UsageRow[]> {
  return inTenant(db, ctx, async (tx) => {
    const { rows } = await tx.query(
      `SELECT u.provider, u.model, u.source, count(*)::int AS calls,
              count(*) FILTER (WHERE u.outcome <> 'ok')::int AS failed,
              coalesce(sum(u.input_tokens), 0)::bigint AS input_tokens,
              coalesce(sum(u.output_tokens), 0)::bigint AS output_tokens,
              count(*) FILTER (WHERE u.outcome = 'ok' AND u.input_tokens IS NULL)::int AS unreported,
              r.currency, r.input_per_million, r.output_per_million
         FROM ai_usage_events u
         LEFT JOIN LATERAL (SELECT currency, input_per_million, output_per_million FROM pricing_rates p
                             WHERE p.provider = u.provider AND p.model = u.model AND p.effective_from <= current_date
                             ORDER BY effective_from DESC LIMIT 1) r ON true
        WHERE u.created_at > now() - ($1 || ' days')::interval
        GROUP BY u.provider, u.model, u.source, r.currency, r.input_per_million, r.output_per_million
        ORDER BY calls DESC`,
      [String(days)],
    );
    return rows.map((r) => {
      const inT = Number(r.input_tokens);
      const outT = Number(r.output_tokens);
      return {
        provider: r.provider,
        model: r.model,
        source: r.source,
        calls: r.calls,
        failed: r.failed,
        inputTokens: inT,
        outputTokens: outT,
        unreportedCalls: r.unreported,
        estimatedCost:
          r.currency == null
            ? null
            : { currency: r.currency, amount: (inT * Number(r.input_per_million) + outT * Number(r.output_per_million)) / 1e6 },
      };
    });
  });
}
