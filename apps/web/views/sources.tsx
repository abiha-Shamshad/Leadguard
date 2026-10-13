'use client';
// Sources list (API-012, API-013). Connected is shown only for `verified` (SRC-03).
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useSession } from '@/lib/session';
import { useCommand, useInvalidate, useOrgQuery } from '@/lib/hooks';
import { formatInZone, SOURCE_STATUS } from '@/lib/format';
import type { SourceSummary } from '@/lib/types';
import { Badge, Banner, Button, Card, CopyField, Dialog, Empty, ErrorView, Loading, PageHead, Select, TextInput } from '@/components/ui';
import { LIMITS, MESSAGES, PATTERNS } from '@/lib/limits';

export function SourcesView() {
  const s = useSession();
  const q = useOrgQuery<{ items: SourceSummary[] }>(['sources'], '/sources');
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHead title="Sources" subtitle="Where enquiries come from. A source shows Connected only after a real event was verified."
        actions={s.can('sources.manage') ? <Button variant="primary" onClick={() => setOpen(true)} disabled={!s.writable}>Add source</Button> : null} />
      <Card>
        {q.isPending ? <Loading /> : q.error ? <ErrorView error={q.error} onReload={() => void q.refetch()} /> : !q.data.items.length ? (
          <Empty title="No sources yet"><p>Add your website form to start receiving leads.</p></Empty>
        ) : (
          <ul className="list">
            {q.data.items.map(src => {
              const st = SOURCE_STATUS[src.status];
              return (
                <li key={src.id} className="lead-row">
                  <div>
                    <Link className="title" href={`/sources/${src.id}`}>{src.name}</Link> <Badge tone={st.tone}>{st.label}</Badge>
                    <div className="meta">
                      <span>{src.type === 'call_webhook' ? 'Phone calls' : src.type === 'web_form_embed' ? 'Website embed' : 'Form webhook'}</span>
                      <span>Last event: {src.last_event_at ? formatInZone(src.last_event_at, s.timeZone) : 'never'}</span>
                      {src.events_24h ? <span>24 h: {src.events_24h.accepted} accepted, {src.events_24h.duplicate} duplicate, {src.events_24h.rejected} rejected</span> : null}
                      {src.last_error ? <span style={{ color: 'var(--bad)' }}>{src.last_error.count} x {src.last_error.reason}</span> : null}
                    </div>
                  </div>
                  <Link className="btn btn-small" href={`/sources/${src.id}`}>Details</Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Dialog open={open} onClose={() => setOpen(false)} title="Add a source" variant="sheet">
        <CreateSourceForm />
      </Dialog>
    </>
  );
}

function CreateSourceForm() {
  const router = useRouter();
  const invalidate = useInvalidate();
  const [type, setType] = useState('hmac_v1');
  const [name, setName] = useState('');
  const [origin, setOrigin] = useState('');
  const [created, setCreated] = useState<any>(null);
  const cmd = useCommand<void, any>(() => ({
    path: '/sources',
    body: type === 'embed'
      ? { type: 'web_form_embed', name, allowed_origins: origin ? [origin] : [] }
      : type === 'call' ? { type: 'call_webhook', name } : { type: 'web_form_webhook', name, auth_mode: type },
  }), { onSuccess: d => { setCreated(d); void invalidate('sources'); } });
  if (created) {
    return (
      <div>
        {created.signing_secret ? <Banner tone="warn"><strong>Copy the secret now.</strong> <p>It will not be shown again.</p></Banner> : null}
        <CopyField label="Endpoint URL" value={created.endpoint_url} />
        {created.signing_secret ? <CopyField label="Secret" value={created.signing_secret} /> : null}
        {created.embed_snippet ? <CopyField label="Embed snippet" value={created.embed_snippet} /> : null}
        <Button variant="primary" onClick={() => router.push(`/sources/${created.source.id}`)}>Next: send a test event</Button>
      </div>
    );
  }
  return (
    <form onSubmit={e => { e.preventDefault(); void cmd.run(); }}>
      <Select label="How does your form send enquiries?" value={type} onChange={e => setType(e.target.value)}>
        <option value="hmac_v1">Signed webhook (recommended)</option>
        <option value="secret_header">Webhook with a secret header</option>
        <option value="embed">LeadGuard embed code on my site</option>
        <option value="call">Phone calls (provider must be enabled)</option>
      </Select>
      <TextInput label="Name" value={name} onChange={e => setName(e.target.value)} required minLength={1} maxLength={LIMITS.sourceName} placeholder="Website contact form" />
      {type === 'embed' ? <TextInput label="Website origin" type="url" required maxLength={200} pattern={PATTERNS.httpsOrigin} invalidMessage={MESSAGES.httpsOrigin} value={origin} onChange={e => setOrigin(e.target.value)} placeholder="https://www.example.com" /> : null}
      <ErrorView error={cmd.error} compact />
      <Button variant="primary" type="submit" pending={cmd.pending}>Create source</Button>
    </form>
  );
}
