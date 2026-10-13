'use client';
import type { DayHours } from '@/lib/types';

const DAYS: { key: string; label: string }[] = [
  { key: 'mon', label: 'Mon' }, { key: 'tue', label: 'Tue' }, { key: 'wed', label: 'Wed' }, { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' }, { key: 'sat', label: 'Sat' }, { key: 'sun', label: 'Sun' },
];

export const DEFAULT_HOURS: DayHours[] = DAYS.map(d => ({
  weekday: d.key,
  open: ['sat', 'sun'].includes(d.key) ? null : '08:00',
  close: ['sat', 'sun'].includes(d.key) ? null : '18:00',
}));

/** One interval per weekday; closed days send open/close null. */
export function normalizeHours(days: DayHours[]): DayHours[] {
  return DAYS.map(d => days.find(x => x.weekday === d.key) ?? { weekday: d.key, open: null, close: null });
}

export function HoursEditor({ value, onChange, errors = {} }: { value: DayHours[]; onChange: (v: DayHours[]) => void; errors?: Record<string, string> }) {
  const days = normalizeHours(value);
  const set = (i: number, patch: Partial<DayHours>) => onChange(days.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  return (
    <fieldset style={{ border: 'none', padding: 0, margin: '0 0 12px' }}>
      <legend className="label" style={{ marginBottom: 8 }}>Business hours</legend>
      {days.map((d, i) => {
        const open = Boolean(d.open && d.close);
        const label = DAYS[i].label;
        const err = errors[`days[${i}].close`] ?? errors[`days[${i}]`] ?? errors[`business_hours[${i}].close`];
        return (
          <div key={d.weekday}>
            <div className="hours-row">
              <strong>{label}</strong>
              <label className="small"><input type="checkbox" checked={open} onChange={e => set(i, e.target.checked ? { open: '08:00', close: '18:00' } : { open: null, close: null })} /> Open</label>
              <input type="time" aria-label={`${label} opens`} value={d.open ?? ''} disabled={!open} required={open} onChange={e => set(i, { open: e.target.value })} />
              <input type="time" aria-label={`${label} closes`} value={d.close ?? ''} disabled={!open} required={open} min={d.open ?? undefined} onChange={e => set(i, { close: e.target.value })} aria-invalid={err ? true : undefined} />
            </div>
            {err ? <div className="small" style={{ color: 'var(--bad)', marginBottom: 6 }} role="alert">{label}: {err}</div> : null}
          </div>
        );
      })}
    </fieldset>
  );
}

export function timeZones(): string[] {
  try { return (Intl as any).supportedValuesOf('timeZone') as string[]; } catch { return ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles']; }
}
