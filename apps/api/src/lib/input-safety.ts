// Input safety checks applied to every product API body and query before schema validation.
// PostgreSQL rejects NUL (\u0000) in text with a server error; other C0 control characters are never valid in
// LeadGuard text fields. Keys that could pollute object prototypes are rejected outright.
import { AppError } from '@leadguard/contracts';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// Allowed whitespace controls: tab, line feed, carriage return.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const MAX_DEPTH = 8;

export function findUnsafeInput(value: unknown, path = 'body', depth = 0): string | null {
  if (depth > MAX_DEPTH) return path;
  if (typeof value === 'string') return CONTROL_RE.test(value) ? path : null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const p = findUnsafeInput(value[i], `${path}[${i}]`, depth + 1);
      if (p) return p;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k) || CONTROL_RE.test(k)) return `${path}.${k}`;
      const p = findUnsafeInput(v, `${path}.${k}`, depth + 1);
      if (p) return p;
    }
  }
  return null;
}

export function assertSafeInput(value: unknown, root: string): void {
  const bad = findUnsafeInput(value, root);
  if (bad) {
    throw new AppError('VALIDATION_FAILED', 'The request contains characters or fields that are not allowed.', { fields: { [bad]: 'Remove control characters or reserved field names.' } });
  }
}

/** Ingest payloads come from third-party tools: strip control characters instead of rejecting the lead. */
export function stripControlChars(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

export function isForbiddenKey(k: string): boolean {
  return FORBIDDEN_KEYS.has(k);
}
