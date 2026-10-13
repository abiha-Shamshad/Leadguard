// Canonical business-time calculator (ported from the delivered domain/business-time.mjs, Section 11.3).
// Pure: no DB, no clock reads.
//
// Port note: the delivered module capped `minutes` at 1440 and searched a fixed 31 days. Follow-up intervals
// are allowed up to 10080 minutes (Section 11.1), so this port accepts 1..10080 and throws NO_BUSINESS_HOURS
// only after 31 consecutive days without any open interval. Results for inputs <= 1440 are unchanged.
import { DateTime, Interval } from 'luxon';

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export interface DayHours {
  weekday: Weekday;
  open: string | null;
  close: string | null;
}

export interface BusinessHours {
  zone: string;
  days: DayHours[];
  holidays: string[];
}

const MAX_EMPTY_DAYS = 31;
const MAX_MINUTES = 10080;

export function openIntervals(dayStart: DateTime, hours: BusinessHours): Interval[] {
  const iso = dayStart.toISODate()!;
  if (hours.holidays.includes(iso)) return [];
  const weekday = WEEKDAYS[dayStart.weekday - 1];
  return hours.days
    .filter(d => d.weekday === weekday && d.open && d.close)
    .map(d => Interval.fromDateTimes(
      DateTime.fromISO(`${iso}T${d.open}`, { zone: hours.zone }),
      DateTime.fromISO(`${iso}T${d.close}`, { zone: hours.zone })))
    .filter(i => i.isValid && i.length('minutes') > 0)
    .sort((a, b) => a.start!.toMillis() - b.start!.toMillis());
}

/**
 * Add business minutes to an arrival instant.
 * Returns the due instant as an ISO UTC string. Throws Error('NO_BUSINESS_HOURS') if no open time in 31 days.
 */
export function addBusinessMinutes(startUtcIso: string, minutes: number, hours: BusinessHours): string {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) throw new Error('MINUTES_OUT_OF_RANGE');
  let cursor = DateTime.fromISO(startUtcIso, { zone: 'utc' }).setZone(hours.zone);
  let remaining = minutes;
  let day = cursor.startOf('day');
  let emptyDays = 0;
  while (emptyDays < MAX_EMPTY_DAYS) {
    const intervals = openIntervals(day, hours);
    if (intervals.length === 0) emptyDays++; else emptyDays = 0;
    for (const iv of intervals) {
      const from = cursor > iv.start! ? cursor : iv.start!;
      if (from >= iv.end!) continue;
      const available = iv.end!.diff(from, 'minutes').minutes;
      if (remaining <= available) {
        return from.plus({ minutes: remaining }).toUTC().toISO({ suppressMilliseconds: true })!;
      }
      remaining -= available;
      cursor = iv.end!;
    }
    day = day.plus({ days: 1 }).startOf('day');
  }
  throw new Error('NO_BUSINESS_HOURS');
}

/**
 * Count business minutes between two instants (used for dashboard first-action time and silence detection).
 * Returns 0 when `toUtcIso` is not after `fromUtcIso`.
 */
export function businessMinutesBetween(fromUtcIso: string, toUtcIso: string, hours: BusinessHours): number {
  const from = DateTime.fromISO(fromUtcIso, { zone: 'utc' }).setZone(hours.zone);
  const to = DateTime.fromISO(toUtcIso, { zone: 'utc' }).setZone(hours.zone);
  if (to <= from) return 0;
  let total = 0;
  for (let day = from.startOf('day'); day < to; day = day.plus({ days: 1 }).startOf('day')) {
    for (const iv of openIntervals(day, hours)) {
      const s = iv.start! > from ? iv.start! : from;
      const e = iv.end! < to ? iv.end! : to;
      if (e > s) total += e.diff(s, 'minutes').minutes;
    }
  }
  return Math.round(total * 100) / 100;
}

/**
 * Convert a user-entered local wall time ("2026-10-15T09:00") to UTC.
 * Rejects times that do not exist (DST gap) or exist twice (DST repeat), because Luxon would
 * otherwise silently shift a gap time forward and pick one offset for a repeated time.
 */
export function parseLocalWallTime(localIso: string, zone: string): string {
  const wall = localIso.slice(0, 16);
  const dt = DateTime.fromISO(wall, { zone });
  if (!dt.isValid) throw new Error('INVALID_TIME');
  if (dt.toFormat("yyyy-MM-dd'T'HH:mm") !== wall) throw new Error('LOCAL_TIME_IN_DST_GAP');
  for (const delta of [-60, 60]) {
    const candidate = dt.plus({ minutes: delta }).setZone(zone);
    if (candidate.offset !== dt.offset) {
      const twin = DateTime.fromMillis(dt.toMillis() + (dt.offset - candidate.offset) * 60_000, { zone });
      if (twin.toFormat("yyyy-MM-dd'T'HH:mm") === wall) throw new Error('LOCAL_TIME_AMBIGUOUS');
    }
  }
  return dt.toUTC().toISO({ suppressMilliseconds: true })!;
}

export function isValidZone(zone: string): boolean {
  return DateTime.local().setZone(zone).isValid;
}

/** "Oct 14, 9:30 AM CDT" - the due_at_local format used by every lead response. */
export function formatLocal(utc: Date | string | null | undefined, zone: string): string | null {
  if (!utc) return null;
  const dt = typeof utc === 'string' ? DateTime.fromISO(utc, { zone: 'utc' }) : DateTime.fromJSDate(utc);
  return dt.setZone(zone).toFormat('LLL d, h:mm a ZZZZ');
}

/** "Fri Oct 16, 5:55 PM CDT" - used by the policy preview. */
export function formatLocalWithWeekday(utc: string, zone: string): string {
  return DateTime.fromISO(utc, { zone: 'utc' }).setZone(zone).toFormat('ccc LLL d, h:mm a ZZZZ');
}

/** Start of a local calendar date as a UTC Date (for dashboard ranges). */
export function localDateStartUtc(localDate: string, zone: string): Date {
  return DateTime.fromISO(localDate, { zone }).startOf('day').toUTC().toJSDate();
}
