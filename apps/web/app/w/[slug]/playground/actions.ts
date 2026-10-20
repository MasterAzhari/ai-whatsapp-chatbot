'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { createAiResolver, getDashboard, receiveInbound, simulate, splitBubbles } from '@chatbot/core';
import { actionError, db, requireTenant } from '@/lib/server';

export interface PlaygroundState {
  text?: string;
  route?: { route: string; reason: string; bubbles: string[]; imageAssetId: string | null };
  ai?: { ok: boolean; bubbles?: string[]; handover?: string; detail?: string; reason?: string; tokens?: string };
  error?: string;
}

export async function runPlayground(_prev: PlaygroundState, f: FormData): Promise<PlaygroundState> {
  const slug = String(f.get('slug'));
  const text = String(f.get('text') ?? '').slice(0, 4096);
  try {
    const ctx = await requireTenant(slug);
    const r = await simulate(db(), ctx, { text, channelId: String(f.get('channelId')), callAi: f.get('callAi') === 'on', isLead: f.get('isLead') === 'on' }, createAiResolver(db()));
    const reply = 'reply' in r.route ? r.route.reply : null;
    const imageAssetId = r.route.route === 'keyword' ? r.route.imageAssetId : null;
    // Shown as the customer would get it: picture with the first bubble, then the rest.
    const route = { route: r.route.route, reason: r.route.reason, bubbles: reply ? splitBubbles(reply) : [], imageAssetId };
    if (!r.ai) return { text, route };
    const ai = r.ai.ok
      ? {
          ok: true,
          bubbles: r.ai.text ? splitBubbles(r.ai.text) : [],
          handover: r.aiHandover,
          tokens: `${r.ai.usage.inputTokens ?? 'no data'} in / ${r.ai.usage.outputTokens ?? 'no data'} out · ${r.ai.latencyMs} ms · ${r.ai.model}`,
        }
      : { ok: false, reason: r.ai.reason, detail: r.ai.detail };
    return { text, route, ai };
  } catch (err) {
    return { text, error: actionError(err) };
  }
}

/** Sends a message as a pretend customer on a MOCK channel, through the real routing path. */
export async function sendAsMockCustomer(f: FormData) {
  const slug = String(f.get('slug'));
  const ctx = await requireTenant(slug);
  if (ctx.role === 'operator') throw new Error('admin only');
  const channelId = String(f.get('channelId'));
  const { channels } = await getDashboard(db(), ctx);
  const ch = channels.find((c) => c.id === channelId);
  if (!ch || ch.provider !== 'mock') throw new Error('only mock channels can receive test messages');
  const r = await receiveInbound(db(), ctx.tenantId, channelId, {
    type: 'message',
    providerMessageId: `playground-${randomUUID()}`,
    providerIdentity: `playground-${ctx.user.id}`,
    profileName: `Test (${ctx.user.name})`,
    text: String(f.get('text') ?? '').slice(0, 4096),
    timestamp: new Date(),
  });
  redirect(r.kind === 'stored' ? `/w/${slug}/inbox/${r.conversationId}` : `/w/${slug}/playground`);
}
