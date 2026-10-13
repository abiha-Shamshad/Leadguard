'use client';
// Guided setup (Section 29.3): one step per screen; never shows Connected before the source is `verified`.
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useAuthState } from '@/lib/auth';
import { useSession } from '@/lib/session';
import { useCommand, useOrgQuery } from '@/lib/hooks';
import type { DayHours, SourceDetail, SourceSummary } from '@/lib/types';
import { Banner, Button, Card, CopyField, ErrorView, Loading, Select, TextInput } from '@/components/ui';
import { DEFAULT_HOURS, HoursEditor, timeZones } from '@/components/hours-editor';
import { VerificationChecklist } from '@/components/verification';
import { InviteForm } from '@/views/team';
import { LIMITS, MESSAGES, PATTERNS } from '@/lib/limits';

type Step = 'org' | 'source' | 'secret' | 'test' | 'team';
const ORDER: Step[] = ['org', 'source', 'secret', 'test', 'team'];

interface Created { sourceId: string; endpoint: string; secret: string | null; authMode: string; snippet?: string }

export function SetupView() {
  const auth = useAuthState();
  const s = useSession();
  const router = useRouter();
  const [step, setStep] = useState<Step | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const sources = useOrgQuery<{ items: SourceSummary[] }>(['sources'], '/sources', { enabled: Boolean(s.me?.active_org) });

  useEffect(() => { if (auth.loaded && !auth.signedIn) router.replace('/sign-in'); }, [auth.loaded, auth.signedIn, router]);

  // Resume where the user left off.
  useEffect(() => {
    if (step || !s.me) return;
    if (!s.me.active_org) { setStep('org'); return; }
    if (!s.can('sources.manage')) { router.replace('/inbox'); return; }
    if (!sources.data) return;
    const first = sources.data.items.find(x => x.status !== 'disabled');
    if (!first) setStep('source');
    else if (first.status === 'verified' || first.status === 'failing') setStep('team');
    else { setCreated({ sourceId: first.id, endpoint: '', secret: null, authMode: '' }); setStep('test'); }
  }, [s.me, sources.data, step, router, s]);

  if (!s.me || !step) return <main id="main"><Loading label="Loading setup" /></main>;
  const idx = ORDER.indexOf(step);

  return (
    <main id="main" className="setup">
      <div className="brand" style={{ padding: '0 0 12px' }}><span className="brand-mark" aria-hidden>LG</span>LeadGuard setup</div>
      <div className="progress" aria-label={`Step ${idx + 1} of ${ORDER.length}`}>{ORDER.map((st, i) => <span key={st} data-done={i <= idx} />)}</div>
      {step === 'org' && <OrgStep onDone={() => setStep('source')} />}
      {step === 'source' && <SourceStep onCreated={c => { setCreated(c); setStep('secret'); }} />}
      {step === 'secret' && created && <SecretStep created={created} onNext={() => setStep('test')} />}
      {step === 'test' && created && <TestStep sourceId={created.sourceId} onVerified={() => setStep('team')} onBack={() => setStep('secret')} hasSecret={Boolean(created.secret)} />}
      {step === 'team' && <TeamStep onDone={() => router.push('/inbox')} />}
    </main>
  );
}

