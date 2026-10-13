'use client';
// Alerts (API-036/037). Acknowledging records that you saw it; it never hides the lead from the inbox.
import Link from 'next/link';
import { useState } from 'react';
import { useSession } from '@/lib/session';
import { useCommand, useInvalidate, useOrgQuery } from '@/lib/hooks';
import { formatInZone } from '@/lib/format';
import type { AlertItem } from '@/lib/types';
import { Badge, Button, Card, Empty, ErrorView, Loading, Notice, PageHead } from '@/components/ui';

export function AlertsView() {
  const s = useSession();
  const [state, setState] = useState<'open' | 'acknowledged' | 'all'>('open');
  const q = useOrgQuery<{ items: AlertItem[]; unread: number; next_cursor: string | null }>(['alerts', state], `/alerts?state=${state}&limit=50`, { refetchInterval: 60_000 });
  const invalidate = useInvalidate();
  const [notice, setNotice] = useState<string | null>(null);
  const ack = useCommand<string>(id => ({ path: `/alerts/${id}/acknowledge`, body: {} }), {
    onSuccess: (_d, _v, m) => { setNotice(m ?? 'Acknowledged.'); void invalidate('alerts'); },
  });
  return (
    <>
      <PageHead title="Alerts" subtitle="Reminders and escalations sent to you."
        actions={<div className="row" role="group" aria-label="Filter alerts">
          {(['open', 'acknowledged', 'all'] as const).map(v => <Button key={v} small variant={state === v ? 'primary' : 'default'} aria-pressed={state === v} onClick={() => setState(v)}>{v === 'open' ? 'Not acknowledged' : v[0].toUpperCase() + v.slice(1)}</Button>)}
        </div>} />
      <Notice text={notice} />
      <ErrorView error={ack.error} compact />
      <Card>
        {q.isPending ? <Loading label="Loading alerts" /> : q.error ? <ErrorView error={q.error} onReload={() => void q.refetch()} /> : !q.data.items.length ? (
          <Empty title="No alerts">{state === 'open' ? <p>You are all caught up.</p> : null}</Empty>
        ) : (
          <ul className="list">
            {q.data.items.map(a => (
              <li key={a.id} className="lead-row">
                <div>
                  <Badge tone={a.kind === 'reminder' ? 'info' : 'warn'}>{a.kind === 'reminder' ? 'Reminder' : a.kind === 'escalation' ? 'Escalation' : 'Unassigned'}</Badge>{' '}
                  <Link className="title" href={`/leads/${a.lead_id}`}>{a.lead_name ?? 'Unnamed lead'}</Link>
                  <div className="meta">
                    <span>{a.text}</span>
                    <span>{formatInZone(a.created_at, s.timeZone)}</span>
                    {a.my_deliveries.map(d => <span key={d.channel}>{d.channel.replace('_', '-')}: {d.state}</span>)}
                  </div>
                </div>
                <div className="row">
                  {a.acknowledged ? <Badge tone="ok">Acknowledged</Badge> : <Button small pending={ack.pending} onClick={() => void ack.run(a.id)}>Acknowledge</Button>}
                  <Link className="btn btn-small" href={`/leads/${a.lead_id}`}>Open lead</Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
