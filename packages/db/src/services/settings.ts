// Organization settings needed by the rule engine: time zone, current business hours, current policy.
import type { Db } from '../client.ts';
import type { BusinessHours, DayHours, FollowUpPolicy } from '@leadguard/domain';

export interface OrgSettings {
  orgId: string;
  name: string;
  timeZone: string;
  country: string;
  orgVersion: number;
  hours: BusinessHours;
  hoursVersion: number | null;
  policy: FollowUpPolicy;
}

export async function loadOrgSettings(db: Db, orgId: string): Promise<OrgSettings> {
  const org = await db.one<{ id: string; name: string; time_zone: string; country: string; version: number }>(
    'SELECT id, name, time_zone, country, version FROM lg.organizations WHERE id = $1', [orgId]);
  const bh = await db.maybe<{ version: number; days: DayHours[]; holidays: (string | Date)[] }>(
    'SELECT version, days, holidays::text[] AS holidays FROM lg.business_hours WHERE org_id = $1 AND is_current', [orgId]);
  const pol = await db.one<{ version: number; policy: Omit<FollowUpPolicy, 'version'> }>(
    'SELECT version, policy FROM lg.follow_up_policies WHERE org_id = $1 AND is_current', [orgId]);
  return {
    orgId: org.id,
    name: org.name,
    timeZone: org.time_zone,
    country: org.country.trim(),
    orgVersion: org.version,
    hours: { zone: org.time_zone, days: bh?.days ?? [], holidays: (bh?.holidays ?? []).map(String) },
    hoursVersion: bh?.version ?? null,
    policy: { ...pol.policy, version: pol.version },
  };
}

/** Database clock (Section 11.3: clock authority is the database server time). */
export async function dbNow(db: Db): Promise<Date> {
  return (await db.one<{ now: Date }>('SELECT now() AS now')).now;
}
