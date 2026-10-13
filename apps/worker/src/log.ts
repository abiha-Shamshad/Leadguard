// Structured JSON logs: IDs, states and counts only - never names, emails, phones or messages (Section 32).
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: Level = 'info';
export function setLogLevel(l: string): void {
  if (l in ORDER) threshold = l as Level;
}

function write(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[level] < ORDER[threshold]) return;
  process.stdout.write(JSON.stringify({ level, time: new Date().toISOString(), service: 'worker', msg, ...fields }) + '\n');
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => write('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => write('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => write('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => write('error', m, f),
};

export function errFields(e: unknown): Record<string, unknown> {
  const err = e as { message?: string; code?: string; stack?: string };
  return { error: err?.message, code: err?.code, stack: err?.stack?.split('\n').slice(0, 5).join('\n') };
}
