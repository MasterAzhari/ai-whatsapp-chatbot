import type { InboundSink } from './sessions.js';

/**
 * Posts normalised events to the app's internal webhook. WhatsApp does not
 * redeliver, so failed posts are retried with backoff from memory (best effort;
 * a gateway restart while the app is down can still lose events).
 */
export function createAppSink(url: string, token: string, log = console.error): InboundSink {
  const queue: Array<{ channelId: string; events: unknown[]; attempts: number }> = [];
  let timer: NodeJS.Timeout | null = null;

  const post = async (channelId: string, events: unknown[]) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channelId, events }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status >= 500 || res.status === 429) throw new Error(`app HTTP ${res.status}`);
    if (!res.ok) log(`[gateway] app rejected events: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`); // 4xx: do not retry
  };

  const drain = async () => {
    timer = null;
    while (queue.length) {
      const item = queue[0]!;
      try {
        await post(item.channelId, item.events);
        queue.shift();
      } catch (err) {
        item.attempts++;
        if (item.attempts >= 12) {
          log(`[gateway] dropping ${item.events.length} events after ${item.attempts} attempts: ${(err as Error).message}`);
          queue.shift();
          continue;
        }
        timer = setTimeout(drain, Math.min(60_000, 1000 * 2 ** item.attempts));
        return;
      }
    }
  };

  return async (channelId, events) => {
    // 100 events per post, the app's limit.
    for (let i = 0; i < events.length; i += 100) queue.push({ channelId, events: events.slice(i, i + 100), attempts: 0 });
    if (!timer) await drain();
  };
}
