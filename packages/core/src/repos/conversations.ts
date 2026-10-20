import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db.js';
import { inTenant, requireRole, type TenantContext } from '../auth.js';
import { cancelPendingAutomated, enqueueReply } from '../outbox.js';
import { audit } from './audit.js';
import { loadSettings } from './settings.js';
import { leadActive } from '../routing/router.js';

const MEDIA_LABEL: Record<string, string> = { audio: 'Voice note', image: 'Gambar', video: 'Video', document: 'Fail', other: 'Stiker' };

export interface ConversationSummary {
  id: string;
  status: 'open' | 'pending_human' | 'resolved';
  humanTakeover: boolean;
  /** on: bot answers; off: a person took over; not_lead: lead mode and no active lead window. */
  botState: 'on' | 'off' | 'not_lead';
  contactName: string | null;
  contactPhone: string | null;
  channelName: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
}

export interface MessageView {
  id: string;
  direction: 'inbound' | 'outbound' | 'note';
  origin: 'customer' | 'keyword' | 'flow' | 'ai' | 'human' | 'system';
  body: string | null;
  /** Readable names of media sent with the message, e.g. "Voice note". */
  attachments: string[];
  status: string;
  statusDetail: string | null;
  route: { route: string; reason: string } | null; // why an inbound message was (not) answered
  createdAt: string;
}

function botState(r: { human_takeover: boolean; lead_started_at: Date | null }, s: { leadMode: boolean; leadDays: number }): ConversationSummary['botState'] {
  if (r.human_takeover) return 'off';
  if (s.leadMode && !leadActive(r.lead_started_at, s.leadDays)) return 'not_lead';
  return 'on';
}

export const InboxFilter = z.object({
  status: z.enum(['open', 'pending_human', 'resolved']).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export async function listConversations(db: Db, ctx: TenantContext, filter: z.input<typeof InboxFilter> = {}): Promise<ConversationSummary[]> {
  const f = InboxFilter.parse(filter);
  return inTenant(db, ctx, async (tx) => {
    const settings = await loadSettings(tx, ctx.tenantId);
    const { rows } = await tx.query(
      `SELECT c.id, c.status, c.human_takeover, c.lead_started_at, ct.display_name, ct.phone_e164, ch.name AS channel_name,
              c.last_message_at,
              (SELECT coalesce(left(body, 120), '[' || (attachments->0->>'kind') || ']') FROM messages m
                WHERE m.conversation_id = c.id AND m.direction <> 'note'
                ORDER BY created_at DESC LIMIT 1) AS preview
         FROM conversations c
         JOIN contacts ct ON ct.id = c.contact_id
         JOIN channels ch ON ch.id = c.channel_id
        WHERE ($1::text IS NULL OR c.status = $1)
          AND ($2::text IS NULL OR ct.display_name ILIKE '%' || $2 || '%' OR ct.phone_e164 LIKE '%' || $2 || '%')
        ORDER BY c.last_message_at DESC NULLS LAST
        LIMIT $3`,
      [f.status ?? null, f.q || null, f.limit],
    );
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      humanTakeover: r.human_takeover,
      botState: botState(r, settings),
      contactName: r.display_name,
      contactPhone: r.phone_e164,
      channelName: r.channel_name,
      lastMessageAt: r.last_message_at?.toISOString() ?? null,
      lastMessagePreview: r.preview?.replace(/^\[(\w+)\]$/, (_: string, k: string) => `[${MEDIA_LABEL[k] ?? 'Lampiran'}]`) ?? null,
    }));
  });
}

export async function getConversation(db: Db, ctx: TenantContext, id: string): Promise<{ conversation: ConversationSummary; messages: MessageView[] } | null> {
  if (!z.string().uuid().safeParse(id).success) return null;
  return inTenant(db, ctx, async (tx) => {
    const c = await tx.query(
      `SELECT c.id, c.status, c.human_takeover, c.lead_started_at, ct.display_name, ct.phone_e164, ch.name AS channel_name, c.last_message_at
         FROM conversations c JOIN contacts ct ON ct.id = c.contact_id JOIN channels ch ON ch.id = c.channel_id
        WHERE c.id = $1`,
      [id],
    );
    const r = c.rows[0];
    if (!r) return null;
    const settings = await loadSettings(tx, ctx.tenantId);
    const m = await tx.query(
      `SELECT id, direction, origin, body, attachments, status, status_detail, route, created_at
         FROM messages WHERE conversation_id = $1 ORDER BY created_at, id`,
      [id],
    );
    return {
      conversation: {
        id: r.id,
        status: r.status,
        humanTakeover: r.human_takeover,
        botState: botState(r, settings),
        contactName: r.display_name,
        contactPhone: r.phone_e164,
        channelName: r.channel_name,
        lastMessageAt: r.last_message_at?.toISOString() ?? null,
        lastMessagePreview: null,
      },
      messages: m.rows.map((x) => ({
        id: x.id,
        direction: x.direction,
        origin: x.origin,
        body: x.body,
        attachments: ((x.attachments ?? []) as Array<{ kind: string }>).map((a) => MEDIA_LABEL[a.kind] ?? 'Lampiran'),
        status: x.status,
        statusDetail: x.status_detail,
        route: x.route,
        createdAt: x.created_at.toISOString(),
      })),
    };
  });
}

