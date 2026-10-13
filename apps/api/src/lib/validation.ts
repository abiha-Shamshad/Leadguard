// Zod errors -> 400 VALIDATION_FAILED with `details.fields` (Section 34.2).
import type { ZodError } from 'zod';
import { AppError } from '@leadguard/contracts';

export function fieldPath(path: PropertyKey[]): string {
  let out = '';
  for (const p of path) {
    if (typeof p === 'number') out += `[${p}]`;
    else out += out ? `.${String(p)}` : String(p);
  }
  return out || 'body';
}

export function zodToValidation(err: ZodError, overrides: Record<string, string> = {}): AppError {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const path = fieldPath(issue.path);
    if (fields[path]) continue;
    fields[path] = issue.code === 'unrecognized_keys'
      ? `Unknown field(s): ${(issue as any).keys.join(', ')}.`
      : issue.message;
  }
  const first = Object.keys(fields)[0];
  const message = (first && overrides[first]) ?? 'Check the highlighted fields.';
  return new AppError('VALIDATION_FAILED', message, { fields });
}
