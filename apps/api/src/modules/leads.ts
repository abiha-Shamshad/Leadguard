// API-023..032 Leads. Status, owner and due time change only through their explicit endpoints; every write uses
// expected_version (guarded update) and creates/cancels timers in the same transaction (TASK-009).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DateTime } from 'luxon';
import {
  AppError, activityBody, assignBody, createLeadBody, findPlan, isoOrNull, isoSeconds, mergeBody, searchBody, snoozeBody, statusBody,
  timelineQuery, updateLeadBody, uuid,
} from '@leadguard/contracts';
import {
  checkTransition, formatLocal, isValidEmail, localDateStartUtc, normalizeEmail, normalizePhone, parseLocalWallTime, type LeadStatus, type Role,
} from '@leadguard/domain';
import {
  addActivity, applyActivity, cancelPendingAlerts, cancelTimers, createLead, createTimer, emit, getSubscription, loadOrgSettings, markAssigned,
  replanForOwner, scheduleFirstResponse, scheduleFollowUp, scheduleUnassigned, type Db, type OrgSettings,
} from '@leadguard/db';
import type { Deps } from '../deps.ts';
import { defineRoute } from '../lib/route.ts';
import { assertVersion, isManager, loadLead, loadLeadForWrite, visibilitySql, type LeadRow } from '../lib/access.ts';
import { localTimeError } from '../lib/local-time.ts';
import { allowedActions, contactPhone, dueFields, dueState, names, ownerObj, primaryAction } from '../lib/present.ts';
import { planLimitError, usage } from '../lib/usage.ts';
import { enforce } from '../lib/rate-limit.ts';
import type { Actor } from '../plugins/auth.ts';

const leadParams = z.object({ leadId: uuid });

async function sourceInfo(db: Db, sourceId: string | null) {
  if (!sourceId) return { id: null, name: 'Manual entry', type: 'manual' };
  const s = await db.one<{ id: string; name: string; type: string }>('SELECT id, name, type FROM lg.sources WHERE id = $1', [sourceId]);
  return s;
}

/** Full lead detail (API-025) - also returned by API-024. */
async function leadDetail(db: Db, actor: Actor, s: OrgSettings, lead: LeadRow, now: Date) {
  const nm = await names(db, [lead.owner_id]);
  const timers = await db.q<{ kind: string; due_at: Date; state: string }>(
    `SELECT kind, due_at, state FROM lg.lead_timers WHERE lead_id = $1 AND state IN ('pending','claimed') ORDER BY due_at`, [lead.id]);
  const events = await db.q<{ id: string; kind: string; created_at: Date }>(
    `SELECT id, kind, created_at FROM lg.source_events WHERE lead_id = $1 ORDER BY created_at, id`, [lead.id]);
  const { actions, statuses } = allowedActions(actor, lead);
  return {
    id: lead.id,
    status: lead.status,
    contact: { name: lead.name, email: lead.email_norm, phone: contactPhone(lead) },
    message: lead.message,
    source: await sourceInfo(db, lead.source_id),
    owner: ownerObj(lead.owner_id, nm),
    next_action: lead.next_action,
    ...dueFields(lead, s),
    due_state: dueState(lead, now),
    first_action_at: isoOrNull(lead.first_action_at),
    version: lead.version,
    created_at: isoSeconds(lead.created_at),
    is_test: lead.is_test,
    attributes: lead.attributes,
    primary_action: primaryAction(lead),
    allowed_actions: actions,
    allowed_statuses: statuses,
    timers: timers.map(t => ({ kind: t.kind, due_at: isoSeconds(t.due_at), state: t.state === 'claimed' ? 'pending' : t.state })),
    events: events.map(e => ({ event_id: e.id, kind: e.kind, received_at: isoSeconds(e.created_at) })),
    ...(lead.merged_into ? { merged_into: lead.merged_into } : {}),
    ...(lead.possible_duplicates?.length ? { possible_duplicate_ids: lead.possible_duplicates } : {}),
  };
}

function normalizeContact(input: { email?: string | null; phone?: string | null }, country: string) {
  const fields: Record<string, string> = {};
  let email: string | null | undefined = undefined;
  if (input.email !== undefined) {
    if (input.email === null || input.email === '') email = null;
    else if (!isValidEmail(input.email)) fields.email = 'Use a valid email address.';
    else email = normalizeEmail(input.email);
  }
  let phone: { e164: string | null; raw: string | null } | undefined = undefined;
  if (input.phone !== undefined) phone = normalizePhone(input.phone, country);
  if (Object.keys(fields).length) throw new AppError('VALIDATION_FAILED', 'Check the highlighted fields.', { fields });
  return { email, phone };
}

function roleFor(actor: Actor): Role {
  return isManager(actor) || actor.support?.scope === 'read_write' ? (actor.role === 'owner' ? 'owner' : 'manager') : 'member';
}

