import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLiveOwnMessage, normalizeMessage, normalizeStatus, phoneFromJid } from '../src/normalize.js';

const key = (o: Record<string, unknown> = {}) => ({ remoteJid: '60123456789@s.whatsapp.net', id: 'ABC', fromMe: false, ...o });

test('text message from a phone number', () => {
  const e = normalizeMessage({ key: key(), message: { conversation: 'harga?' }, messageTimestamp: 1760000000, pushName: 'Ali' }, false);
  assert.deepEqual(e, {
    type: 'message', providerMessageId: 'ABC', providerIdentity: '60123456789@s.whatsapp.net', phoneE164: '+60123456789',
    profileName: 'Ali', text: 'harga?', attachments: undefined, timestamp: new Date(1760000000 * 1000).toISOString(),
    fromMe: false, isGroup: false, isHistoryReplay: false,
  });
});

test('LID sender: identity kept, phone only from the alternate jid', () => {
  const e = normalizeMessage({ key: key({ remoteJid: '123456789012345@lid' }), message: { extendedTextMessage: { text: 'hai' } } }, false);
  assert.equal(e?.type === 'message' && e.phoneE164, undefined);
  const e2 = normalizeMessage({ key: key({ remoteJid: '123456789012345@lid', remoteJidAlt: '60111222333@s.whatsapp.net' }), message: { conversation: 'hai' } }, false);
  assert.equal(e2?.type === 'message' && e2.phoneE164, '+60111222333');
});

test('wrapped media with caption, groups and history are flagged', () => {
  const e = normalizeMessage({ key: key({ remoteJid: '1203@g.us' }), message: { ephemeralMessage: { message: { imageMessage: { caption: 'gambar', mimetype: 'image/jpeg' } } } } }, true);
  assert.ok(e && e.type === 'message');
  assert.equal(e.text, 'gambar');
  assert.deepEqual(e.attachments, [{ kind: 'image', mimeType: 'image/jpeg', fileName: undefined }]);
  assert.equal(e.isGroup, true);
  assert.equal(e.isHistoryReplay, true);
});

test('status broadcasts, reactions and empty stubs are dropped', () => {
  assert.equal(normalizeMessage({ key: key({ remoteJid: 'status@broadcast' }), message: { conversation: 'x' } }, false), null);
  assert.equal(normalizeMessage({ key: key(), message: { reactionMessage: { text: '👍' } } }, false), null);
  assert.equal(normalizeMessage({ key: key(), message: null }, false), null);
});

test('delivery statuses for our own messages only', () => {
  assert.equal(normalizeStatus({ key: key({ fromMe: true }), update: { status: 3 } })?.type, 'status');
  assert.equal((normalizeStatus({ key: key({ fromMe: true }), update: { status: 4 } }) as any).status, 'read');
  assert.equal(normalizeStatus({ key: key({ fromMe: false }), update: { status: 3 } }), null);
  assert.equal(normalizeStatus({ key: key({ fromMe: true }), update: { status: 1 } }), null);
});

test('phoneFromJid ignores device suffix and non-phone ids', () => {
  assert.equal(phoneFromJid('60123456789:12@s.whatsapp.net'), '+60123456789');
  assert.equal(phoneFromJid('123@lid'), undefined);
});

test('only recent messages from the business phone count as live', () => {
  const now = new Date('2026-10-20T10:00:00Z');
  const at = (sec: number, fromMe = true) => ({ key: key({ fromMe }), messageTimestamp: now.getTime() / 1000 - sec, message: { conversation: 'x' } });
  assert.equal(isLiveOwnMessage(at(10) as any, now), true);
  assert.equal(isLiveOwnMessage(at(600) as any, now), false);
  assert.equal(isLiveOwnMessage(at(10, false) as any, now), false);
});
