'use client';
// Accept an invitation (API-009). The token arrives in the URL fragment (never sent to servers or logs) and is
// passed to the API in the request body.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthState } from '@/lib/auth';
import { useSession } from '@/lib/session';
import { useCommand } from '@/lib/hooks';
import { Button, Card, ErrorView, Loading } from '@/components/ui';

const PENDING_KEY = 'lg.pendingInvite';

export function InviteView() {
  const auth = useAuthState();
  const s = useSession();
  const router = useRouter();
  const qc = useQueryClient();
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    const fromHash = window.location.hash.slice(1);
    if (fromHash) {
      sessionStorage.setItem(PENDING_KEY, fromHash);
      history.replaceState(null, '', '/invite'); // drop the token from the address bar
    }
    setToken(fromHash || sessionStorage.getItem(PENDING_KEY));
  }, []);

  const cmd = useCommand<void, { org: { id: string; name: string } }>(() => ({ path: '/invitations/accept', body: { token }, idempotent: false }), {
    onSuccess: async d => {
      sessionStorage.removeItem(PENDING_KEY);
      s.switchOrg(d.org.id);
      await qc.invalidateQueries({ queryKey: ['me'] });
      router.replace('/inbox');
    },
  });

  if (!auth.loaded || token === null && typeof window === 'undefined') return <main id="main"><Loading /></main>;
  return (
    <main id="main" className="auth-page">
      <div className="auth-card">
        <Card title="Join your team on LeadGuard">
          {!token ? <p>This invitation link is incomplete. Ask your manager to send it again.</p>
            : !auth.signedIn ? (
              <>
                <p>Sign in with the email address the invitation was sent to, then come back to this page.</p>
                <Link className="btn btn-primary" href="/sign-in">Sign in</Link>
              </>
            ) : (
              <>
                <p>Signed in as <strong>{s.me?.user.email ?? '...'}</strong>.</p>
                <ErrorView error={cmd.error} compact />
                <Button variant="primary" pending={cmd.pending} onClick={() => void cmd.run()}>Accept invitation</Button>
              </>
            )}
        </Card>
      </div>
    </main>
  );
}
