// Shared adapter rules (Appendix E): a blocked integration is replaced by a labelled test double in automated
// tests only. No environment may report a blocked provider as connected, and no code path may fake a
// successful send or payment.

export class AdapterNotConfigured extends Error {
  constructor(readonly integration: string) {
    super(`${integration} provider is not configured (BLOCKED until selected, see Appendix E)`);
  }
}

export function assertTestDoubleAllowed(name: string): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(`${name} test double may only be used when NODE_ENV=test`);
  }
}
