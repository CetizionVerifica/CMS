// Which lifecycle actions the account page offers for an account. The API decides (ADR M15-0001 decision 3); this
// only hides buttons that it would refuse, using the contracts' own transition table.
import {
  canMoveAccount,
  KNOWN_FEATURES,
  type Account,
  type AccountOverride,
  type OperatorAuditEvent,
  type Plan,
  type PlanLimits,
} from '@canopy/contracts';

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

/** The override's parts the console can see, without its note. */
export type OverrideParts = Pick<AccountOverride, 'limits' | 'features'> & {
  removedFeatures: string[];
};

/**
 * The account's current override as far as the console can see it: each limit and feature where the account's
 * entitlements differ from its plan, and the plan's features the account goes without (`removedFeatures`, ADR M16-0001
 * decision 2). The API has no read of the override itself, and this is what the operator set.
 */
export function overrideFrom(
  entitlements: Account['entitlements'],
  plan: Plan | undefined,
): OverrideParts {
  if (!plan) return { limits: {}, features: [], removedFeatures: [] };
  const limits: Partial<PlanLimits> = {};
  for (const key of LIMIT_KEYS) {
    if (entitlements.limits[key] !== plan.limits[key]) limits[key] = entitlements.limits[key];
  }
  return {
    limits,
    features: entitlements.features.filter((f) => !plan.features.includes(f)),
    removedFeatures: plan.features.filter((f) => !entitlements.features.includes(f)),
  };
}

/**
 * The override's note, from the newest `OVERRIDE_CHANGE` the operator audit holds for the account: every override is
 * written by that route, and the event keeps the override as stored. Null when there is none, so a switch or a limits
 * save keeps the note the operator wrote.
 */
export function noteFrom(event: OperatorAuditEvent | undefined): string | null {
  const override = event?.after?.override;
  if (typeof override !== 'object' || override === null) return null;
  const note = (override as { note?: unknown }).note;
  return typeof note === 'string' ? note : null;
}

const KNOWN_CODES: readonly string[] = KNOWN_FEATURES.map((f) => f.code);

/** Whether a flag is one of the add-ons the Add-ons card switches; the limits drawer leaves those alone. */
export const isKnownFeature = (flag: string) => KNOWN_CODES.includes(flag);

/** Where an add-on the account has, or lacks, comes from. */
export function featureSource(
  code: string,
  plan: Plan | undefined,
  current: OverrideParts,
): 'plan' | 'added' | 'removed' | 'off' {
  if (current.removedFeatures.includes(code)) return 'removed';
  if (current.features.includes(code)) return 'added';
  return plan?.features.includes(code) ? 'plan' : 'off';
}

/**
 * The override with one add-on switched on or off and everything else as it was. The switch always names the flag it
 * changes, whether or not the plan has it (ISO-5b): on puts it in `features`, off in `removedFeatures`, so a later
 * plan edit that adds the flag leaves an account switched off still off. Limits and the other flags stay.
 */
export function withFeature(current: OverrideParts, code: string, on: boolean): OverrideParts {
  const features = current.features.filter((f) => f !== code);
  const removedFeatures = current.removedFeatures.filter((f) => f !== code);
  (on ? features : removedFeatures).push(code);
  return { limits: current.limits, features, removedFeatures };
}

/** Minutes the ISO catalogue copy may take before the console flags it (plan §4.3). */
export const ISO_SETUP_MINUTES = 15;

export type IsoSetup =
  | { state: 'copied'; at: string }
  | { state: 'waiting' }
  | { state: 'late'; since: string }
  | { state: 'notYet' };

const COPYABLE: readonly string[] = ['TRIAL', 'ACTIVE'];
const listed = (side: Record<string, unknown> | null, key: string): unknown[] | null => {
  const value = side?.[key];
  return Array.isArray(value) ? value : null;
};

/**
 * Where the ISO catalogue copy stands, for an account with `isoManagement` on (plan §4.3). The copy runs only in TRIAL
 * and ACTIVE, so it is "late" only for such an account still without a copy 15 minutes after the later of the latest
 * switch-on and its latest move into TRIAL or ACTIVE, both read from the operator audit (`events`, newest first). An
 * account created on a plan with the flag has no switch-on entry: its creation counts. Other statuses: "notYet".
 */
export function isoSetup(
  account: Pick<Account, 'status' | 'createdAt' | 'isoCatalogueCopiedAt'>,
  events: readonly OperatorAuditEvent[],
  now: number,
): IsoSetup {
  if (account.isoCatalogueCopiedAt) return { state: 'copied', at: account.isoCatalogueCopiedAt };
  if (!COPYABLE.includes(account.status)) return { state: 'notYet' };
  const switchedOn = events.find((e) => {
    const before = listed(e.before, 'features');
    const after = listed(e.after, 'features');
    return after?.includes('isoManagement') && !(before ?? []).includes('isoManagement');
  });
  const movedIn = events.find((e) => {
    const to = e.after?.status;
    return typeof to === 'string' && COPYABLE.includes(to) && e.before?.status !== to;
  });
  const since = [switchedOn?.at ?? account.createdAt, movedIn?.at]
    .filter((at): at is string => at !== undefined)
    .reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
  return now - Date.parse(since) >= ISO_SETUP_MINUTES * 60_000
    ? { state: 'late', since }
    : { state: 'waiting' };
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
