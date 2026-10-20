import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { SessionManager } from './sessions.js';

/**
 * Internal HTTP API used only by the app container. Every route except /health
 * requires the shared GATEWAY_TOKEN; the port is never published to the internet.
 */
export function createGatewayServer(opts: { token: string; sessions: SessionManager; maxBodyBytes?: number }): Server {
  if (!opts.token || opts.token.length < 24) throw new Error('GATEWAY_TOKEN must be at least 24 characters');
  const expected = Buffer.from(`Bearer ${opts.token}`);
  const maxBody = opts.maxBodyBytes ?? 64 * 1024;

  const authorised = (req: IncomingMessage) => {
    const got = Buffer.from(req.headers.authorization ?? '');
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage) =>
    new Promise<unknown>((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBody) {
          reject(Object.assign(new Error('body too large'), { status: 413 }));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
        }
      });
      req.on('error', reject);
    });

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://gateway');
      if (url.pathname === '/health') return json(res, 200, { ok: true });
      if (!authorised(req)) return json(res, 401, { error: 'unauthorised' });

      const m = url.pathname.match(/^\/channels\/([0-9a-f-]{36})\/(status|connect|logout|send-text)$/i);
      if (!m) return json(res, 404, { error: 'not found' });
      const [, channelId, action] = m as unknown as [string, string, string];
      const session = opts.sessions.get(channelId);

      if (action === 'status' && req.method === 'GET') return json(res, 200, session.status());
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      const body = (await readBody(req)) as Record<string, unknown>;

      if (action === 'connect') {
        await session.connect();
        return json(res, 200, session.status());
      }
      if (action === 'logout') {
        await session.logout();
        return json(res, 200, session.status());
      }
      // send-text
      const { to, text, idempotencyKey } = body;
      if (typeof to !== 'string' || typeof text !== 'string' || typeof idempotencyKey !== 'string' || !text || text.length > 4096) {
        return json(res, 400, { error: 'to, text and idempotencyKey are required' });
      }
      const r = await session.sendText(to, text, idempotencyKey);
      return json(res, 200, { ok: true, providerMessageId: r.providerMessageId, status: 'sent' });
    } catch (err) {
      const e = err as Error & { status?: number };
      return json(res, e.status ?? 500, { error: e.message });
    }
  });
}
