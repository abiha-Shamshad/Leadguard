'use client';
// Subscription (API-042..045, 048, 049): plan limits, trial state, payment choice, cancellation and export in
// plain language. "Contact us" while billing is not configured. Never an optimistic update.
import { useEffect, useState } from 'react';
import { useSession } from '@/lib/session';
import { useCommand, useInvalidate, useOrgQuery } from '@/lib/hooks';
import { formatInZone, SUB_LABEL } from '@/lib/format';
import { Badge, Banner, Button, Card, Dialog, ErrorView, Loading, PageHead, TextInput } from '@/components/ui';
import { LIMITS } from '@/lib/limits';

interface Plans { currency: string; status: string; note: string; items: { plan_id: string; name: string; price_monthly: number | null; limits: Record<string, number> }[] }
interface Subscription {
  state: string; plan_id: string; plan: string; usage: Record<string, number>; writable: boolean; after_trial: string;
  trial?: { started_at: string | null; ends_at: string; card_on_file: boolean }; current_period_end?: string; cancel_at_period_end: boolean; cancels_on?: string | null;
  grace_ends_at?: string; billing_provider_configured: boolean;
}
interface ExportStatus { export_id: string; status: string; rows?: Record<string, number>; download_url?: string; url_expires_at?: string; file_expires_at?: string; failure_reason?: string }

export function BillingView() {
  const s = useSession();
  const plans = useOrgQuery<Plans>(['plans'], '/billing/plans');
  const sub = useOrgQuery<Subscription>(['subscription'], '/billing/subscription');
  const invalidate = useInvalidate();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [checkoutPlan, setCheckoutPlan] = useState<string | null>(null);
  const owner = s.can('billing.manage');

  if (sub.isPending) return <Loading />;
  if (sub.error) return <ErrorView error={sub.error} onReload={() => void sub.refetch()} />;
  const d = sub.data;
  const daysLeft = d.trial ? Math.max(0, Math.ceil((Date.parse(d.trial.ends_at) - Date.now()) / 86_400_000)) : null;

  return (
    <>
      <PageHead title="Subscription" subtitle="Your plan, usage, cancellation and data export." />
      <div className="grid grid-2">
        <Card title="Your plan">
          <p style={{ fontSize: '1.1rem', margin: 0 }}><strong>{d.plan}</strong> <Badge tone={d.state === 'read_only' || d.state === 'past_due' ? 'bad' : d.state === 'trialing' ? 'info' : 'ok'}>{SUB_LABEL[d.state] ?? d.state}</Badge></p>
          {d.state === 'trialing' && d.trial ? <p>Trial - {daysLeft} day{daysLeft === 1 ? '' : 's'} left (ends {formatInZone(d.trial.ends_at, s.timeZone)}). No card on file.</p> : null}
          {d.current_period_end ? <p>Current period ends {formatInZone(d.current_period_end, s.timeZone)}.</p> : null}
          {d.cancel_at_period_end ? <Banner tone="warn"><p>Cancels on {formatInZone(d.cancels_on, s.timeZone)}. After that your account becomes read-only; export stays available.</p></Banner> : null}
          {d.grace_ends_at ? <Banner tone="bad"><p>Payment failed. Update your payment method before {formatInZone(d.grace_ends_at, s.timeZone)}.</p></Banner> : null}
          <p className="muted">{d.after_trial}</p>
          <h3>Usage</h3>
          <ul className="small" style={{ paddingLeft: 18 }}>
            <li>{d.usage.members} active member(s)</li><li>{d.usage.sources} source(s)</li><li>{d.usage.leads_this_month} lead(s) this month</li>
          </ul>
          {owner && !d.cancel_at_period_end && d.state !== 'read_only' ? <Button variant="danger" onClick={() => setCancelOpen(true)}>Cancel subscription</Button> : null}
        </Card>
        <Card title="Plans">
          {plans.isPending ? <Loading /> : plans.error ? <ErrorView error={plans.error} compact /> : (
            <>
              <ul className="list">
                {plans.data.items.map(p => (
                  <li key={p.plan_id} className="lead-row">
                    <div>
                      <strong>{p.name}</strong> {p.plan_id === d.plan_id ? <Badge tone="info">Current</Badge> : null}
                      <div className="meta"><span>{p.limits.members} members</span><span>{p.limits.sources} sources</span><span>{p.limits.leads_per_month} leads/month</span></div>
                    </div>
                    <div>
                      {plans.data.status !== 'published' || p.price_monthly === null || !d.billing_provider_configured
                        ? <a className="btn btn-small" href="mailto:hello@leadguard.io">Contact us</a>
                        : owner ? <Button small variant="primary" onClick={() => setCheckoutPlan(p.plan_id)}>Choose - {plans.data.currency} {p.price_monthly}/mo</Button> : null}
                    </div>
                  </li>
                ))}
              </ul>
              <p className="small muted">{plans.data.note}</p>
            </>
          )}
        </Card>
      </div>
      {s.can('exports.create') ? <ExportCard /> : null}
      <Dialog open={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancel subscription">
        <CancelForm onDone={() => { setCancelOpen(false); void invalidate('subscription'); }} accessUntil={d.current_period_end ?? d.trial?.ends_at ?? null} />
      </Dialog>
      <Dialog open={Boolean(checkoutPlan)} onClose={() => setCheckoutPlan(null)} title="Confirm plan and price">
        {checkoutPlan ? <CheckoutForm planId={checkoutPlan} plans={plans.data!} /> : null}
      </Dialog>
    </>
  );
}

/** No card is collected and no charge is created unless the owner confirms the plan and price here (BIL-02). */
function CheckoutForm({ planId, plans }: { planId: string; plans: Plans }) {
  const p = plans.items.find(x => x.plan_id === planId)!;
  const [confirm, setConfirm] = useState(false);
  const cmd = useCommand<void, { checkout_url: string }>(() => ({
    path: '/billing/checkout', body: { plan_id: planId, confirm_plan_and_price: confirm, return_url: `${location.origin}/settings/billing` },
  }), { onSuccess: d => { location.assign(d.checkout_url); } });
  return (
    <form onSubmit={e => { e.preventDefault(); void cmd.run(); }}>
      <p>{p.name}: {plans.currency} {p.price_monthly} per month. You will enter payment details on the provider&apos;s secure page; nothing is charged until you confirm there.</p>
      <label className="check"><input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} /> I confirm the plan and price above.</label>
      <ErrorView error={cmd.error} compact />
      <Button variant="primary" type="submit" pending={cmd.pending} disabled={!confirm}>Continue to payment</Button>
    </form>
  );
}

