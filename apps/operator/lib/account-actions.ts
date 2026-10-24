// Which lifecycle actions the account page offers for an account. The API decides (ADR M15-0001 decision 3); this
// only hides buttons that it would refuse, using the contracts' own transition table.
import { canMoveAccount, type Account, type Plan, type PlanLimits } from '@canopy/contracts';

export type AccountAction =
  | 'convert'
  | 'suspend'
  | 'resume'
  | 'extendTrial'
  | 'resendInvite'
  | 'markOnboarded'
  | 'requestDeletion'
  | 'cancelDeletion';

export function accountActions(
  account: Pick<Account, 'status' | 'onboardedAt' | 'purgeAfter'>,
  now: number = Date.now(),
): AccountAction[] {
  const { status } = account;
  const actions: AccountAction[] = [];
  if (status === 'PROVISIONING') actions.push('resendInvite');
  if (status === 'TRIAL') actions.push('convert', 'extendTrial');
  if (status === 'SUSPENDED') actions.push('resume');
  if (canMoveAccount(status, 'SUSPENDED') && status !== 'PENDING_DELETION') actions.push('suspend');
  if (account.onboardedAt === null && (status === 'TRIAL' || status === 'ACTIVE')) {
    actions.push('markOnboarded');
  }
  if (canMoveAccount(status, 'PENDING_DELETION') && status !== 'PENDING_DELETION') {
    actions.push('requestDeletion');
  }
  // Past purgeAfter the API refuses the cancel: the nightly purge may already be deleting the account's files.
  const purgeDue = account.purgeAfter !== null && Date.parse(account.purgeAfter) <= now;
  if (status === 'PENDING_DELETION' && !purgeDue) actions.push('cancelDeletion');
  return actions;
}

export const LIMIT_KEYS = ['companies', 'units', 'users', 'storageBytes'] as const;

export const LIMIT_LABEL: Record<(typeof LIMIT_KEYS)[number], string> = {
  companies: 'Companies',
  units: 'Units',
  users: 'Users',
  storageBytes: 'Evidence storage (bytes)',
};

/**
 * The account's current override as far as the console can see it: each limit and feature where the account's
 * entitlements differ from its plan. The API has no read of the override itself, and this is what the operator set.
 */
export function overrideFrom(
  entitlements: Account['entitlements'],
  plan: Plan | undefined,
): { limits: Partial<PlanLimits>; features: string[] } {
  if (!plan) return { limits: {}, features: [] };
  const limits: Partial<PlanLimits> = {};
  for (const key of LIMIT_KEYS) {
    if (entitlements.limits[key] !== plan.limits[key]) limits[key] = entitlements.limits[key];
  }
  return { limits, features: entitlements.features.filter((f) => !plan.features.includes(f)) };
}

/**
 * A limit typed in the override form: blank keeps the plan's value (undefined), "unlimited" lifts it (null), and a
 * whole number sets it. Anything else is an error.
 */
export function limitFrom(text: string): { value: number | null | undefined } | { error: string } {
  const t = text.trim().toLowerCase();
  if (t === '') return { value: undefined };
  if (t === 'unlimited') return { value: null };
  if (/^\d+$/.test(t)) return { value: Number(t) };
  return { error: 'A whole number, "unlimited", or blank for the plan’s limit' };
}

/** Comma- or space-separated feature flags, without repeats. */
export function featuresFrom(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).filter(Boolean))];
}
