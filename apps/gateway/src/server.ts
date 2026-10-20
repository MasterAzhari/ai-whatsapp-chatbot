import { createGatewayServer } from './app.js';
import { MockSessionDriver, SessionManager } from './sessions.js';

const driver = process.env.GATEWAY_DRIVER ?? 'mock';
if (driver !== 'mock') {
  console.error(`GATEWAY_DRIVER=${driver} is not implemented yet (Phase 2). Use "mock".`);
  process.exit(1);
}

const server = createGatewayServer({
  token: process.env.GATEWAY_TOKEN ?? '',
  sessions: new SessionManager(() => new MockSessionDriver()),
});
const port = Number(process.env.PORT ?? 3100);
server.listen(port, () => console.log(`[gateway] listening on :${port} (driver=${driver})`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
