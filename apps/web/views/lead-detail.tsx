'use client';
// Lead detail (API-025, 026, 028..032): one primary action, due time in the org time zone, and a timeline that
// explains every reminder. allowed_actions/allowed_statuses come from the server; the UI never infers them.
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useSession } from '@/lib/session';
import { useCommand, useInvalidate, useOrgQuery } from '@/lib/hooks';
import { formatInZone, localInputValue, STATUS_LABEL } from '@/lib/format';
import type { Lead, Member, Page, TimelineItem } from '@/lib/types';
import { Badge, Button, Card, Dialog, ErrorView, Loading, Notice, PageHead, Select, TextArea, TextInput } from '@/components/ui';
import { ActivityForm } from '@/components/activity-form';
import { LIMITS, MESSAGES, PATTERNS } from '@/lib/limits';

type Panel = 'activity' | 'status' | 'snooze' | 'assign' | 'edit' | 'merge' | null;

export function LeadDetailView() {
  const { id } = useParams<{ id: string }>();
  const s = useSession();
  const q = useOrgQuery<Lead>(['lead', id], `/leads/${id}`);
  const invalidate = useInvalidate();
  const [panel, setPanel] = useState<Panel>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (q.isPending) return <Loading label="Loading lead" />;
  if (q.error) return <ErrorView error={q.error} onReload={() => void q.refetch()} />;
  const lead = q.data;
  // Server-computed (already reflects role, ownership and support scope); read-only subscriptions disable writes.
  const can = (a: string) => Boolean(lead.allowed_actions?.includes(a)) && s.writable;
  const done = (msg?: string) => {
    setPanel(null);
    setNotice(msg ?? 'Saved.');
    void invalidate('lead', id);
    void invalidate('timeline', id);
    void invalidate('inbox');
  };
  const reload = () => { void q.refetch(); };
  const pa = lead.primary_action;

  return (
    <>
      <p className="small"><Link href="/inbox">Back to inbox</Link></p>
      <PageHead
        title={lead.contact.name ?? 'Unnamed lead'}
        subtitle={<span className="row">
          <Badge tone={lead.status === 'won' ? 'ok' : ['lost', 'spam'].includes(lead.status) ? 'bad' : 'info'}>{STATUS_LABEL[lead.status]}</Badge>
          {lead.is_test ? <Badge tone="info">TEST</Badge> : null}
          {lead.due_state === 'overdue' ? <Badge tone="bad">Overdue</Badge> : null}
          <span>from {lead.source.name}</span>
        </span>}
        actions={pa && pa.type !== 'none' ? (
          <a className="btn btn-primary" href={pa.type === 'call' ? `tel:${pa.tel}` : `mailto:${pa.email}`}>{pa.label}</a>
        ) : null}
      />
      <Notice text={notice} />
      {lead.merged_into ? <div className="banner banner-info"><p>This lead was merged into <Link href={`/leads/${lead.merged_into}`}>another lead</Link> and is read-only.</p></div> : null}

      <div className="grid grid-2">
        <Card title="Next action">
          <p style={{ fontSize: '1.1rem', fontWeight: 600, margin: 0 }}>{lead.next_action ?? 'No next action'}</p>
          <p className="muted">{lead.due_at_local ? `Due ${lead.due_at_local}` : 'No due time'} · Owner: {lead.owner?.name ?? 'Unassigned'}</p>
          <div className="row">
            {can('log_activity') ? <Button variant="primary" onClick={() => setPanel('activity')}>Log activity</Button> : null}
            {can('change_status') ? <Button onClick={() => setPanel('status')}>Change status</Button> : null}
            {can('snooze') ? <Button onClick={() => setPanel('snooze')}>Reschedule</Button> : null}
            {can('assign') ? <Button onClick={() => setPanel('assign')}>{s.can('members.manage') ? 'Assign' : 'Claim'}</Button> : null}
            {can('log_activity') ? <Button onClick={() => setPanel('edit')}>Edit details</Button> : null}
            {can('merge') ? <Button onClick={() => setPanel('merge')}>Merge duplicate</Button> : null}
          </div>
          {lead.timers?.length ? (
            <div style={{ marginTop: 12 }}>
              <h3>Scheduled reminders</h3>
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                {lead.timers.map(t => <li key={t.kind + t.due_at}>{t.kind.replaceAll('_', ' ')} - {formatInZone(t.due_at, s.timeZone)}</li>)}
              </ul>
            </div>
          ) : null}
        </Card>
        <Card title="Contact">
          <dl style={{ margin: 0 }}>
            <Row k="Name" v={lead.contact.name} />
            <Row k="Phone" v={lead.contact.phone ? <a href={`tel:${lead.contact.phone}`}>{lead.contact.phone}</a> : null} />
            <Row k="Email" v={lead.contact.email ? <a href={`mailto:${lead.contact.email}`}>{lead.contact.email}</a> : null} />
            <Row k="Message" v={lead.message} />
            {Object.entries(lead.attributes ?? {}).map(([k, v]) => <Row key={k} k={k} v={v} />)}
            <Row k="Received" v={formatInZone(lead.created_at, s.timeZone)} />
            <Row k="First action" v={lead.first_action_at ? formatInZone(lead.first_action_at, s.timeZone) : 'None yet'} />
          </dl>
          {lead.possible_duplicate_ids?.length ? <p className="small" style={{ marginTop: 8 }}><Badge tone="warn">Possible duplicate</Badge> {lead.possible_duplicate_ids.map(d => <Link key={d} href={`/leads/${d}`} style={{ marginRight: 8 }}>view</Link>)}</p> : null}
        </Card>
      </div>

      <Timeline leadId={id} />

      <Dialog open={panel === 'activity'} onClose={() => setPanel(null)} title="Log activity" variant="sheet">
        <ActivityForm leadId={id} version={lead.version} onDone={done} onReload={reload} />
      </Dialog>
      <Dialog open={panel === 'status'} onClose={() => setPanel(null)} title="Change status">
        <StatusForm lead={lead} onDone={done} onReload={reload} />
      </Dialog>
      <Dialog open={panel === 'snooze'} onClose={() => setPanel(null)} title="Reschedule next action">
        <SnoozeForm lead={lead} onDone={done} onReload={reload} />
      </Dialog>
      <Dialog open={panel === 'assign'} onClose={() => setPanel(null)} title={s.can('members.manage') ? 'Assign owner' : 'Claim lead'}>
        <AssignForm lead={lead} onDone={done} onReload={reload} />
      </Dialog>
      <Dialog open={panel === 'edit'} onClose={() => setPanel(null)} title="Edit details" variant="sheet">
        <EditForm lead={lead} onDone={done} onReload={reload} />
      </Dialog>
      <Dialog open={panel === 'merge'} onClose={() => setPanel(null)} title="Merge a duplicate into this lead">
        <MergeForm lead={lead} onDone={done} onReload={reload} />
      </Dialog>
    </>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 8, padding: '4px 0' }}><dt className="muted">{k}</dt><dd style={{ margin: 0, wordBreak: 'break-word' }}>{v ?? <span className="muted">-</span>}</dd></div>;
}

