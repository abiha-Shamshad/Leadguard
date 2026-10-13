// Operator CLI: move an organization to the managed invoice path (Section 13.1 `pilot_invoice`) with an audit record.
// Usage: DATABASE_URL=postgres://lg_app:...@host/db tsx scripts/set-pilot-invoice.ts <org_id> <operator_name> [period_end_iso]
import { createPool, withOrg, transition, audit } from '@leadguard/db';
import { UUID_RE } from '@leadguard/domain';

const [orgId, operator, periodEnd] = process.argv.slice(2);
if (!orgId || !UUID_RE.test(orgId) || !operator) {
  console.error('usage: tsx scripts/set-pilot-invoice.ts <org_id> <operator_name> [period_end_iso]');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL (lg_app) is required');
  process.exit(1);
}
const pool = createPool(process.env.DATABASE_URL, { max: 1, applicationName: 'leadguard-operator' });
try {
  const to = await withOrg(pool, orgId, null, async db => {
    const exists = await db.maybe('SELECT 1 FROM lg.subscriptions WHERE org_id = $1', [orgId]);
    if (!exists) throw new Error('organization not found');
    const fields: Record<string, unknown> = { cancel_at_period_end: false, past_due_since: null };
    if (periodEnd) fields.current_period_end = new Date(periodEnd);
    const state = await transition(db, orgId, 'pilot_invoice', fields as any, { type: 'system', id: `operator:${operator}` });
    await audit(db, { orgId, actorType: 'system', actorId: `operator:${operator}`, action: 'billing.pilot_invoice_set', recordType: 'subscription', recordId: orgId, changedFields: Object.keys(fields) });
    return state;
  });
  console.log(`organization ${orgId} is now ${to}`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
