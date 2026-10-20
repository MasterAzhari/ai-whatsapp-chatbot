import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Db } from '../src/db.js';
import { withSystem, withTenant } from '../src/db.js';
import { getSessionUser, login, resolveTenantContext, type SessionUser as SessionUserT, type TenantContext } from '../src/auth.js';
import { addMembership, createChannel, createTenant, createUser } from '../src/repos/platform.js';
import { drainOnce, splitBubbles } from '../src/outbox.js';
import { getConversation, resumeBot, takeOver } from '../src/repos/conversations.js';
import { MockChannelAdapter } from '../src/channels/mock.js';
import { MockAIProvider, type AIProvider, type GenerateReplyInput, type GenerateReplyResult } from '../src/ai/provider.js';
import { GeminiProvider, toContents } from '../src/ai/gemini.js';
import { AnthropicProvider, thinkingFor, toMessages } from '../src/ai/anthropic.js';
import { matchPattern, normalize, pickRule, type KeywordRule } from '../src/routing/match.js';
import { decide, extractHandover, leadActive, routeInbound } from '../src/routing/router.js';
import { receiveGatewayEvents, receiveInbound } from '../src/routing/receive.js';
import { addQrChannel, connectQrChannel, qrChannelStatus } from '../src/repos/channels.js';
import { routeOnce } from '../src/worker.js';
import { simulate } from '../src/routing/playground.js';
import { createKeywordRule, getImageAsset, listKeywordRules, saveImageAsset, updateKeywordRule } from '../src/repos/keywords.js';
import { getBotSettings, setCredential, updateBotSettings, VersionConflictError, type BotSettings } from '../src/repos/settings.js';
import { getUsageSummary } from '../src/repos/usage.js';
import { createAiResolver } from '../src/routing/ai-resolver.js';
import { exportBotTemplate, importBotTemplate } from '../src/repos/template.js';
import { redactPersonal } from '../src/repos/conversations.js';
import { changeOwnName, changeOwnPassword, countDemoData, createAgentWorkspace, listAgentWorkspaces, purgeDemoData, renameWorkspace, resetAgentPassword, setAgentDisabled } from '../src/repos/agents.js';
import { followupOnce, DEFAULT_FOLLOWUPS } from '../src/followup.js';
import { notifyOnce } from '../src/notify.js';
import { SettingsUpdate } from '../src/repos/settings.js';
import { freshDb } from './helpers.js';

// ------------------------------------------------------------------ pure parts

const rule = (o: Partial<KeywordRule>): KeywordRule => ({
  id: randomUUID(), name: 'r', matchType: 'phrase', patterns: [], priority: 100, enabled: true,
  channelId: null, replyText: 'x', setLabel: null, handover: false, cooldownSeconds: 0, ...o,
});

describe('matcher', () => {
  test('normalises case, accents and punctuation', () => {
    assert.equal(normalize('  HARGA?!  Café '), 'harga cafe');
  });
  test('phrase matches whole words only', () => {
    assert.equal(matchPattern('nak book slot', 'phrase', ['ok']), null);
    assert.equal(matchPattern('ok, terima kasih', 'phrase', ['ok']), 'ok');
    assert.equal(matchPattern('berapa harga dia?', 'phrase', ['harga dia']), 'harga dia');
  });
  test('exact needs the whole message', () => {
    assert.equal(matchPattern('stop', 'exact', ['STOP']), 'STOP');
    assert.equal(matchPattern('jangan stop', 'exact', ['stop']), null);
  });
  test('pickRule: lowest priority wins, disabled/other-channel/cooldown skipped', () => {
    const a = rule({ name: 'a', patterns: ['harga'], priority: 50 });
    const b = rule({ name: 'b', patterns: ['harga'], priority: 10, enabled: false });
    const c = rule({ name: 'c', patterns: ['harga'], priority: 5, channelId: 'other' });
    const d = rule({ name: 'd', patterns: ['harga'], priority: 20, cooldownSeconds: 60 });
    const now = new Date();
    assert.equal(pickRule('harga?', [a, b, c, d], { channelId: 'ch', now })?.rule.name, 'd');
    const hit = pickRule('harga?', [a, b, c, d], { channelId: 'ch', now, lastHitAt: (id) => (id === d.id ? new Date(now.getTime() - 10_000) : undefined) });
    assert.equal(hit?.rule.name, 'a');
  });
});

const baseSettings: BotSettings = {
  version: 1, personaName: 'Bot', language: 'ms', systemInstruction: '', aiEnabled: true, aiProvider: 'gemini',
  aiModel: 'gemini-test', maxOutputTokens: 100, temperature: null, historyTurns: 5, aiTimeoutMs: 5000,
  fallbackReply: null, handoverReply: 'Staf akan balas', mediaReply: 'Sila taip', stopKeywords: ['stop'], humanKeywords: ['nak cakap dengan orang'],
  replyDelayMinSec: 0, replyDelayMaxSec: 0, typingIndicator: false, leadMode: false, leadDays: 30,
  followupEnabled: false, followupGapsMin: [60, 180, 600], followupStartHour: 8, followupEndHour: 23, followupInstruction: '', notifyNumbers: [],
};

describe('decide order', () => {
  const d = (o: Partial<Parameters<typeof decide>[0]>) =>
    decide({ text: 'harga', channelId: 'ch', automationEnabled: true, humanTakeover: false, optedOut: false, isLead: false, aiAllowed: true,
      settings: baseSettings, rules: [rule({ patterns: ['harga', 'stop', 'nak cakap dengan orang'] })], ...o });
  test('a keyword set to "AI answers" goes to the AI, or its own reply when AI is off', () => {
    const rules = [rule({ name: 'Borang', patterns: ['form pendaftaran'], replyText: 'Terima kasih', aiReply: true })];
    assert.equal(d({ text: 'FORM PENDAFTARAN nama Ali', rules }).route, 'ai');
    assert.equal(d({ text: 'FORM PENDAFTARAN nama Ali', rules, aiAllowed: false }).route, 'keyword');
  });
  test('switches and takeover first', () => {
    assert.equal(d({ automationEnabled: false }).route, 'none');
    assert.equal(d({ humanTakeover: true }).route, 'none');
    assert.equal(d({ optedOut: true }).route, 'none');
  });
  test('lead mode: silent until a lead keyword, then normal', () => {
    const leadMode = { ...baseSettings, leadMode: true };
    const rules = [rule({ name: 'Lead', patterns: ['nak info aircond'], startsLead: true }), rule({ name: 'Harga', patterns: ['harga'] })];
    assert.equal(d({ settings: leadMode, rules, text: 'hello' }).route, 'none');
    assert.equal(d({ settings: leadMode, rules, text: 'harga' }).route, 'none');
    assert.equal(d({ settings: leadMode, rules, text: 'STOP' }).route, 'none');
    const lead = d({ settings: leadMode, rules, text: 'Saya nak info Aircond' });
    assert.ok(lead.route === 'keyword' && lead.startsLead);
    assert.equal(d({ settings: leadMode, rules, isLead: true, text: 'harga' }).route, 'keyword');
    assert.equal(d({ settings: leadMode, rules, isLead: true, text: 'hello' }).route, 'ai');
  });
  test('voice, picture or video without text: ask to type, but only for leads; stickers ignored', () => {
    const leadMode = { ...baseSettings, leadMode: true };
    const voice = d({ text: '', attachments: ['audio'] });
    assert.ok(voice.route === 'media' && voice.reply === 'Sila taip');
    assert.equal(d({ text: '', attachments: ['other'] }).route, 'none');
    assert.equal(d({ text: '', attachments: ['image'], settings: leadMode }).route, 'none');
    assert.equal(d({ text: '', attachments: ['image'], settings: leadMode, isLead: true }).route, 'media');
    assert.equal(d({ text: 'harga', attachments: ['image'] }).route, 'keyword'); // a caption is read as text
    assert.equal(d({ text: '', attachments: ['video'], humanTakeover: true }).route, 'none');
  });
  test('lead window', () => {
    const now = new Date('2026-10-20T00:00:00Z');
    const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
    assert.equal(leadActive(null, 30, now), false);
    assert.equal(leadActive(daysAgo(29), 30, now), true);
    assert.equal(leadActive(daysAgo(31), 30, now), false);
    assert.equal(leadActive(daysAgo(400), 0, now), true);
  });
  test('stop, then human, then keyword, then AI', () => {
    assert.equal(d({ text: 'STOP' }).route, 'stop');
    assert.equal(d({ text: 'saya nak cakap dengan orang' }).route, 'human');
    assert.equal(d({ text: 'harga' }).route, 'keyword');
    assert.equal(d({ text: 'hello' }).route, 'ai');
    assert.equal(d({ text: 'hello', aiAllowed: false }).route, 'none');
  });
});