interface FormProps { lead: Lead; onDone: (msg?: string) => void; onReload: () => void }

function StatusForm({ lead, onDone, onReload }: FormProps) {
  const [to, setTo] = useState(lead.allowed_statuses?.[0] ?? '');
  const [reason, setReason] = useState('');
  const cmd = useCommand<void>(() => ({ path: `/leads/${lead.id}/status`, body: { expected_version: lead.version, to_status: to, ...(reason ? { reason } : {}) } }), { onSuccess: (_d, _v, m) => onDone(m) });
  const needsReason = ['lost', 'spam'].includes(to) || (['won', 'lost', 'spam'].includes(lead.status) && to === 'attempted');
  return (
    <form onSubmit={e => { e.preventDefault(); void cmd.run(); }}>
      <Select label="New status" value={to} onChange={e => setTo(e.target.value)}>
        {lead.allowed_statuses?.map(st => <option key={st} value={st}>{STATUS_LABEL[st]}{['won', 'lost', 'spam'].includes(lead.status) && st === 'attempted' ? ' (reopen)' : ''}</option>)}
      </Select>
      <TextArea label={needsReason ? 'Reason (required)' : 'Reason (optional)'} value={reason} onChange={e => setReason(e.target.value)} required={needsReason} maxLength={LIMITS.reason} />
      <p className="small muted">Won and lost are factual outcomes; no revenue value is calculated.</p>
      <ErrorView error={cmd.error} compact onReload={onReload} />
      <Button variant="primary" type="submit" pending={cmd.pending} disabled={!to}>Save status</Button>
    </form>
  );
}

