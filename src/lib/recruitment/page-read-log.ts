import type { AccessContext } from "@/lib/auth/permissions";
import { resolveActivityModule } from "@/lib/activity/modules";
import { logAppError } from "@/lib/error-monitor/service";
import { describeReadFailures, type RecruitmentReadFailure } from "@/lib/recruitment/page-reads";

/**
 * Leaves ONE row in app_error_events when the Recruitment page had to draw without some of its reads.
 *
 * Until 18 Oct 2026 a failed read left nothing at all -- the page caught the error, showed a notice and
 * moved on, so a recruiter reporting "recruitment data cannot be loaded" gave nobody anything to look
 * up. One aggregated row per load (not one per read) keeps a slow database from writing eight rows for
 * every refresh, and names every source and what each one said.
 *
 * Fire-and-forget on purpose: the page is already waiting on a database that is slow, and a log insert
 * must never add to that wait. `logAppError` never throws.
 */
export function logRecruitmentReadFailures(
  access: Pick<AccessContext, "hrId" | "loginId" | "role">,
  failures: ReadonlyArray<RecruitmentReadFailure>,
  route: string,
): void {
  if (failures.length === 0) return;
  const activityModule = resolveActivityModule(route);
  void logAppError({
    source: "server",
    route,
    routeType: "page",
    hrId: access.hrId ?? null,
    loginId: access.loginId ?? null,
    role: access.role ?? null,
    moduleKey: activityModule.key,
    moduleLabel: activityModule.label,
    message: describeReadFailures(failures),
  }).catch(() => undefined);
}