describe('claude adapter', () => {
  const input: GenerateReplyInput = {
    model: 'claude-haiku-5-5', systemInstruction: 'sys', history: [{ role: 'assistant', text: 'old' }, { role: 'customer', text: 'a' }, { role: 'customer', text: 'b' }],
    knowledge: ['Acson 1.0HP'], maxOutputTokens: 50, temperature: 0.7, timeoutMs: 1000,
  };
  const reply = (status: number, json: unknown, cap?: { url?: string; init?: RequestInit }) =>
    (async (url: string, init: RequestInit) => {
      if (cap) { cap.url = String(url); cap.init = init; }
      return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
  const ok = {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'Hai Cik!' }], usage: { input_tokens: 20, output_tokens: 4 },
  };
  test('sends key in header, merges turns, no sampling params, reads usage', async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const r = await new AnthropicProvider('sk-ant-test-123', reply(200, ok, cap), 'https://x.test').generateReply(input);
    assert.deepEqual(r, { ok: true, text: 'Hai Cik!', usage: { inputTokens: 20, outputTokens: 4 }, model: 'claude-haiku-5-5', latencyMs: (r as any).latencyMs });
    assert.equal(cap.url, 'https://x.test/v1/messages');
    assert.ok(!cap.url!.includes('sk-ant'));
    assert.equal(new Headers(cap.init!.headers as HeadersInit).get('x-api-key'), 'sk-ant-test-123');
    const body = JSON.parse(String(cap.init!.body));
    assert.deepEqual(body.messages, [{ role: 'user', content: 'a\nb' }]);
    assert.equal(body.temperature, undefined);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.match(body.system, /Acson 1\.0HP/);
  });
  test('maps rate limit, missing model and empty answers', async () => {
    const c = (f: typeof fetch) => new AnthropicProvider('k-123456789', f, 'https://x.test').generateReply(input);
    const err = (type: string) => ({ type: 'error', error: { type, message: type } });
    assert.equal(((await c(reply(429, err('rate_limit_error')))) as any).reason, 'quota');
    assert.equal(((await c(reply(404, err('not_found_error')))) as any).reason, 'invalid_model');
    assert.equal(((await c(reply(200, { ...ok, content: [], stop_reason: 'refusal' }))) as any).reason, 'blocked');
  });
  test('thinking is turned down the way each Claude model accepts', () => {
    assert.deepEqual(thinkingFor('claude-haiku-5-5'), { thinking: { type: 'disabled' } });
    assert.deepEqual(thinkingFor('claude-sonnet-5-5'), { thinking: { type: 'between_tools' }, output_config: { effort: 'low' } });
    assert.deepEqual(thinkingFor('claude-opus-5-5'), { output_config: { effort: 'low' } });
    assert.deepEqual(thinkingFor('claude-fable-5-1'), {});
  });
  test('toMessages opens with the customer', () => {
    assert.equal(toMessages([{ role: 'assistant', text: 'x' }]).length, 0);
  });
  test('toMessages sends a picture as an image block, never audio', () => {
    const [img] = toMessages([{ role: 'customer', text: 'Gambar', media: { mimeType: 'image/jpeg', data: 'AAAA' } }]);
    assert.deepEqual(img!.content, [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }, { type: 'text', text: 'Gambar' }]);
    assert.equal(toMessages([{ role: 'customer', text: 'Voice', media: { mimeType: 'audio/ogg', data: 'AAAA' } }])[0]!.content, 'Voice');
  });
});

describe('gemini adapter', () => {
  const okFetch = (capture: { url?: string; init?: RequestInit }) =>
    (async (url: string, init: RequestInit) => {
      capture.url = url;
      capture.init = init;
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Hai!' }] } }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 },
        modelVersion: 'gemini-test-001',
      }), { status: 200 });
    }) as unknown as typeof fetch;
  const input: GenerateReplyInput = {
    model: 'gemini-test', systemInstruction: 'sys', history: [{ role: 'assistant', text: 'old' }, { role: 'customer', text: 'a' }, { role: 'customer', text: 'b' }],
    knowledge: [], maxOutputTokens: 50, timeoutMs: 1000,
  };
  test('sends key in header only and reads usage', async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const r = await new GeminiProvider('secret-key-123', okFetch(cap), 'https://x.test').generateReply(input);
    assert.deepEqual(r, { ok: true, text: 'Hai!', usage: { inputTokens: 12, outputTokens: 3 }, model: 'gemini-test-001', latencyMs: (r as any).latencyMs });
    assert.equal(cap.url, 'https://x.test/models/gemini-test:generateContent');
    assert.ok(!cap.url!.includes('secret'));
    assert.equal((cap.init!.headers as Record<string, string>)['x-goog-api-key'], 'secret-key-123');
    const body = JSON.parse(String(cap.init!.body));
    assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'a\nb' }] }]);
  });
  test('maps quota, missing model and empty answers', async () => {
    const resp = (status: number, json: unknown) => (async () => new Response(JSON.stringify(json), { status })) as unknown as typeof fetch;
    const g = (f: typeof fetch) => new GeminiProvider('k-123456789', f, 'https://x.test').generateReply(input);
    assert.equal(((await g(resp(429, { error: { message: 'quota' } }))) as any).reason, 'quota');
    assert.equal(((await g(resp(404, {}))) as any).reason, 'invalid_model');
    assert.equal(((await g(resp(200, { promptFeedback: { blockReason: 'SAFETY' } }))) as any).reason, 'blocked');
  });
  test('asks Gemini 3 models for minimal thinking, and retries without it if refused', async () => {
    const bodies: any[] = [];
    const f = (refuse: boolean) => (async (_url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      bodies.push(b);
      if (refuse && b.generationConfig.thinkingConfig) return new Response(JSON.stringify({ error: { message: 'Thinking level is not supported for this model.' } }), { status: 400 });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hai!' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: 7 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await new GeminiProvider('k-123456789', f(false), 'https://x.test').generateReply({ ...input, model: 'gemini-3.5-flash-lite' });
    assert.deepEqual(bodies[0].generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
    assert.deepEqual((r as any).usage, { inputTokens: 10, outputTokens: 10 });
    bodies.length = 0;
    const r2 = await new GeminiProvider('k-123456789', f(true), 'https://x.test').generateReply({ ...input, model: 'gemini-3.5-flash-lite' });
    assert.equal(r2.ok, true);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1].generationConfig.thinkingConfig, undefined);
    bodies.length = 0;
    await new GeminiProvider('k-123456789', f(false), 'https://x.test').generateReply({ ...input, model: 'gemini-2.5-flash-lite' });
    assert.equal(bodies[0].generationConfig.thinkingConfig, undefined);
  });
  test('rejects odd model ids without calling out', async () => {
    let called = false;
    const f = (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch;
    const r = await new GeminiProvider('k-123456789', f).generateReply({ ...input, model: '../evil' });
    assert.equal(r.ok, false);
    assert.equal(called, false);
  });
  test('toContents opens with the customer', () => {
    assert.equal(toContents([{ role: 'assistant', text: 'x' }]).length, 0);
  });
  test('toContents sends voice notes and pictures inline', () => {
    const c = toContents([{ role: 'customer', text: 'hai' }, { role: 'customer', text: 'Voice', media: { mimeType: 'audio/ogg; codecs=opus', data: 'AAAA' } }]);
    assert.deepEqual(c, [{ role: 'user', parts: [{ text: 'hai' }, { inlineData: { mimeType: 'audio/ogg; codecs=opus', data: 'AAAA' } }, { text: 'Voice' }] }]);
  });
});

// ------------------------------------------------------------------ database

let db: Db;
let drop: () => Promise<void>;
let tA: string, tB: string, chA: string;
let ctxA: TenantContext, ctxB: TenantContext;
const adapter = new MockChannelAdapter();
const resolveAdapter = async () => adapter;

class ScriptedAI implements AIProvider {
  readonly name = 'scripted';
  calls = 0;
  lastInput?: GenerateReplyInput;
  onCall: () => Promise<void> = async () => {};
  constructor(public result: GenerateReplyResult) {}
  async generateReply(input: GenerateReplyInput): Promise<GenerateReplyResult> {
    this.calls++;
    this.lastInput = input;
    await this.onCall();
    return this.result;
  }
}

async function inbound(text: string, from = `cust-${randomUUID()}`, attachments?: Array<{ kind: 'image' | 'audio' | 'video' | 'document' | 'other'; mimeType?: string; data?: string }>) {
  const r = await receiveInbound(db, tA, chA, { type: 'message', providerMessageId: randomUUID(), providerIdentity: from, text: text || undefined, attachments, timestamp: new Date() });
  assert.equal(r.kind, 'stored');
  return r as { kind: 'stored'; messageId: string; conversationId: string };
}

