// API-003..006 Organization creation, profile, settings and business hours.
import type { FastifyInstance } from 'fastify';
import { AppError, createOrgBody, updateOrgBody, businessHoursBody, isoSeconds } from '@leadguard/contracts';
import { defaultDays, defaultPolicy, isValidZone, normalizeDays, uuidv7, validateDays, type DayHours } from '@leadguard/domain';
import { emit, effectiveState, getSubscription, loadOrgSettings, type Db } from '@leadguard/db';
import type { Deps } from '../deps.ts';
import { defineRoute } from '../lib/route.ts';
import { limitsView, usage } from '../lib/usage.ts';

function hoursProblems(days: DayHours[]): Record<string, string> {
  return Object.fromEntries(validateDays(days).map(p => [p.path, p.message]));
}

async function setupProgress(db: Db) {
  const r = await db.one<{ verified: number; team: number }>(
    `SELECT (SELECT count(*)::int FROM lg.sources WHERE status IN ('verified','failing')) AS verified,
            ((SELECT count(*)::int FROM lg.memberships) - 1 + (SELECT count(*)::int FROM lg.invitations WHERE status IN ('pending','accepted'))) AS team`);
  const sourceVerified = r.verified > 0, teamInvited = r.team > 0;
  return { org_created: true, source_verified: sourceVerified, team_invited: teamInvited, complete: sourceVerified && teamInvited };
}

