/**
 * A temporarily locked module refusing a page is an answer, not a failure.
 *
 * `assertPermission` throws `Forbidden: <module> is temporarily locked by the system administrator.` when the
 * administrator has locked a module. The page shells (`EmployeePortalChrome`, `AppShell`) already intercept that
 * and show the lock notice instead of the page, so nobody sees an error — but the page component still renders
 * and throws, and Next hands that throw to `onRequestError`. Reported, it read as a crash: one Sentry issue the
 * first time `incentive` was locked (2026-10-17) and one error-table row when `sales` was locked on 2026-10-12.
 *
 * The match is exact on purpose, as in benign-disconnect.ts: only the lock wording is skipped, so a real
 * `Forbidden: <role> cannot read <resource>.` still reaches both stores.
 *
 * ZERO IMPORTS, DELIBERATELY — `instrumentation.ts` is bundled for the Edge Runtime as well as Node.
 */
const MODULE_LOCK_REFUSAL = /^Forbidden: [a-z0-9_]+ is temporarily locked by the system administrator\.$/;

export function isModuleLockRefusal(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && MODULE_LOCK_REFUSAL.test(message);
}
