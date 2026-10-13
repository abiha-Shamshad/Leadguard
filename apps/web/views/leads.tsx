'use client';
// All leads (API-023): filters, search text sent in the POST body (never the URL). Manual creation (API-024).
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/session';
import { useCommand } from '@/lib/hooks';
import { ApiError } from '@/lib/api';
import { formatInZone, STATUS_LABEL } from '@/lib/format';
import type { LeadStatus, Page } from '@/lib/types';
import { Badge, Button, Card, Dialog, Empty, ErrorView, Loading, PageHead, Select, TextArea, TextInput } from '@/components/ui';
import { LIMITS, MESSAGES, PATTERNS } from '@/lib/limits';

interface Row { id: string; name: string | null; status: LeadStatus; owner: string | null; source: string; created_at: string; due_at_local: string | null; is_test?: boolean }

const STATUS_GROUPS: Record<string, LeadStatus[] | null> = {
  open: ['new', 'attempted', 'contacted', 'qualified'],
  closed: ['won', 'lost', 'spam'],
  all: null,
};

export function LeadsView() {
  const s = useSession();
  const [text, setText] = useState('');
  const [filters, setFilters] = useState({ query: '', group: 'open', owner: '', from: '', to: '', includeTest: false });
  const [pages, setPages] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const body = (c: string | null) => ({
    query: filters.query || null,
    status: STATUS_GROUPS[filters.group],
    owner_id: filters.owner || null,
    created_from: filters.from || null,
    created_to: filters.to || null,
    include_test: filters.includeTest,
    limit: 25,
    cursor: c,
  });

  // Search terms are part of the cache key in memory only; they never reach the URL.
  const q = useQuery<Page<Row>, ApiError>({
    queryKey: ['org', s.orgId, s.supportGrantId, 'leads-search', filters],
    queryFn: () => s.request<Page<Row>>('/leads/search', { method: 'POST', body: body(null) }).then(r => { setPages([]); setCursor(r.data.next_cursor); return r.data; }),
    enabled: Boolean(s.orgId),
  });

  return (
    <>
      <PageHead title="All leads" subtitle="Search by name, email or phone."
        actions={s.can('leads.write') ? <Button variant="primary" onClick={() => setCreateOpen(true)} disabled={!s.writable}>Add lead</Button> : null} />
      <Card>
        <form className="grid grid-4" style={{ alignItems: 'end' }} onSubmit={e => { e.preventDefault(); setFilters(f => ({ ...f, query: text.trim() })); }}>
          <TextInput label="Search" type="search" value={text} onChange={e => setText(e.target.value)} placeholder="Name, email or phone" minLength={2} maxLength={LIMITS.search} autoComplete="off" />
          <Select label="Status" value={filters.group} onChange={e => setFilters(f => ({ ...f, group: e.target.value }))}>
            <option value="open">Open</option><option value="closed">Closed</option><option value="all">All (except merged)</option>
          </Select>
          <Select label="Owner" value={filters.owner} onChange={e => setFilters(f => ({ ...f, owner: e.target.value }))}>
            <option value="">Anyone</option><option value="me">Me</option><option value="unassigned">Unassigned</option>
          </Select>
          <div className="field"><Button type="submit" variant="primary">Search</Button></div>
          <TextInput label="Received from" type="date" value={filters.from} min="2020-01-01" max={filters.to || undefined} onChange={e => setFilters(f => ({ ...f, from: e.target.value }))} />
          <TextInput label="Received to" type="date" value={filters.to} min={filters.from || "2020-01-01"} onChange={e => setFilters(f => ({ ...f, to: e.target.value }))} />
          <label className="check" style={{ alignSelf: 'center' }}><input type="checkbox" checked={filters.includeTest} onChange={e => setFilters(f => ({ ...f, includeTest: e.target.checked }))} /> Include test leads</label>
        </form>
      </Card>
      <Card>
        {q.isPending ? <Loading label="Searching" /> : q.error ? <ErrorView error={q.error} onReload={() => void q.refetch()} /> : !q.data.items.length ? (
          <Empty title="No leads found"><p>Try another search or filter.</p></Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead><tr><th scope="col">Lead</th><th scope="col">Status</th><th scope="col">Owner</th><th scope="col">Source</th><th scope="col">Received</th><th scope="col">Due</th></tr></thead>
                <tbody>
                  {[...q.data.items, ...pages].map(r => (
                    <tr key={r.id}>
                      <td><Link href={`/leads/${r.id}`}>{r.name ?? 'Unnamed lead'}</Link>{r.is_test ? <> <Badge tone="info">TEST</Badge></> : null}</td>
                      <td><Badge>{STATUS_LABEL[r.status]}</Badge></td>
                      <td>{r.owner ?? <span className="muted">Unassigned</span>}</td>
                      <td>{r.source}</td>
                      <td>{formatInZone(r.created_at, s.timeZone)}</td>
                      <td>{r.due_at_local ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {cursor ? <Button small style={{ marginTop: 8 }} onClick={async () => {
              const r = await s.request<Page<Row>>('/leads/search', { method: 'POST', body: body(cursor) });
              setPages(p => [...p, ...r.data.items]);
              setCursor(r.data.next_cursor);
            }}>Load more</Button> : null}
          </>
        )}
      </Card>
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title="Add a lead" variant="sheet">
        <CreateLeadForm onClose={() => setCreateOpen(false)} />
      </Dialog>
    </>
  );
}

function CreateLeadForm({ onClose }: { onClose: () => void }) {
  const s = useSession();
  const router = useRouter();
  const [form, setForm] = useState({ name: '', phone: '', email: '', message: '', mine: true });
  const [dups, setDups] = useState<{ id: string; name: string | null; status: string; created_at: string }[] | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const cmd = useCommand<void, { id: string; possible_duplicates: typeof dups }>(() => ({
    path: '/leads',
    body: { name: form.name || null, phone: form.phone || null, email: form.email || null, message: form.message || null, ...(form.mine ? { owner_id: 'me' } : {}) },
  }), {
    onSuccess: d => {
      if (d.possible_duplicates?.length) { setDups(d.possible_duplicates); setCreatedId(d.id); }
      else { onClose(); router.push(`/leads/${d.id}`); }
    },
  });
  const f = cmd.error?.fields ?? {};
  if (dups && createdId) {
    return (
      <div>
        <p><strong>Lead created.</strong> These existing leads have the same phone or email - you can merge them from the lead page.</p>
        <ul>{dups.map(d => <li key={d.id}><Link href={`/leads/${d.id}`}>{d.name ?? 'Unnamed lead'}</Link> - {STATUS_LABEL[d.status]}, {formatInZone(d.created_at, s.timeZone)}</li>)}</ul>
        <Button variant="primary" onClick={() => { onClose(); router.push(`/leads/${createdId}`); }}>Open the new lead</Button>
      </div>
    );
  }
  return (
    <form onSubmit={e => { e.preventDefault(); void cmd.run(); }}>
      <p className="muted small">For walk-in or phone enquiries that did not come from a connected source. Add an email or phone.</p>
      <TextInput label="Name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} maxLength={LIMITS.personName} autoComplete="off" />
      <TextInput label="Phone" type="tel" inputMode="tel" autoComplete="off" maxLength={LIMITS.phone} pattern={PATTERNS.phone} invalidMessage={MESSAGES.phone} value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} error={f.phone} required={!form.email} />
      <TextInput label="Email" type="email" maxLength={LIMITS.email} pattern={PATTERNS.email} invalidMessage={MESSAGES.email} autoComplete="off" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} error={f.email} required={!form.phone} />
      <TextArea label="What do they need?" value={form.message} onChange={e => setForm({ ...form, message: e.target.value })} maxLength={LIMITS.message} />
      <label className="check"><input type="checkbox" checked={form.mine} onChange={e => setForm({ ...form, mine: e.target.checked })} /> Assign to me (otherwise the assignment rule decides)</label>
      <ErrorView error={cmd.error} compact />
      <Button variant="primary" type="submit" pending={cmd.pending}>Create lead</Button>
    </form>
  );
}
