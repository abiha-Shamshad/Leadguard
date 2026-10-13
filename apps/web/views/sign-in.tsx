'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SignIn } from '@clerk/nextjs';
import { AUTH_MODE, useAuthState } from '@/lib/auth';
import { useSession } from '@/lib/session';
import { Banner, Button, Card, TextInput } from '@/components/ui';
import { LIMITS, MESSAGES, PATTERNS } from '@/lib/limits';

const DEMO = [
  { id: 'demo_owner', email: 'owner@example.com', name: 'Chris Owner' },
  { id: 'demo_manager', email: 'manager@example.com', name: 'Morgan Manager' },
  { id: 'demo_member', email: 'member@example.com', name: 'Maria Member' },
];

export function SignInView() {
  const auth = useAuthState();
  const router = useRouter();
  useEffect(() => { if (auth.loaded && auth.signedIn) router.replace('/'); }, [auth.loaded, auth.signedIn, router]);

  if (AUTH_MODE === 'clerk') {
    return <main id="main" className="auth-page"><SignIn routing="path" path="/sign-in" forceRedirectUrl="/" /></main>;
  }
  return <main id="main" className="auth-page"><DevSignIn /></main>;
}

/** Development-only sign-in (API must run with AUTH_MODE=dev). Production uses Clerk. */
function DevSignIn() {
  const auth = useAuthState();
  const s = useSession();
  const router = useRouter();
  const [id, setId] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [grant, setGrant] = useState('');
  const [error, setError] = useState<string | null>(null);
  const valid = /^[A-Za-z0-9_-]{3,60}$/.test(id) && /^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/.test(email) && name.trim().length > 0 && !name.includes(':');

  return (
    <div className="auth-card">
      <div className="brand" style={{ justifyContent: 'center', fontSize: '1.4rem' }}><span className="brand-mark" aria-hidden>LG</span>LeadGuard</div>
      <Card title="Sign in (development)">
        <Banner tone="warn"><p>Development sign-in. Production uses Clerk (set NEXT_PUBLIC_AUTH_MODE=clerk).</p></Banner>
        <form onSubmit={e => {
          e.preventDefault();
          if (!valid) { setError('Enter a user ID (letters, digits, _ or -), a valid email and a name.'); return; }
          auth.devSignIn?.({ id, email, name: name.trim(), support: Boolean(grant.trim()) });
          if (grant) s.setSupportGrant(grant.trim()); else s.setSupportGrant(null);
          router.replace(grant ? '/inbox' : '/');
        }}>
          <TextInput label="User ID" value={id} onChange={e => setId(e.target.value)} autoComplete="username" hint="Stands in for the Clerk user ID." required minLength={3} maxLength={LIMITS.devUserId} pattern={PATTERNS.devUserId} invalidMessage={MESSAGES.devUserId} />
          <TextInput label="Email" type="email" maxLength={LIMITS.email} pattern={PATTERNS.email} invalidMessage={MESSAGES.email} value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" required />
          <TextInput label="Name" value={name} onChange={e => setName(e.target.value)} autoComplete="name" required maxLength={LIMITS.devName} pattern={PATTERNS.noColon} invalidMessage="Names cannot contain a colon." />
          <TextInput label="Support grant ID (support staff only)" value={grant} onChange={e => setGrant(e.target.value.trim())} maxLength={36} pattern={PATTERNS.uuid} invalidMessage="A grant ID is 36 characters, given to you by the account owner." autoComplete="off" hint="Leave empty for a normal sign-in." />
          {error ? <p className="error" role="alert" style={{ color: 'var(--bad)' }}>{error}</p> : null}
          <Button variant="primary" type="submit" style={{ width: '100%' }}>Sign in</Button>
        </form>
        <div className="small muted" style={{ marginTop: 16 }}>
          Quick fill:{' '}
          {DEMO.map(d => <button key={d.id} type="button" className="btn-link" style={{ marginRight: 10 }} onClick={() => { setId(d.id); setEmail(d.email); setName(d.name); }}>{d.name}</button>)}
        </div>
      </Card>
    </div>
  );
}
