'use client';
// Needs Action inbox (API-022): what needs action, who owns it, what happens next. Overdue, due soon and
// unassigned are separate groups, each with its own "load more"; logging a call happens in a side sheet so the
// list (and its scroll position) stays in place.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useSession } from '@/lib/session';
import { useCommand, useInvalidate, useOrgQuery } from '@/lib/hooks';
import { relativeMinutes } from '@/lib/format';
import type { Inbox, InboxItem, InboxSection } from '@/lib/types';
import { Badge, Button, Card, Dialog, Empty, ErrorView, Loading, Notice, PageHead } from '@/components/ui';
import { ActivityForm } from '@/components/activity-form';

const TITLES: Record<InboxSection, { title: string; empty: string }> = {
  overdue: { title: 'Overdue', empty: 'Nothing overdue. Nice work.' },
  due_soon: { title: 'Due soon', empty: 'No upcoming follow-ups.' },
  unassigned: { title: 'Unassigned', empty: 'Every lead has an owner.' },
};

export function InboxView() {
  const s = useSession();
  const canTeam = s.can('dashboard.read') || Boolean(s.supportGrantId);
  const [view, setView] = useState<'mine' | 'team'>('team');
  const effective = canTeam ? view : 'mine';
  const q = useOrgQuery<Inbox>(['inbox', effective], `/inbox?view=${effective}`, { refetchInterval: 60_000 });
  const invalidate = useInvalidate();
  const [sheet, setSheet] = useState<InboxItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <>
      <PageHead
        title="Needs action"
        subtitle="What needs action now, who owns it and what happens next."
        actions={canTeam ? (
          <div className="row" role="group" aria-label="Inbox view">
            <Button small variant={effective === 'team' ? 'primary' : 'default'} aria-pressed={effective === 'team'} onClick={() => setView('team')}>Team</Button>
            <Button small variant={effective === 'mine' ? 'primary' : 'default'} aria-pressed={effective === 'mine'} onClick={() => setView('mine')}>Mine</Button>
          </div>
        ) : null}
      />
      <Notice text={notice} />
      {q.isPending ? <Loading label="Loading inbox" /> : q.error ? <ErrorView error={q.error} onReload={() => void q.refetch()} /> : (
        <div className="stack">
          {(['overdue', 'due_soon', 'unassigned'] as InboxSection[]).map(sec => (
            <SectionList key={sec} section={sec} data={q.data} view={effective}
              onLog={item => setSheet(item)}
              onChanged={msg => { setNotice(msg ?? null); void invalidate('inbox'); void invalidate('alerts'); }} />
          ))}
        </div>
      )}
      <Dialog open={Boolean(sheet)} onClose={() => setSheet(null)} title={`Log activity${sheet?.name ? ` - ${sheet.name}` : ''}`} variant="sheet">
        {sheet ? (
          <ActivityForm leadId={sheet.id} version={sheet.version}
            onReload={() => { void invalidate('inbox'); setSheet(null); }}
            onDone={msg => { setSheet(null); setNotice(msg ?? 'Saved.'); void invalidate('inbox'); void invalidate('lead', sheet.id); }} />
        ) : null}
      </Dialog>
    </>
  );
}

function SectionList({ section, data, view, onLog, onChanged }: { section: InboxSection; data: Inbox; view: string; onLog: (i: InboxItem) => void; onChanged: (msg?: string) => void }) {
  const s = useSession();
  const [extra, setExtra] = useState<InboxItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(data.cursors[section]);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => { setExtra([]); setCursor(data.cursors[section]); }, [data, section]);
  const items = [...data.sections[section], ...extra];
  const t = TITLES[section];

  const claim = useCommand<InboxItem, unknown>(item => ({ path: `/leads/${item.id}/assign`, body: { expected_version: item.version, owner_id: 'me' } }), {
    onSuccess: (_d, _v, msg) => onChanged(msg),
  });

  return (
    <Card>
      <div className="section-head">
        <h2 style={{ margin: 0 }}>{t.title} <Badge tone={section === 'overdue' && data.counts[section] ? 'bad' : 'muted'}>{data.counts[section]}</Badge></h2>
      </div>
      {claim.error ? <ErrorView error={claim.error} compact onReload={() => onChanged()} /> : null}
      {!items.length ? <p className="muted" style={{ margin: '8px 0 0' }}>{t.empty}</p> : (
        <ul className="list" aria-label={t.title}>
          {items.map(item => (
            <li key={item.id} className="lead-row">
              <div>
                <Link className="title" href={`/leads/${item.id}`}>{item.name ?? item.phone_masked ?? 'Unnamed lead'}</Link>
                {item.is_test ? <> <Badge tone="info">TEST</Badge></> : null}
                {item.escalated ? <> <Badge tone="warn">Escalated</Badge></> : null}
                <div className="meta">
                  <span>{item.next_action ?? 'No next action'}</span>
                  {section === 'overdue' ? <span style={{ color: 'var(--bad)', fontWeight: 600 }}>Overdue {relativeMinutes(item.overdue_minutes)}</span> : null}
                  {section === 'due_soon' ? <span>{item.due_at_local ? `Due ${item.due_at_local}` : 'No due time'}{item.due_in_minutes !== null && item.due_in_minutes !== undefined ? ` (in ${relativeMinutes(item.due_in_minutes)})` : ''}</span> : null}
                  {section === 'unassigned' ? <span>Waiting {relativeMinutes(item.waiting_minutes)}</span> : null}
                  <span>{item.owner ? `Owner: ${item.owner}` : 'No owner'}</span>
                  <span>{item.source}</span>
                </div>
              </div>
              <div className="row">
                {section === 'unassigned'
                  ? <Button small variant="primary" pending={claim.pending} disabled={!s.writable || Boolean(s.supportGrantId)} onClick={() => void claim.run(item)}>Claim</Button>
                  : <Button small variant="primary" disabled={!s.writable || Boolean(s.supportGrantId)} onClick={() => onLog(item)}>Log call</Button>}
                <Link className="btn btn-small" href={`/leads/${item.id}`}>Open</Link>
              </div>
            </li>
          ))}
        </ul>
      )}
      {cursor ? (
        <Button small pending={loadingMore} style={{ marginTop: 8 }} onClick={async () => {
          setLoadingMore(true);
          try {
            const r = await s.request<Inbox>(`/inbox?view=${view}&section=${section}&cursor=${encodeURIComponent(cursor)}`);
            setExtra(e => [...e, ...r.data.sections[section]]);
            setCursor(r.data.cursors[section]);
          } finally { setLoadingMore(false); }
        }}>Load more</Button>
      ) : null}
    </Card>
  );
}

export function EmptyInbox() {
  return <Empty title="All caught up" />;
}