async function outbound(conversationId: string) {
  const c = await getConversation(db, ctxA, conversationId);
  return c!.messages.filter((m) => m.direction === 'outbound');
}

async function settings(patch: Record<string, unknown>) {
  const s = await getBotSettings(db, ctxA);
  await updateBotSettings(db, ctxA, { expectedVersion: s.version, ...patch });
}

before(async () => {
  process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64'); // test-only key
  ({ db, drop } = await freshDb());
  tA = await createTenant(db, { slug: 'ra', name: 'A' });
  tB = await createTenant(db, { slug: 'rb', name: 'B' });
  chA = await createChannel(db, tA, { name: 'A', provider: 'mock', status: 'connected', automationEnabled: true, aiEnabled: true });
  const a = await createUser(db, { email: 'ra@example.test', name: 'A', password: 'password-a-123' });
  const b = await createUser(db, { email: 'rb@example.test', name: 'B', password: 'password-b-123' });
  await addMembership(db, tA, a, 'admin');
  await addMembership(db, tB, b, 'admin');
  const sess = async (email: string, pw: string, slug: string) =>
    resolveTenantContext(db, (await getSessionUser(db, (await login(db, email, pw))!))!, slug);
  ctxA = await sess('ra@example.test', 'password-a-123', 'ra');
  ctxB = await sess('rb@example.test', 'password-b-123', 'rb');
  await settings({ aiEnabled: true, aiModel: 'gemini-test', handoverReply: 'Staf kami akan balas.', fallbackReply: null, replyDelayMinSec: 0, replyDelayMaxSec: 0 });
  await createKeywordRule(db, ctxA, { name: 'Harga', matchType: 'phrase', patterns: ['harga'], replyText: 'Harga bermula RM10.', cooldownSeconds: 3600 });
  await createKeywordRule(db, ctxA, { name: 'Komplen', matchType: 'phrase', patterns: ['komplen'], replyText: 'Kami serahkan kepada staf.', handover: true, setLabel: 'aduan' });
});

after(async () => drop());

