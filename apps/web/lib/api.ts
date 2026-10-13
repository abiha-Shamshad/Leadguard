// Typed client for /api/v1 (Section 18). Contact search terms always travel in POST bodies, never URLs.

export interface ApiErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  details: Record<string, any>;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details: Record<string, any> = {}, readonly retryable = false) {
    super(message);
  }
  get fields(): Record<string, string> {
    return (this.details?.fields as Record<string, string>) ?? {};
  }
}

export interface Envelope<T> {
  success: true;
  message?: string;
  data: T;
  meta: { api_version: 'v1'; request_id: string; timestamp?: string };
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH';
  body?: unknown;
  token: string | null;
  orgId?: string | null;
  idempotencyKey?: string;
  supportGrantId?: string | null;
  signal?: AbortSignal;
}

const BASE = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, '');

export async function apiRequest<T>(path: string, o: RequestOptions): Promise<Envelope<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  if (o.orgId) headers['X-Org-Id'] = o.orgId;
  if (o.idempotencyKey) headers['Idempotency-Key'] = o.idempotencyKey;
  if (o.supportGrantId) headers['X-Support-Grant-Id'] = o.supportGrantId;
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/v1${path}`, {
      method: o.method ?? 'GET',
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      signal: o.signal,
      cache: 'no-store',
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach LeadGuard. Check your connection and try again.', {}, true);
  }
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok || !json?.success) {
    const err: ApiErrorBody | undefined = json?.error;
    throw new ApiError(res.status, err?.code ?? 'SERVICE_UNAVAILABLE', err?.message ?? 'Something went wrong. Try again shortly.', err?.details ?? {}, err?.retryable ?? res.status >= 500);
  }
  return json as Envelope<T>;
}

export function newIdempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}
