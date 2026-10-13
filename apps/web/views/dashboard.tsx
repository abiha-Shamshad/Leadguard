'use client';
// Manager dashboard (API-039..041): factual counts with definitions shown on hover/focus; each exception links
// to its fix. No revenue, ROI or "recovered" estimates.
import Link from 'next/link';
import { useState } from 'react';
import { useSession } from '@/lib/session';
import { useOrgQuery } from '@/lib/hooks';
import { dateInZone, formatInZone, SOURCE_STATUS, todayInZone } from '@/lib/format';
import { Badge, Card, Empty, ErrorView, Loading, PageHead, TextInput } from '@/components/ui';

interface Summary {
  range: { from: string; to: string; time_zone: string };
  leads: { received: number; test_excluded: number; by_source: { source: string; count: number }[] };
  first_action: { median_minutes: number | null; p90_minutes: number | null; within_target_pct: number | null; no_action_yet: number };
  unattended: { overdue_now: number; unassigned_now: number; escalations_sent: number };
  outcomes: Record<'contacted' | 'won' | 'lost' | 'spam' | 'open', number>;
  definitions: Record<string, string>;
}
interface Exception { type: string; text: string; since: string; action: string; lead_id?: string; source_id?: string; alert_id?: string; export_id?: string }
interface Health { source_id: string; name: string; status: string; last_event_at: string | null; last_7d: { accepted: number; duplicate: number; rejected: number }; silence_alert: boolean }

function fixLink(e: Exception): string {
  if (e.lead_id) return `/leads/${e.lead_id}`;
  if (e.source_id) return `/sources/${e.source_id}`;
  if (e.type === 'fixed_owner_inactive') return '/rules';
  if (e.type === 'no_business_hours') return '/settings/organization';
  if (e.type.startsWith('billing') || e.type.startsWith('subscription') || e.type === 'export_failed') return '/settings/billing';
  return '/dashboard';
}

function Stat({ label, value, def }: { label: string; value: React.ReactNode; def?: string }) {
  return (
    <div className="card stat" title={def} tabIndex={def ? 0 : undefined}>
      <div className="value">{value ?? '-'}</div>
      <div className="label">{label}</div>
      {def ? <span className="sr-only">Definition: {def}</span> : null}
    </div>
  );
}

export function DashboardView() {
  const s = useSession();
  const today = todayInZone(s.timeZone);
  const [from, setFrom] = useState(() => dateInZone(new Date(Date.now() - 13 * 86_400_000), s.timeZone));
  const [to, setTo] = useState(today);
  const range = from && to ? `?from=${from}&to=${to}` : '';
  const summary = useOrgQuery<Summary>(['dashboard', 'summary', from, to], `/dashboard/summary${range}`);
  const exceptions = useOrgQuery<{ items: Exception[]; next_cursor: string | null }>(['dashboard', 'exceptions'], '/dashboard/exceptions?limit=50', { refetchInterval: 60_000 });
  const health = useOrgQuery<{ items: Health[] }>(['dashboard', 'health'], '/dashboard/source-health');
  const d = summary.data;
  const def = d?.definitions ?? {};

  return (
    <>
      <PageHead title="Dashboard" subtitle="What happened, and what needs fixing. Counts only - no estimates."
        actions={<form className="row" onSubmit={e => e.preventDefault()} aria-label="Date range">
          <TextInput label="From" type="date" value={from} max={to} min="2020-01-01" required onChange={e => setFrom(e.target.value)} />
          <TextInput label="To" type="date" value={to} min={from} max={today} required onChange={e => setTo(e.target.value)} />
        </form>} />

      {summary.isPending ? <Loading label="Loading dashboard" /> : summary.error ? <ErrorView error={summary.error} onReload={() => void summary.refetch()} /> : d ? (
        <div className="stack">
          <div className="grid grid-4">
            <Stat label="Leads received" value={d.leads.received} def={`${def.cohort ?? ''} (test leads excluded: ${d.leads.test_excluded})`} />
            <Stat label="Median first action" value={d.first_action.median_minutes !== null ? `${d.first_action.median_minutes} min` : null} def={`${def.first_action}; ${def.time_basis}`} />
            <Stat label="90th percentile first action" value={d.first_action.p90_minutes !== null ? `${d.first_action.p90_minutes} min` : null} def={`${def.first_action}; ${def.time_basis}`} />
            <Stat label="First action within target" value={d.first_action.within_target_pct !== null ? `${d.first_action.within_target_pct}%` : null} def={def.within_target_pct} />
            <Stat label="Overdue now" value={d.unattended.overdue_now} />
            <Stat label="Unassigned now" value={d.unattended.unassigned_now} />
            <Stat label="Escalations sent" value={d.unattended.escalations_sent} />
            <Stat label="No action yet" value={d.first_action.no_action_yet} def="Cohort leads still new or attempted with no call, text, email or visit logged" />
          </div>
          <div className="grid grid-2">
            <Card title="Leads by source">
              {d.leads.by_source.length ? <table><tbody>{d.leads.by_source.map(r => <tr key={r.source}><td>{r.source}</td><td style={{ textAlign: 'right' }}>{r.count}</td></tr>)}</tbody></table> : <p className="muted">No leads in this range.</p>}
            </Card>
            <Card title="Outcomes">
              <table><tbody>{Object.entries(d.outcomes).map(([k, v]) => <tr key={k}><td style={{ textTransform: 'capitalize' }}>{k}</td><td style={{ textAlign: 'right' }}>{v}</td></tr>)}</tbody></table>
              <p className="small muted" style={{ marginTop: 8 }}>Won and lost are recorded outcomes; LeadGuard does not estimate revenue.</p>
            </Card>
          </div>
        </div>
      ) : null}

      <Card title="Needs fixing">
        {exceptions.isPending ? <Loading /> : exceptions.error ? <ErrorView error={exceptions.error} compact /> : !exceptions.data.items.length ? (
          <Empty title="Nothing to fix" />
        ) : (
          <ul className="list">
            {exceptions.data.items.map((e, i) => (
              <li key={i} className="lead-row">
                <div>
                  <Badge tone={e.type.includes('not_delivered') || e.type === 'source_failing' ? 'bad' : 'warn'}>{e.type.replaceAll('_', ' ')}</Badge>
                  <div>{e.text}</div>
                  <div className="meta"><span>Since {formatInZone(e.since, s.timeZone)}</span></div>
                </div>
                <Link className="btn btn-small" href={fixLink(e)}>{e.action}</Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Source health (last 7 days)">
        {health.isPending ? <Loading /> : health.error ? <ErrorView error={health.error} compact /> : !health.data.items.length ? <p className="muted">No sources yet.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th scope="col">Source</th><th scope="col">Status</th><th scope="col">Last event</th><th scope="col">Accepted</th><th scope="col">Duplicate</th><th scope="col">Rejected</th></tr></thead>
            <tbody>{health.data.items.map(h => {
              const st = SOURCE_STATUS[h.status];
              return (
                <tr key={h.source_id}>
                  <td><Link href={`/sources/${h.source_id}`}>{h.name}</Link>{h.silence_alert ? <> <Badge tone="warn">Silent</Badge></> : null}</td>
                  <td><Badge tone={st?.tone ?? 'muted'}>{st?.label ?? h.status}</Badge></td>
                  <td>{h.last_event_at ? formatInZone(h.last_event_at, s.timeZone) : 'Never'}</td>
                  <td>{h.last_7d.accepted}</td><td>{h.last_7d.duplicate}</td><td>{h.last_7d.rejected}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}
