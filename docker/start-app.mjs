// Runs migrations, then supervises the web server and the outbox worker.
// If either exits, the other is stopped and the container exits so Docker restarts it.
import { spawn } from 'node:child_process';

function run(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
  child.name = name;
  return child;
}

const migrate = run('migrate', 'node', ['packages/core/dist/src/cli/migrate.js']);
const code = await new Promise((r) => migrate.on('exit', r));
if (code !== 0) {
  console.error('[start] migrations failed; not starting');
  process.exit(code ?? 1);
}

const children = [
  run('web', 'node', ['../../node_modules/next/dist/bin/next', 'start', '-p', process.env.PORT ?? '3000'], { cwd: 'apps/web' }),
  run('worker', 'node', ['packages/core/dist/src/cli/worker.js']),
];
let stopping = false;
const stopAll = (sig) => {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill(sig);
  setTimeout(() => process.exit(1), 20_000).unref();
};
for (const c of children) {
  c.on('exit', (code) => {
    console.log(`[start] ${c.name} exited (${code})`);
    stopAll('SIGTERM');
    if (children.every((x) => x.exitCode !== null)) process.exit(stopping && code === 0 ? 0 : 1);
  });
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => stopAll(sig));
