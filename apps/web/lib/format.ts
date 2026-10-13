// Display helpers. All instants come from the server in UTC; they are shown in the organization time zone.

export function formatInZone(iso: string | null | undefined, timeZone: string, withDate = true): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    ...(withDate ? { month: 'short', day: 'numeric' } : {}),
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(d);
}

export function relativeMinutes(min: number | null | undefined): string {
  if (min === null || min === undefined) return '';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return m ? `${h} h ${m} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}

export const STATUS_LABEL: Record<string, string> = {
  new: 'New', attempted: 'Attempted', contacted: 'Contacted', qualified: 'Qualified', won: 'Won', lost: 'Lost', spam: 'Spam', merged: 'Merged',
};

export const SOURCE_STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'muted' }> = {
  // Only `verified` is ever shown as Connected (Section 9.2, SRC-03).
  verified: { label: 'Connected', tone: 'ok' },
  testing: { label: 'Waiting for test event', tone: 'muted' },
  draft: { label: 'Not connected - send a test event', tone: 'muted' },
  failing: { label: 'Needs attention', tone: 'warn' },
  disabled: { label: 'Disabled - events are rejected', tone: 'bad' },
};

export const SUB_LABEL: Record<string, string> = {
  setup_pending: 'Finish setup to start your trial',
  trialing: 'Trial',
  pilot_invoice: 'Pilot plan - invoiced',
  active: 'Active',
  past_due: 'Payment failed - update payment method',
  read_only: 'Subscription ended - export or reactivate',
};

/** "2026-10-15T09:00" for a datetime-local input, in the org time zone. */
export function localInputValue(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  return parts.replace(' ', 'T').slice(0, 16);
}

export function dateInZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function todayInZone(timeZone: string): string {
  return dateInZone(new Date(), timeZone);
}
