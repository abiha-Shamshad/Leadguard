// Product API envelopes (Section 18.2).

export interface Meta {
  api_version: 'v1';
  request_id: string;
  timestamp?: string;
}

export interface SuccessEnvelope<T> {
  success: true;
  message?: string;
  data: T;
  meta: Meta;
}

export interface ErrorEnvelope {
  success: false;
  error: { code: string; message: string; retryable: boolean; details: Record<string, unknown> };
  meta: Meta;
}

export function successEnvelope<T>(data: T, requestId: string, message?: string, timestamp: Date = new Date()): SuccessEnvelope<T> {
  const env: SuccessEnvelope<T> = { success: true, data, meta: { api_version: 'v1', request_id: requestId, timestamp: isoSeconds(timestamp) } };
  if (message) return { success: true, message, data, meta: env.meta };
  return env;
}

export function errorEnvelope(code: string, message: string, requestId: string, details: Record<string, unknown> = {}, retryable = false): ErrorEnvelope {
  return { success: false, error: { code, message, retryable, details }, meta: { api_version: 'v1', request_id: requestId } };
}

/** ISO 8601 UTC without milliseconds, as used in every example. */
export function isoSeconds(d: Date | string | null | undefined): string {
  if (!d) return null as unknown as string;
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function isoOrNull(d: Date | string | null | undefined): string | null {
  return d ? isoSeconds(d) : null;
}