function CancelForm({ onDone, accessUntil }: { onDone: () => void; accessUntil: string | null }) {
  const s = useSession();
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const cmd = useCommand<void>(() => ({ path: '/billing/cancel', body: { confirm, ...(reason ? { reason } : {}) } }), { onSuccess: onDone });
  return (
    <form onSubmit={e => { e.preventDefault(); void cmd.run(); }}>
      <p>{accessUntil ? `You keep full access until ${formatInZone(accessUntil, s.timeZone)}.` : 'Your account becomes read-only.'} After that, leads are read-only, new enquiries are rejected and you can still export everything.</p>
      <TextInput label="Why are you cancelling? (optional)" value={reason} onChange={e => setReason(e.target.value)} maxLength={LIMITS.reason} />
      <label className="check"><input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} /> Yes, cancel my subscription.</label>
      <ErrorView error={cmd.error} compact />
      <Button variant="danger" type="submit" pending={cmd.pending} disabled={!confirm}>Cancel subscription</Button>
    </form>
  );
}

function ExportCard() {
  const s = useSession();
  const [exportId, setExportId] = useState<string | null>(null);
  const status = useOrgQuery<ExportStatus>(['export', exportId], exportId ? `/exports/${exportId}` : null, {
    refetchInterval: q => (q.state.data && ['ready', 'failed', 'expired'].includes(q.state.data.status) ? false : 3000),
  });
  const cmd = useCommand<void, { export_id: string }>(() => ({ path: '/exports', body: { include: ['leads', 'activities', 'alerts'], format: 'csv_zip' } }), {
    onSuccess: d => setExportId(d.export_id),
  });
  useEffect(() => {
    const running = cmd.error?.code === 'EXPORT_IN_PROGRESS' ? cmd.error.details.export_id : null;
    if (running) setExportId(running);
  }, [cmd.error]);
  const st = status.data;
  return (
    <Card title="Export your data">
      <p className="muted">Full CSV export of leads, activities and alerts - available in every subscription state. Files are deleted after 24 hours.</p>
      <Button variant="primary" pending={cmd.pending} onClick={() => void cmd.run()}>Request export</Button>
      {cmd.error && cmd.error.code !== 'EXPORT_IN_PROGRESS' ? <ErrorView error={cmd.error} compact /> : null}
      {exportId ? (
        <div role="status" aria-live="polite" style={{ marginTop: 12 }}>
          {!st || st.status === 'queued' || st.status === 'building' ? <p><span className="spinner" style={{ width: 14, height: 14, verticalAlign: 'middle' }} aria-hidden /> Preparing your export...</p> : null}
          {st?.status === 'ready' && st.download_url ? (
            <p><a className="btn" href={st.download_url}>Download ZIP</a> <span className="small muted">{st.rows ? Object.entries(st.rows).map(([k, v]) => `${v} ${k}`).join(', ') : ''} · link valid until {formatInZone(st.url_expires_at, s.timeZone)}</span></p>
          ) : null}
          {st?.status === 'failed' ? <Banner tone="bad"><p>The export failed{st.failure_reason ? `: ${st.failure_reason}` : ''}. Request a new one.</p></Banner> : null}
          {status.error ? <ErrorView error={status.error} compact /> : null}
        </div>
      ) : null}
    </Card>
  );
}

