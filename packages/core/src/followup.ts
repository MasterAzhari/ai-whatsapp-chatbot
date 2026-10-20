import type { Db, Tx } from './db.js';
import { withSystem, withTenant } from './db.js';
import type { ChatTurn, GenerateReplyResult } from './ai/provider.js';
import { enqueueReply, splitBubbles } from './outbox.js';
import { loadSettings, replyDelayMs, type BotSettings } from './repos/settings.js';
import { AI_GUARDRAILS, leadActive, type RouterDeps } from './routing/router.js';

/**
 * Auto follow-up. When a customer goes quiet after the bot's last message, the bot
 * nudges them, at most once per configured gap (three at most), each gap counted
 * from the previous bot message. Once the gaps are used up it stays quiet until the
 * customer writes again, which starts a new count.
 *
 * Never follows up a chat a person is handling, a chat waiting for staff, a resolved
 * chat, an opted-out or "Rejected" contact, or (in lead mode) a chat that is not a lead.
 */

/** Messages used when the AI is off or fails, one per step. */
export const DEFAULT_FOLLOWUPS = [
  'Hai Cik 😊 Ada apa-apa lagi yang saya boleh bantu? Kalau Cik berminat, saya boleh bantu buat semakan percuma.',
  'Cik, sekadar mengingatkan ya 😊 Semakan adalah percuma dan tiada komitmen. Balas sahaja di sini bila Cik bersedia.',
  'Hai Cik, ini mesej terakhir daripada saya buat masa ini 🙏 Bila-bila masa Cik nak sambung, mesej sahaja di sini ya.',
];

/** The AI answers with this when the chat should not be followed up. */
const SKIP = 'SKIP';
const EXCLUDED_LABELS = ['rejected'];
const DUE_WINDOW_HOURS = 12; // a follow-up due longer ago than this is dropped, not sent late

interface Due {
  conversationId: string;
  tenantId: string;
  lastMessageId: string;
  step: number; // 1-based
}

/** Follow-ups due now. With conversationId, re-checks that one chat (inside its tenant). */
async function findDue(tx: Tx, conversationId?: string): Promise<Due[]> {
  const { rows } = await tx.query(
    `SELECT c.id, c.tenant_id, c.lead_started_at, b.lead_mode, b.lead_days, last.id AS last_id, fu.n
       FROM conversations c
       JOIN bot_settings b ON b.tenant_id = c.tenant_id AND b.followup_enabled
       JOIN channels ch ON ch.id = c.channel_id AND ch.automation_enabled
       JOIN contacts ct ON ct.id = c.contact_id AND ct.opted_out_at IS NULL
       JOIN LATERAL (SELECT m.id, m.origin, m.status, m.created_at FROM messages m
                      WHERE m.conversation_id = c.id AND m.direction IN ('inbound', 'outbound')
                      ORDER BY m.created_at DESC, m.id DESC LIMIT 1) last ON true
       JOIN LATERAL (SELECT max(created_at) AS at FROM messages
                      WHERE conversation_id = c.id AND direction = 'inbound') li ON li.at IS NOT NULL
       JOIN LATERAL (SELECT count(*)::int AS n FROM messages
                      WHERE conversation_id = c.id AND origin = 'followup' AND created_at > li.at) fu ON true
      WHERE ($1::uuid IS NULL OR c.id = $1)
        AND NOT c.human_takeover AND c.status = 'open'
        AND last.origin IN ('keyword', 'ai', 'system', 'followup')
        AND last.status IN ('sent', 'delivered', 'read')
        AND fu.n < cardinality(b.followup_gaps_min)
        AND last.created_at > b.followup_enabled_at
        AND (c.followup_stopped_at IS NULL OR c.followup_stopped_at < li.at)
        AND last.created_at + make_interval(mins => b.followup_gaps_min[fu.n + 1]) <= now()
        AND last.created_at + make_interval(mins => b.followup_gaps_min[fu.n + 1]) > now() - make_interval(hours => $2)
        AND NOT EXISTS (SELECT 1 FROM contact_label_assignments a JOIN contact_labels l ON l.id = a.label_id
                         WHERE a.contact_id = c.contact_id AND lower(l.name) = ANY($3))
      ORDER BY last.created_at
      LIMIT 20`,
    [conversationId ?? null, DUE_WINDOW_HOURS, EXCLUDED_LABELS],
  );
  return rows
    .filter((r) => !r.lead_mode || leadActive(r.lead_started_at, r.lead_days))
    .map((r) => ({ conversationId: r.id, tenantId: r.tenant_id, lastMessageId: r.last_id, step: r.n + 1 }));
}

/** Malaysia time (UTC+8, no daylight saving). */
export function withinHours(s: Pick<BotSettings, 'followupStartHour' | 'followupEndHour'>, now = new Date()): boolean {
  const h = (now.getUTCHours() + 8) % 24;
  return h >= s.followupStartHour && h < s.followupEndHour;
}

