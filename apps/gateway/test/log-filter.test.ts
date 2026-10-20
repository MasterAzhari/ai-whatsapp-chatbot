import { test } from 'node:test';
import assert from 'node:assert/strict';

test('libsignal session dumps never reach the console', async () => {
  const lines: unknown[][] = [];
  const orig = { info: console.info, warn: console.warn, log: console.log };
  console.info = (...a: unknown[]) => void lines.push(a);
  console.warn = (...a: unknown[]) => void lines.push(a);
  console.log = (...a: unknown[]) => void lines.push(a);
  try {
    await import('../src/log-filter.js');
    console.info('Closing session:', { rootKey: 'SECRET' });
    console.warn('Session already closed', { rootKey: 'SECRET' });
    console.log('[gateway] normal line');
  } finally {
    Object.assign(console, orig);
  }
  const text = JSON.stringify(lines);
  assert.ok(!text.includes('SECRET'));
  assert.ok(text.includes('normal line'));
  assert.ok(text.includes('details hidden'));
});
