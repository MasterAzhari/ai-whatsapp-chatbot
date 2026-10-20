/**
 * libsignal (used by Baileys) prints whole session records, including key
 * material, with console.info/warn. Replace those lines with a short note so
 * secrets never reach container logs. Imported before anything else.
 */
const SESSION_DUMP = /^(Closing session|Opening session|Removing old closed session|Session already (closed|open)|Migrating session|Unhandled bucket type)/;

for (const level of ['log', 'info', 'warn', 'debug'] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && SESSION_DUMP.test(args[0])) {
      if (level === 'warn') orig(`[gateway] signal: ${args[0].replace(/:\s*$/, '')} (details hidden)`);
      return;
    }
    orig(...args);
  };
}

export {};