const ReplyInput = z.object({ text: z.string().trim().min(1).max(4096), clientRequestId: z.string().max(100).optional() });

/**
 * Operator reply. Sending manually implies a human is handling the conversation, so
 * it also turns on human takeover and cancels any queued automated reply.
 */
export async function sendManualReply(db: Db, ctx: TenantContext, conversationId: string, input: z.input<typeof ReplyInput>) {
  requireRole(ctx, 'operator');
  const { text, clientRequestId } = ReplyInput.parse(input);
  return inTenant(db, ctx, async (tx) => {
    const lock = await tx.query('SELECT id FROM conversations WHERE id = $1 FOR UPDATE', [conversationId]);
    if (!lock.rows[0]) throw new Error('conversation not found');
    await tx.query("UPDATE conversations SET human_takeover = true, status = 'pending_human' WHERE id = $1 AND NOT human_takeover", [conversationId]);
    await cancelPendingAutomated(tx, conversationId);
    return enqueueReply(tx, {
      tenantId: ctx.tenantId,
      conversationId,
      text,
      origin: 'human',
      authorUserId: ctx.user.id,
      idempotencyKey: `human:${clientRequestId ?? randomUUID()}`,
    });
  });
}

export async function addInternalNote(db: Db, ctx: TenantContext, conversationId: string, text: string) {
  requireRole(ctx, 'operator');
  const body = z.string().trim().min(1).max(4096).parse(text);
  return inTenant(db, ctx, async (tx) => {
    const conv = await tx.query<{ channel_id: string }>('SELECT channel_id FROM conversations WHERE id = $1', [conversationId]);
    if (!conv.rows[0]) throw new Error('conversation not found');
    await tx.query(
      `INSERT INTO messages (tenant_id, conversation_id, channel_id, direction, origin, body, status, author_user_id)
       VALUES ($1, $2, $3, 'note', 'human', $4, 'received', $5)`,
      [ctx.tenantId, conversationId, conv.rows[0].channel_id, body, ctx.user.id],
    );
  });
}

/** Pauses all automation for one conversation and cancels anything automated still queued. */
export async function takeOver(db: Db, ctx: TenantContext, conversationId: string): Promise<{ cancelled: number }> {
  requireRole(ctx, 'operator');
  return inTenant(db, ctx, async (tx) => {
    const before = await tx.query('SELECT human_takeover, status FROM conversations WHERE id = $1 FOR UPDATE', [conversationId]);
    if (!before.rows[0]) throw new Error('conversation not found');
    await tx.query("UPDATE conversations SET human_takeover = true, status = 'pending_human', assignee_user_id = $2 WHERE id = $1", [conversationId, ctx.user.id]);
    const cancelled = await cancelPendingAutomated(tx, conversationId);
    await audit(tx, ctx, 'conversation.takeover', 'conversation', conversationId, before.rows[0], { human_takeover: true });
    return { cancelled };
  });
}

/**
 * Explicitly hands the conversation back to automation. In lead mode this also
 * starts a new lead window, so the bot serves this number even without a keyword.
 */
export async function resumeBot(db: Db, ctx: TenantContext, conversationId: string): Promise<void> {
  requireRole(ctx, 'operator');
  await inTenant(db, ctx, async (tx) => {
    const before = await tx.query('SELECT human_takeover, status FROM conversations WHERE id = $1 FOR UPDATE', [conversationId]);
    if (!before.rows[0]) throw new Error('conversation not found');
    await tx.query("UPDATE conversations SET human_takeover = false, status = 'open', lead_started_at = now() WHERE id = $1", [conversationId]);
    await audit(tx, ctx, 'conversation.resume', 'conversation', conversationId, before.rows[0], { human_takeover: false });
  });
}

export async function setStatus(db: Db, ctx: TenantContext, conversationId: string, status: 'open' | 'pending_human' | 'resolved') {
  requireRole(ctx, 'operator');
  z.enum(['open', 'pending_human', 'resolved']).parse(status);
  await inTenant(db, ctx, async (tx) => {
    const r = await tx.query('UPDATE conversations SET status = $2 WHERE id = $1', [conversationId, status]);
    if (!r.rowCount) throw new Error('conversation not found');
  });
}
