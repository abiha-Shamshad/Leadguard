// Error catalogue (Section 34.2). Every error code the API returns is listed here with its default HTTP status.

export const ERROR_CATALOGUE = {
  VALIDATION_FAILED: 400,
  CONTACT_REQUIRED: 400,
  PAYLOAD_UNMAPPABLE: 400,
  CONFIRMATION_REQUIRED: 400,
  LOCAL_TIME_IN_DST_GAP: 400,
  LOCAL_TIME_AMBIGUOUS: 400,
  AUTHENTICATION_REQUIRED: 401,
  SIGNATURE_INVALID: 401,
  AUTHORIZATION_DENIED: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  REQUEST_IN_PROGRESS: 409,
  ALREADY_CLAIMED: 409,
  SOURCE_DISABLED: 409, // 410 on ingest
  SOURCE_NOT_VERIFIED: 409,
  EXPORT_IN_PROGRESS: 409,
  BILLING_NOT_CONFIGURED: 409,
  INVITATION_EXPIRED: 410,
  INVALID_TRANSITION: 422,
  PLAN_LIMIT_REACHED: 422,
  ORG_LIMIT_REACHED: 422,
  LAST_OWNER: 422,
  MERGE_NOT_ALLOWED: 422,
  NOT_APPLICABLE: 422,
  SOURCE_TYPE_NOT_ENABLED: 422,
  CHANNEL_NOT_AVAILABLE: 422,
  SUBSCRIPTION_INACTIVE: 423,
  RATE_LIMITED: 429,
  BILLING_PROVIDER_UNAVAILABLE: 503,
  SERVICE_UNAVAILABLE: 503,
  // ---- implementation additions (documented in README "Spec deviations"): the spec lists these HTTP outcomes
  // without naming a code.
  ALREADY_INVITED: 409,      // API-008 409 "Already a member or pending invite"
  OWNER_INACTIVE: 422,       // API-027 422 "Owner inactive"
  PAYLOAD_TOO_LARGE: 413,    // API-020 413 "Body over 64 KB"
  ORIGIN_NOT_ALLOWED: 403,   // API-020 403 "Origin not allowed / challenge failed"
} as const;

export type ErrorCode = keyof typeof ERROR_CATALOGUE;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;
  readonly headers: Record<string, string>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}, opts: { status?: number; retryable?: boolean; headers?: Record<string, string> } = {}) {
    super(message);
    this.code = code;
    this.status = opts.status ?? ERROR_CATALOGUE[code];
    this.details = details;
    this.retryable = opts.retryable ?? (this.status === 429 || this.status === 503);
    this.headers = opts.headers ?? {};
  }
}

export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found.`);
export const denied = (message = 'You do not have permission to do this.') => new AppError('AUTHORIZATION_DENIED', message);
export const validation = (message: string, fields: Record<string, string> = {}) =>
  new AppError('VALIDATION_FAILED', message, Object.keys(fields).length ? { fields } : {});
export const versionConflict = (current: number, message = 'This record was changed by someone else. Reload to see the latest version.') =>
  new AppError('VERSION_CONFLICT', message, { current_version: current });