function OrgStep({ onDone }: { onDone: () => void }) {
  const s = useSession();
  const qc = useQueryClient();
  const detected = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const [name, setName] = useState('');
  const [tz, setTz] = useState(detected);
  const [country, setCountry] = useState('US');
  const [hours, setHours] = useState<DayHours[]>(DEFAULT_HOURS);
  const cmd = useCommand<void, { org: { id: string } }>(() => ({
    path: '/organizations',
    body: { name: name.trim(), time_zone: tz, country, business_hours: hours },
  }), {
    onSuccess: async data => {
      s.switchOrg(data.org.id);
      await qc.invalidateQueries({ queryKey: ['me'] });
      onDone();
    },
  });
  const f = cmd.error?.fields ?? {};
  return (
    <Card title="Create your organization">
      <p className="muted">Due times and reminders follow your time zone and business hours.</p>
      <form onSubmit={e => { e.preventDefault(); void cmd.run(); }}>
        <TextInput label="Business name" value={name} onChange={e => setName(e.target.value)} required minLength={1} maxLength={LIMITS.orgName} autoComplete="organization" error={f.name} />
        <Select label="Time zone" value={tz} onChange={e => setTz(e.target.value)} error={f.time_zone}>
          {timeZones().map(z => <option key={z} value={z}>{z}</option>)}
        </Select>
        <TextInput label="Country code" value={country} onChange={e => setCountry(e.target.value.toUpperCase())} required minLength={2} maxLength={2} pattern={PATTERNS.countryCode} invalidMessage={MESSAGES.countryCode} autoComplete="country" hint="Used to read local phone numbers, e.g. US." error={f.country} />
        <HoursEditor value={hours} onChange={setHours} errors={f} />
        <ErrorView error={cmd.error} compact />
        <Button variant="primary" type="submit" pending={cmd.pending} disabled={!name.trim()}>Create organization</Button>
      </form>
    </Card>
  );
}

const MODES = [
  { value: 'hmac_v1', type: 'web_form_webhook', title: 'My form tool can sign webhooks', text: 'Most secure. Your form tool computes an HMAC signature for each submission.' },
  { value: 'secret_header', type: 'web_form_webhook', title: 'My form tool can add a header', text: 'For tools that can send a fixed custom header but cannot sign.' },
  { value: 'embed', type: 'web_form_embed', title: 'Add LeadGuard form code to my site', text: 'For sites without a webhook-capable form tool. Reduces abuse but cannot prove an enquiry is genuine.' },
  { value: 'call', type: 'call_webhook', title: 'Phone calls', text: 'Only available once your call provider has been verified for your account.' },
] as const;

function SourceStep({ onCreated }: { onCreated: (c: Created) => void }) {
  const [mode, setMode] = useState<string>('hmac_v1');
  const [name, setName] = useState('Website contact form');
  const [origin, setOrigin] = useState('');
  const m = MODES.find(x => x.value === mode)!;
  const cmd = useCommand<void, any>(() => ({
    path: '/sources',
    body: {
      type: m.type, name: name.trim(),
      ...(m.type === 'web_form_webhook' ? { auth_mode: mode } : {}),
      ...(m.type === 'web_form_embed' ? { allowed_origins: origin ? [origin.trim()] : [] } : {}),
    },
  }), {
    onSuccess: d => onCreated({ sourceId: d.source.id, endpoint: d.endpoint_url, secret: d.signing_secret ?? null, authMode: d.auth_mode ?? mode, snippet: d.embed_snippet }),
  });
  return (
    <Card title="Connect a source">
      <p className="muted">Where do your enquiries come from? LeadGuard connects one verified source at a time.</p>
      <form onSubmit={e => { e.preventDefault(); void cmd.run(); }}>
        <fieldset style={{ border: 'none', padding: 0, margin: '0 0 12px' }}>
          <legend className="sr-only">Connection type</legend>
          {MODES.map(x => (
            <label key={x.value} className="choice">
              <input type="radio" name="mode" value={x.value} checked={mode === x.value} onChange={() => setMode(x.value)} />
              <strong>{x.title}</strong>
              <div className="small muted" style={{ marginLeft: 24 }}>{x.text}</div>
            </label>
          ))}
        </fieldset>
        <TextInput label="Source name" value={name} onChange={e => setName(e.target.value)} required minLength={1} maxLength={LIMITS.sourceName} />
        {m.type === 'web_form_embed' ? <TextInput label="Your website origin" type="url" required maxLength={200} pattern={PATTERNS.httpsOrigin} invalidMessage={MESSAGES.httpsOrigin} placeholder="https://www.example.com" value={origin} onChange={e => setOrigin(e.target.value)} hint="Exact https origin where the form runs." /> : null}
        <ErrorView error={cmd.error} compact />
        <Button variant="primary" type="submit" pending={cmd.pending} disabled={!name.trim()}>Create source</Button>
      </form>
    </Card>
  );
}

