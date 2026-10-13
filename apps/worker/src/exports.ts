// export-builds: full CSV export (leads, activities, alerts) zipped into private storage, expiring after 24 h.
import { zipSync, strToU8 } from 'fflate';
import { withOrg, type Db } from '@leadguard/db';
import type { WorkerContext } from './context.ts';
import { log } from './log.ts';

const PAGE = 5000;
const FILE_HOURS = 24;

/** CSV cell with spreadsheet formula-injection guard (cells starting with = + - @ are prefixed). */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header.join(','), ...rows.map(r => r.map(csvCell).join(','))].join('\r\n') + '\r\n';
}

async function paged(db: Db, sql: string): Promise<any[]> {
  const out: any[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const rows = await db.q(`${sql} LIMIT ${PAGE} OFFSET ${offset}`);
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

export async function processExport(ctx: WorkerContext, orgId: string, exportId: string): Promise<'ready' | 'failed' | 'skipped'> {
  const claim = await withOrg(ctx.app, orgId, null, async db => {
    const e = await db.maybe<{ status: string; include: string[]; attempts: number }>('SELECT status, include, attempts FROM lg.exports WHERE id = $1 FOR UPDATE', [exportId]);
    if (!e || !['queued', 'building'].includes(e.status)) return null;
    await db.q(`UPDATE lg.exports SET status = 'building', attempts = attempts + 1 WHERE id = $1`, [exportId]);
    return e;
  });
  if (!claim) return 'skipped';
  try {
    const files: Record<string, Uint8Array> = {};
    const counts: Record<string, number> = {};
    await withOrg(ctx.app, orgId, null, async db => {
      if (claim.include.includes('leads')) {
        const rows = await paged(db,
          `SELECT l.id, l.created_at, l.status, l.name, l.email_norm, coalesce(l.phone_e164, l.phone_raw) AS phone, l.message, coalesce(s.name, 'Manual entry') AS source,
                  coalesce(u.name, u.email) AS owner, l.next_action, l.due_at, l.first_action_at, l.closed_at, l.close_reason, l.merged_into, l.is_test, l.attributes
             FROM lg.leads l LEFT JOIN lg.sources s ON s.id = l.source_id LEFT JOIN lg.users u ON u.id = l.owner_id ORDER BY l.created_at, l.id`);
        files['leads.csv'] = strToU8(toCsv(
          ['id', 'created_at', 'status', 'name', 'email', 'phone', 'message', 'source', 'owner', 'next_action', 'due_at', 'first_action_at', 'closed_at', 'close_reason', 'merged_into', 'is_test', 'attributes'],
          rows.map(r => [r.id, r.created_at, r.status, r.name, r.email_norm, r.phone, r.message, r.source, r.owner, r.next_action, r.due_at, r.first_action_at, r.closed_at, r.close_reason, r.merged_into, r.is_test, r.attributes])));
        counts.leads = rows.length;
      }
      if (claim.include.includes('activities')) {
        const rows = await paged(db,
          `SELECT a.id, a.lead_id, a.occurred_at, a.type, a.subtype, a.outcome, a.evidence, a.note, coalesce(u.name, u.email) AS actor
             FROM lg.lead_activities a LEFT JOIN lg.users u ON u.id = a.actor_id ORDER BY a.occurred_at, a.id`);
        files['activities.csv'] = strToU8(toCsv(['id', 'lead_id', 'occurred_at', 'type', 'subtype', 'outcome', 'evidence', 'note', 'actor'],
          rows.map(r => [r.id, r.lead_id, r.occurred_at, r.type, r.subtype, r.outcome, r.evidence, r.note, r.actor])));
        counts.activities = rows.length;
      }
      if (claim.include.includes('alerts')) {
        const rows = await paged(db,
          `SELECT a.id, a.lead_id, a.kind, a.created_at, a.state, a.policy_version, t.kind AS timer_kind, t.cycle,
                  (SELECT string_agg(coalesce(u.name, u.email) || ' ' || d.channel || ' ' || d.state, '; ' ORDER BY d.recipient_id, d.channel)
                     FROM lg.alert_deliveries d JOIN lg.users u ON u.id = d.recipient_id WHERE d.alert_id = a.id) AS deliveries
             FROM lg.alerts a JOIN lg.lead_timers t ON t.id = a.timer_id ORDER BY a.created_at, a.id`);
        files['alerts.csv'] = strToU8(toCsv(['id', 'lead_id', 'kind', 'created_at', 'state', 'policy_version', 'timer_kind', 'cycle', 'deliveries'],
          rows.map(r => [r.id, r.lead_id, r.kind, r.created_at, r.state, r.policy_version, r.timer_kind, r.cycle, r.deliveries])));
        counts.alerts = rows.length;
      }
    });
    const zip = Buffer.from(zipSync(files, { level: 6 }));
    const key = `exports/${orgId}/${exportId}.zip`;
    await ctx.storage.put(key, zip, 'application/zip');
    await withOrg(ctx.app, orgId, null, db => db.q(
      `UPDATE lg.exports SET status = 'ready', file_key = $2, rows = $3, expires_at = now() + make_interval(hours => $4) WHERE id = $1 AND status = 'building'`,
      [exportId, key, JSON.stringify(counts), FILE_HOURS]));
    log.info('export ready', { export_id: exportId, org_id: orgId, ...counts });
    return 'ready';
  } catch (e) {
    const final = claim.attempts + 1 >= 2;
    await withOrg(ctx.app, orgId, null, db => db.q(
      `UPDATE lg.exports SET status = $2, failure_reason = $3 WHERE id = $1`, [exportId, final ? 'failed' : 'queued', final ? 'Export build failed' : null]));
    log.error('export failed', { export_id: exportId, org_id: orgId, final, error: (e as Error).message });
    if (!final) throw e;
    return 'failed';
  }
}

/** Expired files are deleted and the export marked expired (file kept 24 hours). */
export async function expireExport(ctx: WorkerContext, orgId: string, exportId: string): Promise<void> {
  await withOrg(ctx.app, orgId, null, async db => {
    const e = await db.maybe<{ file_key: string | null }>(`SELECT file_key FROM lg.exports WHERE id = $1 AND status = 'ready' AND expires_at < now() FOR UPDATE`, [exportId]);
    if (!e) return;
    if (e.file_key) await ctx.storage.delete(e.file_key);
    await db.q(`UPDATE lg.exports SET status = 'expired', file_key = NULL WHERE id = $1`, [exportId]);
  });
}
