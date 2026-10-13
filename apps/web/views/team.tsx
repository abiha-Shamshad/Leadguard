'use client';
// Team (API-007, 008, 010, 011): role changes and deactivation with a reassignment choice.
import { useState } from 'react';
import { useSession } from '@/lib/session';
import { useCommand, useInvalidate, useOrgQuery } from '@/lib/hooks';
import { formatInZone } from '@/lib/format';
import type { Member, Page } from '@/lib/types';
import { Badge, Banner, Button, Card, CopyField, Dialog, ErrorView, Loading, Notice, PageHead, Select, TextInput } from '@/components/ui';
import { LIMITS, MESSAGES, PATTERNS } from '@/lib/limits';

export function InviteForm({ onInvited }: { onInvited?: () => void }) {
  const s = useSession();
  const invalidate = useInvalidate();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const cmd = useCommand<void, { email: string; invite_url?: string | null; email_delivery: string }>(() => ({ path: '/invitations', body: { email: email.trim(), role } }), {
    onSuccess: d => {
      if (d.invite_url) setLink({ email: d.email, url: d.invite_url });
      setEmail('');
      void invalidate('members');
      onInvited?.();
    },
  });
  return (
    <>
      <form onSubmit={e => { e.preventDefault(); void cmd.run(); }} className="grid grid-3" style={{ alignItems: 'end' }}>
        <TextInput label="Email" type="email" maxLength={LIMITS.email} pattern={PATTERNS.email} invalidMessage={MESSAGES.email} autoComplete="off" value={email} onChange={e => setEmail(e.target.value)} required error={cmd.error?.fields.email} />
        <Select label="Role" value={role} onChange={e => setRole(e.target.value)}>
          <option value="member">Member - works assigned leads</option>
          <option value="manager">Manager - team, sources, rules</option>
          {s.me?.active_org?.role === 'owner' ? <option value="owner">Owner - everything incl. billing</option> : null}
        </Select>
        <div className="field"><Button variant="primary" type="submit" pending={cmd.pending} disabled={!s.writable}>Send invitation</Button></div>
      </form>
      <ErrorView error={cmd.error} compact />
      <Notice text={cmd.message} />
      {link ? (
        <Banner tone="info">
          <p><strong>Email is not set up yet.</strong> Copy this link and send it to {link.email}. It works once and expires in 7 days.</p>
          <CopyField label="Invitation link" value={link.url} />
        </Banner>
      ) : null}
    </>
  );
}

export function TeamView() {
  const s = useSession();
  const q = useOrgQuery<Page<Member>>(['members'], '/members?limit=100');
  const invalidate = useInvalidate();
  const [deactivate, setDeactivate] = useState<Member | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const roleCmd = useCommand<{ m: Member; role: string }>(({ m, role }) => ({ path: `/members/${m.user_id}`, method: 'PATCH', idempotent: false, body: { expected_version: m.version, role } }), {
    onSuccess: (_d, _v, msg) => { setNotice(msg ?? 'Role updated.'); void invalidate('members'); },
  });
  const isOwner = s.me?.active_org?.role === 'owner';
  const active = q.data?.items.filter(m => m.status === 'active') ?? [];

  return (
    <>
      <PageHead title="Team" subtitle="Who receives leads and alerts." />
      <Card title="Invite someone"><InviteForm /></Card>
      <Card title="Members">
        <Notice text={notice} />
        <ErrorView error={roleCmd.error} compact onReload={() => void q.refetch()} />
        {q.isPending ? <Loading /> : q.error ? <ErrorView error={q.error} onReload={() => void q.refetch()} /> : (
          <div className="table-wrap"><table>
            <thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Open leads</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {q.data.items.map(m => {
                const self = m.user_id === s.me?.user.id;
                const canEdit = m.status === 'active' && !self && (isOwner || m.role !== 'owner') && s.can('members.manage');
                return (
                  <tr key={m.user_id ?? m.invitation_id}>
                    <td><div>{m.name ?? m.email}</div><div className="small muted">{m.email}</div></td>
                    <td>
                      {canEdit ? (
                        <label><span className="sr-only">Role for {m.name ?? m.email}</span>
                          <select value={m.role} disabled={roleCmd.pending} onChange={e => void roleCmd.run({ m, role: e.target.value })}>
                            <option value="member">Member</option><option value="manager">Manager</option>{isOwner ? <option value="owner">Owner</option> : null}
                          </select>
                        </label>
                      ) : <span style={{ textTransform: 'capitalize' }}>{m.role}</span>}
                    </td>
                    <td>{m.status === 'invited' ? <Badge tone="info">Invited · expires {formatInZone(m.expires_at, s.timeZone)}</Badge> : m.status === 'active' ? <Badge tone="ok">Active</Badge> : <Badge>Deactivated</Badge>}</td>
                    <td>{m.open_leads ?? '-'}</td>
                    <td>{canEdit ? <Button small variant="danger" onClick={() => setDeactivate(m)}>Deactivate</Button> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </Card>
      <Dialog open={Boolean(deactivate)} onClose={() => setDeactivate(null)} title="Deactivate member">
        {deactivate ? <DeactivateForm member={deactivate} others={active.filter(m => m.user_id !== deactivate.user_id)}
          onDone={msg => { setDeactivate(null); setNotice(msg ?? 'Member deactivated.'); void invalidate('members'); void invalidate('inbox'); }} /> : null}
      </Dialog>
    </>
  );
}

function DeactivateForm({ member, others, onDone }: { member: Member; others: Member[]; onDone: (msg?: string) => void }) {
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const cmd = useCommand<void, { leads_reassigned: number }>(() => ({ path: `/members/${member.user_id}/deactivate`, body: { reassign_to: to || null, ...(reason ? { reason } : {}) } }), {
    onSuccess: d => onDone(`Member deactivated. ${d.leads_reassigned} open lead(s) reassigned.`),
  });
  return (
    <form onSubmit={e => { e.preventDefault(); void cmd.run(); }}>
      <p>{member.name ?? member.email} loses access on their next request. Their history stays in lead timelines.</p>
      <Select label={`Hand over their ${member.open_leads ?? 0} open lead(s) to`} value={to} onChange={e => setTo(e.target.value)}>
        <option value="">The unassigned queue</option>
        {others.map(o => <option key={o.user_id} value={o.user_id}>{o.name ?? o.email}</option>)}
      </Select>
      <TextInput label="Reason (optional)" value={reason} onChange={e => setReason(e.target.value)} maxLength={LIMITS.reason} />
      <ErrorView error={cmd.error} compact />
      <Button variant="danger" type="submit" pending={cmd.pending}>Deactivate</Button>
    </form>
  );
}
