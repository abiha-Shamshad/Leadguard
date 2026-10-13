// API-022 Needs Action inbox: overdue, due soon and unassigned, each with its own cursor and exact count.
// One query per section (ix_leads_inbox / ix_leads_owner) with owner and source names joined (Section 33).
import type { FastifyInstance } from 'fastify';
import { inboxQuery } from '@leadguard/contracts';
import { formatLocal, maskPhone } from '@leadguard/domain';
import { loadOrgSettings, type Db } from '@leadguard/db';
import type { Deps } from '../deps.ts';
import { defineRoute } from '../lib/route.ts';
import { isManager } from '../lib/access.ts';
import type { Actor } from '../plugins/auth.ts';

type Section = 'overdue' | 'due_soon' | 'unassigned';

/** Shared predicates: counts and lists must use exactly the same WHERE clauses (TASK-009 troubleshoot). */
function sectionWhere(section: Section, mine: boolean): string {
  const base = `l.status IN ('new','attempted')`;
  if (section === 'unassigned') return `${base} AND l.owner_id IS NULL`;
  const owner = mine ? 'l.owner_id = $1' : 'l.owner_id IS NOT NULL';
  if (section === 'overdue') return `${base} AND ${owner} AND l.due_at < $2`;
  return `${base} AND ${owner} AND (l.due_at >= $2 OR l.due_at IS NULL)`;
}

const ORDER: Record<Section, { sql: string; key: (r: any) => unknown[]; after: string }> = {
  overdue: { sql: 'l.due_at ASC, l.id ASC', key: r => [r.due_at.toISOString(), r.id], after: '(l.due_at, l.id) > ($3::timestamptz, $4::uuid)' },
  due_soon: {
    sql: `coalesce(l.due_at, 'infinity'::timestamptz) ASC, l.id ASC`,
    key: r => [r.due_at ? r.due_at.toISOString() : 'infinity', r.id],
    after: `(coalesce(l.due_at, 'infinity'::timestamptz), l.id) > ($3::timestamptz, $4::uuid)`,
  },
  unassigned: { sql: 'l.created_at ASC, l.id ASC', key: r => [r.created_at.toISOString(), r.id], after: '(l.created_at, l.id) > ($3::timestamptz, $4::uuid)' },
};

async function sectionRows(db: Db, section: Section, mine: boolean, userId: string, now: Date, after: unknown[] | null, limit: number) {
  const o = ORDER[section];
  // $1/$2 are always bound; reference both so PostgreSQL can type them in every section.
  const where = sectionWhere(section, mine) + ' AND $1::uuid IS NOT NULL AND $2::timestamptz IS NOT NULL' + (after ? ` AND ${o.after}` : '');
  const params: unknown[] = [userId, now];
  if (after) params.push(after[0], after[1]);
  params.push(limit + 1);
  return db.q<any>(
    `SELECT l.id, l.name, l.phone_e164, l.phone_raw, l.next_action, l.due_at, l.created_at, l.version, l.is_test,
            coalesce(src.name, 'Manual entry') AS source, coalesce(u.name, u.email) AS owner,
            EXISTS (SELECT 1 FROM lg.alerts a WHERE a.lead_id = l.id AND a.kind = 'escalation' AND a.state <> 'cancelled'
                     AND a.created_at >= coalesce(l.cycle_started_at, l.created_at)) AS escalated
       FROM lg.leads l
       LEFT JOIN lg.sources src ON src.id = l.source_id
       LEFT JOIN lg.users u ON u.id = l.owner_id
      WHERE ${where}
      ORDER BY ${o.sql} LIMIT $${params.length}`, params);
}

async function sectionCounts(db: Db, mine: boolean, userId: string, now: Date) {
  return db.one<{ overdue: number; due_soon: number; unassigned: number }>(
    `SELECT count(*) FILTER (WHERE ${sectionWhere('overdue', mine)})::int AS overdue,
            count(*) FILTER (WHERE ${sectionWhere('due_soon', mine)})::int AS due_soon,
            count(*) FILTER (WHERE ${sectionWhere('unassigned', mine)})::int AS unassigned
       FROM lg.leads l WHERE l.status IN ('new','attempted') AND ($1::uuid IS NOT NULL) AND ($2::timestamptz IS NOT NULL)`, [userId, now]);
}

function itemFor(section: Section, r: any, tz: string, now: Date) {
  const base: Record<string, unknown> = { id: r.id, name: r.name };
  if (section === 'unassigned') {
    base.phone_masked = maskPhone(r.phone_e164, r.phone_raw);
    Object.assign(base, {
      source: r.source, next_action: r.next_action,
      waiting_minutes: Math.max(0, Math.floor((now.getTime() - r.created_at.getTime()) / 60_000)), version: r.version,
    });
  } else {
    Object.assign(base, { source: r.source, owner: r.owner, next_action: r.next_action, due_at_local: formatLocal(r.due_at, tz) });
    if (section === 'overdue') {
      base.overdue_minutes = Math.floor((now.getTime() - r.due_at.getTime()) / 60_000);
      base.escalated = r.escalated;
    } else {
      base.due_in_minutes = r.due_at ? Math.max(0, Math.ceil((r.due_at.getTime() - now.getTime()) / 60_000)) : null;
    }
    base.version = r.version;
  }
  if (r.is_test) base.is_test = true;
  return base;
}

function viewFor(actor: Actor, requested: 'mine' | 'team' | undefined): 'mine' | 'team' {
  // Members see their own and unassigned leads; managers and owners can switch to the team view.
  if (!isManager(actor) && !actor.support) return 'mine';
  return requested ?? 'team';
}

export function registerInbox(app: FastifyInstance, deps: Deps): void {
  defineRoute(app, deps, {
    op: 'API-022',
    query: inboxQuery,
    permission: 'leads.read',
    handler: async ctx => {
      const q = ctx.query;
      const s = await loadOrgSettings(ctx.db, ctx.orgId);
      const mine = viewFor(ctx.actor, q.view) === 'mine';
      const sections: Section[] = q.section ? [q.section] : ['overdue', 'due_soon', 'unassigned'];
      const out: Record<string, unknown[]> = {};
      const cursors: Record<string, string | null> = {};
      for (const sec of sections) {
        const endpoint = `API-022:${sec}:${mine ? 'mine' : 'team'}`;
        const after = q.section ? deps.cursors.decode(ctx.orgId, endpoint, q.cursor) : null;
        const rows = await sectionRows(ctx.db, sec, mine, ctx.userId, ctx.now, after, q.limit);
        const items = rows.slice(0, q.limit);
        out[sec] = items.map(r => itemFor(sec, r, s.timeZone, ctx.now));
        cursors[sec] = rows.length > q.limit ? deps.cursors.encode(ctx.orgId, endpoint, ORDER[sec].key(items[items.length - 1])) : null;
      }
      const counts = await sectionCounts(ctx.db, mine, ctx.userId, ctx.now);
      return { data: { view: mine ? 'mine' : 'team', counts, sections: out, cursors } };
    },
  });
}
