'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useSession } from '@/lib/session';
import { useAuthState } from '@/lib/auth';
import { useOrgQuery } from '@/lib/hooks';
import { SUB_LABEL } from '@/lib/format';
import type { AlertItem, Permission } from '@/lib/types';
import { Banner, Button, Loading, ErrorView } from './ui';

interface NavItem { href: string; label: string; perm?: Permission; badge?: number }

export function AppShell({ children }: { children: ReactNode }) {
  const auth = useAuthState();
  const s = useSession();
  const router = useRouter();
  const path = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => { setMenuOpen(false); }, [path]);
  useEffect(() => {
    if (auth.loaded && !auth.signedIn) router.replace('/sign-in');
    else if (s.me && !s.me.active_org && !s.supportGrantId) router.replace('/setup');
  }, [auth.loaded, auth.signedIn, s.me, s.supportGrantId, router]);

  const alerts = useOrgQuery<{ unread: number; items: AlertItem[] }>(['alerts', 'badge'], '/alerts?state=open&limit=1', { refetchInterval: 60_000 });

  if (!auth.loaded || s.loading) return <main id="main"><Loading label="Loading LeadGuard" /></main>;
  if (s.meError) return <main id="main" className="content"><ErrorView error={s.meError} onReload={() => location.reload()} /></main>;
  if (!s.me || !s.me.active_org && !s.supportGrantId) return <main id="main"><Loading /></main>;

  const me = s.me;
  const nav: { section: string; items: NavItem[] }[] = [
    { section: 'Work', items: [
      { href: '/inbox', label: 'Needs action', perm: 'leads.read' },
      { href: '/leads', label: 'All leads', perm: 'leads.read' },
      { href: '/alerts', label: 'Alerts', perm: 'leads.read', badge: alerts.data?.unread },
    ] },
    { section: 'Manage', items: [
      { href: '/dashboard', label: 'Dashboard', perm: 'dashboard.read' },
      { href: '/sources', label: 'Sources', perm: 'sources.manage' },
      { href: '/team', label: 'Team', perm: 'members.manage' },
      { href: '/rules', label: 'Follow-up rules', perm: 'leads.read' },
    ] },
    { section: 'Settings', items: [
      { href: '/settings/organization', label: 'Organization', perm: 'leads.read' },
      { href: '/settings/notifications', label: 'Notifications' },
      { href: '/settings/billing', label: 'Subscription', perm: 'leads.read' },
      { href: '/settings/support', label: 'Support access', perm: 'support.grant' },
    ] },
  ];

  const sidebar = (
    <nav className="sidebar" data-open={menuOpen} aria-label="Main">
      <Link href="/inbox" className="brand"><span className="brand-mark" aria-hidden>LG</span>LeadGuard</Link>
      {nav.map(group => {
        const items = group.items.filter(i => !i.perm || s.can(i.perm) || (s.supportGrantId && i.perm === 'leads.read'));
        if (!items.length) return null;
        return (
          <div key={group.section} className="nav">
            <div className="nav-section">{group.section}</div>
            {items.map(i => (
              <Link key={i.href} href={i.href} aria-current={path === i.href || path.startsWith(i.href + '/') ? 'page' : undefined}>
                <span>{i.label}</span>
                {i.badge ? <span className="count" aria-label={`${i.badge} unread`}>{i.badge}</span> : null}
              </Link>
            ))}
          </div>
        );
      })}
      <div className="sidebar-foot">
        {me.organizations.length > 1 && !s.supportGrantId ? (
          <label className="small">
            <span className="muted">Organization</span>
            <select value={s.orgId ?? ''} onChange={e => { s.switchOrg(e.target.value); router.push('/inbox'); }}>
              {me.organizations.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
        ) : <div><strong>{me.active_org?.name}</strong><div className="muted small">{me.active_org?.role}</div></div>}
        <div className="small muted" title={me.user.email}>{me.user.name ?? me.user.email}</div>
        {s.supportGrantId ? <Button small onClick={() => { s.setSupportGrant(null); router.push('/sign-in'); }}>End support session</Button> : null}
        <Button small onClick={async () => { await s.signOut(); router.replace('/sign-in'); }}>Sign out</Button>
      </div>
    </nav>
  );

  const sub = me.subscription_state;
  return (
    <div className="shell">
      {sidebar}
      {menuOpen ? <div className="scrim" onClick={() => setMenuOpen(false)} aria-hidden /> : null}
      <div className="main">
        <header className="topbar">
          <Button small onClick={() => setMenuOpen(o => !o)} aria-expanded={menuOpen} aria-label="Open menu">Menu</Button>
          <strong>{me.active_org?.name ?? 'LeadGuard'}</strong>
          <Link href="/alerts" className="btn btn-small" aria-label={`Alerts, ${alerts.data?.unread ?? 0} unread`}>Alerts{alerts.data?.unread ? <span className="count">{alerts.data.unread}</span> : null}</Link>
        </header>
        <main id="main" className="content">
          {s.supportGrantId ? <Banner tone="warn">You are viewing this organization through a support access grant. Every request is audited.</Banner> : null}
          {sub === 'read_only' ? (
            <Banner tone="warn" action={<Link className="btn btn-small" href="/settings/billing">Export or reactivate</Link>}>
              <strong>{SUB_LABEL.read_only}.</strong> <p>Leads are read-only and new enquiries are rejected. Your data stays available to export.</p>
            </Banner>
          ) : sub === 'setup_pending' ? (
            <Banner tone="info" action={<Link className="btn btn-small" href="/setup">Continue setup</Link>}>
              <strong>{SUB_LABEL.setup_pending}.</strong> <p>Connect and verify a source - your trial starts after the first verified enquiry.</p>
            </Banner>
          ) : sub === 'past_due' ? (
            <Banner tone="warn" action={<Link className="btn btn-small" href="/settings/billing">Billing</Link>}><strong>{SUB_LABEL.past_due}.</strong></Banner>
          ) : null}
          {children}
        </main>
      </div>
    </div>
  );
}
