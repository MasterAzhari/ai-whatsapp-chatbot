import type { Db } from '../db.js';
import { withTenant } from '../db.js';
import type { AIProvider } from '../ai/provider.js';
import { GeminiProvider } from '../ai/gemini.js';
import { AnthropicProvider } from '../ai/anthropic.js';
import { KEY_KIND, loadSettings, readCredential } from '../repos/settings.js';

/** Builds the tenant's selected AI provider from its encrypted key; null when no key is set. */
export function createAiResolver(db: Db, fetchImpl: typeof fetch = fetch): (tenantId: string) => Promise<AIProvider | null> {
  return async (tenantId) => {
    const { provider, key } = await withTenant(db, tenantId, async (tx) => {
      const s = await loadSettings(tx, tenantId);
      return { provider: s.aiProvider, key: await readCredential(tx, KEY_KIND[s.aiProvider]) };
    });
    if (!key) return null;
    return provider === 'anthropic' ? new AnthropicProvider(key, fetchImpl) : new GeminiProvider(key, fetchImpl);
  };
}
