export const DEFAULT_PROVIDER_BUDGET_SECONDS = 120;
export const PROVIDER_WATCHDOG_GRACE_SECONDS = 15;
export const MAX_PROVIDER_WATCHDOG_SECONDS = 15 * 60;
export const DEFAULT_PROVIDER_WATCHDOG_SECONDS =
  DEFAULT_PROVIDER_BUDGET_SECONDS + PROVIDER_WATCHDOG_GRACE_SECONDS;

export function providerWatchdogSeconds(reportedBudgetSeconds?: number): number {
  if (reportedBudgetSeconds !== undefined && Number.isFinite(reportedBudgetSeconds) && reportedBudgetSeconds > 0) {
    return Math.min(
      MAX_PROVIDER_WATCHDOG_SECONDS,
      Math.ceil(reportedBudgetSeconds) + PROVIDER_WATCHDOG_GRACE_SECONDS
    );
  }
  return DEFAULT_PROVIDER_WATCHDOG_SECONDS;
}
