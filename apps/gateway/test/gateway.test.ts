import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createGatewayServer } from '../src/app.js';
import { MockSessionDriver, SessionManager } from '../src/sessions.js';

const token = 'test-token-0123456789abcdef';
const ch = '11111111-2222-3333-4444-555555555555';
const server = createGatewayServer({ token, sessions: new SessionManager(() => new MockSessionDriver()) });
let base = '';

before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

const call = (path: string, body?: unknown, auth = token) =>
  fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test('rejects calls without the internal token', async () => {
  assert.equal((await call(`/channels/${ch}/status`, undefined, 'wrong')).status, 401);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('cannot send before the session is connected', async () => {
  const r = await call(`/channels/${ch}/send-text`, { to: 'x', text: 'hi', idempotencyKey: 'k0' });
  assert.equal(r.status, 409);
});

test('pairs, then sends idempotently', async () => {
  const c = await (await call(`/channels/${ch}/connect`, {})).json();
  assert.equal(c.state, 'pairing');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal((await (await call(`/channels/${ch}/status`)).json()).state, 'connected');
  const a = await (await call(`/channels/${ch}/send-text`, { to: 'x', text: 'hi', idempotencyKey: 'k1' })).json();
  const b = await (await call(`/channels/${ch}/send-text`, { to: 'x', text: 'hi', idempotencyKey: 'k1' })).json();
  assert.equal(a.providerMessageId, b.providerMessageId);
});

test('sends a picture with a caption; rejects other file types', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const ok = await call(`/channels/${ch}/send-image`, { to: 'x', caption: 'Poster promo', mimeType: 'image/png', data: png, idempotencyKey: 'img1' });
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).providerMessageId);
  const bad = await call(`/channels/${ch}/send-image`, { to: 'x', mimeType: 'application/pdf', data: png, idempotencyKey: 'img2' });
  assert.equal(bad.status, 400);
});

test('sends a video or a document; rejects types WhatsApp users cannot open safely', async () => {
  const bytes = Buffer.from('0000001866747970', 'hex').toString('base64');
  const v = await call(`/channels/${ch}/send-media`, { to: 'x', caption: 'Video promo', mimeType: 'video/mp4', data: bytes, idempotencyKey: 'vid1' });
  assert.equal(v.status, 200);
  const d = await call(`/channels/${ch}/send-media`, { to: 'x', mimeType: 'application/pdf', fileName: 'Brosur.pdf', data: bytes, idempotencyKey: 'doc1' });
  assert.equal(d.status, 200);
  const bad = await call(`/channels/${ch}/send-media`, { to: 'x', mimeType: 'text/html', data: bytes, idempotencyKey: 'doc2' });
  assert.equal(bad.status, 400);
});
