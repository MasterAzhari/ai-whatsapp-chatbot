import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Db } from '../src/db.js';
import { withSystem, withTenant } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { getSessionUser, login, resolveTenantContext, type TenantContext } from '../src/auth.js';
import { addMembership, createChannel, createTenant, createUser } from '../src/repos/platform.js';
import { ingestEvent } from '../src/inbound.js';
import { claimDue, drainOnce, enqueueReply, processJob } from '../src/outbox.js';
import { getConversation, listConversations, resumeBot, sendManualReply, takeOver } from '../src/repos/conversations.js';
import { MockChannelAdapter } from '../src/channels/mock.js';
import { decryptSecret, encryptSecret } from '../src/secrets.js';
import { freshDb } from './helpers.js';

let db: Db;
let drop: () => Promise<void>;
let tA: string, tB: string, chA: string, chB: string;
let ctxA: TenantContext, ctxB: TenantContext, ctxOperatorA: TenantContext;
const mock = new MockChannelAdapter();
const resolve = async () => mock;

async function inbound(tenantId: string, channelId: string, from: string, text: string, id = randomUUID()) {
  return withTenant(db, tenantId, (tx) =>
    ingestEvent(tx, tenantId, channelId, { type: 'message', providerMessageId: id, providerIdentity: from, text, timestamp: new Date() }),
  );
}

before(async () => {
  ({ db, drop } = await freshDb());
  tA = await createTenant(db, { slug: 'tenant-a', name: 'A' });
  tB = await createTenant(db, { slug: 'tenant-b', name: 'B' });
  chA = await createChannel(db, tA, { name: 'A mock', provider: 'mock', status: 'connected', automationEnabled: true });
  chB = await createChannel(db, tB, { name: 'B mock', provider: 'mock', status: 'connected', automationEnabled: true });
  const adminA = await createUser(db, { email: 'admin-a@example.test', name: 'Admin A', password: 'password-a-123' });
  const adminB = await createUser(db, { email: 'admin-b@example.test', name: 'Admin B', password: 'password-b-123' });
  const opA = await createUser(db, { email: 'op-a@example.test', name: 'Op A', password: 'password-op-123' });
  await addMembership(db, tA, adminA, 'admin');
  await addMembership(db, tB, adminB, 'admin');
  await addMembership(db, tA, opA, 'operator');
  const sess = async (email: string, pw: string, slug: string) =>
    resolveTenantContext(db, (await getSessionUser(db, (await login(db, email, pw))!))!, slug);
  ctxA = await sess('admin-a@example.test', 'password-a-123', 'tenant-a');
  ctxB = await sess('admin-b@example.test', 'password-b-123', 'tenant-b');
  ctxOperatorA = await sess('op-a@example.test', 'password-op-123', 'tenant-a');
});

after(async () => drop());

describe('migrations', () => {
  test('re-running is a no-op', async () => {
    assert.deepEqual(await migrate(db), []);
  });
});

describe('auth', () => {
  test('wrong password and unknown email both fail', async () => {
    assert.equal(await login(db, 'admin-a@example.test', 'nope-nope-nope'), null);
    assert.equal(await login(db, 'nobody@example.test', 'password-a-123'), null);
  });
  test('user cannot open a workspace they are not a member of', async () => {
    const user = ctxA.user;
    await assert.rejects(resolveTenantContext(db, user, 'tenant-b'), /no access/);
  });
});

describe('tenant isolation (row-level security)', () => {
  test('tenant A cannot see tenant B conversations, even by id', async () => {
    const b = await inbound(tB, chB, 'b-cust-1', 'hello from B');
    assert.equal(b.kind, 'stored');
    const convB = b.kind === 'stored' ? b.conversationId : '';
    assert.equal((await listConversations(db, ctxA)).some((c) => c.id === convB), false);
    assert.equal(await getConversation(db, ctxA, convB), null);
    assert.ok(await getConversation(db, ctxB, convB));
  });

  test('raw queries inside tenant A return nothing from B', async () => {
    const counts = await withTenant(db, tA, async (tx) => {
      const r = await tx.query('SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1', [tB]);
      const ch = await tx.query('SELECT count(*)::int AS n FROM channels WHERE id = $1', [chB]);
      return [r.rows[0].n, ch.rows[0].n];
    });
    assert.deepEqual(counts, [0, 0]);
  });

  test('tenant A cannot write rows labelled as tenant B', async () => {
    await assert.rejects(
      withTenant(db, tA, (tx) => tx.query('INSERT INTO contacts (tenant_id, display_name) VALUES ($1, $2)', [tB, 'x'])),
      /row-level security/,
    );
  });

  test('tenant A actions on tenant B conversation fail', async () => {
    const b = await inbound(tB, chB, 'b-cust-2', 'another');
    const convB = b.kind === 'stored' ? b.conversationId : '';
    await assert.rejects(sendManualReply(db, ctxA, convB, { text: 'hi' }), /not found/);
    await assert.rejects(takeOver(db, ctxA, convB), /not found/);
  });

  test('without any tenant set, nothing is visible', async () => {
    const r = await db.query('SELECT count(*)::int AS n FROM conversations');
    assert.equal(r.rows[0].n, 0);
  });
});

