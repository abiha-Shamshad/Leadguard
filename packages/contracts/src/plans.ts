// Plans and trial length are configuration pending leadership approval (OD-03). Defaults are the
// illustrative values used throughout the specification examples; override with PLANS_JSON / TRIAL_DAYS.

export interface Plan {
  plan_id: string;
  name: string;
  price_monthly: number | null;
  limits: { members: number; sources: number; leads_per_month: number };
}

export const DEFAULT_PLANS: Plan[] = [
  { plan_id: 'starter', name: 'Starter', price_monthly: null, limits: { members: 3, sources: 1, leads_per_month: 200 } },
  { plan_id: 'team', name: 'Team', price_monthly: null, limits: { members: 10, sources: 3, leads_per_month: 1000 } },
];

export interface PlanConfig {
  currency: string;
  status: 'draft_pending_validation' | 'published';
  plans: Plan[];
  trialDays: number;
  note: string;
}

export function loadPlanConfig(env: NodeJS.ProcessEnv = process.env): PlanConfig {
  let plans = DEFAULT_PLANS;
  if (env.PLANS_JSON) {
    const parsed = JSON.parse(env.PLANS_JSON) as Plan[];
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('PLANS_JSON must be a non-empty array');
    plans = parsed;
  }
  const published = env.PLAN_PRICES_STATUS === 'published';
  return {
    currency: 'USD',
    status: published ? 'published' : 'draft_pending_validation',
    plans,
    trialDays: Number(env.TRIAL_DAYS ?? 14),
    note: 'Prices are set by leadership within the USD 50-200 range before publication.',
  };
}

export function findPlan(cfg: PlanConfig, planId: string): Plan {
  return cfg.plans.find(p => p.plan_id === planId) ?? cfg.plans[cfg.plans.length - 1];
}
