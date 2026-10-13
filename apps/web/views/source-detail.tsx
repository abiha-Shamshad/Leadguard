'use client';
// Source detail (API-014..019): verification checklist, delivery log with reason codes, rotate, disable/enable.
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useSession } from '@/lib/session';
import { useCommand, useInvalidate, useOrgQuery } from '@/lib/hooks';
import { formatInZone, SOURCE_STATUS } from '@/lib/format';
import type { Page, SourceDetail } from '@/lib/types';
import { Badge, Banner, Button, Card, CopyField, Dialog, ErrorView, Loading, Notice, PageHead, TextInput } from '@/components/ui';
import { VerificationChecklist } from '@/components/verification';
import { LIMITS } from '@/lib/limits';

interface Attempt { event_id: string; received_at: string; outcome: string; reason?: string; lead_id: string | null; dedupe_key?: string; auth_mode?: string }

export function SourceDetailView() {
  const { id } = useParams<{ id: string }>();
  const s = useSession();
  const invalidate = useInvalidate();
  const testing = (d?: SourceDetail) => d?.verification?.result === 'open' && d.status !== 'verified';
  const q = useOrgQuery<SourceDetail>(['source', id], `/sources/${id}`, { refetchInterval: query => (testing(query.state.data) ? 3000 : false) });
  const [notice, setNotice] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ value: string; until: string } | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const refresh = (msg?: string) => { setNotice(msg ?? null); void invalidate('source', id); void invalidate('sources'); void invalidate('source-events', id); };

  const test = useCommand<void>(() => ({ path: `/sources/${id}/test-event`, body: { window_minutes: 15 } }), { onSuccess: (_d, _v, m) => refresh(m) });
  const rotate = useCommand<void, { signing_secret: string; previous_secret_valid_until: string }>(() => ({ path: `/sources/${id}/rotate-secret`, body: {} }), {
    onSuccess: (d, _v, m) => { setSecret({ value: d.signing_secret, until: d.previous_secret_valid_until }); refresh(m); },
  });
  const enable = useCommand<void>(() => ({ path: `/sources/${id}/enable`, body: {} }), { onSuccess: (_d, _v, m) => refresh(m) });

  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorView error={q.error} onReload={() => void q.refetch()} />;
  const src = q.data;
  const st = SOURCE_STATUS[src.status];
  const manage = s.can('sources.manage');
  const err = test.error ?? rotate.error ?? enable.error;

  return (
    <>
      <p className="small"><Link href="/sources">Back to sources</Link></p>
      <PageHead title={src.name} subtitle={<span className="row"><Badge tone={st.tone}>{st.label}</Badge><span>{src.auth_mode === 'hmac_v1' ? 'Signed webhook' : src.auth_mode === 'secret_header' ? 'Secret header' : 'Embed'}</span></span>}
        actions={manage ? (
          src.status === 'disabled'
            ? <Button variant="primary" pending={enable.pending} disabled={!s.writable} onClick={() => void enable.run()}>Re-enable</Button>
            : <>
              <Button pending={test.pending} disabled={!s.writable} onClick={() => void test.run()}>Send a test event</Button>
              {src.auth_mode !== 'embed' ? <Button pending={rotate.pending} disabled={!s.writable} onClick={() => void rotate.run()}>Rotate secret</Button> : null}
              <Button variant="danger" onClick={() => setConfirmDisable(true)}>Disable</Button>
            </>
        ) : null} />
      <Notice text={notice} />
      <ErrorView error={err} compact />
      {secret ? (
        <Banner tone="warn">
          <p><strong>New secret - copy it now.</strong> The previous secret keeps working until {formatInZone(secret.until, s.timeZone)}.</p>
          <CopyField label="Signing secret" value={secret.value} />
        </Banner>
      ) : null}
      {src.status === 'failing' ? <Banner tone="warn"><strong>Needs attention.</strong> <p>Recent deliveries were rejected or the source went silent. Check the delivery log below.</p></Banner> : null}

      <div className="grid grid-2">
        <Card title="Connection">
          <CopyField label="Endpoint URL" value={src.endpoint_url} />
          <p className="small muted">Last event: {src.last_event_at ? formatInZone(src.last_event_at, s.timeZone) : 'never'}{src.verified_at ? ` · verified ${formatInZone(src.verified_at, s.timeZone)}` : ''}</p>
          {src.events_24h ? <p className="small">Last 24 h: {src.events_24h.accepted} accepted, {src.events_24h.duplicate} duplicate, {src.events_24h.rejected} rejected</p> : null}
        </Card>
        <Card title="Verification">
          {src.verification ? (
            <>
              <p className="small muted">Window {src.verification.result === 'open' ? `open until ${formatInZone(src.verification.expires_at, s.timeZone)}` : src.verification.result}</p>
              <VerificationChecklist steps={src.verification.steps} />
              {testing(src) ? <p role="status" aria-live="polite" className="small muted">Waiting for your test event...</p> : null}
            </>
          ) : <p className="muted">No verification yet. Use "Send a test event", then submit your real form once.</p>}
        </Card>
      </div>

      <DeliveryLog sourceId={id} />

      <Dialog open={confirmDisable} onClose={() => setConfirmDisable(false)} title="Disable source">
        <DisableForm sourceId={id} onDone={m => { setConfirmDisable(false); refresh(m); }} />
      </Dialog>
    </>
  );
}

