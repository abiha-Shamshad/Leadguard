'use client';
// Follow-up rules (API-033..035). Preview shows due and escalation times with the production calculator before
// saving. Members see the policy read-only so they understand why reminders happen.
import { useEffect, useState } from 'react';
import { useSession } from '@/lib/session';
import { useCommand, useInvalidate, useOrgQuery } from '@/lib/hooks';
import { formatInZone, localInputValue } from '@/lib/format';
import type { Member, Page, Policy } from '@/lib/types';
import { Banner, Button, Card, ErrorView, Loading, Notice, PageHead, Select, TextInput } from '@/components/ui';
import { MESSAGES, PATTERNS } from '@/lib/limits';

type Draft = Omit<Policy, 'version' | 'updated_by' | 'updated_at'>;

function toDraft(p: Policy): Draft {
  const { version: _v, updated_by: _b, updated_at: _a, ...rest } = p;
  return JSON.parse(JSON.stringify(rest));
}

export function RulesView() {
  const s = useSession();
  const q = useOrgQuery<Policy>(['policy'], '/rules/follow-up-policy');
  const canEdit = s.can('rules.manage') && s.writable;
  const members = useOrgQuery<Page<Member>>(['members', 'active'], canEdit && s.can('members.manage') ? '/members?status=active&limit=100' : null);
  const invalidate = useInvalidate();
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => { if (q.data && !draft) setDraft(toDraft(q.data)); }, [q.data, draft]);

  const save = useCommand<void, { version: number }>(() => ({
    path: '/rules/follow-up-policy', method: 'PUT', idempotent: false,
    body: { expected_version: q.data?.version, ...draft },
  }), { onSuccess: () => { void invalidate('policy'); } });

  if (q.error) return <ErrorView error={q.error} onReload={() => void q.refetch()} />;
  if (!q.data || !draft) return <Loading />;
  const policy = q.data;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const ints = (v: string) => v.split(',').map(x => Number(x.trim())).filter(n => Number.isFinite(n) && n > 0);
  const f = save.error?.fields ?? {};

  return (
    <>
      <PageHead title="Follow-up rules" subtitle={`Version ${q.data.version}${q.data.updated_by ? ` · changed by ${q.data.updated_by} ${formatInZone(q.data.updated_at, s.timeZone)}` : ''}`} />
      {!canEdit ? <Banner tone="info"><p>These rules decide who gets new leads and when reminders and escalations are sent. Only owners and managers can change them.</p></Banner> : null}
      <form onSubmit={e => { e.preventDefault(); void save.run(); }}>
        <fieldset disabled={!canEdit} style={{ border: 'none', padding: 0, margin: 0 }}>
          <div className="grid grid-2">
            <Card title="Assignment">
              <Select label="New leads go to" value={draft.assignment.mode} onChange={e => {
                const mode = e.target.value as Draft['assignment']['mode'];
                set({ assignment: mode === 'round_robin' ? { mode, eligible_roles: ['member', 'manager'] } : mode === 'fixed_owner' ? { mode, owner_id: s.me?.user.id ?? '' } : { mode } });
              }}>
                <option value="round_robin">Round-robin across the team</option>
                <option value="fixed_owner">Always the same person</option>
                <option value="unassigned_queue">Unassigned queue - anyone can claim</option>
              </Select>
              {draft.assignment.mode === 'round_robin' ? (
                <fieldset style={{ border: 'none', padding: 0 }}>
                  <legend className="label">Who is in the rotation</legend>
                  {(['member', 'manager', 'owner'] as const).map(r => (
                    <label key={r} className="check"><input type="checkbox" checked={(draft.assignment as any).eligible_roles.includes(r)}
                      onChange={e => {
                        const cur: string[] = (draft.assignment as any).eligible_roles;
                        set({ assignment: { mode: 'round_robin', eligible_roles: e.target.checked ? [...cur, r] : cur.filter(x => x !== r) } });
                      }} /> {r[0].toUpperCase() + r.slice(1)}s</label>
                  ))}
                </fieldset>
              ) : null}
              {draft.assignment.mode === 'fixed_owner' ? (
                <Select label="Owner" value={(draft.assignment as any).owner_id} onChange={e => set({ assignment: { mode: 'fixed_owner', owner_id: e.target.value } })} error={f['assignment.owner_id']}>
                  {(members.data?.items ?? []).filter(m => m.user_id).map(m => <option key={m.user_id} value={m.user_id}>{m.name ?? m.email}</option>)}
                  {!members.data ? <option value={(draft.assignment as any).owner_id}>Current owner</option> : null}
                </Select>
              ) : null}
              <TextInput label="Escalate unassigned leads after (minutes)" type="number" inputMode="numeric" step={1} required min={5} max={240} value={draft.unassigned_escalation_minutes}
                onChange={e => set({ unassigned_escalation_minutes: Number(e.target.value) })} error={f.unassigned_escalation_minutes} />
            </Card>
            <Card title="First response">
              <TextInput label="Target (minutes)" type="number" inputMode="numeric" step={1} required min={5} max={1440} value={draft.first_response.target_minutes}
                onChange={e => set({ first_response: { ...draft.first_response, target_minutes: Number(e.target.value) } })} error={f['first_response.target_minutes']} hint="5-1440 minutes" />
              <label className="check"><input type="checkbox" checked={draft.first_response.business_hours_only}
                onChange={e => set({ first_response: { ...draft.first_response, business_hours_only: e.target.checked } })} /> Count business hours only</label>
            </Card>
            <Card title="Follow-up attempts">
              <TextInput label="Intervals between attempts (minutes, comma-separated)" required inputMode="numeric" maxLength={60} pattern={PATTERNS.intervals} invalidMessage={MESSAGES.intervals} value={draft.follow_up.attempt_intervals_minutes.join(', ')}
                onChange={e => set({ follow_up: { ...draft.follow_up, attempt_intervals_minutes: ints(e.target.value) } })} error={f['follow_up.attempt_intervals_minutes']} hint="1-6 values, each 15-10080. Example: 60, 240, 1440" />
              <TextInput label="Maximum attempts" type="number" inputMode="numeric" step={1} required min={1} max={6} value={draft.follow_up.max_attempts}
                onChange={e => set({ follow_up: { ...draft.follow_up, max_attempts: Number(e.target.value) } })} error={f['follow_up.max_attempts']} />
            </Card>
            <Card title="Escalation">
              <TextInput label="Escalate when overdue by (minutes)" type="number" inputMode="numeric" step={1} required min={5} max={1440} value={draft.escalation.after_overdue_minutes}
                onChange={e => set({ escalation: { ...draft.escalation, after_overdue_minutes: Number(e.target.value) } })} error={f['escalation.after_overdue_minutes']} />
              <fieldset style={{ border: 'none', padding: 0 }}>
                <legend className="label">Notify</legend>
                {(['managers', 'owners'] as const).map(n => (
                  <label key={n} className="check"><input type="checkbox" checked={draft.escalation.notify.includes(n)}
                    onChange={e => set({ escalation: { ...draft.escalation, notify: e.target.checked ? [...draft.escalation.notify, n] : draft.escalation.notify.filter(x => x !== n) } })} /> {n[0].toUpperCase() + n.slice(1)}</label>
                ))}
                <p className="small muted">With no active manager, owners receive manager escalations.</p>
              </fieldset>
              <label className="check"><input type="checkbox" checked={draft.escalation.repeat} onChange={e => set({ escalation: { ...draft.escalation, repeat: e.target.checked } })} /> Repeat escalation while still overdue</label>
            </Card>
          </div>
          {canEdit ? (
            <div className="row" style={{ marginTop: 16 }}>
              <Button variant="primary" type="submit" pending={save.pending}>Save as version {q.data.version + 1}</Button>
              <Button type="button" onClick={() => setDraft(toDraft(policy))}>Discard changes</Button>
            </div>
          ) : null}
          <ErrorView error={save.error} compact onReload={() => void q.refetch()} />
          <Notice text={save.message ? `${save.message} New leads and the next timer step of open leads use it.` : null} />
        </fieldset>
      </form>
      {s.can('rules.manage') ? <Preview draft={draft} /> : null}
    </>
  );
}

