'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthState } from '@/lib/auth';
import { useSession } from '@/lib/session';
import { ErrorView, Loading } from '@/components/ui';

export function HomeRedirect() {
  const auth = useAuthState();
  const s = useSession();
  const router = useRouter();
  useEffect(() => {
    if (!auth.loaded) return;
    if (!auth.signedIn) { router.replace('/sign-in'); return; }
    if (sessionStorage.getItem('lg.pendingInvite')) { router.replace('/invite'); return; }
    if (!s.me) return;
    router.replace(s.me.active_org ? (s.me.subscription_state === 'setup_pending' ? '/setup' : '/inbox') : '/setup');
  }, [auth.loaded, auth.signedIn, s.me, router]);
  if (s.meError) return <main id="main" className="content"><ErrorView error={s.meError} onReload={() => location.reload()} /></main>;
  return <main id="main"><Loading label="Opening LeadGuard" /></main>;
}