function DisableForm({ sourceId, onDone }: { sourceId: string; onDone: (m?: string) => void }) {
  const [reason, setReason] = useState('');
  const cmd = useCommand<void>(() => ({ path: `/sources/${sourceId}/disable`, body: reason ? { reason } : {} }), { onSuccess: (_d, _v, m) => onDone(m) });
  return (
    <form onSubmit={e => { e.preventDefault(); void cmd.run(); }}>
      <p>New events from this source will be rejected. Existing leads are not changed. Re-enabling requires a new test event.</p>
      <TextInput label="Reason (optional)" value={reason} onChange={e => setReason(e.target.value)} maxLength={LIMITS.reason} />
      <ErrorView error={cmd.error} compact />
      <Button variant="danger" type="submit" pending={cmd.pending}>Disable source</Button>
    </form>
  );
}

function DeliveryLog({ sourceId }: { sourceId: string }) {
  const s = useSession();
  const [outcome, setOutcome] = useState('');
  const q = useOrgQuery<Page<Attempt>>(['source-events', sourceId, outcome], `/sources/${sourceId}/events?limit=50${outcome ? `&outcome=${outcome}` : ''}`);
  const [more, setMore] = useState<Attempt[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const next = cursor === undefined ? q.data?.next_cursor : cursor;
  return (
    <Card title="Delivery log" actions={
      <label className="small row">Outcome
        <select value={outcome} onChange={e => { setOutcome(e.target.value); setMore([]); setCursor(undefined); }} style={{ width: 'auto' }}>
          <option value="">All</option><option value="accepted">Accepted</option><option value="duplicate">Duplicate</option><option value="rejected">Rejected</option><option value="failed">Failed</option>
        </select>
      </label>}>
      <p className="small muted">Outcome and reason only - contact details are on the linked lead.</p>
      {q.isPending ? <Loading /> : q.error ? <ErrorView error={q.error} compact /> : !q.data.items.length ? <p className="muted">No deliveries yet.</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th scope="col">Received</th><th scope="col">Outcome</th><th scope="col">Reason</th><th scope="col">Lead</th></tr></thead>
          <tbody>{[...q.data.items, ...more].map(a => (
            <tr key={a.event_id}>
              <td>{formatInZone(a.received_at, s.timeZone)}</td>
              <td><Badge tone={a.outcome === 'accepted' ? 'ok' : a.outcome === 'duplicate' ? 'muted' : 'bad'}>{a.outcome}</Badge>{a.auth_mode === 'embed' ? <> <Badge>embed</Badge></> : null}</td>
              <td className="mono">{a.reason ?? ''}</td>
              <td>{a.lead_id ? <Link href={`/leads/${a.lead_id}`}>Open</Link> : '-'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {next ? <Button small style={{ marginTop: 8 }} onClick={async () => {
        const r = await s.request<Page<Attempt>>(`/sources/${sourceId}/events?limit=50&cursor=${encodeURIComponent(next)}${outcome ? `&outcome=${outcome}` : ''}`);
        setMore(m => [...m, ...r.data.items]);
        setCursor(r.data.next_cursor);
      }}>Load more</Button> : null}
    </Card>
  );
}
