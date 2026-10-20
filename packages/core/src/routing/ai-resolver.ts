import type { Db } from '../db.js';
import { withTenant } from '../db.js';
import type { AIProvider } from '../ai/provider.js';
import { GeminiProvider } from '../ai/gemini.js';
import { readCredential } from '../repos/settings.js';

/** Builds each tenant's Gemini provider from its encrypted key; null when no key is set. */
export function createAiResolver(db: Db, fetchImpl: typeof fetch = fetch): (tenantId: string) => Promise<AIProvider | null> {
  return async (tenantId) => {
    const key = await withTenant(db, tenantId, (tx) => readCredential(tx, 'gemini_api_key'));
    return key ? new GeminiProvider(key, fetchImpl) : null;
  };
}