describe('routing', () => {
  let ai: ScriptedAI;
  const deps = { aiFor: async () => ai as AIProvider };
  beforeEach(() => {
    ai = new ScriptedAI({ ok: true, text: 'Jawapan AI', usage: { inputTokens: 10, outputTokens: 4 }, model: 'gemini-test', latencyMs: 5 });
  });

  test('lead mode: only chats that came in with a lead keyword get bot or AI replies', async () => {
    const lead = await createKeywordRule(db, ctxA, { name: 'Lead aircond', matchType: 'phrase', patterns: ['saya nak info aircond'], replyText: 'Hai Cik, saya Fairuz.', startsLead: true });
    await settings({ leadMode: true });
    try {
      const from = `lead-${randomUUID()}`;
      assert.equal(await routeInbound(db, tA, (await inbound('hello', from)).messageId, deps), 'none');
      assert.equal(await routeInbound(db, tA, (await inbound('harga?', `team-${randomUUID()}`)).messageId, deps), 'none');
      assert.equal(ai.calls, 0);
      assert.equal(await routeInbound(db, tA, (await inbound('Saya nak info Aircond', from)).messageId, deps), 'keyword');
      assert.equal(await routeInbound(db, tA, (await inbound('boleh hantar ke Kedah?', from)).messageId, deps), 'ai_reply');
      assert.equal(ai.calls, 1);
      // 30 days later the bot stands down; a new lead keyword starts a new window
      const conv = (await inbound('masih ada promo?', from)).conversationId;
      await withTenant(db, tA, (tx) => tx.query("UPDATE conversations SET lead_started_at = now() - interval '31 days' WHERE id = $1", [conv]));
      assert.equal(await routeInbound(db, tA, (await inbound('masih ada promo?', from)).messageId, deps), 'none');
      assert.equal(await routeInbound(db, tA, (await inbound('Saya nak info aircond', from)).messageId, deps), 'keyword');
      assert.equal(await routeInbound(db, tA, (await inbound('ok terima kasih', from)).messageId, deps), 'ai_reply');
      // turning the bot on by hand for a number that never sent a lead keyword
      const team = `team-${randomUUID()}`;
      const t1 = await inbound('bos, esok meeting?', team);
      assert.equal(await routeInbound(db, tA, t1.messageId, deps), 'none');
      assert.equal((await getConversation(db, ctxA, t1.conversationId))!.conversation.botState, 'not_lead');
      await resumeBot(db, ctxA, t1.conversationId);
      assert.equal((await getConversation(db, ctxA, t1.conversationId))!.conversation.botState, 'on');
      assert.equal(await routeInbound(db, tA, (await inbound('ok', team)).messageId, deps), 'ai_reply');
      await takeOver(db, ctxA, t1.conversationId);
      assert.equal((await getConversation(db, ctxA, t1.conversationId))!.conversation.botState, 'off');
    } finally {
      while ((await routeOnce(db, deps)) > 0); // clear the routing jobs these messages queued
      await settings({ leadMode: false });
      await updateKeywordRule(db, ctxA, lead.id, lead.version, { name: 'Lead aircond', matchType: 'phrase', patterns: ['saya nak info aircond'], replyText: 'x', enabled: false });
    }
  });

  test('voice note: one polite reply per 30 minutes, chat flagged for staff, bot stays on', async () => {
    const from = `voice-${randomUUID()}`;
    const v1 = await inbound('', from, [{ kind: 'audio' }]);
    assert.equal(await routeInbound(db, tA, v1.messageId, deps), 'media');
    assert.equal(await routeInbound(db, tA, (await inbound('', from, [{ kind: 'image' }])).messageId, deps), 'media');
    const c = await getConversation(db, ctxA, v1.conversationId);
    assert.equal(c!.conversation.status, 'pending_human');
    assert.equal(c!.conversation.botState, 'on');
    assert.deepEqual(c!.messages[0]!.attachments, ['Voice note']);
    assert.equal((await outbound(v1.conversationId)).filter((o) => o.origin === 'system').length, 1);
    assert.equal(ai.calls, 0);
    assert.equal(await routeInbound(db, tA, (await inbound('harga', from)).messageId, deps), 'keyword');
    while ((await routeOnce(db, deps)) > 0); // clear the routing jobs these messages queued
  });

  test('IC picture: bot copies nothing from it, hands the chat to staff', async () => {
    const pic = [{ kind: 'image' as const, mimeType: 'image/jpeg', data: Buffer.from('fake-jpeg').toString('base64') }];
    const v = await inbound('', `ic-${randomUUID()}`, pic);
    ai.result = { ok: true, text: '[dokumen pengenalan]', usage: { inputTokens: 50, outputTokens: 4 }, model: 'gemini-test', latencyMs: 5 };
    assert.equal(await routeInbound(db, tA, v.messageId, deps), 'human');
    const c = await getConversation(db, ctxA, v.conversationId);
    assert.match(c!.messages[0]!.body ?? '', /Gambar IC diterima/);
    assert.equal(c!.conversation.status, 'pending_human');
    assert.equal((await outbound(v.conversationId)).filter((o) => o.origin === 'system').length, 1);
    const left = await withTenant(db, tA, (tx) => tx.query('SELECT 1 FROM message_media WHERE message_id = $1', [v.messageId]));
    assert.equal(left.rowCount, 0);
    ai.result = { ok: true, text: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, model: 'gemini-test', latencyMs: 1 };
    while ((await routeOnce(db, deps)) > 0);
  });

  test('voice note is turned into text, then answered like a typed message; bytes are not kept', async () => {
    const bytes = Buffer.from('fake-opus '.repeat(40)); // longer than one 76-char base64 line
    const voice = [{ kind: 'audio' as const, mimeType: 'audio/ogg; codecs=opus', data: bytes.toString('base64') }];
    const v = await inbound('', `voice-${randomUUID()}`, voice);
    ai.result = { ok: true, text: 'Berapa harga aircond 1.5HP?', usage: { inputTokens: 50, outputTokens: 8 }, model: 'gemini-test', latencyMs: 5 };
    assert.equal(await routeInbound(db, tA, v.messageId, deps), 'keyword'); // "harga" rule answers the transcript
    assert.equal(ai.calls, 1);
    assert.equal(ai.lastInput!.history[0]!.media!.mimeType, 'audio/ogg'); // codec suffix dropped for the AI API
    assert.equal(ai.lastInput!.history[0]!.media!.data, bytes.toString('base64')); // exact bytes, no line breaks
    const c = await getConversation(db, ctxA, v.conversationId);
    assert.equal(c!.messages[0]!.body, '🎤 Berapa harga aircond 1.5HP?');
    assert.equal(c!.conversation.status, 'open');
    const left = await withTenant(db, tA, (tx) => tx.query('SELECT 1 FROM message_media WHERE message_id = $1', [v.messageId]));
    assert.equal(left.rowCount, 0);
    // no clear speech, or Claude (cannot hear audio): ask to type instead
    ai.result = { ok: true, text: '[tiada suara jelas]', usage: { inputTokens: 1, outputTokens: 1 }, model: 'gemini-test', latencyMs: 1 };
    assert.equal(await routeInbound(db, tA, (await inbound('', `voice-${randomUUID()}`, voice)).messageId, deps), 'media');
    await settings({ aiProvider: 'anthropic' });
    try {
      const calls = ai.calls;
      assert.equal(await routeInbound(db, tA, (await inbound('', `voice-${randomUUID()}`, voice)).messageId, deps), 'media');
      assert.equal(ai.calls, calls);
    } finally {
      await settings({ aiProvider: 'gemini' });
      while ((await routeOnce(db, deps)) > 0);
    }
  });

  test('keyword reply is queued once even if routed twice, and sent', async () => {
    const m = await inbound('Berapa harga?');
    assert.equal(await routeOnce(db, deps), 1);
    assert.equal(await routeInbound(db, tA, m.messageId, deps), 'skipped');
    await drainOnce(db, resolveAdapter);
    const out = await outbound(m.conversationId);
    assert.deepEqual(out.map((o) => [o.origin, o.body, o.status]), [['keyword', 'Harga bermula RM10.', 'sent']]);
    assert.equal(ai.calls, 0);
  });

  test('keyword cooldown falls through to AI', async () => {
    const from = `cust-${randomUUID()}`;
    await inbound('harga', from);
    await routeOnce(db, deps);
    const m2 = await inbound('harga lagi', from);
    await routeOnce(db, deps);
    const out = await outbound(m2.conversationId);
    assert.deepEqual(out.map((o) => o.origin), ['keyword', 'ai']);
  });

  test('handover rule: notice still sent, label applied, AI not called', async () => {
    const m = await inbound('nak komplen');
    await routeOnce(db, deps);
    await drainOnce(db, resolveAdapter);
    const c = await getConversation(db, ctxA, m.conversationId);
    assert.equal(c!.conversation.humanTakeover, true);
    assert.deepEqual(c!.messages.filter((x) => x.direction === 'outbound').map((x) => [x.origin, x.status]), [['system', 'sent']]);
    const labels = await withTenant(db, tA, (tx) => tx.query('SELECT l.name FROM contact_label_assignments a JOIN contact_labels l ON l.id = a.label_id'));
    assert.ok(labels.rows.some((r) => r.name === 'aduan'));
    // Later messages are not answered by the bot.
    const from = (await withTenant(db, tA, (tx) => tx.query('SELECT provider_identity FROM provider_identity_mappings p JOIN conversations c ON c.contact_id = p.contact_id WHERE c.id = $1', [m.conversationId]))).rows[0].provider_identity;
    await inbound('hello?', from);
    await routeOnce(db, deps);
    assert.equal(ai.calls, 0);
  });

  test('stop opts out; human keyword hands over with notice', async () => {
    const s = await inbound('STOP');
    await routeOnce(db, deps);
    const opted = await withTenant(db, tA, (tx) => tx.query('SELECT ct.opted_out_at FROM contacts ct JOIN conversations c ON c.contact_id = ct.id WHERE c.id = $1', [s.conversationId]));
    assert.ok(opted.rows[0].opted_out_at);
    assert.equal((await outbound(s.conversationId)).length, 0);

    const h = await inbound('saya nak cakap dengan orang');
    await routeOnce(db, deps);
    const out = await outbound(h.conversationId);
    assert.deepEqual(out.map((o) => [o.origin, o.body]), [['system', 'Staf kami akan balas.']]);
  });

  test('AI reply records usage and route reason', async () => {
    const m = await inbound('apa khabar');
    await routeOnce(db, deps);
    const c = await getConversation(db, ctxA, m.conversationId);
    assert.equal(c!.messages[0]!.route?.route, 'ai');
    assert.deepEqual(c!.messages.filter((x) => x.direction === 'outbound').map((x) => x.body), ['Jawapan AI']);
    const usage = await getUsageSummary(db, ctxA);
    const live = usage.find((u) => u.source === 'live')!;
    assert.ok(live.inputTokens >= 10);
    assert.equal(live.estimatedCost, null); // no rate on file
  });

  test('AI receives the message being answered, after earlier turns', async () => {
    const from = `cust-${randomUUID()}`;
    const first = await inbound('hai', from);
    await routeInbound(db, tA, first.messageId, deps);
    assert.deepEqual(ai.lastInput?.history, [{ role: 'customer', text: 'hai' }]);
    const second = await inbound('ada stok?', from);
    await routeInbound(db, tA, second.messageId, deps);
    assert.deepEqual(ai.lastInput?.history.map((t) => t.text), ['hai', 'Jawapan AI', 'ada stok?']);
  });

  test('AI answer discarded if a human takes over while it generates', async () => {
    const m = await inbound('soalan panjang');
    ai.onCall = async () => {
      await takeOver(db, ctxA, m.conversationId);
    };
    assert.equal(await routeInbound(db, tA, m.messageId, deps), 'ai_discarded');
    assert.equal((await outbound(m.conversationId)).length, 0);
  });

  test('AI failure: hand over when no fallback, fallback reply when set', async () => {
    ai.result = { ok: false, reason: 'quota', detail: 'quota exceeded' };
    const m = await inbound('soalan satu');
    assert.equal(await routeInbound(db, tA, m.messageId, deps), 'ai_handover');
    assert.equal((await getConversation(db, ctxA, m.conversationId))!.conversation.humanTakeover, true);

    await settings({ fallbackReply: 'Maaf, sila tunggu sebentar.' });
    const m2 = await inbound('soalan dua');
    assert.equal(await routeInbound(db, tA, m2.messageId, deps), 'ai_fallback');
    assert.deepEqual((await outbound(m2.conversationId)).map((o) => [o.origin, o.body]), [['system', 'Maaf, sila tunggu sebentar.']]);
    await settings({ fallbackReply: null });
  });

  test('older message is not answered by AI when a newer one is waiting', async () => {
    const from = `cust-${randomUUID()}`;
    const m1 = await inbound('soalan a', from);
    const m2 = await inbound('soalan b', from);
    assert.equal(await routeInbound(db, tA, m1.messageId, deps), 'none');
    assert.equal(await routeInbound(db, tA, m2.messageId, deps), 'ai_reply');
    assert.equal(ai.calls, 1);
  });

  test('reply pacing: automated reply waits, typing time is passed to the adapter', async () => {
    await settings({ replyDelayMinSec: 5, replyDelayMaxSec: 5, typingIndicator: true });
    const m = await inbound('Berapa harga?');
    assert.equal(await routeInbound(db, tA, m.messageId, deps), 'keyword');
    const due = await withTenant(db, tA, (tx) =>
      tx.query(`SELECT extract(epoch FROM o.next_attempt_at - now()) AS wait FROM outbox o JOIN messages x ON x.id = o.message_id WHERE x.conversation_id = $1`, [m.conversationId]));
    assert.ok(due.rows[0].wait > 3 && due.rows[0].wait <= 5, `waits ~5s, got ${due.rows[0].wait}`);
    await withTenant(db, tA, (tx) => tx.query(`UPDATE outbox SET next_attempt_at = now() WHERE conversation_id = $1`, [m.conversationId]));
    const seen: Array<number | undefined> = [];
    await drainOnce(db, async () => ({ ...adapter, sendText: async (i: any) => { seen.push(i.typingMs); return adapter.sendText(i); } }) as any);
    assert.ok(seen[0]! >= 1000);
    await settings({ replyDelayMinSec: 0, replyDelayMaxSec: 0, typingIndicator: false });
    await assert.rejects(settings({ replyDelayMinSec: 9, replyDelayMaxSec: 2 }));
  });

  test('channel AI switch off means no AI', async () => {
    await withTenant(db, tA, (tx) => tx.query('UPDATE channels SET ai_enabled = false WHERE id = $1', [chA]));
    const m = await inbound('hello');
    assert.equal(await routeInbound(db, tA, m.messageId, deps), 'none');
    await withTenant(db, tA, (tx) => tx.query('UPDATE channels SET ai_enabled = true WHERE id = $1', [chA]));
  });
});

