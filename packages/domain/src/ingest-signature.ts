// LeadGuard-defined webhook signature (scheme "v1", Section 9.4). Ported unchanged from domain/ingest-signature.mjs.
//   X-LeadGuard-Timestamp: <unix seconds>
//   X-LeadGuard-Signature: v1=<lowercase hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>
// rawBody must be the exact received bytes (Buffer), captured before JSON parsing.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const TOLERANCE_SECONDS = 300;

export function signV1(secret: string, timestamp: string, rawBody: Buffer | string): string {
  return 'v1=' + createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

export type VerifyResult = { ok: true } | { ok: false; reason: 'SIGNATURE_MISSING' | 'TIMESTAMP_INVALID' | 'TIMESTAMP_OUT_OF_WINDOW' | 'SIGNATURE_INVALID' };

/** secrets: [current, previousIfStillValid]. */
export function verifyV1(args: {
  secrets: (string | null | undefined)[];
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  rawBody: Buffer;
  nowSeconds: number;
}): VerifyResult {
  const { secrets, timestampHeader, signatureHeader, rawBody, nowSeconds } = args;
  if (!timestampHeader || !signatureHeader) return { ok: false, reason: 'SIGNATURE_MISSING' };
  if (!/^\d{10}$/.test(timestampHeader)) return { ok: false, reason: 'TIMESTAMP_INVALID' };
  if (Math.abs(nowSeconds - Number(timestampHeader)) > TOLERANCE_SECONDS) return { ok: false, reason: 'TIMESTAMP_OUT_OF_WINDOW' };
  const provided = Buffer.from(signatureHeader, 'utf8');
  for (const secret of secrets.filter((s): s is string => Boolean(s))) {
    const expected = Buffer.from(signV1(secret, timestampHeader, rawBody), 'utf8');
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) return { ok: true };
  }
  return { ok: false, reason: 'SIGNATURE_INVALID' };
}

/** secret_header mode (Section 9.1): constant-time compare against current and still-valid previous secret. */
export function verifySecretHeader(secrets: (string | null | undefined)[], header: string | undefined): boolean {
  if (!header) return false;
  const provided = Buffer.from(header, 'utf8');
  let ok = false;
  for (const secret of secrets.filter((s): s is string => Boolean(s))) {
    const expected = Buffer.from(secret, 'utf8');
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) ok = true;
  }
  return ok;
}
