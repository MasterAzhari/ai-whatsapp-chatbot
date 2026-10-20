import { z } from 'zod';
import type { Db } from '../db.js';
import { withSystem, withTenant } from '../db.js';
import type { NormalizedEvent } from '../channels/adapter.js';
import { ingestEvent, type IngestResult } from '../inbound.js';
import { enqueueJob } from '../jobs.js';

export const ROUTE_JOB = 'route_inbound';

/**
 * Stores a provider event and, for a new inbound message, queues its routing job in
 * the same transaction. Webhook handlers call this and return at once; the worker
 * decides the reply, so a slow AI call never holds up the provider's webhook.
 */
export async function receiveInbound(db: Db, tenantId: string, channelId: string, ev: NormalizedEvent): Promise<IngestResult> {
  return withTenant(db, tenantId, async (tx) => {
    const r = await ingestEvent(tx, tenantId, channelId, ev);
    if (r.kind === 'stored') await enqueueJob(tx, tenantId, ROUTE_JOB, r.messageId, { messageId: r.messageId });
    return r;
  });
}

const InboundEvent = z.union([
  z.object({
    type: z.literal('message'),
    providerMessageId: z.string().min(1).max(200),
    providerIdentity: z.string().min(1).max(200),
    phoneE164: z.string().regex(/^\+[1-9]\d{6,14}$/).optional(),
    profileName: z.string().max(200).optional(),
    text: z.string().max(65536).optional(),
    attachments: z
      .array(z.object({ kind: z.enum(['image', 'document', 'audio', 'video', 'other']), mimeType: z.string().max(200).optional(), url: z.string().max(2000).optional(), fileName: z.string().max(300).optional() }))
      .max(20)
      .optional(),
    timestamp: z.coerce.date(),
    fromMe: z.boolean().optional(),
    isGroup: z.boolean().optional(),
    isHistoryReplay: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('status'),
    providerMessageId: z.string().min(1).max(200),
    status: z.enum(['accepted', 'sent', 'delivered', 'read', 'failed']),
    detail: z.string().max(500).optional(),
    timestamp: z.coerce.date(),
  }),
]);
export const GatewayEventBatch = z.object({ channelId: z.string().uuid(), events: z.array(InboundEvent).min(1).max(100) });

/** Entry point for the gateway's internal webhook: validates, finds the channel's tenant, stores. */
export async function receiveGatewayEvents(db: Db, body: unknown): Promise<{ results: IngestResult[] } | { error: string; status: number }> {
  const parsed = GatewayEventBatch.safeParse(body);
  if (!parsed.success) return { error: 'invalid event batch', status: 400 };
  const { channelId, events } = parsed.data;
  const ch = await withSystem(db, (tx) => tx.query<{ tenant_id: string }>("SELECT tenant_id FROM channels WHERE id = $1 AND provider = 'qr'", [channelId]));
  if (!ch.rows[0]) return { error: 'unknown channel', status: 404 };
  const results: IngestResult[] = [];
  for (const ev of events) results.push(await receiveInbound(db, ch.rows[0].tenant_id, channelId, ev));
  return { results };
}
