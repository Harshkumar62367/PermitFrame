/**
 * SaaS entitlement policy (tiers hook point). Pure functions over an explicit
 * tier so limits are unit-testable; the current workspace resolves to the
 * allow-all tier. Future Prompt: back tiers by Stripe/subscription rows.
 */

export interface EntitlementTier {
  id: string;
  /** Max stages dispatched in one produce run. */
  maxAssetsPerRun: number;
  /** Max concurrent generation jobs (pipeline runs sequentially today). */
  maxConcurrentJobs: number;
  /** Whether the premium quality profile may be selected. */
  premiumModels: boolean;
  /** Monthly generation budget in USD (null = unlimited). */
  monthlyBudgetUsd: number | null;
  /** Upper bound for Custom pack stage counts (server-side). */
  maxCustomStages: number;
}

export const ALLOW_ALL_TIER: EntitlementTier = {
  id: "workspace-allow-all",
  maxAssetsPerRun: 32,
  maxConcurrentJobs: 4,
  premiumModels: true,
  monthlyBudgetUsd: null,
  maxCustomStages: 16
};

/**
 * Resolve the tier for the current workspace. Allow-all today; reads an
 * optional server-side custom-stage ceiling so operators can tighten Custom
 * packs without code changes. Tier rows (Stripe) plug in here later.
 */
export function resolveEntitlements(): EntitlementTier {
  const custom = Number.parseInt(process.env.LIVEPEER_MAX_CUSTOM_STAGES ?? "", 10);
  if (Number.isInteger(custom) && custom > 0) {
    return { ...ALLOW_ALL_TIER, maxCustomStages: custom, maxAssetsPerRun: Math.max(32, custom) };
  }
  return ALLOW_ALL_TIER;
}

/** Refuse a produce run that exceeds the tier's per-run asset limit. */
export function checkAssetsPerRun(wantedCount: number, tier: EntitlementTier): string | null {
  if (wantedCount > tier.maxAssetsPerRun) {
    return `This run selects ${wantedCount} stages but the workspace allows ${tier.maxAssetsPerRun} per run - split it into smaller runs.`;
  }
  return null;
}

/** Refuse premium routing on tiers without premium model access. */
export function checkProfileAccess(profile: string, tier: EntitlementTier): string | null {
  if (profile === "premium" && !tier.premiumModels) {
    return "The premium quality profile is not enabled for this workspace - pick balanced or draft.";
  }
  return null;
}

/**
 * Refuse a run that would breach the monthly budget. Skipped when the tier
 * has no budget or when nothing in the selection is quotable (unknown cost
 * can never be a breach - the estimate says so honestly).
 */
export function checkMonthlyBudget(
  spentUsd: number,
  estimatedUsd: number | null,
  tier: EntitlementTier
): string | null {
  if (tier.monthlyBudgetUsd === null || tier.monthlyBudgetUsd <= 0) return null;
  if (estimatedUsd === null) return null;
  if (spentUsd + estimatedUsd > tier.monthlyBudgetUsd) {
    return `This run would exceed the workspace monthly budget ($${tier.monthlyBudgetUsd.toFixed(2)}): $${spentUsd.toFixed(2)} spent + $${estimatedUsd.toFixed(2)} estimated.`;
  }
  return null;
}
