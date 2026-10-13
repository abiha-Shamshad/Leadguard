'use client';
// Authentication: Clerk owns sign-in, MFA and sessions (Section 7.1). NEXT_PUBLIC_AUTH_MODE=dev mirrors the
// API's AUTH_MODE=dev (never in production) so the app can run before the Clerk instance exists.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ClerkProvider, useAuth, useClerk } from '@clerk/nextjs';

export interface DevIdentity { id: string; email: string; name: string; support?: boolean }

export interface AuthState {
  mode: 'clerk' | 'dev';
  loaded: boolean;
  signedIn: boolean;
  getToken(): Promise<string | null>;
  signOut(): Promise<void>;
  /** Dev mode only. */
  devSignIn?(identity: DevIdentity): void;
  devIdentity?: DevIdentity | null;
}

const AuthContext = createContext<AuthState | null>(null);

export const AUTH_MODE: 'clerk' | 'dev' = process.env.NEXT_PUBLIC_AUTH_MODE === 'clerk' ? 'clerk' : 'dev';
const DEV_KEY = 'lg.devIdentity'; // an identity only - never lead data (Section 29.1)

function ClerkBridge({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const clerk = useClerk();
  const value = useMemo<AuthState>(() => ({
    mode: 'clerk',
    loaded: isLoaded,
    signedIn: Boolean(isSignedIn),
    getToken: () => getToken(),
    signOut: () => clerk.signOut(),
  }), [isLoaded, isSignedIn, getToken, clerk]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function DevAuth({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<DevIdentity | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DEV_KEY);
      const stored: DevIdentity | null = raw ? JSON.parse(raw) : null;
      // A support identity is only valid together with its grant, which lives in sessionStorage (per tab).
      if (stored?.support && !sessionStorage.getItem('lg.supportGrant')) localStorage.removeItem(DEV_KEY);
      else if (stored) setIdentity(stored);
    } catch { /* ignore */ }
    setLoaded(true);
  }, []);
  const devSignIn = useCallback((i: DevIdentity) => {
    localStorage.setItem(DEV_KEY, JSON.stringify(i));
    setIdentity(i);
  }, []);
  const value = useMemo<AuthState>(() => ({
    mode: 'dev',
    loaded,
    signedIn: Boolean(identity),
    devIdentity: identity,
    devSignIn,
    getToken: async () => (identity ? `${identity.support ? 'devsupport' : 'dev'}:${identity.id}:${identity.email}:${identity.name}` : null),
    signOut: async () => { localStorage.removeItem(DEV_KEY); setIdentity(null); },
  }), [identity, loaded, devSignIn]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  if (AUTH_MODE === 'clerk') {
    return <ClerkProvider><ClerkBridge>{children}</ClerkBridge></ClerkProvider>;
  }
  return <DevAuth>{children}</DevAuth>;
}

export function useAuthState(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuthState outside AuthProvider');
  return ctx;
}
