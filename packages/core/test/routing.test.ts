import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Db } from '../src/db.js';
import { withSystem, withTenant } from '../src/db.js';
import { getSessionUser, login, resolveTenantContext, type SessionUser as SessionUserT, type TenantContext } from '../src/auth.js';
import { addMembership, createChannel, createTenant, createUser } from '../src/repos/platform.js';
import { drainOnce } from '../src/outbox.js';
import { getConversation, takeOver } from '../src/repos/conversations.js';
import { MockChannelAdapter } from '../src/channels/mock.js';
import { MockAIProvider, type AIProvider, type GenerateReplyInput, type GenerateReplyResult } from '../src/ai/provider.js';
import { GeminiProvider, toContents } from '../src/ai/gemini.js';
import { AnthropicProvider, toMessages } from '../src/ai/anthropic.js';
import { matchPattern, normalize, pickRule, type KeywordRule } from '../src/routing/match.js';
import { decide, routeInbound } from '../src/routing/router.js';
import { receiveGatewayEvents, receiveInbound } from '../src/routing/receive.js';
import { addQrChannel, connectQrChannel, qrChannelStatus } from '../src/repos/channels.js';
import { routeOnce } from '../src/worker.js';
import { simulate } from '../src/routing/playground.js';
import { createKeywordRule, listKeywordRules, updateKeywordRule } from '../src/repos/keywords.js';
import { getBotSettings, setCredential, updateBotSettings, VersionConflictError, type BotSettings } from '../src/repos/settings.js';
import { getUsageSummary } from '../src/repos/usage.js';
import { createAiResolver } from '../src/routing/ai-resolver.js';
import { exportBotTemplate, importBotTemplate } from '../src/repos/template.js';
import { changeOwnPassword, createAgentWorkspace, listAgentWorkspaces, resetAgentPassword, setAgentDisabled } from '../src/repos/agents.js';
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
  fallbackReply: null, handoverReply: 'Staf akan balas', stopKeywords: ['stop'], humanKeywords: ['nak cakap dengan orang'],
  replyDelayMinSec: 0, replyDelayMaxSec: 0, typingIndicator: false, leadMode: false,
};

describe('decide order', () => {
  const d = (o: Partial<Parameters<typeof decide>[0]>) =>
    decide({ text: 'harga', channelId: 'ch', automationEnabled: true, humanTakeover: false, optedOut: false, isLead: false, aiAllowed: true,
      settings: baseSettings, rules: [rule({ patterns: ['harga', 'stop', 'nak cakap dengan orang'] })], ...o });
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
  test('toMessages opens with the customer', () => {
    assert.equal(toMessages([{ role: 'assistant', text: 'x' }]).length, 0);
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

async function inbound(text: string, from = `cust-${randomUUID()}`) {
  const r = await receiveInbound(db, tA, chA, { type: 'message', providerMessageId: randomUUID(), providerIdentity: from, text, timestamp: new Date() });
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
    } finally {
      while ((await routeOnce(db, deps)) > 0); // clear the routing jobs these messages queued
      await settings({ leadMode: false });
      await updateKeywordRule(db, ctxA, lead.id, lead.version, { name: 'Lead aircond', matchType: 'phrase', patterns: ['saya nak info aircond'], replyText: 'x', enabled: false });
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

  test('import copies the setup; add mode keeps old rules, replace mode drops them', async () => {
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
});