describe('settings, rules and isolation', () => {
  test('stale settings version is rejected', async () => {
    const s = await getBotSettings(db, ctxA);
    await updateBotSettings(db, ctxA, { expectedVersion: s.version, personaName: 'Aina' });
    await assert.rejects(updateBotSettings(db, ctxA, { expectedVersion: s.version, personaName: 'X' }), VersionConflictError);
  });

  test('stale rule version is rejected', async () => {
    const [r] = (await listKeywordRules(db, ctxA)).filter((x) => x.name === 'Harga');
    const input = { name: 'Harga', matchType: 'phrase' as const, patterns: ['harga', 'price'], replyText: 'RM10' };
    await updateKeywordRule(db, ctxA, r!.id, r!.version, input);
    await assert.rejects(updateKeywordRule(db, ctxA, r!.id, r!.version, input), VersionConflictError);
  });

  test('rule needs a reply, label or handover', async () => {
    await assert.rejects(createKeywordRule(db, ctxA, { name: 'x', matchType: 'exact', patterns: ['x'] }));
  });

  test('API key is stored encrypted and only shown masked', async () => {
    await setCredential(db, ctxA, 'gemini_api_key', 'AIzaFAKEKEY-for-tests-0001');
    const s = await getBotSettings(db, ctxA);
    assert.ok(s.aiKeyMasked && !s.aiKeyMasked.includes('FAKEKEY-for-tests'));
    const raw = await withTenant(db, tA, (tx) => tx.query('SELECT ciphertext FROM credential_references'));
    assert.ok(!String(raw.rows[0].ciphertext).includes('AIza'));
    const audit = await withTenant(db, tA, (tx) => tx.query("SELECT after FROM audit_events WHERE action = 'credential.set'"));
    assert.ok(!JSON.stringify(audit.rows).includes('AIza'));
    assert.ok((await createAiResolver(db)(tA)) instanceof GeminiProvider);
    assert.equal(await createAiResolver(db)(tB), null);
  });

  test('selected provider decides which key and adapter are used', async () => {
    await setCredential(db, ctxA, 'anthropic_api_key', 'sk-ant-FAKE-for-tests-0001');
    const s = await getBotSettings(db, ctxA);
    assert.ok(s.keysMasked.anthropic && !s.keysMasked.anthropic.includes('FAKE-for-tests'));
    assert.ok((await createAiResolver(db)(tA)) instanceof GeminiProvider);
    const after = await updateBotSettings(db, ctxA, { expectedVersion: s.version, aiProvider: 'anthropic', aiModel: 'claude-haiku-5-5' });
    assert.equal(after.aiProvider, 'anthropic');
    assert.ok((await createAiResolver(db)(tA)) instanceof AnthropicProvider);
    await setCredential(db, ctxA, 'anthropic_api_key', null);
    assert.equal(await createAiResolver(db)(tA), null);
    await assert.rejects(updateBotSettings(db, ctxA, { expectedVersion: after.version, aiProvider: 'openai' as any }));
  });

  test('tenant B sees none of tenant A rules, settings, hits or usage', async () => {
    assert.equal((await listKeywordRules(db, ctxB)).length, 0);
    assert.equal((await getBotSettings(db, ctxB)).personaName, 'Assistant');
    assert.equal((await getUsageSummary(db, ctxB)).length, 0);
    const n = await withTenant(db, tB, async (tx) => ({
      hits: (await tx.query('SELECT count(*)::int AS n FROM keyword_rule_hits')).rows[0].n,
      usage: (await tx.query('SELECT count(*)::int AS n FROM ai_usage_events')).rows[0].n,
      creds: (await tx.query('SELECT count(*)::int AS n FROM credential_references')).rows[0].n,
    }));
    assert.deepEqual(n, { hits: 0, usage: 0, creds: 0 });
  });

  test('pricing rates: readable by tenants, writable only by system code', async () => {
    await withSystem(db, (tx) =>
      tx.query(`INSERT INTO pricing_rates (provider, model, input_per_million, output_per_million, effective_from) VALUES ('scripted', 'gemini-test', 1, 2, '2026-01-01')`),
    );
    await assert.rejects(
      withTenant(db, tA, (tx) => tx.query(`INSERT INTO pricing_rates (provider, model, input_per_million, output_per_million, effective_from) VALUES ('x', 'y', 1, 1, '2026-01-01')`)),
    );
    const live = (await getUsageSummary(db, ctxA)).find((u) => u.source === 'live' && u.provider === 'scripted')!;
    assert.equal(live.estimatedCost?.currency, 'USD');
    assert.ok(live.estimatedCost!.amount > 0);
  });

  test('playground does not store messages; AI call is recorded as playground usage', async () => {
    const before = await withTenant(db, tA, (tx) => tx.query('SELECT count(*)::int AS n FROM messages'));
    const ai = new MockAIProvider(() => 'jawapan uji');
    const r = await simulate(db, ctxA, { text: 'apa khabar', channelId: chA, callAi: true }, async () => ai);
    assert.equal(r.route.route, 'ai');
    assert.equal(r.ai?.ok, true);
    const k = await simulate(db, ctxA, { text: 'harga', channelId: chA, callAi: true }, async () => ai);
    assert.equal(k.route.route, 'keyword');
    assert.equal(ai.calls, 1);
    const afterN = await withTenant(db, tA, (tx) => tx.query('SELECT count(*)::int AS n FROM messages'));
    assert.equal(afterN.rows[0].n, before.rows[0].n);
    assert.ok((await getUsageSummary(db, ctxA)).some((u) => u.source === 'playground'));
  });
});

describe('QR channels', () => {
  const fake = (state: 'pairing' | 'connected') => () => ({
    getStatus: async () => (state === 'connected' ? { state, displayNumber: '+60100000000' } : { state, qr: 'QR-DATA' }),
    connect: async () => ({ state: 'pairing' as const, qr: 'QR-DATA' }),
    disconnect: async () => {},
  });

  test('admin adds a channel (switches off), connects, status is recorded; other tenant cannot touch it', async () => {
    const id = await addQrChannel(db, ctxA, 'WhatsApp ujian');
    const ch = await withTenant(db, tA, (tx) => tx.query('SELECT provider, automation_enabled, ai_enabled FROM channels WHERE id = $1', [id]));
    assert.deepEqual(ch.rows[0], { provider: 'qr', automation_enabled: false, ai_enabled: false });
    assert.equal((await connectQrChannel(db, ctxA, id, fake('pairing'))).qr, 'QR-DATA');
    await qrChannelStatus(db, ctxA, id, fake('connected'));
    const after = await withTenant(db, tA, (tx) => tx.query('SELECT status, display_number FROM channels WHERE id = $1', [id]));
    assert.deepEqual(after.rows[0], { status: 'connected', display_number: '+60100000000' });
    await assert.rejects(qrChannelStatus(db, ctxB, id, fake('connected')), /not found/);
    await assert.rejects(connectQrChannel(db, ctxA, chA, fake('pairing')), /not found/); // mock channel is not QR
  });

  test('gateway events land in the right tenant and only for QR channels', async () => {
    const id = await addQrChannel(db, ctxA, 'QR 2');
    const ev = { type: 'message', providerMessageId: randomUUID(), providerIdentity: '60123@s.whatsapp.net', text: 'hai', timestamp: new Date().toISOString() };
    const r = await receiveGatewayEvents(db, { channelId: id, events: [ev] });
    assert.ok('results' in r && r.results[0]!.kind === 'stored');
    assert.deepEqual(await receiveGatewayEvents(db, { channelId: chA, events: [ev] }), { error: 'unknown channel', status: 404 });
    assert.equal(((await receiveGatewayEvents(db, { channelId: id, events: [{ type: 'message' }] })) as any).status, 400);
  });
});

