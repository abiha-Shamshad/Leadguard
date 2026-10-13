// Bot challenge verification for embed sources (INT-005, BLOCKED). Embed sources stay feature-flagged off.
import { assertTestDoubleAllowed } from './common.ts';

export interface BotChallengeAdapter {
  readonly name: string;
  readonly configured: boolean;
  verify(token: string | undefined, remoteIp: string | undefined): Promise<boolean>;
}

export const noneBotChallenge: BotChallengeAdapter = {
  name: 'none',
  configured: false,
  async verify() { return false; },
};

export function createTestBotChallenge(validToken = 'test-pass'): BotChallengeAdapter {
  assertTestDoubleAllowed('bot-challenge');
  return { name: 'test_double', configured: true, async verify(token) { return token === validToken; } };
}

export function createBotChallenge(name: string | undefined): BotChallengeAdapter {
  if (!name || name === 'none') return noneBotChallenge;
  throw new Error(`BOT_CHALLENGE_PROVIDER=${name} has no adapter yet (INT-005 BLOCKED). Use none.`);
}
