'use client';
// Support access (API-050..052): grant time-bound access for a ticket, view usage, revoke.
import { useState } from 'react';
import { useSession } from '@/lib/session';
import { useCommand, useInvalidate, useOrgQuery } from '@/lib/hooks';
import { formatInZone } from '@/lib/format';
import { Badge, Banner, Button, Card, CopyField, ErrorView, Loading, Notice, PageHead, Select, TextInput } from '@/components/ui';
import { LIMITS } from '@/lib/limits';

interface Grant { grant_id: string; scope: string; reason: string; granted_by: string | null; starts_at: string; expires_at: string; revoked_at: string | null; status: string; accesses: number }

export function SupportView() {
  const s = useSession();
  const q = useOrgQuery<{ items: Grant[] }>(['grants'], '/support-access/grants');
  const invalidate = useInvalidate();
  const [scope, setScope] = useState('read_only');
  const [hours, setHours] = useState(4);
  const [reason, setReason] = useState('');
  const [confirmRw, setConfirmRw] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const grant = useCommand<void, { grant_id: string }>(() => ({
    path: '/support-access/grants', body: { scope, duration_hours: hours, reason, ...(scope === 'read_write' ? { confirm_read_write: confirmRw } : {}) },
  }), { onSuccess: d => { setCreated(d.grant_id); setReason(''); void invalidate('grants'); } });
  const revoke = useCommand<string>(id => ({ path: `/support-access/grants/${id}/revoke`, body: {} }), { onSuccess: () => { void invalidate('grants'); } });

  return (
    <>
      <PageHead title="Support access" subtitle="LeadGuard support can see your account only through a grant you approve. Every access is logged." />
      <Card title="Grant access">
        <form onSubmit={e => { e.preventDefault(); void grant.run(); }}>
          <div className="grid grid-3">
            <Select label="Access" value={scope} onChange={e => setScope(e.target.value)}>
              <option value="read_only">Read-only (recommended)</option><option value="read_write">Read and write</option>
            </Select>
            <TextInput label="Duration (hours)" type="number" inputMode="numeric" step={1} required min={1} max={72} value={hours} onChange={e => setHours(Number(e.target.value))} hint="At most 72 hours." error={grant.error?.fields.duration_hours} />
            <TextInput label="Reason / ticket" value={reason} onChange={e => setReason(e.target.value)} required minLength={3} maxLength={LIMITS.reason} placeholder="Ticket #1042 - missing leads" />
          </div>
          {scope === 'read_write' ? <label className="check"><input type="checkbox" checked={confirmRw} onChange={e => setConfirmRw(e.target.checked)} /> I understand support will be able to change leads and settings.</label> : null}
          <ErrorView error={grant.error} compact />
          <Button variant="primary" type="submit" pending={grant.pending}>Grant access</Button>
        </form>
        {created ? <Banner tone="ok"><p>Access granted. Give this grant ID to LeadGuard support:</p><CopyField label="Grant ID" value={created} /></Banner> : null}
      </Card>
      <Card title="Grants">
        <ErrorView error={revoke.error} compact />
        <Notice text={revoke.message} />
        {q.isPending ? <Loading /> : q.error ? <ErrorView error={q.error} onReload={() => void q.refetch()} /> : !q.data.items.length ? <p className="muted">No support access has been granted.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th scope="col">Reason</th><th scope="col">Access</th><th scope="col">Window</th><th scope="col">Status</th><th scope="col">Accesses</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{q.data.items.map(g => (
              <tr key={g.grant_id}>
                <td>{g.reason}<div className="small muted">by {g.granted_by ?? 'owner'}</div></td>
                <td>{g.scope === 'read_only' ? 'Read-only' : 'Read and write'}</td>
                <td className="small">{formatInZone(g.starts_at, s.timeZone)} - {formatInZone(g.expires_at, s.timeZone)}</td>
                <td><Badge tone={g.status === 'active' ? 'warn' : 'muted'}>{g.status}</Badge></td>
                <td>{g.accesses}</td>
                <td>{g.status === 'active' ? <Button small variant="danger" pending={revoke.pending} onClick={() => void revoke.run(g.grant_id)}>Revoke</Button> : null}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}