describe('bot template (copy setup to an agent workspace)', () => {
  let ctxC: TenantContext;
  before(async () => {
    const tC = await createTenant(db, { slug: 'rc', name: 'Agent C' });
    const c = await createUser(db, { email: 'rc@example.test', name: 'C', password: 'password-c-123' });
    await addMembership(db, tC, c, 'admin');
    ctxC = (await resolveTenantContext(db, (await getSessionUser(db, (await login(db, 'rc@example.test', 'password-c-123'))!))!, 'rc'))!;
    await createKeywordRule(db, ctxC, { name: 'Lama', matchType: 'exact', patterns: ['lama'], replyText: 'old' });
  });

  test('export carries settings and rules but never keys or channel ids', async () => {
    await setCredential(db, ctxA, 'gemini_api_key', 'AIzaFAKEKEY-template-0002');
    await createKeywordRule(db, ctxA, { name: 'Kawasan', matchType: 'phrase', patterns: ['kawasan'], replyText: 'Kami pasang di Lembah Klang.', channelId: chA });
    const t = await exportBotTemplate(db, ctxA, 'A');
    const json = JSON.stringify(t);
    assert.ok(!json.includes('AIza') && !json.includes(chA));
    assert.ok(t.keywordRules.some((r) => r.name === 'Kawasan'));
    assert.equal(t.settings.aiModel, (await getBotSettings(db, ctxA)).aiModel);
  });

  test('import copies the setup; add mode keeps old rules and updates same-named ones, replace mode drops them', async () => {
    const t = JSON.parse(JSON.stringify(await exportBotTemplate(db, ctxA)));
    const r1 = await importBotTemplate(db, ctxC, t, { replaceRules: false });
    assert.equal(r1.rulesRemoved, 0);
    const a = await getBotSettings(db, ctxA);
    const c = await getBotSettings(db, ctxC);
    assert.equal(c.personaName, a.personaName);
    assert.equal(c.systemInstruction, a.systemInstruction);
    assert.equal(c.aiKeyMasked, null); // agent sets their own key
    const names = (await listKeywordRules(db, ctxC)).map((r) => r.name);
    assert.ok(names.includes('Lama') && names.includes('Kawasan'));
    // Importing again replaces the same-named rules rather than adding a second copy.
    const again = await importBotTemplate(db, ctxC, t, { replaceRules: false });
    assert.equal(again.rulesRemoved, t.keywordRules.length);
    assert.deepEqual((await listKeywordRules(db, ctxC)).map((r) => r.name).sort(), [...names].sort());
    const r2 = await importBotTemplate(db, ctxC, t, { replaceRules: true });
    assert.equal(r2.rulesRemoved, names.length);
    assert.equal((await listKeywordRules(db, ctxC)).length, t.keywordRules.length);
    assert.equal((await listKeywordRules(db, ctxA)).some((r) => r.name === 'Lama'), false);
  });

  test('bad files and non-admins are rejected', async () => {
    await assert.rejects(importBotTemplate(db, ctxC, { format: 'other' }, { replaceRules: false }));
    const t = await exportBotTemplate(db, ctxA);
    await assert.rejects(importBotTemplate(db, ctxC, { ...t, settings: { ...t.settings, replyDelayMinSec: 9, replyDelayMaxSec: 2 } }, { replaceRules: false }));
    await assert.rejects(importBotTemplate(db, { ...ctxC, role: 'operator' }, t, { replaceRules: false }));
  });

  test('a keyword picture is sent with its caption and copies with the template', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    await assert.rejects(saveImageAsset(db, ctxA, 'application/pdf', png));
    const img = await saveImageAsset(db, ctxA, 'image/png', png);
    await assert.rejects(createKeywordRule(db, ctxC, { name: 'X', matchType: 'phrase', patterns: ['x'], imageAssetId: img })); // other workspace's picture
    await assert.rejects(createKeywordRule(db, ctxA, { name: 'Long', matchType: 'phrase', patterns: ['long'], replyText: 'a'.repeat(1001), imageAssetId: img }));
    await createKeywordRule(db, ctxA, { name: 'Poster', matchType: 'phrase', patterns: ['poster promo'], replyText: 'Ini poster promo kami', imageAssetId: img });
    await createKeywordRule(db, ctxA, { name: 'Gambar sahaja', matchType: 'phrase', patterns: ['gambar aircond'], imageAssetId: img });

    const m = await inbound('boleh hantar poster promo?');
    assert.equal(await routeInbound(db, tA, m.messageId, { aiFor: async () => null }), 'keyword');
    await drainOnce(db, resolveAdapter);
    const sent = adapter.sent.at(-1)!;
    assert.equal(sent.text, 'Ini poster promo kami');
    assert.deepEqual([sent.attachment?.mimeType, sent.attachment?.data], ['image/png', png.toString('base64')]);
    const out = (await getConversation(db, ctxA, m.conversationId))!.messages.at(-1)!;
    assert.equal(out.imageAssetId, img);
    assert.equal((await getImageAsset(db, ctxB, img)), null); // not visible to another workspace

    const t = JSON.parse(JSON.stringify(await exportBotTemplate(db, ctxA)));
    assert.equal(t.keywordRules.find((r: any) => r.name === 'Poster').image.data, png.toString('base64'));
    await importBotTemplate(db, ctxC, t, { replaceRules: true });
    const copied = (await listKeywordRules(db, ctxC)).filter((r) => r.imageAssetId);
    assert.equal(copied.length, 2);
    assert.notEqual(copied[0]!.imageAssetId, img); // its own copy
    assert.deepEqual((await getImageAsset(db, ctxC, copied[0]!.imageAssetId!))!.data, png);
  });
});

describe('agents (owner adds workspaces and logins)', () => {
  let owner: SessionUserT;
  before(async () => {
    const id = await createUser(db, { email: 'boss@example.test', name: 'Boss', password: 'password-boss-1', platformOwner: true });
    owner = { id, email: 'boss@example.test', name: 'Boss', isPlatformOwner: true };
  });

  test('creates workspace, login and copies the bot setup', async () => {
    const r = await createAgentWorkspace(db, owner, { workspaceName: 'Agent Siti', slug: 'agent-siti', agentName: 'Siti', agentEmail: 'Siti@Example.test', copyFromSlug: 'ra' });
    assert.equal(r.email, 'siti@example.test');
    assert.ok(r.tempPassword && r.tempPassword.length >= 12);
    assert.equal(r.rulesCopied, (await listKeywordRules(db, ctxA)).length);
    const token = await login(db, 'siti@example.test', r.tempPassword!);
    assert.ok(token);
    const siti = (await getSessionUser(db, token!))!;
    const ctx = await resolveTenantContext(db, siti, 'agent-siti');
    assert.equal(ctx.role, 'admin');
    assert.equal((await getBotSettings(db, ctx)).personaName, (await getBotSettings(db, ctxA)).personaName);
    await assert.rejects(resolveTenantContext(db, siti, 'ra')); // no access to the owner's workspace
    const list = await listAgentWorkspaces(db, owner);
    assert.ok(list.find((w) => w.slug === 'agent-siti')?.admins.some((a) => a.email === 'siti@example.test'));
  });

  test('second workspace for the same email reuses the login; duplicate slug is refused', async () => {
    const r = await createAgentWorkspace(db, owner, { workspaceName: 'Agent Siti 2', slug: 'agent-siti-2', agentName: 'Siti', agentEmail: 'siti@example.test' });
    assert.equal(r.tempPassword, null);
    assert.equal(r.rulesCopied, null);
    await assert.rejects(createAgentWorkspace(db, owner, { workspaceName: 'X', slug: 'agent-siti', agentName: 'X', agentEmail: 'x@example.test' }));
    assert.equal((await listAgentWorkspaces(db, owner)).filter((w) => w.slug === 'agent-siti').length, 1);
  });

  test('only the platform owner can manage agents', async () => {
    const notOwner = { ...owner, isPlatformOwner: false };
    await assert.rejects(createAgentWorkspace(db, notOwner, { workspaceName: 'X', slug: 'agent-x', agentName: 'X', agentEmail: 'x@example.test' }));
    await assert.rejects(listAgentWorkspaces(db, notOwner));
  });

  test('reset, disable and own password change end other sessions', async () => {
    const siti = (await listAgentWorkspaces(db, owner)).find((w) => w.slug === 'agent-siti')!.admins[0]!;
    const pw = await resetAgentPassword(db, owner, siti.userId);
    const t1 = (await login(db, 'siti@example.test', pw))!;
    const t2 = (await login(db, 'siti@example.test', pw))!;
    const user = (await getSessionUser(db, t1))!;
    await assert.rejects(changeOwnPassword(db, user, 'wrong-password', 'new-password-123', t1));
    await changeOwnPassword(db, user, pw, 'new-password-123', t1);
    assert.ok(await getSessionUser(db, t1));
    assert.equal(await getSessionUser(db, t2), null);
    await setAgentDisabled(db, owner, siti.userId, true);
    assert.equal(await getSessionUser(db, t1), null);
    assert.equal(await login(db, 'siti@example.test', 'new-password-123'), null);
    await setAgentDisabled(db, owner, siti.userId, false);
    assert.ok(await login(db, 'siti@example.test', 'new-password-123'));
    await assert.rejects(resetAgentPassword(db, owner, owner.id)); // owner account is not an agent
  });

  test('owner renames a workspace and its address; own display name can change', async () => {
    const w = (await listAgentWorkspaces(db, owner)).find((x) => x.slug === 'agent-siti-2')!;
    assert.deepEqual(await renameWorkspace(db, owner, w.tenantId, { workspaceName: 'Team Siti', slug: 'team-siti' }), { slug: 'team-siti' });
    const after = (await listAgentWorkspaces(db, owner)).find((x) => x.tenantId === w.tenantId)!;
    assert.deepEqual([after.name, after.slug], ['Team Siti', 'team-siti']);
    await assert.rejects(renameWorkspace(db, owner, w.tenantId, { workspaceName: 'X', slug: 'agent-siti' })); // taken
    await assert.rejects(renameWorkspace(db, { ...owner, isPlatformOwner: false }, w.tenantId, { workspaceName: 'X', slug: 'x-x' }));
    await changeOwnName(db, owner, 'Encik Azhari');
    const r = await withSystem(db, (tx) => tx.query('SELECT name FROM users WHERE id = $1', [owner.id]));
    assert.equal(r.rows[0].name, 'Encik Azhari');
  });
});

