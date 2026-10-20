import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for provider credentials stored in the database. The key comes from
 * APP_ENCRYPTION_KEY (32 bytes, base64) and must live outside the database and its
 * backups; losing it makes stored credentials unrecoverable.
 */
function key(raw = process.env.APP_ENCRYPTION_KEY): Buffer {
  if (!raw) throw new Error('APP_ENCRYPTION_KEY is not set');
  const k = Buffer.from(raw, 'base64');
  if (k.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  return k;
}

export function encryptSecret(plain: string, rawKey?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(rawKey), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}

export function decryptSecret(blob: string, rawKey?: string): string {
  const [v, iv, tag, ct] = blob.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('unsupported secret format');
  const decipher = createDecipheriv('aes-256-gcm', key(rawKey), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

/** Shows only enough of a secret to recognise it, e.g. "AIza…x9Qk". */
export function maskSecret(plain: string): string {
  return plain.length <= 8 ? '••••' : `${plain.slice(0, 4)}…${plain.slice(-4)}`;
}