export function followupInstruction(s: BotSettings, step: number, steps: number): string {
  return [
    s.systemInstruction.trim(),
    `Your name is ${s.personaName}.`,
    AI_GUARDRAILS,
    [
      `TUGAS SEKARANG: pelanggan belum membalas mesej terakhir anda. Tulis mesej follow-up ke-${step} daripada maksimum ${steps}, berdasarkan perbualan di atas.`,
      s.followupInstruction.trim(),
      step === steps ? 'Ini follow-up terakhir: tutup dengan sopan dan beritahu pelanggan boleh mesej bila-bila masa.' : '',
      `Jika pelanggan sudah kata tidak berminat, minta dihubungi pada masa lain, minta jangan dihubungi, atau perbualan sudah selesai, balas tepat ${SKIP} sahaja.`,
    ].filter(Boolean).join('\n'),
  ].filter(Boolean).join('\n\n');
}

interface Prepared {
  due: Due;
  settings: BotSettings;
  history: ChatTurn[];
  aiAllowed: boolean;
}

async function sendOne(db: Db, due: Due, deps: RouterDeps): Promise<'sent' | 'skipped' | 'stopped'> {
  const prep = await withTenant(db, due.tenantId, async (tx): Promise<Prepared | null> => {
    await tx.query('SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE', [due.conversationId]);
    const again = (await findDue(tx, due.conversationId))[0];
    if (!again || again.lastMessageId !== due.lastMessageId) return null;
    const settings = await loadSettings(tx, due.tenantId);
    if (!withinHours(settings)) return null;
    const sw = await tx.query(
      `SELECT c.ai_enabled AS conv_ai, ch.ai_enabled AS channel_ai FROM conversations c JOIN channels ch ON ch.id = c.channel_id WHERE c.id = $1`,
      [due.conversationId],
    );
    const aiAllowed = settings.aiEnabled && !!settings.aiModel && (sw.rows[0].conv_ai ?? sw.rows[0].channel_ai) === true;
    const hist = await tx.query(
      `SELECT direction, body FROM messages
        WHERE conversation_id = $1 AND direction IN ('inbound', 'outbound') AND body IS NOT NULL AND status <> 'failed'
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      [due.conversationId, settings.historyTurns],
    );
    const history = hist.rows.reverse().map((r) => ({ role: r.direction === 'inbound' ? 'customer' : 'assistant', text: r.body }) as ChatTurn);
    return { due: again, settings, history, aiAllowed };
  });
  if (!prep) return 'skipped';

  const s = prep.settings;
  const steps = s.followupGapsMin.length;
  const step = prep.due.step;
  const provider = prep.aiAllowed ? await deps.aiFor(due.tenantId) : null;
  const result: GenerateReplyResult | null = provider
    ? await provider.generateReply({
        model: s.aiModel!,
        systemInstruction: followupInstruction(s, step, steps),
        // The model expects the customer to speak last; this note says why it is writing.
        history: [...prep.history, { role: 'customer', text: '[Nota sistem, bukan mesej pelanggan: pelanggan belum membalas. Tulis follow-up sekarang.]' }],
        knowledge: [],
        maxOutputTokens: s.maxOutputTokens,
        temperature: s.temperature ?? undefined,
        timeoutMs: s.aiTimeoutMs,
      })
    : null;

  return withTenant(db, due.tenantId, async (tx) => {
    await tx.query('SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE', [due.conversationId]);
    if (result) {
      await tx.query(
        `INSERT INTO ai_usage_events (tenant_id, conversation_id, provider, model, input_tokens, output_tokens, latency_ms, outcome)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          due.tenantId, due.conversationId, provider!.name, result.ok ? result.model : s.aiModel,
          result.ok ? result.usage.inputTokens : null, result.ok ? result.usage.outputTokens : null, result.ok ? result.latencyMs : null,
          result.ok ? 'ok' : result.reason,
        ],
      );
    }
    // The customer may have written, or staff taken over, while the AI was thinking.
    const again = (await findDue(tx, due.conversationId))[0];
    if (!again || again.lastMessageId !== due.lastMessageId) return 'skipped';
    // One bubble: each follow-up message counts towards the limit of three.
    const text = result?.ok ? splitBubbles(result.text).join('\n\n') : '';
    if (text.replace(/[^A-Z]/g, '') === SKIP) {
      await tx.query('UPDATE conversations SET followup_stopped_at = now() WHERE id = $1', [due.conversationId]);
      return 'stopped';
    }
    await enqueueReply(tx, {
      tenantId: due.tenantId,
      conversationId: due.conversationId,
      text: text || DEFAULT_FOLLOWUPS[Math.min(step, DEFAULT_FOLLOWUPS.length) - 1]!,
      origin: 'followup',
      idempotencyKey: `followup:${due.lastMessageId}`,
      delayMs: replyDelayMs(s),
    });
    return 'sent';
  });
}

/** Sends the follow-ups due now. Returns how many went into the outbox. */
export async function followupOnce(db: Db, deps: RouterDeps, log: (m: string) => void = () => {}): Promise<number> {
  const due = await withSystem(db, (tx) => findDue(tx));
  let sent = 0;
  for (const d of due) {
    try {
      if ((await sendOne(db, d, deps)) === 'sent') sent++;
    } catch (err) {
      log(`follow-up ${d.conversationId} failed: ${(err as Error).message}`);
    }
  }
  return sent;
}