// Runs last: it removes every mock channel, including the ones the tests above use.
describe('removing sample data', () => {
  test('mock channels, their chats and sample workspaces go; real QR chats stay', async () => {
    const owner = { id: (await createUser(db, { email: 'purge@example.test', name: 'P', password: 'password-purge-1', platformOwner: true })), email: 'purge@example.test', name: 'P', isPlatformOwner: true };
    const tS = await createTenant(db, { slug: 'sample-x', name: 'Contoh X (data sintetik)' });
    const chS = await createChannel(db, tS, { name: 'mock', provider: 'mock', status: 'connected', automationEnabled: true });
    await receiveInbound(db, tS, chS, { type: 'message', providerMessageId: randomUUID(), providerIdentity: 'synthetic-1', text: 'hai', timestamp: new Date() });
    const qrChats = async () => (await withSystem(db, (tx) => tx.query("SELECT count(*)::int AS n FROM conversations v JOIN channels c ON c.id = v.channel_id WHERE c.provider = 'qr'"))).rows[0].n;
    const before = await qrChats();
    assert.ok(before > 0);
    const seen = await countDemoData(db, owner);
    assert.ok(seen.mockChannels >= 2 && seen.conversations > 0);
    assert.deepEqual(seen.sampleWorkspaces, ['Contoh X (data sintetik)']);
    await assert.rejects(purgeDemoData(db, { ...owner, isPlatformOwner: false }));
    const r = await purgeDemoData(db, owner);
    assert.equal(r.mockChannels, seen.mockChannels);
    assert.deepEqual(await countDemoData(db, owner), { mockChannels: 0, conversations: 0, sampleWorkspaces: [] });
    assert.equal(await qrChats(), before);
    assert.equal((await withSystem(db, (tx) => tx.query("SELECT 1 FROM tenants WHERE slug = 'sample-x'"))).rowCount, 0);
    assert.equal((await withSystem(db, (tx) => tx.query('SELECT 1 FROM tenants WHERE id = $1', [tA]))).rowCount, 1); // has a QR channel
  });
});

describe('auto follow-up', () => {
  let tF: string, chF: string;
  let ai: ScriptedAI;
  const deps = { aiFor: async () => ai as AIProvider };
  const ok = (text: string): GenerateReplyResult => ({ ok: true, text, usage: { inputTokens: 5, outputTokens: 5 }, model: 'gemini-test', latencyMs: 1 });

  before(async () => {
    tF = await createTenant(db, { slug: 'fu', name: 'F' });
    chF = await createChannel(db, tF, { name: 'F', provider: 'mock', status: 'connected', automationEnabled: true, aiEnabled: true });
    await withTenant(db, tF, (tx) => tx.query(
      `INSERT INTO bot_settings (tenant_id, ai_enabled, ai_model, reply_delay_min_sec, reply_delay_max_sec, followup_enabled,
                                 followup_enabled_at, followup_start_hour, followup_end_hour)
       VALUES ($1, true, 'gemini-test', 0, 0, true, now() - interval '30 days', 0, 24)`, [tF]));
  });
  beforeEach(() => { ai = new ScriptedAI(ok('Jawapan AI')); });

  async function say(text: string, from: string) {
    const r = await receiveInbound(db, tF, chF, { type: 'message', providerMessageId: randomUUID(), providerIdentity: from, text, timestamp: new Date() });
    assert.equal(r.kind, 'stored');
    const s = r as { messageId: string; conversationId: string };
    await routeInbound(db, tF, s.messageId, deps);
    await drainOnce(db, resolveAdapter);
    return s.conversationId;
  }
  /** Moves the whole chat back in time, as if the customer had been quiet that long. */
  const age = (conv: string, minutes: number) =>
    withTenant(db, tF, (tx) => tx.query(`UPDATE messages SET created_at = created_at - make_interval(mins => $2) WHERE conversation_id = $1`, [conv, minutes]));
  const followups = async (conv: string) =>
    (await withTenant(db, tF, (tx) => tx.query("SELECT body FROM messages WHERE conversation_id = $1 AND origin = 'followup' ORDER BY created_at", [conv]))).rows.map((r) => r.body as string);
  async function run() {
    const n = await followupOnce(db, deps);
    await drainOnce(db, resolveAdapter);
    return n;
  }

  test('nudges a quiet customer three times at most, then waits for them to write again', async () => {
    const conv = await say('aircond ada lagi?', `fu-${randomUUID()}`);
    assert.equal(await run(), 0); // not yet due
    await age(conv, 59);
    assert.equal(await run(), 0);
    await age(conv, 2);
    ai.result = ok('Hai Cik, masih berminat?');
    assert.equal(await run(), 1);
    assert.match(ai.lastInput!.systemInstruction, /follow-up ke-1 daripada maksimum 3/);
    assert.equal(ai.lastInput!.history.at(-2)!.text, 'Jawapan AI');
    assert.equal(await run(), 0); // the next gap counts from the follow-up just sent
    await age(conv, 181);
    assert.equal(await run(), 1);
    await age(conv, 601);
    assert.match((await (async () => { await run(); return ai.lastInput!.systemInstruction; })()), /follow-up terakhir/);
    await age(conv, 5000);
    assert.equal(await run(), 0); // three is the limit
    assert.equal((await followups(conv)).length, 3);
  });

  test('a reply from the customer resets the count; old chats, takeover and Rejected are left alone', async () => {
    const who = `fu-${randomUUID()}`;
    const conv = await say('harga berapa?', who);
    await age(conv, 61);
    assert.equal(await run(), 1);
    await age(conv, 181);
    assert.equal(await run(), 1);
    await say('sorry sibuk, ok saya tengok', who);
    await age(conv, 61);
    assert.equal(await run(), 1);
    assert.equal((await followups(conv)).length, 3);

    // due more than 12 hours ago (e.g. the worker was down): dropped, not sent late
    const old = await say('info aircond', `fu-${randomUUID()}`);
    await age(old, 60 * 24);
    assert.equal(await run(), 0);

    const taken = await say('nak tanya', `fu-${randomUUID()}`);
    await withTenant(db, tF, (tx) => tx.query('UPDATE conversations SET human_takeover = true WHERE id = $1', [taken]));
    await age(taken, 61);
    assert.equal(await run(), 0);

    const no = await say('mahal', `fu-${randomUUID()}`);
    await withTenant(db, tF, async (tx) => {
      const l = await tx.query("INSERT INTO contact_labels (tenant_id, name) VALUES ($1, 'Rejected') ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id", [tF]);
      await tx.query('INSERT INTO contact_label_assignments (tenant_id, contact_id, label_id) SELECT $1, contact_id, $3 FROM conversations WHERE id = $2', [tF, no, l.rows[0].id]);
    });
    await age(no, 61);
    assert.equal(await run(), 0);
  });

  test('the AI can decline (customer asked to be contacted later); a failed AI uses a fixed message', async () => {
    const who = `fu-${randomUUID()}`;
    const conv = await say('nanti malam saya call', who);
    await age(conv, 61);
    ai.result = ok('SKIP');
    assert.equal(await run(), 0);
    ai.result = ok('Hai Cik!');
    assert.equal(await run(), 0); // stopped until the customer writes
    assert.equal((await followups(conv)).length, 0);

    const conv2 = await say('ok', `fu-${randomUUID()}`);
    await age(conv2, 61);
    ai.result = { ok: false, reason: 'timeout', detail: 'slow' };
    assert.equal(await run(), 1);
    assert.deepEqual(await followups(conv2), [DEFAULT_FOLLOWUPS[0]]);
  });
});