function Preview({ draft }: { draft: Draft }) {
  const s = useSession();
  const [arrival, setArrival] = useState(() => localInputValue(new Date(), s.timeZone));
  const [result, setResult] = useState<any>(null);
  const cmd = useCommand<void, any>(() => ({
    path: '/rules/follow-up-policy/preview', idempotent: false,
    body: { policy: { first_response: draft.first_response, escalation: { after_overdue_minutes: draft.escalation.after_overdue_minutes } }, arrival_local: arrival },
  }), { onSuccess: d => setResult(d) });
  return (
    <Card title="Preview">
      <form className="row" style={{ alignItems: 'end' }} onSubmit={e => { e.preventDefault(); void cmd.run(); }}>
        <div style={{ minWidth: 240 }}><TextInput label={`If a lead arrives at (${s.timeZone})`} type="datetime-local" required value={arrival} onChange={e => setArrival(e.target.value)} /></div>
        <div className="field"><Button type="submit" pending={cmd.pending}>Preview</Button></div>
      </form>
      <ErrorView error={cmd.error} compact />
      {result ? (
        <div role="status" aria-live="polite">
          <p><strong>First response due:</strong> {result.first_response_due_local}<br /><strong>Escalation:</strong> {result.escalation_at_local}</p>
          <p className="small muted">{result.explanation} Business hours v{result.business_hours_version}: {result.business_hours_status}.</p>
        </div>
      ) : null}
    </Card>
  );
}