function SecretStep({ created, onNext }: { created: Created; onNext: () => void }) {
  return (
    <Card title="Copy your connection details">
      {created.secret ? <Banner tone="warn"><strong>Copy the secret now.</strong> <p>It is shown only once. If you lose it, rotate it from the Sources page.</p></Banner> : null}
      <CopyField label="Endpoint URL" value={created.endpoint} />
      {created.secret ? <CopyField label={created.authMode === 'secret_header' ? 'Secret (send as X-LeadGuard-Source-Secret header)' : 'Signing secret'} value={created.secret} /> : null}
      {created.snippet ? <CopyField label="Embed snippet" value={created.snippet} /> : null}
      {created.authMode === 'hmac_v1' ? (
        <div className="small muted stack">
          <p>Your form tool must send two headers with each JSON POST:</p>
          <p className="mono">X-LeadGuard-Timestamp: &lt;unix seconds&gt;<br />X-LeadGuard-Signature: v1=&lt;hex HMAC-SHA256(secret, "&lt;timestamp&gt;.&lt;raw body&gt;")&gt;</p>
        </div>
      ) : null}
      <Button variant="primary" onClick={onNext}>I have saved it - send a test enquiry</Button>
    </Card>
  );
}

function TestStep({ sourceId, onVerified, onBack, hasSecret }: { sourceId: string; onVerified: () => void; onBack: () => void; hasSecret: boolean }) {
  const start = useCommand<void, { expires_at: string; instructions: string }>(() => ({ path: `/sources/${sourceId}/test-event`, body: { window_minutes: 15 } }));
  const [instructions, setInstructions] = useState<string | null>(null);
  useEffect(() => { void start.run().then(r => { if (r) setInstructions(r.instructions); }); /* open the window once */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId]);
  // Poll API-014 every 3 s while waiting (Section 29.2).
  const src = useOrgQuery<SourceDetail>(['source', sourceId], `/sources/${sourceId}`, { refetchInterval: q => (q.state.data?.status === 'verified' ? false : 3000) });
  const v = src.data?.verification;
  const expired = v && v.result === 'expired';
  return (
    <Card title="Send a test enquiry">
      {instructions ? <p>{instructions}</p> : null}
      <ErrorView error={start.error ?? src.error} compact onReload={() => void start.run()} />
      {!src.data ? <Loading label="Waiting for your test event" /> : (
        <>
          <p className="small muted">Status: <strong>{src.data.status === 'verified' ? 'Connected' : 'Waiting for test event'}</strong>{v ? ` - window open until ${new Date(v.expires_at).toLocaleTimeString()}` : ''}</p>
          {v ? <VerificationChecklist steps={v.steps} /> : null}
          {src.data.status === 'verified' ? (
            <>
              <Banner tone="ok"><strong>Connected.</strong> <p>Your test enquiry arrived and is in your inbox marked TEST. Your trial has started.</p></Banner>
              <Button variant="primary" onClick={onVerified}>Continue</Button>
            </>
          ) : expired ? (
            <Banner tone="warn" action={<Button small onClick={() => void start.run()} pending={start.pending}>Open a new window</Button>}><p>The 15-minute test window expired before a valid event arrived.</p></Banner>
          ) : (
            <p role="status" aria-live="polite" className="muted"><span className="spinner" style={{ width: 14, height: 14, verticalAlign: 'middle' }} aria-hidden /> Waiting for your test event. LeadGuard never sends a test on your behalf.</p>
          )}
          {src.data.status !== 'verified' ? <div className="row" style={{ marginTop: 12 }}>{hasSecret ? <Button onClick={onBack}>Back to connection details</Button> : <Link className="btn" href={`/sources/${sourceId}`}>Source details (rotate secret)</Link>}</div> : null}
        </>
      )}
    </Card>
  );
}

function TeamStep({ onDone }: { onDone: () => void }) {
  return (
    <Card title="Invite your team (optional)">
      <p className="muted">Team members get leads assigned and receive reminders. You can do this later from the Team page.</p>
      <InviteForm />
      <div className="row" style={{ marginTop: 16 }}><Button variant="primary" onClick={onDone}>Go to my inbox</Button></div>
    </Card>
  );
}
