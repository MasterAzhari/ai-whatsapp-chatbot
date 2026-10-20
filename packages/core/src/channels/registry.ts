import { withSystem, type Db } from '../db.js';
import type { ChannelAdapter } from './adapter.js';
import { GatewayChannelAdapter } from './gateway-client.js';
import { MockChannelAdapter } from './mock.js';
import type { AdapterResolver } from '../outbox.js';

/**
 * Picks the one active sending adapter for a channel from its provider setting.
 * The official Cloud API adapter arrives in Phase 3; until then such channels
 * resolve to null and their outbox rows wait with a clear reason.
 */
export function createAdapterResolver(db: Db): AdapterResolver & { mocks: Map<string, MockChannelAdapter> } {
  const mocks = new Map<string, MockChannelAdapter>();
  const cache = new Map<string, ChannelAdapter>();
  const resolve = async (_tenantId: string, channelId: string): Promise<ChannelAdapter | null> => {
    const hit = cache.get(channelId);
    if (hit) return hit;
    const provider = await withSystem(db, async (tx) =>
      (await tx.query<{ provider: string }>('SELECT provider FROM channels WHERE id = $1', [channelId])).rows[0]?.provider,
    );
    let adapter: ChannelAdapter | null = null;
    if (provider === 'mock') {
      const m = new MockChannelAdapter();
      mocks.set(channelId, m);
      adapter = m;
    } else if (provider === 'qr') {
      adapter = new GatewayChannelAdapter(channelId);
    }
    if (adapter) cache.set(channelId, adapter);
    return adapter;
  };
  return Object.assign(resolve, { mocks });
}