function SnoozeForm({ lead, onDone, onReload }: FormProps) {
  const s = useSession();
  const tomorrow9 = localInputValue(new Date(Date.now() + 86_400_000), s.timeZone).slice(0, 11) + '09:00';
  const [when, setWhen] = useState(tomorrow9);
  const [reason, setReason] = useState('');
  const [next, setNext] = useState('Follow-up call');
  const cmd = useCommand<void>(() => ({ path: `/leads/${lead.id}/snooze`, body: { expected_version: lead.version, due_at_local: when, reason, next_action: next } }), { onSuccess: (_d, _v, m) => onDone(m) });
  return (
    <form onSubmit={e => { e.preventDefault(); void cmd.run(); }}>
      <TextInput label="New due time" type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} required hint={`In ${s.timeZone}. Up to 30 days ahead.`} error={cmd.error?.code?.startsWith('LOCAL_TIME') ? cmd.error.message : cmd.error?.fields.due_at_local} />
      <TextInput label="Next action" value={next} onChange={e => setNext(e.target.value)} maxLength={LIMITS.nextAction} />
      <TextArea label="Reason (required)" value={reason} onChange={e => setReason(e.target.value)} required minLength={1} maxLength={LIMITS.reason} hint="The timeline uses this to explain why no reminder fired." />
      {cmd.error && !cmd.error.code.startsWith('LOCAL_TIME') ? <ErrorView error={cmd.error} compact onReload={onReload} /> : null}
      <Button variant="primary" type="submit" pending={cmd.pending}>Reschedule</Button>
    </form>
  );
}

function AssignForm({ lead, onDone, onReload }: FormProps) {
  const s = useSession();
  const manager = s.can('members.manage');
  const members = useOrgQuery<Page<Member>>(['members', 'active'], manager ? '/members?status=active&limit=100' : null);
  const [owner, setOwner] = useState('me');
  const [note, setNote] = useState('');
  const cmd = useCommand<void>(() => ({ path: `/leads/${lead.id}/assign`, body: { expected_version: lead.version, owner_id: owner, ...(note ? { note } : {}) } }), { onSuccess: (_d, _v, m) => onDone(m) });
  return (
    <form onSubmit={e => { e.preventDefault(); void cmd.run(); }}>
      {manager ? (
        <>
          <Select label="Owner" value={owner} onChange={e => setOwner(e.target.value)}>
            <option value="me">Me</option>
            {members.data?.items.filter(m => m.user_id && m.user_id !== s.me?.user.id).map(m => <option key={m.user_id} value={m.user_id}>{m.name ?? m.email} ({m.open_leads ?? 0} open)</option>)}
          </Select>
          <TextInput label="Note (optional)" value={note} onChange={e => setNote(e.target.value)} maxLength={LIMITS.shortNote} />
        </>
      ) : <p>Claim this unassigned lead? You become its owner and the first-response timer starts.</p>}
      <ErrorView error={cmd.error} compact onReload={onReload} />
      <Button variant="primary" type="submit" pending={cmd.pending}>{manager ? 'Assign' : 'Claim'}</Button>
    </form>
  );
}

function EditForm({ lead, onDone, onReload }: FormProps) {
  const [name, setName] = useState(lead.contact.name ?? '');
  const [email, setEmail] = useState(lead.contact.email ?? '');
  const [phone, setPhone] = useState(lead.contact.phone ?? '');
  const [message, setMessage] = useState(lead.message ?? '');
  const [next, setNext] = useState(lead.next_action ?? '');
  // The latest server version is used at submit time; typed values are kept across a reload (409 handling).
  const cmd = useCommand<void>(() => ({
    path: `/leads/${lead.id}`, method: 'PATCH', idempotent: false,
    body: { expected_version: lead.version, contact: { name: name || null, email: email || null, phone: phone || null }, message: message || null, next_action: next || null },
  }), { onSuccess: (_d, _v, m) => onDone(m) });
  const f = cmd.error?.fields ?? {};
  return (
    <form onSubmit={e => { e.preventDefault(); void cmd.run(); }}>
      <TextInput label="Name" value={name} onChange={e => setName(e.target.value)} maxLength={LIMITS.personName} autoComplete="off" />
      <TextInput label="Email" type="email" maxLength={LIMITS.email} pattern={PATTERNS.email} invalidMessage={MESSAGES.email} autoComplete="off" value={email} onChange={e => setEmail(e.target.value)} error={f.email} />
      <TextInput label="Phone" type="tel" inputMode="tel" autoComplete="off" maxLength={LIMITS.phone} pattern={PATTERNS.phone} invalidMessage={MESSAGES.phone} value={phone} onChange={e => setPhone(e.target.value)} error={f.phone} />
      <TextArea label="Message" value={message} onChange={e => setMessage(e.target.value)} maxLength={LIMITS.message} />
      <TextInput label="Next action" value={next} onChange={e => setNext(e.target.value)} maxLength={LIMITS.nextAction} />
      <ErrorView error={cmd.error} compact onReload={onReload} />
      <Button variant="primary" type="submit" pending={cmd.pending}>Save</Button>
    </form>
  );
}

