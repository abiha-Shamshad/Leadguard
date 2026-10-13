// Input limits shared by every form. They mirror the API's Zod schemas (packages/contracts/src/schemas.ts) and
// the database CHECK constraints, so the browser rejects bad input before it is sent. The API still validates
// everything - these are a usability layer, not the security boundary.

export const LIMITS = {
  orgName: 120,
  sourceName: 120,
  personName: 200,
  email: 254,
  phone: 40,
  message: 4000,
  nextAction: 200,
  activityNote: 2000,
  shortNote: 500,
  reason: 500,
  search: 100,
  devUserId: 64,
  devName: 120,
  holidays: 1100,
} as const;

/**
 * HTML `pattern` values (implicitly anchored by the browser). Browsers compile them with the `v` (Unicode sets)
 * flag, where ( ) - and other syntax characters must be escaped inside a character class - an invalid pattern
 * is silently ignored, so every pattern is checked under `v` by `lib/limits.test.ts`.
 */
export const PATTERNS = {
  phone: '[0-9+\\(\\)\\-.\\s]{7,40}',
  countryCode: '[A-Za-z]{2}',
  uuid: '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}',
  httpsOrigin: 'https://[A-Za-z0-9.\\-]+(:[0-9]{1,5})?',
  devUserId: '[A-Za-z0-9_\\-]{3,64}',
  email: '[^\\s@:]+@[^\\s@:]+\\.[A-Za-z]{2,24}',
  holidays: '\\s*(\\d{4}-\\d{2}-\\d{2}(\\s*,\\s*\\d{4}-\\d{2}-\\d{2})*)?\\s*',
  intervals: '\\s*\\d{2,5}(\\s*,\\s*\\d{2,5}){0,5}\\s*',
  noColon: '[^:]+',
} as const;

export const MESSAGES = {
  phone: 'Use digits, spaces and + ( ) - only (7-40 characters).',
  countryCode: 'Use a two-letter country code such as US or PK.',
  uuid: 'Paste the full lead ID (36 characters).',
  httpsOrigin: 'Use the exact https origin, e.g. https://www.example.com',
  devUserId: '3-64 letters, digits, _ or -.',
  email: 'Use a valid email address.',
  holidays: 'Dates as YYYY-MM-DD separated by commas.',
  intervals: '1-6 numbers separated by commas, each 15-10080.',
} as const;

// C0 control characters other than tab/newline, and DEL - never valid in LeadGuard text.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function stripControl(s: string, multiline = false): string {
  const out = s.replace(CONTROL, '');
  return multiline ? out : out.replace(/[\r\n\t]/g, ' ');
}
