'use client';
import { useCallback, useRef, useState } from 'react';
import { useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { ApiError, newIdempotencyKey } from './api';
import { useSession } from './session';

/** GET with an org-scoped key: ['org', orgId, ...key]. */
export function useOrgQuery<T>(key: unknown[], path: string | null, opts: Partial<UseQueryOptions<T, ApiError>> = {}) {
  const s = useSession();
  return useQuery<T, ApiError>({
    queryKey: ['org', s.orgId, s.supportGrantId, ...key],
    queryFn: ({ signal }) => s.request<T>(path!, { signal }).then(r => r.data),
    enabled: Boolean(s.orgId && path) && (opts.enabled ?? true),
    retry: (n, e) => !(e instanceof ApiError && e.status > 0 && e.status < 500) && n < 2,
    ...opts,
  } as UseQueryOptions<T, ApiError>);
}

export function useInvalidate() {
  const qc = useQueryClient();
  const s = useSession();
  return useCallback((...key: unknown[]) => qc.invalidateQueries({ queryKey: ['org', s.orgId, s.supportGrantId, ...key] }), [qc, s.orgId, s.supportGrantId]);
}

export interface Command<V, R> {
  run(vars: V): Promise<R | undefined>;
  pending: boolean;
  error: ApiError | null;
  message: string | null;
  clearError(): void;
}

/**
 * A side-effect action. Disabled while pending; a retry after a failure reuses the same Idempotency-Key, and a
 * new key is issued only after success (Section 29.1). No optimistic updates - the UI shows the server result.
 */
export function useCommand<V, R = unknown>(
  build: (vars: V, idempotencyKey: string) => { path: string; method?: 'POST' | 'PUT' | 'PATCH'; body?: unknown; idempotent?: boolean },
  opts: { onSuccess?: (data: R, vars: V, message?: string) => void | Promise<void> } = {},
): Command<V, R> {
  const s = useSession();
  const keyRef = useRef<string>(newIdempotencyKey());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const run = useCallback(async (vars: V) => {
    if (pending) return undefined;
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const req = build(vars, keyRef.current);
      const r = await s.request<R>(req.path, {
        method: req.method ?? 'POST', body: req.body ?? {}, idempotencyKey: req.idempotent === false ? undefined : keyRef.current,
      });
      keyRef.current = newIdempotencyKey();
      setMessage(r.message ?? null);
      await opts.onSuccess?.(r.data, vars, r.message);
      return r.data;
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', (e as Error).message));
      return undefined;
    } finally {
      setPending(false);
    }
  }, [pending, build, s, opts]);
  return { run, pending, error, message, clearError: () => setError(null) };
}
