// API service entry point. Graceful shutdown waits up to 30 s for in-flight requests (Section 36.2).
import { loadConfig } from './config.ts';
import { buildDeps } from './deps.ts';
import { buildApp } from './app.ts';

const config = loadConfig();
const deps = buildDeps(config);
const app = await buildApp(deps);

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  const timer = setTimeout(() => process.exit(1), 30_000);
  try {
    await app.close();
    await deps.close();
  } finally {
    clearTimeout(timer);
    process.exit(0);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
