// Weekly business hours validation (API-003, API-006).
import { z } from 'zod';
import { WEEKDAYS, type DayHours } from './business-time.ts';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour).');

export const dayHoursSchema = z.strictObject({
  weekday: z.enum(WEEKDAYS as [string, ...string[]]),
  open: hhmm.nullable(),
  close: hhmm.nullable(),
});

export const holidaysSchema = z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')).max(100);

export interface HoursProblem {
  path: string;
  message: string;
}

/** Returns field problems for overlapping, inverted or half-specified intervals; [] when valid. */
export function validateDays(days: DayHours[]): HoursProblem[] {
  const problems: HoursProblem[] = [];
  days.forEach((d, i) => {
    if ((d.open === null) !== (d.close === null)) problems.push({ path: `days[${i}]`, message: 'Set both opening and closing time, or neither.' });
    else if (d.open && d.close && d.open >= d.close) problems.push({ path: `days[${i}].close`, message: `Must be after ${d.open}.` });
  });
  for (const w of WEEKDAYS) {
    const open = days.map((d, i) => ({ ...d, i })).filter(d => d.weekday === w && d.open && d.close).sort((a, b) => a.open!.localeCompare(b.open!));
    for (let k = 1; k < open.length; k++) {
      if (open[k].open! < open[k - 1].close!) problems.push({ path: `days[${open[k].i}].open`, message: 'Overlaps another interval on the same day.' });
    }
  }
  if (!days.some(d => d.open && d.close)) problems.push({ path: 'days', message: 'At least one open interval per week is required.' });
  return problems;
}

/** Only open intervals are stored; closed days are implied. */
export function normalizeDays(days: DayHours[]): DayHours[] {
  return days
    .filter(d => d.open && d.close)
    .sort((a, b) => WEEKDAYS.indexOf(a.weekday) - WEEKDAYS.indexOf(b.weekday) || a.open!.localeCompare(b.open!));
}

export function defaultDays(): DayHours[] {
  return (['mon', 'tue', 'wed', 'thu', 'fri'] as const).map(w => ({ weekday: w, open: '08:00', close: '18:00' }));
}
