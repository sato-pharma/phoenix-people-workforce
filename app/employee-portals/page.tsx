import { Suspense } from "react";
import { redirect } from "next/navigation";

import { MrAreaNoticeBanner } from "@/components/employee-portal/mr-area-notice-banner";
import { PortalCommandCenter } from "@/components/employee-portal/portal-command-center";
import { EmployeePortalEmptyState } from "@/components/employee-portal/enterprise-shell";
import { getPortalHomeSnapshot } from "@/lib/employee-portal/home-snapshot";
import { loadRepTodayPlan } from "@/lib/phoenix-crm/server/rep-landing";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { isForbiddenError } from "@/lib/auth/server";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";

export const dynamic = "force-dynamic";

/**
 * `?kpiMonth=YYYY-MM` — the month the Medical Rep's keycards are showing.
 *
 * It rides in the URL rather than in component state, for the same reason the KPIs board's whole
 * selection does: every change re-runs the gates above server-side, so no month can be picked past
 * the access check, and the back button and a pasted link both work. The value is handed over RAW —
 * `getPortalHomeSnapshot` validates it against the one month list and falls back to the running
 * month — so there is deliberately no second opinion here about what a month may be.
 */
type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

/** First value only: a repeated `?kpiMonth=a&kpiMonth=b` must resolve to one month, not an array. */
function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function EmployeePortalsHomePage({ searchParams }: PageProps) {
  const access = await resolveAuthenticatedPageAccess();
  const mode = resolveNavigationMode(access);

  if (mode !== "employee-portal") {
    redirect("/overview");
  }
  // A Training Manager signs in to her coaching section (landing.ts), but this home is never a bounce
  // for her: the Command Center row must still open it.
  try {
    await assertPermission(access, "employee_profile", "read");
  } catch (error) {
    if (isForbiddenError(error)) redirect("/login");
    throw error;
  }

  // The rep's day, which replaced the Phoenix CRM Today module (owner, 2026-09-30). It never throws
  // — a closed line, a missing permission or a failed read all answer null and the panel renders
  // nothing, because a landing page that fails to paint over one panel is worse than one panel short.
  //
  // STARTED BESIDE THE SNAPSHOT, not after it (2026-10-01, "slow to transfer between page and page"):
  // the two read different things and neither needs the other, so awaiting them in turn made the
  // landing page as slow as both added together. Never rejecting is what makes it safe to leave
  // running when the snapshot fails below.
  //
  // Read for the Medical Rep ONLY (2026-10-31, "fix the slowest five pages"): his is the one landing
  // that draws the panel — PortalCommandCenter's own "medical rep" test — so every other role was
  // waiting on a CRM day load and throwing it away.
  //
  // 🔴 HANDED TO THE PAGE STILL RUNNING, AND NEVER AWAITED HERE (2026-11-01, "fix the portal home slow
  // opens"): it is the slowest read on the landing, so awaiting it held the rep's whole page behind one
  // panel. It fills under its own Suspense in the rep's command center.
  const repTodayPlanPromise =
    (access.role ?? "").toLowerCase() === "medical rep" ? loadRepTodayPlan(access) : Promise.resolve(null);
  const params = (await searchParams) ?? {};

  let snapshot;
  try {
    // streamRepCards: a Medical Rep's slow cards (achievement, rank, field KPIs, his record) arrive
    // still running and fill under Suspense, so the page paints on the fast reads alone (owner,
    // 2026-10-23: "the process of shifting from page to page never take more than 1 second").
    // streamRoleExtras: the same for a District, Regional or National Sales Manager and the
    // Marketing Manager — his team, region or national figures, rankings, CRM board and inbox fill
    // under their own Suspense, and the identity band and pending actions paint first.
    // streamDvFocus: and the double-visit focus at the foot of a manager's landing, the same way.
    // streamLandingCards: and plan adherence, his own interviews, the CV folders and the Early Birds,
    // on every role's landing (2026-11-01, "fix the portal home slow opens").
    // landing: and the reads this role's landing never draws are not started at all.
    snapshot = await getPortalHomeSnapshot(access, {
      kpiMonth: one(params.kpiMonth),
      streamRepCards: true,
      streamRoleExtras: true,
      streamDvFocus: true,
      streamLandingCards: true,
      landing: true,
    });
  } catch (error) {
    logPortalFailure(
      { route: "/employee-portals", module: "home-snapshot", role: access.role, hrId: access.hrId },
      error,
    );
    return (
      <EmployeePortalEmptyState
        message="Your command center is temporarily unavailable. Please try again in a moment."
        title="Portal Unavailable"
      />
    );
  }

  // A Medical Rep candidate HR passed for his area (owner, 7 Nov 2026): above everything, so he sees it
  // the moment he signs in. Its own Suspense — the landing never waits on it.
  return (
    <>
      <Suspense fallback={null}>
        <MrAreaNoticeBanner hrId={access.hrId} />
      </Suspense>
      <PortalCommandCenter access={access} repTodayPlan={repTodayPlanPromise} snapshot={snapshot} />
    </>
  );
}
