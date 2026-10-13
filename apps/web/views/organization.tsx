'use client';
// Organization profile, time zone and business hours (API-004..006). Changing hours or time zone recomputes
// due times of open leads; each change is written to the lead timeline.
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/lib/session';
import { useCommand, useInvalidate, useOrgQuery } from '@/lib/hooks';
import type { DayHours, Org } from '@/lib/types';
import { Badge, Banner, Button, Card, ErrorView, Loading, Notice, PageHead, Select, TextInput } from '@/components/ui';
import { HoursEditor, normalizeHours, timeZones } from '@/components/hours-editor';
import { LIMITS, MESSAGES, PATTERNS } from '@/lib/limits';

export function OrganizationView() {
  const s = useSession();
  const q = useOrgQuery<Org>(['org'], '/organizations/current');
  const invalidate = useInvalidate();
  const qc = useQueryClient();
  const canEdit = s.can('org.manage') && s.writable;
  const [profile, setProfile] = useState<{ name: string; time_zone: string; country: string } | null>(null);
  const [hours, setHours] = useState<DayHours[] | null>(null);
  const [holidays, setHolidays] = useState('');
  useEffect(() => {
    if (!q.data) return;
    setProfile(p => p ?? { name: q.data.name, time_zone: q.data.time_zone, country: q.data.country });
    setHours(h => h ?? normalizeHours(q.data.business_hours.days));
    setHolidays(h => h || q.data.business_hours.holidays.join(', '));
  }, [q.data]);

  const saveProfile = useCommand<void>(() => ({
    path: '/organizations/current', method: 'PATCH', idempotent: false,
    body: { expected_version: q.data?.version, ...profile },
  }), { onSuccess: async () => { void invalidate('org'); await qc.invalidateQueries({ queryKey: ['me'] }); } });

  const saveHours = useCommand<void>(() => ({
    path: '/organizations/current/business-hours', method: 'PUT', idempotent: false,
    body: { expected_version: q.data?.business_hours.version ?? 0, days: hours, holidays: holidays.split(/[\s,]+/).filter(Boolean) },
  }), { onSuccess: () => { void invalidate('org'); } });

  if (q.error) return <ErrorView error={q.error} onReload={() => void q.refetch()} />;
  if (!q.data || !profile || !hours) return <Loading />;
  const o = q.data;

  return (
    <>
      <PageHead title="Organization" subtitle={`${o.name} · plan ${o.plan_id}`} />
      {!o.setup.complete ? (
        <Banner tone="info"><p>Setup progress: organization created{o.setup.source_verified ? ', source verified' : ' - verify a source next'}{o.setup.team_invited ? ', team invited' : ' - invite your team'}.</p></Banner>
      ) : null}
      <div className="grid grid-2">
        <Card title="Profile">
          <form onSubmit={e => { e.preventDefault(); void saveProfile.run(); }}>
            <fieldset disabled={!canEdit} style={{ border: 'none', padding: 0, margin: 0 }}>
              <TextInput label="Name" value={profile.name} onChange={e => setProfile({ ...profile, name: e.target.value })} required minLength={1} maxLength={LIMITS.orgName} autoComplete="organization" />
              <Select label="Time zone" value={profile.time_zone} onChange={e => setProfile({ ...profile, time_zone: e.target.value })} hint="Changing it recomputes due times of open leads.">
                {timeZones().map(z => <option key={z} value={z}>{z}</option>)}
              </Select>
              <TextInput label="Country code" value={profile.country} required minLength={2} maxLength={2} pattern={PATTERNS.countryCode} invalidMessage={MESSAGES.countryCode} autoComplete="country" onChange={e => setProfile({ ...profile, country: e.target.value.toUpperCase() })} />
              <ErrorView error={saveProfile.error} compact onReload={() => void q.refetch()} />
              {canEdit ? <Button variant="primary" type="submit" pending={saveProfile.pending}>Save profile</Button> : null}
              <Notice text={saveProfile.message} />
            </fieldset>
          </form>
        </Card>
        <Card title={`Business hours (version ${o.business_hours.version ?? '-'})`}>
          <form onSubmit={e => { e.preventDefault(); void saveHours.run(); }}>
            <fieldset disabled={!canEdit} style={{ border: 'none', padding: 0, margin: 0 }}>
              <HoursEditor value={hours} onChange={setHours} errors={saveHours.error?.fields} />
              <TextInput label="Holidays (closed days)" value={holidays} onChange={e => setHolidays(e.target.value)} maxLength={LIMITS.holidays} pattern={PATTERNS.holidays} invalidMessage={MESSAGES.holidays} placeholder="2026-11-26, 2026-12-25" hint="YYYY-MM-DD, separated by commas." />
              <ErrorView error={saveHours.error} compact onReload={() => void q.refetch()} />
              {canEdit ? <Button variant="primary" type="submit" pending={saveHours.pending}>Save hours</Button> : null}
              <Notice text={saveHours.message ? `${saveHours.message} Open leads are being recalculated.` : null} />
            </fieldset>
          </form>
        </Card>
      </div>
      <Card title="Plan limits">
        <div className="grid grid-3">
          {Object.entries(o.limits).map(([k, v]) => (
            <div key={k}><div className="small muted" style={{ textTransform: 'capitalize' }}>{k.replaceAll('_', ' ')}</div><strong>{v.used} / {v.max}</strong> {v.used >= v.max ? <Badge tone="warn">At limit</Badge> : null}</div>
          ))}
        </div>
      </Card>
    </>
  );
}
