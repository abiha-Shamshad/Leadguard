'use client';
// Notification preferences (API-038). Escalations always include in-app.
import { useState } from 'react';
import { useSession } from '@/lib/session';
import { useCommand } from '@/lib/hooks';
import { Banner, Button, Card, ErrorView, Notice, PageHead } from '@/components/ui';

export function NotificationsView() {
  const s = useSession();
  const [channels, setChannels] = useState({ in_app: true, email: true, sms: false });
  const [always, setAlways] = useState(true);
  const [result, setResult] = useState<{ email_available?: boolean; sms_available?: boolean } | null>(null);
  const cmd = useCommand<void, { email_available?: boolean; sms_available?: boolean }>(() => ({
    path: '/me/notification-preferences', method: 'PUT', idempotent: false, body: { channels, escalations_always_email: always },
  }), { onSuccess: d => setResult(d) });
  if (s.supportGrantId) return <Banner tone="info"><p>Support sessions have no notification preferences.</p></Banner>;
  return (
    <>
      <PageHead title="Notifications" subtitle="How LeadGuard reaches you about your leads." />
      <Card>
        <form onSubmit={e => { e.preventDefault(); void cmd.run(); }}>
          <fieldset style={{ border: 'none', padding: 0, margin: '0 0 12px' }}>
            <legend className="label">Channels</legend>
            <label className="check"><input type="checkbox" checked={channels.in_app} onChange={e => setChannels({ ...channels, in_app: e.target.checked })} /> In-app alerts <span className="muted small">(escalations always appear in-app)</span></label>
            <label className="check"><input type="checkbox" checked={channels.email} onChange={e => setChannels({ ...channels, email: e.target.checked })} /> Email</label>
            <label className="check"><input type="checkbox" checked={channels.sms} onChange={e => setChannels({ ...channels, sms: e.target.checked })} /> Text messages</label>
          </fieldset>
          <label className="check"><input type="checkbox" checked={always} onChange={e => setAlways(e.target.checked)} /> Always email me escalations, even if email reminders are off</label>
          <ErrorView error={cmd.error} compact />
          <Button variant="primary" type="submit" pending={cmd.pending}>Save preferences</Button>
          <Notice text={cmd.message} />
        </form>
        {result && result.email_available === false ? <Banner tone="info"><p>Email delivery is not set up for LeadGuard yet, so alerts arrive in-app only for now. Your email choice is saved for when it is.</p></Banner> : null}
      </Card>
    </>
  );
}
