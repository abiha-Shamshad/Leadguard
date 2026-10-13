// Contact normalization and dedupe keys (Sections 9.3, 10).
import { createHash } from 'node:crypto';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

export interface NormalizedPhone {
  e164: string | null;
  raw: string | null;
}

export function normalizePhone(input: string | null | undefined, country: string = 'US'): NormalizedPhone {
  if (input === null || input === undefined) return { e164: null, raw: null };
  const trimmed = String(input).trim();
  if (!trimmed) return { e164: null, raw: null };
  const parsed = parsePhoneNumberFromString(trimmed, country as CountryCode);
  if (parsed && parsed.isValid()) return { e164: parsed.number, raw: null };
  return { e164: null, raw: trimmed.slice(0, 40) };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const v = String(input).trim().toLowerCase();
  if (!v) return null;
  return EMAIL_RE.test(v) && v.length <= 254 ? v : null;
}

export function isValidEmail(input: string): boolean {
  return EMAIL_RE.test(input.trim()) && input.trim().length <= 254;
}

/** `hash:` + hex SHA-256 of `source_id | email_norm | phone_e164 | message | occurred_at truncated to the minute`. */
export function hashDedupeKey(sourceId: string, emailNorm: string | null, phoneE164: string | null, message: string | null, occurredAtIso: string): string {
  const minute = new Date(occurredAtIso).toISOString().slice(0, 16);
  const h = createHash('sha256').update([sourceId, emailNorm ?? '', phoneE164 ?? '', message ?? '', minute].join('|')).digest('hex');
  return `hash:${h}`;
}

export function providerDedupeKey(family: 'form' | 'call', providerId: string): string {
  return `${family}:${providerId}`.slice(0, 200);
}

/** "(512) ***-0199" - phone shown on unassigned inbox rows. */
export function maskPhone(e164: string | null, raw: string | null): string | null {
  if (e164) {
    const parsed = parsePhoneNumberFromString(e164);
    const national = parsed?.formatNational() ?? e164;
    const digits = national.replace(/\D/g, '');
    if (parsed?.country === 'US' || parsed?.country === 'CA') {
      return `(${digits.slice(0, 3)}) ***-${digits.slice(-4)}`;
    }
    return `${national.slice(0, Math.max(0, national.length - 6)).replace(/\d/g, '*')}${national.slice(-4)}`;
  }
  if (raw) return raw.length > 4 ? '***' + raw.slice(-4) : '***';
  return null;
}

export function firstName(name: string | null): string | null {
  if (!name) return null;
  return name.trim().split(/\s+/)[0] || null;
}
