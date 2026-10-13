// Guided-setup progress (API-002 setup_complete, API-004 setup). Setup is complete when a source has been
// verified and at least one teammate has been invited or has joined.
import type { Db } from '@leadguard/db';

export interface SetupProgress { org_created: true; source_verified: boolean; team_invited: boolean; complete: boolean }

export async function setupProgress(db: Db): Promise<SetupProgress> {
  const r = await db.one<{ verified: number; team: number }>(
    `SELECT (SELECT count(*)::int FROM lg.sources WHERE status IN ('verified','failing')) AS verified,
            ((SELECT count(*)::int FROM lg.memberships) - 1 + (SELECT count(*)::int FROM lg.invitations WHERE status IN ('pending','accepted'))) AS team`);
  const sourceVerified = r.verified > 0, teamInvited = r.team > 0;
  return { org_created: true, source_verified: sourceVerified, team_invited: teamInvited, complete: sourceVerified && teamInvited };
}
