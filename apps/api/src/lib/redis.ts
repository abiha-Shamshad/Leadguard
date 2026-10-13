// Redis connection used by the API for rate-limit counters and the readiness check only.
import { Redis as IORedis } from 'ioredis';

export interface Redis {
  client: IORedis;
  available(): boolean;
  ping(timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

export function createRedis(url: string | null): Redis | null {
  if (!url) return null;
  const client = new IORedis(url, { lazyConnect: false, maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2000 });
  client.on('error', () => { /* status is reported by the readiness check; never crash the API */ });
  return {
    client,
    available: () => client.status === 'ready',
    async ping(timeoutMs = 500) {
      if (client.status !== 'ready') return false;
      try {
        const r = await Promise.race([client.ping(), new Promise<string>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]);
        return r === 'PONG';
      } catch {
        return false;
      }
    },
    async close() { client.disconnect(); },
  };
}
