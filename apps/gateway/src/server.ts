import './log-filter.js'; // must stay first: hides libsignal session dumps
import { readdir } from 'node:fs/promises';
import { createGatewayServer } from './app.js';
import { MockSessionDriver, SessionManager, type SessionDriver } from './sessions.js';
import { BaileysSessionDriver, sessionDir } from './baileys.js';
import { createAppSink } from './sink.js';

const driver = process.env.GATEWAY_DRIVER ?? 'mock';
const token = process.env.GATEWAY_TOKEN ?? '';
const root = process.env.SESSIONS_DIR ?? '/data/sessions';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let factory: (channelId: string) => SessionDriver;
if (driver === 'mock') {
  factory = () => new MockSessionDriver();
} else if (driver === 'baileys') {
  const sink = createAppSink(process.env.APP_EVENTS_URL ?? 'http://chatbot-app:3000/api/internal/gateway/events', token);
  factory = (id) => new BaileysSessionDriver(id, sessionDir(root, id), sink);
} else {
  console.error(`GATEWAY_DRIVER=${driver} is not supported. Use "mock" or "baileys".`);
  process.exit(1);
}

const sessions = new SessionManager(factory);
const server = createGatewayServer({ token, sessions });
const port = Number(process.env.PORT ?? 3100);
server.listen(port, () => console.log(`[gateway] listening on :${port} (driver=${driver})`));

if (driver === 'baileys') {
  const linked = (await readdir(root, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory() && UUID.test(d.name)).map((d) => d.name);
  if (linked.length) console.log(`[gateway] restoring ${linked.length} session(s)`);
  void sessions.restore(linked);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