export function registerLeads(app: FastifyInstance, deps: Deps): void {
  // API-023 Search and list leads (contact terms only in the body; trigram indexes; caller's org only).
  defineRoute(app, deps, {
    op: 'API-023',
    body: searchBody,
    permission: 'leads.read',
    handler: async ctx => {
      await enforce(deps.limiter, `search:${ctx.userId}`, 60, 60);
      const b = ctx.body;
      const s = await loadOrgSettings(ctx.db, ctx.orgId);
      const after = deps.cursors.decode(ctx.orgId, 'API-023', b.cursor);
      const params: unknown[] = [ctx.userId];
      const where: string[] = [visibilitySql(ctx.actor, 'l', 1), '$1::uuid IS NOT NULL'];
      const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll('?', `$${params.length}`)); };
      if (b.query) {
        const digits = b.query.replace(/\D/g, '');
        params.push(`%${b.query.replace(/[%_\\]/g, m => '\\' + m)}%`);
        const p = params.length;
        let clause = `(l.name ILIKE $${p} OR l.email_norm ILIKE $${p}`;
        if (digits.length >= 3) { params.push(`%${digits}%`); clause += ` OR l.phone_e164 LIKE $${params.length} OR l.phone_raw LIKE $${params.length}`; }
        where.push(clause + ')');
      }
      if (b.status?.length) add('l.status = ANY(?::text[])', b.status);
      else where.push(`l.status <> 'merged'`);
      if (b.owner_id === 'me') add('l.owner_id = ?', ctx.userId);
      else if (b.owner_id === 'unassigned') where.push('l.owner_id IS NULL');
      else if (b.owner_id) add('l.owner_id = ?', b.owner_id);
      if (b.source_id) add('l.source_id = ?', b.source_id);
      if (b.created_from) add('l.created_at >= ?', localDateStartUtc(b.created_from, s.timeZone));
      if (b.created_to) add('l.created_at < ?', DateTime.fromISO(b.created_to, { zone: s.timeZone }).plus({ days: 1 }).startOf('day').toUTC().toJSDate());
      if (!b.include_test) where.push('NOT l.is_test');
      if (after) { params.push(after[0], after[1]); where.push(`(l.created_at, l.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`); }
      params.push(b.limit + 1);
      const rows = await ctx.db.q<any>(
        `SELECT l.id, l.name, l.status, l.owner_id, l.due_at, l.created_at, l.is_test, coalesce(src.name, 'Manual entry') AS source, coalesce(u.name, u.email) AS owner
           FROM lg.leads l LEFT JOIN lg.sources src ON src.id = l.source_id LEFT JOIN lg.users u ON u.id = l.owner_id
          WHERE ${where.join(' AND ')}
          ORDER BY l.created_at DESC, l.id DESC LIMIT $${params.length}`, params);
      const more = rows.length > b.limit;
      const items = rows.slice(0, b.limit).map(r => ({
        id: r.id, name: r.name, status: r.status, owner: r.owner ?? null, source: r.source, created_at: isoSeconds(r.created_at),
        due_at_local: ['new', 'attempted'].includes(r.status) ? formatLocal(r.due_at, s.timeZone) : null, ...(r.is_test ? { is_test: true } : {}),
      }));
      const last = rows[b.limit - 1];
      await ctx.audit('lead.searched');
      return { data: { items, next_cursor: more ? deps.cursors.encode(ctx.orgId, 'API-023', [last.created_at.toISOString(), last.id]) : null } };
    },
  });

  // API-024 Create lead manually: same assignment and due-time rules as source leads.
  defineRoute(app, deps, {
    op: 'API-024',
    body: createLeadBody,
    permission: 'leads.write',
    handler: async ctx => {
      const b = ctx.body;
      const s = await loadOrgSettings(ctx.db, ctx.orgId);
      const { email, phone } = normalizeContact({ email: b.email ?? null, phone: b.phone ?? null }, s.country);
      if (!email && !phone?.e164 && !phone?.raw) throw new AppError('CONTACT_REQUIRED', 'Add an email or phone number.', { fields: { phone: 'Email or phone required.' } });
      let ownerId: string | undefined;
      if (b.owner_id) {
        ownerId = b.owner_id === 'me' ? ctx.userId : b.owner_id;
        if (!isManager(ctx.actor) && ownerId !== ctx.userId) throw new AppError('AUTHORIZATION_DENIED', 'Members can only create leads for themselves.');
        const m = await ctx.db.maybe<{ status: string }>('SELECT status FROM lg.memberships WHERE org_id = $1 AND user_id = $2', [ctx.orgId, ownerId]);
        if (!m) throw new AppError('NOT_FOUND', 'Member not found.');
        if (m.status !== 'active') throw new AppError('OWNER_INACTIVE', 'That team member is not active.');
      }
      const sub = await getSubscription(ctx.db, ctx.orgId);
      const u = await usage(ctx.db, s.timeZone, ctx.now);
      const max = findPlan(deps.config.plans, sub.plan_id).limits.leads_per_month;
      if (u.leads_this_month >= max) throw planLimitError('leads_per_month', u.leads_this_month, max);

      const dups = await ctx.db.q<{ id: string; name: string | null; status: string; created_at: Date }>(
        `SELECT id, name, status, created_at FROM lg.leads
          WHERE status <> 'merged' AND (($1::text IS NOT NULL AND phone_e164 = $1) OR ($2::text IS NOT NULL AND email_norm = $2))
          ORDER BY created_at DESC LIMIT 5`, [phone?.e164 ?? null, email ?? null]);
      const created = await createLead(ctx.db, s, {
        sourceId: null, name: b.name?.trim() || null, emailNorm: email ?? null, phoneE164: phone?.e164 ?? null, phoneRaw: phone?.raw ?? null,
        message: b.message ?? null, attributes: b.attributes ?? {}, isTest: false, explicitOwnerId: ownerId, nextAction: 'First call',
        possibleDuplicates: dups.map(d => d.id), actor: { type: ctx.actor.support ? 'support' : 'user', id: ctx.userId }, requestId: ctx.requestId,
        supportGrantId: ctx.actor.support?.grantId,
      }, ctx.now);
      const lead = await ctx.db.one<LeadRow>('SELECT * FROM lg.leads WHERE id = $1', [created.id]);
      const detail = await leadDetail(ctx.db, ctx.actor, s, lead, ctx.now);
      return {
        status: 201,
        message: 'Lead created.',
        data: {
          id: detail.id, status: detail.status, contact: detail.contact, message: detail.message, source: detail.source, owner: detail.owner,
          next_action: detail.next_action, due_at: detail.due_at, due_at_local: detail.due_at_local, due_state: detail.due_state,
          first_action_at: detail.first_action_at, version: detail.version, created_at: detail.created_at,
          possible_duplicates: dups.map(d => ({ id: d.id, name: d.name, status: d.status, created_at: isoSeconds(d.created_at) })),
        },
      };
    },
  });

  // API-025 Read lead.
  defineRoute(app, deps, {
    op: 'API-025',
    params: leadParams,
    permission: 'leads.read',
    handler: async ctx => {
      const lead = await loadLead(ctx.db, ctx.actor, ctx.params.leadId);
      const s = await loadOrgSettings(ctx.db, ctx.orgId);
      return { data: await leadDetail(ctx.db, ctx.actor, s, lead, ctx.now) };
    },
  });

  // API-026 Update lead contact details (not status, owner or due time).
  defineRoute(app, deps, {
    op: 'API-026',
    params: leadParams,
    body: updateLeadBody,
    handler: async ctx => {
      const lead = await loadLeadForWrite(ctx.db, ctx.actor, ctx.params.leadId);
      assertVersion(lead, ctx.body.expected_version);
      if (lead.status === 'merged') throw new AppError('INVALID_TRANSITION', 'Merged leads are read-only.', { from: 'merged' });
      const s = await loadOrgSettings(ctx.db, ctx.orgId);
      const c = ctx.body.contact ?? {};
      const { email, phone } = normalizeContact({ email: c.email, phone: c.phone }, s.country);
      const next = {
        name: c.name !== undefined ? (c.name?.trim() || null) : lead.name,
        email_norm: email !== undefined ? email : lead.email_norm,
        phone_e164: phone !== undefined ? phone.e164 : lead.phone_e164,
        phone_raw: phone !== undefined ? phone.raw : lead.phone_raw,
        message: ctx.body.message !== undefined ? ctx.body.message : lead.message,
        next_action: ctx.body.next_action !== undefined ? ctx.body.next_action : lead.next_action,
      };
      if (!next.email_norm && !next.phone_e164 && !next.phone_raw) throw new AppError('CONTACT_REQUIRED', 'A lead needs an email or phone number.');
      const changed = (Object.keys(next) as (keyof typeof next)[]).filter(k => (next[k] ?? null) !== ((lead as any)[k] ?? null));
      const row = await ctx.db.maybe<LeadRow>(
        `UPDATE lg.leads SET name = $3, email_norm = $4, phone_e164 = $5, phone_raw = $6, message = $7, next_action = $8, version = version + 1, updated_at = now()
          WHERE id = $1 AND version = $2 RETURNING *`,
        [lead.id, ctx.body.expected_version, next.name, next.email_norm, next.phone_e164, next.phone_raw, next.message, next.next_action]);
      if (!row) throw new AppError('VERSION_CONFLICT', 'This lead was changed by someone else. Reload to see the latest version.', { current_version: lead.version });
      // Field names only - never before/after contact values (Section 32).
      await ctx.audit('lead.updated', 'lead', lead.id, changed.map(f => f.replace('_norm', '').replace('_e164', '').replace('_raw', '')));
      await emit(ctx.db, ctx.orgId, 'lead.updated', { lead_id: lead.id });
      return {
        message: 'Lead updated.',
        data: { id: row.id, contact: { name: row.name, email: row.email_norm, phone: contactPhone(row) }, message: row.message, next_action: row.next_action, version: row.version },
      };
    },
  });

  // API-027 Assign or claim. Two members claiming at once: the guarded update lets exactly one succeed.
  defineRoute(app, deps, {
    op: 'API-027',
    params: leadParams,
    body: assignBody,
    permission: 'leads.assign',
    handler: async ctx => {
      const target = ctx.body.owner_id === 'me' ? ctx.userId : ctx.body.owner_id;
      const manager = isManager(ctx.actor) || ctx.actor.support?.scope === 'read_write';
      // A member who lost a claim race must learn it was claimed (409 ALREADY_CLAIMED), so the row is read
      // without the member visibility filter here; RLS still limits it to the caller's organization.
      const raw = await ctx.db.maybe<LeadRow>('SELECT * FROM lg.leads WHERE id = $1 FOR UPDATE', [ctx.params.leadId]);
      if (!raw) throw new AppError('NOT_FOUND', 'Lead not found.');
      const lead = manager ? await loadLead(ctx.db, ctx.actor, ctx.params.leadId) : raw;
      if (!manager) {
        if (target !== ctx.userId) throw new AppError('AUTHORIZATION_DENIED', 'Members can only claim unassigned leads for themselves.');
        if (lead.owner_id && lead.owner_id !== ctx.userId) {
          const nm = await names(ctx.db, [lead.owner_id]);
          throw new AppError('ALREADY_CLAIMED', `${nm.get(lead.owner_id) ?? 'Someone'} claimed this lead a moment ago.`, { owner_id: lead.owner_id, current_version: lead.version });
        }
      }
      assertVersion(lead, ctx.body.expected_version);
      if (lead.status === 'merged') throw new AppError('INVALID_TRANSITION', 'Merged leads are read-only.', { from: 'merged' });
      const m = await ctx.db.maybe<{ status: string }>('SELECT status FROM lg.memberships WHERE org_id = $1 AND user_id = $2', [ctx.orgId, target]);
      if (!m) throw new AppError('NOT_FOUND', 'Member not found.');
      if (m.status !== 'active') throw new AppError('OWNER_INACTIVE', 'That team member is not active.');
      const s = await loadOrgSettings(ctx.db, ctx.orgId);
      const nm = await names(ctx.db, [target, ctx.userId]);
      if (lead.owner_id === target) {
        return { message: `Lead already assigned to ${nm.get(target)}.`, data: { id: lead.id, owner: ownerObj(target, nm), ...dueFields(lead, s), timers_cancelled: [], version: lead.version } };
      }
      const row = await ctx.db.maybe<{ version: number }>(
        'UPDATE lg.leads SET owner_id = $3, version = version + 1, updated_at = now() WHERE id = $1 AND version = $2 RETURNING version',
        [lead.id, ctx.body.expected_version, target]);
      if (!row) throw new AppError('VERSION_CONFLICT', 'This lead was changed by someone else. Reload to see the latest version.', { current_version: lead.version });
      await markAssigned(ctx.db, ctx.orgId, target);
      const how = target === ctx.userId && !lead.owner_id ? 'claimed' : `by ${nm.get(ctx.userId) ?? 'a manager'}`;
      await addActivity(ctx.db, {
        orgId: ctx.orgId, leadId: lead.id, type: 'assigned', actorId: ctx.userId, evidence: 'system',
        note: how === 'claimed' ? `Claimed by ${nm.get(target)}` : `Assigned to ${nm.get(target)} ${how}${ctx.body.note ? ` - ${ctx.body.note}` : ''}`,
      });
      const plan = ['new', 'attempted'].includes(lead.status)
        ? await replanForOwner(ctx.db, s, lead, target, ctx.now, 'reassigned')
        : { cancelled: [], dueAt: lead.due_at };
      await cancelPendingAlerts(ctx.db, lead.id);
      await ctx.audit('lead.assigned', 'lead', lead.id, ['owner_id']);
      await emit(ctx.db, ctx.orgId, 'lead.assigned', { lead_id: lead.id, owner_id: target, previous_owner_id: lead.owner_id });
      const after = await ctx.db.one<LeadRow>('SELECT * FROM lg.leads WHERE id = $1', [lead.id]);
      return {
        message: `Lead assigned to ${nm.get(target)}.`,
        data: { id: lead.id, owner: ownerObj(target, nm), ...dueFields(after, s), timers_cancelled: plan.cancelled, version: after.version },
      };
    },
  });

  // API-028 Log contact attempt or note.
  defineRoute(app, deps, {
    op: 'API-028',
    params: leadParams,
    body: activityBody,
    handler: async ctx => {
      const b = ctx.body;
      const lead = await loadLeadForWrite(ctx.db, ctx.actor, ctx.params.leadId);
      if (lead.status === 'merged') throw new AppError('INVALID_TRANSITION', 'Merged leads are read-only.', { from: 'merged' });
      const isNote = b.type === 'note';
      if (!isNote && b.expected_version === undefined) {
        throw new AppError('VALIDATION_FAILED', 'expected_version is required when logging a contact attempt.', { fields: { expected_version: 'Required.' } });
      }
      if (!isNote && (!b.outcome || b.outcome === 'note')) {
        throw new AppError('VALIDATION_FAILED', 'Choose the outcome of this contact attempt.', { fields: { outcome: 'Required for calls, texts, emails and visits.' } });
      }
      const occurredAt = b.occurred_at ? new Date(b.occurred_at) : ctx.now;
      if (occurredAt.getTime() > ctx.now.getTime() + 60_000) {
        throw new AppError('VALIDATION_FAILED', 'Activity time cannot be in the future.', { fields: { occurred_at: 'Must be on or before now.' } });
      }
      if (b.expected_version !== undefined) assertVersion(lead, b.expected_version);
      const s = await loadOrgSettings(ctx.db, ctx.orgId);
      const eff = await applyActivity(ctx.db, s, lead, {
        type: b.type, outcome: (b.outcome ?? null) as any, note: b.note ?? null, actorId: ctx.userId, occurredAt, evidence: 'self_reported',
      });
      await ctx.audit('lead.activity_added', 'lead', lead.id);
      const nm = await names(ctx.db, [ctx.userId]);
      const activity = { id: eff.activityId, type: b.type, outcome: isNote ? 'note' : b.outcome, occurred_at: isoSeconds(occurredAt), by: nm.get(ctx.userId) ?? null };
      const contact = b.outcome === 'reached' || b.outcome === 'booked';
      if (isNote) return { status: 201, message: 'Note added.', data: { activity, lead: { id: lead.id, status: lead.status, version: lead.version }, timers: { cancelled: [], created: [] } } };
      if (contact) {
        return {
          status: 201,
          message: eff.status === 'contacted' ? 'Marked contacted. Pending reminders cancelled.' : 'Contact logged.',
          data: {
            activity, lead: { id: lead.id, status: eff.status, next_action: eff.nextAction, due_at: isoOrNull(eff.dueAt), version: eff.version },
            timers: { cancelled: eff.timersCancelled, created: eff.timersCreated }, alerts_cancelled: eff.alertsCancelled,
          },
        };
      }
      const label = b.type === 'call' ? 'Call' : b.type === 'text' ? 'Text' : b.type === 'email' ? 'Email' : 'Visit';
      const nextLocal = eff.dueAt ? DateTime.fromJSDate(eff.dueAt).setZone(s.timeZone).toFormat('h:mm a') : null;
      return {
        status: 201,
        message: nextLocal ? `${label} logged. Next attempt due ${nextLocal}.` : `${label} logged.`,
        data: {
          activity,
          lead: { id: lead.id, status: eff.status, first_action_at: isoOrNull(eff.firstActionAt), next_action: eff.nextAction, due_at_local: formatLocal(eff.dueAt, s.timeZone), version: eff.version },
          timers: { cancelled: eff.timersCancelled, created: eff.timersCreated },
        },
      };
    },
  });

  // API-029 Change lead status (Section 30.1 table; lost and spam require a reason).
  defineRoute(app, deps, {
    op: 'API-029',
    params: leadParams,
    body: statusBody,
    handler: async ctx => {
      const b = ctx.body;
      const lead = await loadLeadForWrite(ctx.db, ctx.actor, ctx.params.leadId);
      assertVersion(lead, b.expected_version);
      const from = lead.status as LeadStatus;
      const to = b.to_status as LeadStatus;
      const check = checkTransition(from, to, roleFor(ctx.actor), b.reason);
      if (!check.ok) {
        const message = check.reasonMissing
          ? 'A reason is required for this change.'
          : from === 'new' && to === 'won' ? `A lead cannot move from 'new' to 'won'. Log contact first.` : `A lead cannot move from '${from}' to '${to}'.`;
        throw new AppError('INVALID_TRANSITION', message, { from, to, allowed: check.allowed, ...(check.reasonMissing ? { reason: 'required' } : {}) });
      }
      const s = await loadOrgSettings(ctx.db, ctx.orgId);
      let timersCancelled: string[] = [];
      let closedAt: Date | null = null;
      if (check.reopen) {
        await ctx.db.q(`UPDATE lg.leads SET status = 'attempted', closed_at = NULL, close_reason = NULL, cycle_started_at = $2, next_action = 'Follow up (reopened)', version = version + 1, updated_at = now() WHERE id = $1`, [lead.id, ctx.now]);
        if (lead.owner_id) await scheduleFirstResponse(ctx.db, s, lead.id, ctx.now, 'Reopened lead follow-up');
        else await scheduleUnassigned(ctx.db, s, lead.id, ctx.now);
      } else if (to === 'attempted') {
        timersCancelled = await cancelTimers(ctx.db, ctx.orgId, lead.id, 'marked attempted', ['first_response_due']);
        await ctx.db.q(`UPDATE lg.leads SET status = 'attempted', version = version + 1, updated_at = now() WHERE id = $1`, [lead.id]);
        if (lead.owner_id) await scheduleFollowUp(ctx.db, s, lead.id, ctx.now, 1);
      } else {
        const closing = ['won', 'lost', 'spam'].includes(to);
        timersCancelled = await cancelTimers(ctx.db, ctx.orgId, lead.id, closing ? `lead marked ${to}` : 'lead contacted');
        await cancelPendingAlerts(ctx.db, lead.id);
        closedAt = closing ? ctx.now : null;
        await ctx.db.q(
          `UPDATE lg.leads SET status = $2, closed_at = $3, close_reason = $4, next_action = NULL, due_at = NULL, version = version + 1, updated_at = now() WHERE id = $1`,
          [lead.id, to, closedAt, closing ? (b.reason ?? null) : null]);
      }
      await addActivity(ctx.db, {
        orgId: ctx.orgId, leadId: lead.id, type: 'status_changed', actorId: ctx.userId, evidence: 'system',
        note: `Status changed from ${from} to ${to}${b.reason ? ` - ${b.reason}` : ''}`,
      });
      await ctx.audit('lead.status_changed', 'lead', lead.id, ['status']);
      await emit(ctx.db, ctx.orgId, 'lead.status_changed', { lead_id: lead.id, from, to });
      const v = await ctx.db.one<{ version: number }>('SELECT version FROM lg.leads WHERE id = $1', [lead.id]);
      return {
        message: `Lead marked ${to}.`,
        data: { id: lead.id, status: to, previous_status: from, ...(closedAt ? { closed_at: isoSeconds(closedAt) } : {}), timers_cancelled: timersCancelled.length, version: v.version },
      };
    },
  });

  // API-030 Reschedule next action (local time parsed with the DST guard).
  defineRoute(app, deps, {
    op: 'API-030',
    params: leadParams,
    body: snoozeBody,
    handler: async ctx => {
      const b = ctx.body;
      const lead = await loadLeadForWrite(ctx.db, ctx.actor, ctx.params.leadId);
      assertVersion(lead, b.expected_version);
      if (!['new', 'attempted'].includes(lead.status)) throw new AppError('INVALID_TRANSITION', 'This lead is closed or already contacted; there is no next action to reschedule.', { from: lead.status });
      const s = await loadOrgSettings(ctx.db, ctx.orgId);
      let due: Date;
      try {
        due = new Date(parseLocalWallTime(b.due_at_local, s.timeZone));
      } catch (e) {
        throw localTimeError((e as Error).message, b.due_at_local, s.timeZone, 'due_at_local');
      }
      if (due.getTime() <= ctx.now.getTime()) throw new AppError('VALIDATION_FAILED', 'Choose a time in the future.', { fields: { due_at_local: 'Must be in the future.' } });
      if (due.getTime() > ctx.now.getTime() + 30 * 86_400_000) throw new AppError('VALIDATION_FAILED', 'Choose a time within the next 30 days.', { fields: { due_at_local: 'At most 30 days ahead.' } });
      const hadFirst = await ctx.db.maybe(`SELECT 1 FROM lg.lead_timers WHERE lead_id = $1 AND kind = 'first_response_due' AND state IN ('pending','claimed')`, [lead.id]);
      await cancelTimers(ctx.db, ctx.orgId, lead.id, 'rescheduled', ['first_response_due', 'follow_up_due', 'escalation'], { silent: true });
      await cancelPendingAlerts(ctx.db, lead.id);
      const nextAction = b.next_action ?? 'Follow-up call';
      await createTimer(ctx.db, { orgId: ctx.orgId, leadId: lead.id, kind: hadFirst ? 'first_response_due' : 'follow_up_due', dueAt: due, policyVersion: s.policy.version });
      const row = await ctx.db.one<{ version: number }>(
        'UPDATE lg.leads SET due_at = $2, next_action = $3, version = version + 1, updated_at = now() WHERE id = $1 RETURNING version', [lead.id, due, nextAction]);
      const local = formatLocal(due, s.timeZone)!;
      await addActivity(ctx.db, { orgId: ctx.orgId, leadId: lead.id, type: 'rescheduled', actorId: ctx.userId, evidence: 'system', note: `Rescheduled to ${local} - ${b.reason}` });
      await ctx.audit('lead.rescheduled', 'lead', lead.id, ['due_at', 'next_action']);
      await emit(ctx.db, ctx.orgId, 'lead.rescheduled', { lead_id: lead.id, due_at: due.toISOString() });
      return {
        message: `Rescheduled for ${DateTime.fromJSDate(due).setZone(s.timeZone).toFormat('LLL d, h:mm a')}.`,
        data: { id: lead.id, next_action: nextAction, due_at: isoSeconds(due), due_at_local: local, version: row.version },
      };
    },
  });

  // API-031 Timeline: one UNION query over activities, source events and alerts, ordered and paged.
  defineRoute(app, deps, {
    op: 'API-031',
    params: leadParams,
    query: timelineQuery,
    permission: 'leads.read',
    handler: async ctx => {
      const lead = await loadLead(ctx.db, ctx.actor, ctx.params.leadId);
      const after = deps.cursors.decode(ctx.orgId, `API-031:${lead.id}`, ctx.query.cursor);
      const ids = [lead.id, ...(await ctx.db.q<{ id: string }>('SELECT id FROM lg.leads WHERE merged_into = $1', [lead.id])).map(r => r.id)];
      const rows = await ctx.db.q<any>(
        `SELECT * FROM (
           SELECT a.occurred_at AS at, a.id::text AS k, 'activity' AS src, a.type, a.subtype, a.outcome, a.evidence, a.note, a.actor_id,
                  NULL::uuid AS alert_id, NULL::text AS alert_state, NULL::int AS policy_version, NULL::text AS timer_kind, NULL::int AS cycle,
                  NULL::int AS minutes, NULL::text AS source_name, false AS is_test
             FROM lg.lead_activities a WHERE a.lead_id = ANY($1::uuid[])
           UNION ALL
           SELECT e.created_at, e.id::text, 'event', e.kind, e.outcome, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, s.name, e.is_test
             FROM lg.source_events e JOIN lg.sources s ON s.id = e.source_id WHERE e.lead_id = ANY($1::uuid[])
           UNION ALL
           SELECT al.created_at, al.id::text, 'alert', al.kind, NULL, NULL, NULL, NULL, NULL, al.id, al.state, al.policy_version, t.kind, t.cycle,
                  t.business_minutes, NULL, false
             FROM lg.alerts al JOIN lg.lead_timers t ON t.id = al.timer_id WHERE al.lead_id = ANY($1::uuid[])
         ) x
         WHERE ($2::timestamptz IS NULL OR (x.at, x.k) > ($2::timestamptz, $3::text))
         ORDER BY x.at, x.k LIMIT $4`,
        [ids, after?.[0] ?? null, after?.[1] ?? null, ctx.query.limit + 1]);
      const pageRows = rows.slice(0, ctx.query.limit);
      const alertIds = pageRows.filter(r => r.src === 'alert').map(r => r.alert_id);
      const deliveries = alertIds.length
        ? await ctx.db.q<{ alert_id: string; recipient_id: string; channel: string; state: string }>(
          'SELECT alert_id, recipient_id, channel, state FROM lg.alert_deliveries WHERE alert_id = ANY($1::uuid[]) ORDER BY recipient_id, channel', [alertIds])
        : [];
      const nm = await names(ctx.db, [...pageRows.map(r => r.actor_id), ...deliveries.map(d => d.recipient_id)]);
      const items = pageRows.map(r => timelineItem(r, deliveries, nm));
      const last = pageRows[pageRows.length - 1];
      return { data: { items, next_cursor: rows.length > ctx.query.limit ? deps.cursors.encode(ctx.orgId, `API-031:${lead.id}`, [last.at.toISOString(), last.k]) : null } };
    },
  });

  // API-032 Merge duplicate lead into this one. Nothing is deleted: append-only history stays on the merged lead
  // and the survivor's timeline includes it (merged_into link).
  defineRoute(app, deps, {
    op: 'API-032',
    params: leadParams,
    body: mergeBody,
    permission: 'leads.write',
    handler: async ctx => {
      if (!isManager(ctx.actor) && ctx.actor.support?.scope !== 'read_write') throw new AppError('AUTHORIZATION_DENIED', 'Only owners and managers can merge leads.');
      const b = ctx.body;
      if (b.merge_lead_id === ctx.params.leadId) throw new AppError('MERGE_NOT_ALLOWED', 'You cannot merge a lead into itself.');
      // Lock both rows in a stable order to avoid deadlocks between concurrent merges.
      const [first, second] = [ctx.params.leadId, b.merge_lead_id].sort();
      await ctx.db.q('SELECT id FROM lg.leads WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[first, second]]);
      const survivor = await loadLead(ctx.db, ctx.actor, ctx.params.leadId);
      const merged = await loadLead(ctx.db, ctx.actor, b.merge_lead_id);
      const open = (st: string) => ['new', 'attempted', 'contacted', 'qualified'].includes(st);
      if (!open(survivor.status) || !open(merged.status)) throw new AppError('MERGE_NOT_ALLOWED', 'Only open leads can be merged.');
      assertVersion(survivor, b.expected_version);
      assertVersion(merged, b.merge_expected_version);
      await cancelTimers(ctx.db, ctx.orgId, merged.id, 'merged into another lead');
      await cancelPendingAlerts(ctx.db, merged.id);
      await ctx.db.q(`UPDATE lg.leads SET status = 'merged', merged_into = $2, next_action = NULL, due_at = NULL, closed_at = $3, version = version + 1, updated_at = now() WHERE id = $1`,
        [merged.id, survivor.id, ctx.now]);
      // Fill contact gaps on the survivor from the merged lead (never overwrite).
      const row = await ctx.db.one<{ version: number }>(
        `UPDATE lg.leads SET name = coalesce(name, $2), email_norm = coalesce(email_norm, $3), phone_e164 = coalesce(phone_e164, $4),
                phone_raw = CASE WHEN phone_e164 IS NULL AND $4::text IS NULL THEN coalesce(phone_raw, $5) ELSE phone_raw END,
                first_action_at = CASE WHEN first_action_at IS NULL THEN $6::timestamptz WHEN $6::timestamptz IS NULL THEN first_action_at ELSE least(first_action_at, $6::timestamptz) END,
                possible_duplicates = array_remove(possible_duplicates, $7::uuid),
                version = version + 1, updated_at = now() WHERE id = $1 RETURNING version`,
        [survivor.id, merged.name, merged.email_norm, merged.phone_e164, merged.phone_raw, merged.first_action_at, merged.id]);
      const counts = await ctx.db.one<{ events: number; activities: number }>(
        `SELECT (SELECT count(*)::int FROM lg.source_events WHERE lead_id = $1) AS events,
                (SELECT count(*)::int FROM lg.lead_activities WHERE lead_id = $1) AS activities`, [merged.id]);
      await addActivity(ctx.db, { orgId: ctx.orgId, leadId: survivor.id, type: 'merged', actorId: ctx.userId, evidence: 'system', note: `Merged duplicate lead ${merged.id} into this lead` });
      await addActivity(ctx.db, { orgId: ctx.orgId, leadId: merged.id, type: 'merged', actorId: ctx.userId, evidence: 'system', note: `Merged into lead ${survivor.id}` });
      await ctx.audit('lead.merged', 'lead', survivor.id);
      await emit(ctx.db, ctx.orgId, 'lead.merged', { lead_id: survivor.id, merged_lead_id: merged.id });
      return {
        message: 'Leads merged.',
        data: { id: survivor.id, merged_lead_id: merged.id, events_moved: counts.events, activities_moved: counts.activities, merged_lead_status: 'merged', version: row.version },
      };
    },
  });
}