describe('inbound', () => {
  test('a repeated webhook creates one message and one conversation', async () => {
    const id = randomUUID();
    const first = await inbound(tA, chA, 'dup-cust', 'hi', id);
    const second = await inbound(tA, chA, 'dup-cust', 'hi', id);
    assert.equal(first.kind, 'stored');
    assert.equal(second.kind, 'duplicate');
    const n = await withTenant(db, tA, async (tx) =>
      (await tx.query("SELECT count(*)::int AS n FROM messages WHERE provider_message_id = $1", [id])).rows[0].n,
    );
    assert.equal(n, 1);
  });

  test('concurrent duplicate deliveries still store once', async () => {
    const id = randomUUID();
    const results = await Promise.all([1, 2, 3].map(() => inbound(tA, chA, 'race-cust', 'race', id)));
    assert.equal(results.filter((r) => r.kind === 'stored').length, 1);
  });

  test('own messages, groups and history replay are ignored', async () => {
    for (const flag of [{ fromMe: true }, { isGroup: true }, { isHistoryReplay: true }]) {
      const r = await withTenant(db, tA, (tx) =>
        ingestEvent(tx, tA, chA, { type: 'message', providerMessageId: randomUUID(), providerIdentity: 'x', text: 'x', timestamp: new Date(), ...flag }),
      );
      assert.equal(r.kind, 'ignored');
    }
  });

  test('delivery status never moves backwards', async () => {
    const r = await inbound(tA, chA, 'status-cust', 'hi');
    assert.equal(r.kind, 'stored');
    if (r.kind !== 'stored') return;
    const { messageId } = await withTenant(db, tA, (tx) =>
      enqueueReply(tx, { tenantId: tA, conversationId: r.conversationId, text: 'ok', origin: 'keyword', idempotencyKey: randomUUID() }),
    );
    await drainOnce(db, resolve);
    const pmid = await withTenant(db, tA, async (tx) =>
      (await tx.query('SELECT provider_message_id FROM messages WHERE id = $1', [messageId])).rows[0].provider_message_id,
    );
    const st = (status: 'read' | 'delivered') =>
      withTenant(db, tA, (tx) => ingestEvent(tx, tA, chA, { type: 'status', providerMessageId: pmid, status, timestamp: new Date() }));
    await st('read');
    await st('delivered');
    const final = await withTenant(db, tA, async (tx) => (await tx.query('SELECT status FROM messages WHERE id = $1', [messageId])).rows[0].status);
    assert.equal(final, 'read');
  });
});

