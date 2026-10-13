// User-facing errors for local wall times typed in the organization time zone (API-030 snooze, API-035 preview).
import { DateTime } from 'luxon';
import { AppError } from '@leadguard/contracts';

export function localTimeError(code: string, local: string, zone: string, field: string): AppError {
  if (code === 'LOCAL_TIME_IN_DST_GAP') {
    return new AppError('LOCAL_TIME_IN_DST_GAP', 'That local time does not exist because clocks move forward. Choose another time.', { [field]: local });
  }
  if (code === 'LOCAL_TIME_AMBIGUOUS') {
    const dt = DateTime.fromISO(local, { zone });
    return new AppError('LOCAL_TIME_AMBIGUOUS', `${dt.toFormat('h:mm a')} happens twice on ${dt.toFormat('LLL d')} because clocks move back. Choose another time.`, { [field]: local });
  }
  return new AppError('VALIDATION_FAILED', 'Use a valid local date and time.', { fields: { [field]: 'Invalid local time.' } });
}