const KIND_LABEL: Record<string, string> = { first_response_due: 'first response overdue', follow_up_due: 'follow-up overdue' };

function timelineItem(r: any, deliveries: { alert_id: string; recipient_id: string; channel: string; state: string }[], nm: Map<string, string>) {
  const at = isoSeconds(r.at);
  if (r.src === 'event') {
    const test = r.is_test ? ' (TEST)' : '';
    const text = r.type === 'call'
      ? (r.subtype === 'activity_logged' ? `Answered call received on ${r.source_name}` : `Missed call received on ${r.source_name}${test}`)
      : (r.subtype === 'lead_linked' ? `Repeat enquiry received from ${r.source_name}` : `Enquiry received from ${r.source_name}${test}`);
    return { at, type: 'event_received', text };
  }
  if (r.src === 'alert') {
    const ds = deliveries.filter(d => d.alert_id === r.alert_id);
    const recipients = [...new Set(ds.map(d => nm.get(d.recipient_id) ?? 'team member'))].join(', ') || 'nobody (no deliverable channel)';
    const step = `policy v${r.policy_version}, ${r.timer_kind} cycle ${r.cycle}`;
    let text: string;
    let type: string;
    if (r.type === 'reminder') { type = 'reminder'; text = `Reminder to ${recipients} - ${KIND_LABEL[r.timer_kind] ?? 'overdue'} (${step})`; }
    else if (r.type === 'escalation') { type = 'escalation'; text = `Escalated to ${recipients}${r.minutes ? ` - overdue ${r.minutes} min` : ''} (${step})`; }
    else { type = 'escalation'; text = `Unassigned lead escalated to ${recipients} (${step})`; }
    if (r.alert_state === 'cancelled') text += ' - pending notifications cancelled, lead handled';
    return { at, type, text, alert_id: r.alert_id, deliveries: ds.map(d => ({ recipient: nm.get(d.recipient_id) ?? null, channel: d.channel, state: d.state })) };
  }
  const actor = r.actor_id ? (nm.get(r.actor_id) ?? 'A team member') : 'System';
  switch (r.type) {
    case 'call': case 'text': case 'email': case 'visit': {
      const evidence = r.evidence === 'provider_confirmed' ? 'provider-confirmed' : 'self-reported';
      const who = r.evidence === 'provider_confirmed' ? 'Call provider' : actor;
      return { at, type: 'activity', text: `${who} logged a ${r.type}: ${r.outcome ?? 'no outcome'} (${evidence})`, ...(r.note ? { note: r.note } : {}) };
    }
    case 'note':
      return { at, type: 'note', text: `${actor} added a note`, note: r.note };
    case 'system':
      return { at, type: r.subtype ?? 'system', text: r.note };
    default:
      return { at, type: r.type, text: r.note };
  }
}