describe('outbox', () => {
  async function newConversation(from = randomUUID()) {
    const r = await inbound(tA, chA, from, 'hello');
    assert.equal(r.kind, 'stored');
    return r.kind === 'stored' ? r.conversationId : '';
  }
  const status = (messageId: string) =>
    withTenant(db, tA, async (tx) => (await tx.query('SELECT status, status_detail FROM messages WHERE id = $1', [messageId])).rows[0]);

  test('same idempotency key queues one reply', async () => {
    const conv = await newConversation();
    const key = randomUUID();
    const a = await withTenant(db, tA, (tx) => enqueueReply(tx, { tenantId: tA, conversationId: conv, text: 'x', origin: 'ai', idempotencyKey: key }));
    const b = await withTenant(db, tA, (tx) => enqueueReply(tx, { tenantId: tA, conversationId: conv, text: 'x', origin: 'ai', idempotencyKey: key }));
    assert.equal(b.duplicate, true);
    assert.equal(a.messageId, b.messageId);
    await drainOnce(db, resolve);
  });

  test('retryable failure is retried later; unknown result is not retried', async () => {
    const conv = await newConversation();
    const m1 = await withTenant(db, tA, (tx) => enqueueReply(tx, { tenantId: tA, conversationId: conv, text: 'r', origin: 'keyword', idempotencyKey: randomUUID() }));
    mock.script.push({ ok: false, retryable: true, error: 'rate limited' });
    const c1 = await drainOnce(db, resolve);
    assert.equal(c1.retry, 1);
    assert.equal((await status(m1.messageId)).status, 'queued');

    const m2 = await withTenant(db, tA, (tx) => enqueueReply(tx, { tenantId: tA, conversationId: conv, text: 'u', origin: 'keyword', idempotencyKey: randomUUID() }));
    mock.script.push({ ok: false, retryable: false, unknown: true, error: 'timeout' });
    const sentBefore = mock.sent.length;
    const c2 = await drainOnce(db, resolve);
    assert.equal(c2.unknown, 1);
    assert.equal((await status(m2.messageId)).status, 'unknown');
    // Nothing is due any more: the unknown one stays unknown, the retry waits for backoff.
    const c3 = await drainOnce(db, resolve);
    assert.equal(Object.values(c3).reduce((a, b) => a + b, 0), 0);
    assert.equal(mock.sent.length, sentBefore);
  });

  test('human takeover cancels queued automated replies but not human ones', async () => {
    const conv = await newConversation();
    const auto = await withTenant(db, tA, (tx) => enqueueReply(tx, { tenantId: tA, conversationId: conv, text: 'auto', origin: 'ai', idempotencyKey: randomUUID() }));
    const r = await takeOver(db, ctxOperatorA, conv);
    assert.equal(r.cancelled, 1);
    const human = await sendManualReply(db, ctxOperatorA, conv, { text: 'Saya bantu ya' });
    await drainOnce(db, resolve);
    assert.equal((await status(auto.messageId)).status, 'failed');
    assert.equal((await status(human.messageId)).status, 'sent');
    await resumeBot(db, ctxOperatorA, conv);
  });

  test('takeover that lands after an automated reply was claimed still stops it', async () => {
    const conv = await newConversation();
    const auto = await withTenant(db, tA, (tx) => enqueueReply(tx, { tenantId: tA, conversationId: conv, text: 'late', origin: 'ai', idempotencyKey: randomUUID() }));
    const jobs = await claimDue(db);
    await takeOver(db, ctxOperatorA, conv);
    for (const j of jobs) await processJob(db, j, resolve);
    assert.match((await status(auto.messageId)).status_detail, /human takeover/);
    await resumeBot(db, ctxOperatorA, conv);
  });

  test('automation disabled blocks automated replies but allows human replies', async () => {
    const conv = await newConversation();
    await withTenant(db, tA, (tx) => tx.query('UPDATE channels SET automation_enabled = false WHERE id = $1', [chA]));
    try {
      const auto = await withTenant(db, tA, (tx) => enqueueReply(tx, { tenantId: tA, conversationId: conv, text: 'a', origin: 'keyword', idempotencyKey: randomUUID() }));
      await drainOnce(db, resolve);
      assert.match((await status(auto.messageId)).status_detail, /automation disabled/);
      const human = await sendManualReply(db, ctxOperatorA, conv, { text: 'manual' });
      await drainOnce(db, resolve);
      assert.equal((await status(human.messageId)).status, 'sent');
    } finally {
      await withTenant(db, tA, (tx) => tx.query('UPDATE channels SET automation_enabled = true WHERE id = $1', [chA]));
    }
  });

  test('stale backlog is not sent', async () => {
    const conv = await newConversation();
    const m = await withTenant(db, tA, (tx) =>
      enqueueReply(tx, { tenantId: tA, conversationId: conv, text: 'old', origin: 'keyword', idempotencyKey: randomUUID(), expiresInMs: 1 }),
    );
    await new Promise((r) => setTimeout(r, 20));
    await drainOnce(db, resolve);
    assert.match((await status(m.messageId)).status_detail, /expired/);
  });

  test('a send interrupted by a crashed worker is marked unknown, not resent', async () => {
    const conv = await newConversation();
    const m = await withTenant(db, tA, (tx) => enqueueReply(tx, { tenantId: tA, conversationId: conv, text: 'crash', origin: 'keyword', idempotencyKey: randomUUID() }));
    await claimDue(db); // claimed, then the "worker" dies
    await withSystem(db, (tx) => tx.query("UPDATE outbox SET lease_until = now() - interval '1 second' WHERE message_id = $1", [m.messageId]));
    const sentBefore = mock.sent.length;
    await drainOnce(db, resolve);
    assert.equal((await status(m.messageId)).status, 'unknown');
    assert.equal(mock.sent.length, sentBefore);
  });
});

describe('secrets', () => {
  test('round trip and tamper detection', () => {
    const k = Buffer.alloc(32, 7).toString('base64');
    const blob = encryptSecret('AIza-test-key', k);
    assert.equal(decryptSecret(blob, k), 'AIza-test-key');
    const parts = blob.split('.');
    parts[3] = Buffer.from('tampered').toString('base64');
    assert.throws(() => decryptSecret(parts.join('.'), k));
  });
});