async function openLeadCount(db: Db): Promise<number> {
  return (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM lg.leads WHERE status IN ('new','attempted')`)).n;
}

export function registerOrg(app: FastifyInstance, deps: Deps): void {
  // API-003 Create organization: bootstrap lookup, then default policy v1 and business hours v1 in the new org context.
  defineRoute(app, deps, {
    op: 'API-003',
    orgOptional: true,
    body: createOrgBody,
    idempotencyScope: actor => actor.userId,
    handler: async ctx => {
      const b = ctx.body;
      const fields: Record<string, string> = {};
      if (!isValidZone(b.time_zone)) fields.time_zone = 'Use a valid IANA time zone such as America/Chicago.';
      const days = (b.business_hours ?? defaultDays()) as DayHours[];
      Object.assign(fields, Object.fromEntries(Object.entries(hoursProblems(days)).map(([k, v]) => [`business_hours${k.replace(/^days/, '')}`, v])));
      if (Object.keys(fields).length) throw new AppError('VALIDATION_FAILED', 'Check the highlighted fields.', { fields });

      const orgId = uuidv7();
      try {
        await ctx.db.q('SELECT lg.bootstrap_organization($1,$2,$3,$4,$5)', [orgId, b.name, b.time_zone, b.country, ctx.userId]);
      } catch (e: any) {
        if (e?.message?.includes('ORG_LIMIT_REACHED')) throw new AppError('ORG_LIMIT_REACHED', 'You already own 3 organizations, the most allowed in this release.');
        throw e;
      }
      await ctx.switchOrg(orgId);
      const policy = defaultPolicy();
      const { version, ...policyBody } = policy;
      await ctx.db.q('INSERT INTO lg.business_hours (org_id, version, days, holidays) VALUES ($1, 1, $2, $3::date[])',
        [orgId, JSON.stringify(normalizeDays(days)), b.holidays ?? []]);
      await ctx.db.q('INSERT INTO lg.follow_up_policies (org_id, version, policy, created_by) VALUES ($1, $2, $3, $4)',
        [orgId, version, JSON.stringify(policyBody), ctx.userId]);
      await ctx.audit('org.created', 'organization', orgId);
      await emit(ctx.db, orgId, 'org.created', { user_id: ctx.userId });
      return {
        status: 201,
        message: 'Organization created.',
        data: {
          org: { id: orgId, name: b.name, time_zone: b.time_zone, country: b.country },
          membership: { role: 'owner' },
          subscription: { state: 'setup_pending', trial_starts: 'after_first_verified_source' },
          follow_up_policy: { version: 1, first_response_minutes: policy.first_response.target_minutes },
          setup: { next_step: 'connect_source' },
        },
      };
    },
  });

  // API-004 Read organization.
  defineRoute(app, deps, {
    op: 'API-004',
    handler: async ctx => {
      const s = await loadOrgSettings(ctx.db, ctx.orgId);
      const sub = await getSubscription(ctx.db, ctx.orgId);
      const u = await usage(ctx.db, s.timeZone, ctx.now);
      return {
        data: {
          id: s.orgId,
          name: s.name,
          time_zone: s.timeZone,
          country: s.country,
          business_hours: { version: s.hoursVersion, days: s.hours.days, holidays: s.hours.holidays },
          setup: await setupProgress(ctx.db),
          plan_id: sub.plan_id,
          subscription_state: effectiveState(sub, ctx.now),
          limits: limitsView(deps.config.plans, sub.plan_id, u),
          version: s.orgVersion,
        },
      };
    },
  });

  // API-005 Update organization.
  defineRoute(app, deps, {
    op: 'API-005',
    body: updateOrgBody,
    permission: 'org.manage',
    permissionMessage: 'Only owners can change organization settings.',
    handler: async ctx => {
      const b = ctx.body;
      if (b.time_zone && !isValidZone(b.time_zone)) throw new AppError('VALIDATION_FAILED', 'Check the highlighted fields.', { fields: { time_zone: 'Use a valid IANA time zone such as America/Chicago.' } });
      const cur = await ctx.db.one<{ version: number; time_zone: string; name: string; country: string }>('SELECT version, time_zone, name, country FROM lg.organizations WHERE id = $1 FOR UPDATE', [ctx.orgId]);
      if (cur.version !== b.expected_version) throw new AppError('VERSION_CONFLICT', 'Settings were changed by someone else. Reload and try again.', { current_version: cur.version });
      const changed = (['name', 'time_zone', 'country'] as const).filter(k => b[k] !== undefined && b[k] !== cur[k]);
      const row = await ctx.db.one<{ version: number; time_zone: string; name: string; country: string }>(
        `UPDATE lg.organizations SET name = coalesce($2, name), time_zone = coalesce($3, time_zone), country = coalesce($4, country),
                version = version + 1, updated_at = now() WHERE id = $1 AND version = $5 RETURNING version, time_zone, name, country`,
        [ctx.orgId, b.name ?? null, b.time_zone ?? null, b.country ?? null, b.expected_version]);
      await ctx.audit('org.updated', 'organization', ctx.orgId, changed);
      await emit(ctx.db, ctx.orgId, 'org.updated', { fields: changed });
      const data: Record<string, unknown> = { id: ctx.orgId, version: row.version };
      for (const k of changed) data[k] = row[k];
      if (changed.includes('time_zone')) {
        await emit(ctx.db, ctx.orgId, 'org.recompute_due', { reason: 'time_zone_changed' });
        data.recompute = { open_leads: await openLeadCount(ctx.db), status: 'queued' };
      }
      return { message: 'Organization updated.', data };
    },
  });

  // API-006 Replace business hours (new version; open leads recomputed by the worker).
  defineRoute(app, deps, {
    op: 'API-006',
    body: businessHoursBody,
    permission: 'org.manage',
    permissionMessage: 'Only owners can change business hours.',
    handler: async ctx => {
      const b = ctx.body;
      const problems = hoursProblems(b.days as DayHours[]);
      if (Object.keys(problems).length) {
        const first = Object.values(problems)[0];
        throw new AppError('VALIDATION_FAILED', first.startsWith('Must be after') ? 'Opening time must be before closing time.' : first, { fields: problems });
      }
      const cur = await ctx.db.maybe<{ version: number }>('SELECT version FROM lg.business_hours WHERE org_id = $1 AND is_current FOR UPDATE', [ctx.orgId]);
      const curVersion = cur?.version ?? 0;
      if (curVersion !== b.expected_version) throw new AppError('VERSION_CONFLICT', 'Business hours were changed by someone else. Reload and try again.', { current_version: curVersion });
      const next = curVersion + 1;
      await ctx.db.q('UPDATE lg.business_hours SET is_current = false WHERE org_id = $1 AND is_current', [ctx.orgId]);
      await ctx.db.q('INSERT INTO lg.business_hours (org_id, version, days, holidays) VALUES ($1, $2, $3, $4::date[])',
        [ctx.orgId, next, JSON.stringify(normalizeDays(b.days as DayHours[])), [...new Set(b.holidays)].sort()]);
      await ctx.audit('org.business_hours_changed', 'business_hours', ctx.orgId, ['days', 'holidays']);
      await emit(ctx.db, ctx.orgId, 'org.business_hours_changed', { business_hours_version: next });
      await emit(ctx.db, ctx.orgId, 'org.recompute_due', { reason: 'business_hours_changed' });
      return {
        message: 'Business hours saved.',
        data: { business_hours_version: next, effective_at: isoSeconds(ctx.now), open_leads_recomputed: 'queued' },
      };
    },
  });
}