function MergeForm({ lead, onDone, onReload }: FormProps) {
  const s = useSession();
  const [other, setOther] = useState(lead.possible_duplicate_ids?.[0] ?? '');
  const otherLead = useOrgQuery<Lead>(['lead', other], /^[0-9a-f-]{36}$/i.test(other) ? `/leads/${other}` : null);
  const cmd = useCommand<void>(() => ({
    path: `/leads/${lead.id}/merge`,
    body: { merge_lead_id: other, expected_version: lead.version, merge_expected_version: otherLead.data?.version },
  }), { onSuccess: (_d, _v, m) => onDone(m) });
  return (
    <form onSubmit={e => { e.preventDefault(); void cmd.run(); }}>
      <TextInput label="Duplicate lead ID" value={other} onChange={e => setOther(e.target.value.trim())} required maxLength={36} pattern={PATTERNS.uuid} invalidMessage={MESSAGES.uuid} autoComplete="off" hint="Open the duplicate and copy the ID from its address bar." />
      {otherLead.data ? <p className="small">Will merge <strong>{otherLead.data.contact.name ?? 'Unnamed lead'}</strong> ({STATUS_LABEL[otherLead.data.status]}, received {formatInZone(otherLead.data.created_at, s.timeZone)}) into this lead. Nothing is deleted; the duplicate becomes read-only.</p> : null}
      {otherLead.error ? <ErrorView error={otherLead.error} compact /> : null}
      <ErrorView error={cmd.error} compact onReload={onReload} />
      <Button variant="danger" type="submit" pending={cmd.pending} disabled={!otherLead.data}>Merge</Button>
    </form>
  );
}

function Timeline({ leadId }: { leadId: string }) {
  const s = useSession();
  const q = useOrgQuery<Page<TimelineItem>>(['timeline', leadId], `/leads/${leadId}/timeline?limit=100`);
  const [more, setMore] = useState<TimelineItem[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const next = cursor === undefined ? q.data?.next_cursor : cursor;
  return (
    <Card title="Timeline">
      {q.isPending ? <Loading label="Loading timeline" /> : q.error ? <ErrorView error={q.error} compact onReload={() => void q.refetch()} /> : (
        <>
          <ol className="timeline">
            {[...q.data.items, ...more].map((t, i) => (
              <li key={i} data-type={t.type}>
                <div className="small muted"><time dateTime={t.at}>{formatInZone(t.at, s.timeZone)}</time></div>
                <div>{t.text}</div>
                {t.note && t.type !== 'activity' ? <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{t.note}</div> : t.note ? <div className="small muted">{t.note}</div> : null}
                {t.deliveries?.length ? (
                  <div className="row small" style={{ marginTop: 4 }}>
                    {t.deliveries.map((d, j) => <Badge key={j} tone={d.state === 'delivered' ? 'ok' : d.state === 'failed' ? 'bad' : d.state === 'unknown' ? 'warn' : 'muted'}>{d.recipient} · {d.channel.replace('_', '-')} · {d.state}</Badge>)}
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
          {next ? <Button small onClick={async () => {
            const r = await s.request<Page<TimelineItem>>(`/leads/${leadId}/timeline?limit=100&cursor=${encodeURIComponent(next)}`);
            setMore(m => [...m, ...r.data.items]);
            setCursor(r.data.next_cursor);
          }}>Load more</Button> : null}
        </>
      )}
    </Card>
  );
}