describe('replies in several bubbles', () => {
  let tG: string, chG: string;
  before(async () => {
    tG = await createTenant(db, { slug: 'bub', name: 'G' });
    chG = await createChannel(db, tG, { name: 'G', provider: 'mock', status: 'connected', automationEnabled: true });
    await withTenant(db, tG, (tx) => tx.query('INSERT INTO bot_settings (tenant_id, reply_delay_min_sec, reply_delay_max_sec) VALUES ($1, 0, 0)', [tG]));
  });

  test('a --- line splits a reply into bubbles (at most 4), sent in order', async () => {
    assert.deepEqual(splitBubbles('Satu'), ['Satu']);
    assert.deepEqual(splitBubbles('Satu\n---\nDua\n\n  ---  \nTiga'), ['Satu', 'Dua', 'Tiga']);
    assert.deepEqual(splitBubbles('a\n---\nb\n---\nc\n---\nd\n---\ne'), ['a', 'b', 'c', 'd\n\ne']);
    assert.deepEqual(splitBubbles('harga - RM105 --- lepas tu'), ['harga - RM105 --- lepas tu']); // only a line of its own splits

    await withTenant(db, tG, (tx) => tx.query(
      `INSERT INTO keyword_rules (tenant_id, name, match_type, patterns, reply_text) VALUES ($1, 'Bubble', 'phrase', '{nak bubble}', $2)`,
      [tG, 'Harga dulu\n---\nKelebihan pula\n---\nTaip DAFTAR']));
    {
      const r = await receiveInbound(db, tG, chG, { type: 'message', providerMessageId: randomUUID(), providerIdentity: `bub-${randomUUID()}`, text: 'saya nak bubble', timestamp: new Date() });
      const m = r as { messageId: string; conversationId: string };
      assert.equal(await routeInbound(db, tG, m.messageId, { aiFor: async () => null }), 'keyword');
      const before = adapter.sent.length;
      while (Object.values(await drainOnce(db, resolveAdapter)).some((n) => n > 0));
      // later bubbles wait a moment; send them now, keeping their order
      await withTenant(db, tG, (tx) => tx.query("UPDATE outbox SET next_attempt_at = next_attempt_at - interval '1 hour' WHERE conversation_id = $1 AND state = 'pending'", [m.conversationId]));
      while (Object.values(await drainOnce(db, resolveAdapter)).some((n) => n > 0));
      assert.deepEqual(adapter.sent.slice(before).map((s) => s.text), ['Harga dulu', 'Kelebihan pula', 'Taip DAFTAR']);
      const rows = await withTenant(db, tG, (tx) => tx.query("SELECT body FROM messages WHERE conversation_id = $1 AND direction = 'outbound' ORDER BY created_at", [m.conversationId]));
      assert.deepEqual(rows.rows.map((o) => o.body), ['Harga dulu', 'Kelebihan pula', 'Taip DAFTAR']);
    }
  });
});

describe('conversation review export', () => {
  test('hides phone, IC and email but keeps prices and package names', () => {
    assert.equal(
      redactPersonal('Nama Ali, IC 900101-07-5555, tel 012-345 6789, ali@mail.com. Combo D 1.0+1.5HP RM220, poskod 08000'),
      'Nama Ali, IC [IC], tel [number], [email]. Combo D 1.0+1.5HP RM220, poskod 08000',
    );
    assert.equal(redactPersonal('+60123456789 / 900101075555'), '[number] / [IC]');
  });
});

describe('staff alerts on WhatsApp', () => {
  let tN: string, chN: string;
  before(async () => {
    tN = await createTenant(db, { slug: 'ntf', name: 'N' });
    chN = await createChannel(db, tN, { name: 'N', provider: 'mock', status: 'connected', automationEnabled: true });
    await withTenant(db, tN, async (tx) => {
      await tx.query("INSERT INTO bot_settings (tenant_id, reply_delay_min_sec, reply_delay_max_sec, notify_numbers) VALUES ($1, 0, 0, '{60123456789}')", [tN]);
      await tx.query(
        `INSERT INTO keyword_rules (tenant_id, name, match_type, patterns, reply_text, set_label, handover, priority)
         VALUES ($1, 'Borang diterima', 'phrase', '{form pendaftaran}', 'Terima kasih Cik!', 'Borang diisi', true, 1)`,
        [tN],
      );
    });
  });

  test('staff numbers accept common spellings and reject others', () => {
    assert.deepEqual(SettingsUpdate.parse({ expectedVersion: 1, notifyNumbers: ['012-345 6789', '+60 11-2345 6789'] }).notifyNumbers, ['60123456789', '601123456789']);
    assert.throws(() => SettingsUpdate.parse({ expectedVersion: 1, notifyNumbers: ['12345'] }));
  });

  test('a form sent back hands over and alerts staff once; staff replies are not answered', async () => {
    const r = (await receiveInbound(db, tN, chN, {
      type: 'message', providerMessageId: randomUUID(), providerIdentity: 'cust-ntf', phoneE164: '+60199998888', profileName: 'Siti',
      text: 'FORM PENDAFTARAN\nNAMA: Siti\nPAKEJ AIRCOND: Combo D', timestamp: new Date(),
    })) as { messageId: string; conversationId: string };
    assert.equal(await routeInbound(db, tN, r.messageId, { aiFor: async () => null }), 'keyword');
    const before = adapter.sent.length;
    assert.equal(await notifyOnce(db, resolveAdapter), 1);
    assert.equal(await notifyOnce(db, resolveAdapter), 0);
    const alert = adapter.sent.slice(before);
    assert.equal(alert.length, 1);
    assert.equal(alert[0]!.to, '60123456789@s.whatsapp.net');
    assert.match(alert[0]!.text, /Siti \(\+60199998888\)/);
    assert.match(alert[0]!.text, /Borang diterima \(label Borang diisi\)/);
    const conv = await withTenant(db, tN, (tx) => tx.query('SELECT human_takeover, status FROM conversations WHERE id = $1', [r.conversationId]));
    assert.deepEqual(conv.rows[0], { human_takeover: true, status: 'pending_human' });

    const staff = (await receiveInbound(db, tN, chN, {
      type: 'message', providerMessageId: randomUUID(), providerIdentity: 'staff-ntf', phoneE164: '+60123456789', text: 'ok noted', timestamp: new Date(),
    })) as { messageId: string };
    assert.equal(await routeInbound(db, tN, staff.messageId, { aiFor: async () => null }), 'none');
  });
});

describe('AI hands a chat to staff', () => {
  test('the [SERAH_STAF] tag is removed and its reason kept', () => {
    assert.deepEqual(extractHandover('Terima kasih Cik 🙏\n[SERAH_STAF: borang lengkap]'), { text: 'Terima kasih Cik 🙏', handover: true, reason: 'borang lengkap' });
    assert.deepEqual(extractHandover('[[serah staf]]'), { text: '', handover: true, reason: null });
    assert.deepEqual(extractHandover('Harga RM115 [nota]'), { text: 'Harga RM115 [nota]', handover: false, reason: null });
  });

  test('a form given bit by bit: AI closes, chat goes to staff, staff are alerted', async () => {
    const tH = await createTenant(db, { slug: 'aiho', name: 'H' });
    const chH = await createChannel(db, tH, { name: 'H', provider: 'mock', status: 'connected', automationEnabled: true });
    await withTenant(db, tH, async (tx) => {
      await tx.query("INSERT INTO bot_settings (tenant_id, ai_enabled, ai_model, reply_delay_min_sec, reply_delay_max_sec, notify_numbers) VALUES ($1, true, 'gemini-test', 0, 0, '{60123456789}')", [tH]);
      await tx.query('UPDATE channels SET ai_enabled = true WHERE id = $1', [chH]);
    });
    const ai = new MockAIProvider(() => 'Terima kasih Cik, maklumat dah lengkap 🙏 Team akan hubungi Cik.\n[SERAH_STAF: borang lengkap]');
    const r = (await receiveInbound(db, tH, chH, {
      type: 'message', providerMessageId: randomUUID(), providerIdentity: 'cust-aiho', text: 'Waris: Safura, isteri', timestamp: new Date(),
    })) as { messageId: string; conversationId: string };
    assert.equal(await routeInbound(db, tH, r.messageId, { aiFor: async () => ai }), 'ai_handover');
    const before = adapter.sent.length;
    while (Object.values(await drainOnce(db, resolveAdapter)).some((n) => n > 0));
    assert.equal(await notifyOnce(db, resolveAdapter), 1);
    const sent = adapter.sent.slice(before);
    const toCustomer = sent.filter((x) => x.to === 'cust-aiho').map((x) => x.text);
    assert.deepEqual(toCustomer, ['Terima kasih Cik, maklumat dah lengkap 🙏 Team akan hubungi Cik.']);
    const alert = sent.find((x) => x.to === '60123456789@s.whatsapp.net' && x.text.includes('AI: borang lengkap'));
    assert.ok(alert);
    assert.ok(!sent.some((x) => x.text.includes('SERAH')));
    const conv = await withTenant(db, tH, (tx) => tx.query('SELECT human_takeover, status FROM conversations WHERE id = $1', [r.conversationId]));
    assert.deepEqual(conv.rows[0], { human_takeover: true, status: 'pending_human' });
  });
});
