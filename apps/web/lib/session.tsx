'use client';
// Active user + organization. Query keys always start with ['org', orgId, ...]; switching organization or
// signing out clears the whole cache (Section 29.1).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest, ApiError } from './api';
import { useAuthState } from './auth';
import type { Me, Permission } from './types';

const ORG_KEY = 'lg.activeOrg';
const GRANT_KEY = 'lg.supportGrant';

export interface Session {
  me: Me | undefined;
  meError: ApiError | null;
  loading: boolean;
  orgId: string | null;
  timeZone: string;
  /** Support staff act under an owner-approved grant (X-Support-Grant-Id). */
  supportGrantId: string | null;
  can(p: Permission): boolean;
  writable: boolean;
  switchOrg(orgId: string): void;
  setSupportGrant(grantId: string | null): void;
  signOut(): Promise<void>;
  request<T>(path: string, init?: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH'; body?: unknown; idempotencyKey?: string; signal?: AbortSignal }): Promise<{ data: T; message?: string }>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const auth = useAuthState();
  const qc = useQueryClient();
  const [orgId, setOrgId] = useState<string | null>(null);
  const [grant, setGrant] = useState<string | null>(null);
  // Org chosen by the server when none is stored yet (single-org users, first visit).
  const serverOrg = useRef<string | null>(null);

  useEffect(() => {
    try {
      setOrgId(localStorage.getItem(ORG_KEY));
      setGrant(sessionStorage.getItem(GRANT_KEY));
    } catch { /* storage unavailable */ }
  }, []);

  const request = useCallback(async <T,>(path: string, init: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH'; body?: unknown; idempotencyKey?: string; signal?: AbortSignal } = {}) => {
    const token = await auth.getToken();
    const env = await apiRequest<T>(path, { ...init, token, orgId: grant ? null : (orgId ?? serverOrg.current), supportGrantId: grant });
    return { data: env.data, message: env.message };
  }, [auth, orgId, grant]);

  const meQuery = useQuery({
    queryKey: ['me', orgId, grant, auth.signedIn],
    queryFn: ({ signal }) => request<Me>('/me', { signal }).then(r => r.data),
    enabled: auth.loaded && auth.signedIn,
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
  });

  // An expired or rejected session goes back to sign-in instead of leaving the user on an error.
  useEffect(() => {
    const err = meQuery.error;
    if (err instanceof ApiError && err.status === 401) {
      qc.clear();
      localStorage.removeItem(ORG_KEY);
      sessionStorage.removeItem(GRANT_KEY);
      void auth.signOut().then(() => { if (!location.pathname.startsWith('/sign-in')) location.assign('/sign-in'); });
    }
  }, [meQuery.error, auth, qc]);

  // A stored org the user no longer belongs to falls back to the server's choice.
  useEffect(() => {
    const err = meQuery.error;
    if (err instanceof ApiError && err.status === 404 && orgId) {
      localStorage.removeItem(ORG_KEY);
      setOrgId(null);
    }
  }, [meQuery.error, orgId]);

  const me = meQuery.data;
  const activeOrgId = me?.active_org?.id ?? null;
  serverOrg.current = activeOrgId;

  const switchOrg = useCallback((id: string) => {
    localStorage.setItem(ORG_KEY, id);
    qc.clear();
    setOrgId(id);
  }, [qc]);

  const setSupportGrant = useCallback((id: string | null) => {
    if (id) sessionStorage.setItem(GRANT_KEY, id); else sessionStorage.removeItem(GRANT_KEY);
    qc.clear();
    setGrant(id);
  }, [qc]);

  const signOut = useCallback(async () => {
    qc.clear();
    localStorage.removeItem(ORG_KEY);
    sessionStorage.removeItem(GRANT_KEY);
    await auth.signOut();
  }, [auth, qc]);

  const value = useMemo<Session>(() => ({
    me,
    meError: (meQuery.error as ApiError) ?? null,
    loading: !auth.loaded || (auth.signedIn && meQuery.isPending),
    orgId: activeOrgId,
    timeZone: me?.active_org?.time_zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    supportGrantId: grant,
    can: p => Boolean(me?.permissions.includes(p)),
    writable: me?.subscription_state !== 'read_only',
    switchOrg,
    setSupportGrant,
    signOut,
    request,
  }), [me, meQuery.error, meQuery.isPending, auth.loaded, auth.signedIn, activeOrgId, grant, switchOrg, setSupportGrant, signOut, request]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}
