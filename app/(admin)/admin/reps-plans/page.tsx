// Reps Plans — READ-ONLY board inside the Phoenix admin shell.
//
// The owner's own KPI, split so that a call nobody can check cannot inflate it: two AM accounts and
// ten PM clinics every working day, reported twice — what the rep recorded, and what the GPS
// check-ins prove. The rules live in src/lib/crm/call-rate.ts (pure) and the shaping in
// src/lib/crm/reps-plans.ts; this page only wires the fetch to the board.
//
// SUPER ADMIN ONLY, and that is a fact about THIS SHELL rather than about the board. The role
// list is NOT maintained here — it lives in src/lib/crm/reps-plans-access.ts, so the page and the
// nav entry cannot drift apart on who may open it. The Regional and District Managers added there
// on 2026-09-03 are portal seats: app/(admin)/layout.tsx redirects them out of this shell before
// this page's gate could run, so they reach the identical board through the twin at
// /employee-portals/reps-plans.
//
// The scope is resolved and passed even so. Super Admin resolves to company-wide, so it changes
// nothing here — which is exactly why it must be passed rather than omitted: an omitted scope is
// company-wide too, and the two are indistinguishable until the day a narrower seat reaches this
// file.
//
// Month and rep ride in the URL, so every change re-runs the gate server-side (same posture as Rep
// Doctor Lists next door).
import { redirect } from "next/navigation";

import { RepsPlansBoardView } from "@/components/crm/reps-plans-board";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadCallRateReport, loadJobTitlesByHrId, loadRepNamesByHrId } from "@/lib/crm/call-rate-service";
import { getDoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";
import { loadOrgPlacementTree } from "@/lib/crm/org-placement-data";
import { cairoTodayIso } from "@/lib/crm/dates";
import { buildRepsPlansBoard, repsPlansRange, repsPlansWeeks, resolveRepsPlansMonth } from "@/lib/crm/reps-plans";
import { canAccessRepsPlans } from "@/lib/crm/reps-plans-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{
    line?: string;
    month?: string;
    /** `month` (default), `w1`…`w5`, or an explicit `YYYY-MM-DD..YYYY-MM-DD`. */
    period?: string;
    region?: string;
    rep?: string;
  }>;
};

export default async function RepsPlansPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  // Two gates, both server-side: the explicit role list, then the permission matrix that is the
  // real security boundary. No access redirects rather than explaining — inside the admin shell an
  // unreachable page should behave as if it does not exist for that role.
  if (!canAccessRepsPlans(access)) redirect("/admin");
  if (!(await canAccess(access, "crm_visits", "read"))) redirect("/admin");

  const params = await searchParams;
  const today = cairoTodayIso();
  const month = resolveRepsPlansMonth(params?.month, today);
  // The window bounds the FETCH as well as the caption, so a week's rate is a week's calls over a
  // week's working days. Owner, 2026-08-28: "if this is the plan of the first week, calculate the
  // call rate on the first week only, not all the month."
  const range = repsPlansRange(month, today, params?.period);
  const weekOptions = repsPlansWeeks(month, today);

  // Data fetch and JSX stay separated (react-hooks/error-boundaries: JSX must not be constructed
  // inside try/catch). A data failure renders a plain explanation, never a crash page — and never a
  // zero, which on this board would read as "every rep did nothing".
  let report: Awaited<ReturnType<typeof loadCallRateReport>> | null = null;
  // The directory names the person; the CRM only names the territory (owner, 2026-08-27). A failed
  // directory read must not take the board down with it — the names fall back to the CRM handle,
  // which is what this page showed before, so the worst case is the old behaviour and not a blank
  // screen. Only the visits are load-bearing.
  let repNameByHrId: ReadonlyMap<string, string> | undefined;
  // Same directory, same cache, same "must not take the board down" posture: it names the people the
  // SALES organogram has no seat for — head office, where the Product Managers sit. Without it those
  // rows fall back to the marker, which is the old behaviour and not a blank screen.
  let jobTitleByHrId: ReadonlyMap<string, string> | undefined;
  let loadError: string | null = null;
  try {
    const [loadedReport, loadedNames, loadedTitles] = await Promise.all([
      loadCallRateReport({ dateFrom: range.dateFrom, dateTo: range.dateTo }),
      loadRepNamesByHrId().catch(() => undefined),
      loadJobTitlesByHrId().catch(() => undefined),
    ]);
    report = loadedReport;
    repNameByHrId = loadedNames;
    jobTitleByHrId = loadedTitles;
  } catch (error) {
    loadError = error instanceof Error ? error.message : "CRM visit data is unavailable.";
  }

  // The ORGANOGRAM is a SEPARATE failure. It powers the line/region pickers and the tier each
  // person is measured by, so losing it must not take the call rate down with it — the board falls
  // back to month + rep and hides the two pickers rather than offering empty ones.
  //
  // au_v_org_tree, every tier. NOT a rep-only view: reading one is what once rendered 22 seated
  // District Managers, NSMs and an RSM as holding no seat at all.
  let tree: Awaited<ReturnType<typeof loadOrgPlacementTree>> | null = null;
  try {
    tree = await loadOrgPlacementTree();
  } catch {
    tree = null;
  }

  if (!report) {
    return (
      <div className="border border-rose-200 bg-rose-50 px-5 py-4">
        <p className="text-sm font-bold text-rose-800">Reps Plans could not load.</p>
        <p className="mt-1 text-xs text-rose-700">{loadError}</p>
      </div>
    );
  }

  // WHOSE reps. The same resolver the KPIs board asks, so a manager's reach cannot differ between
  // the two screens, and NOT wrapped in a catch: a scope that failed to resolve must never fall
  // through to company-wide. getDoctorCoverageScope answers `company` for this shell's one role
  // without touching the directory at all, so there is nothing here to fail.
  const scope = await getDoctorCoverageScope(access);

  const board = buildRepsPlansBoard(report, {
    geography: { line: params?.line ?? null, region: params?.region ?? null },
    isCurrentMonth: range.isCurrentMonth,
    jobTitleByHrId,
    month,
    range,
    repKey: params?.rep ?? null,
    repNameByHrId,
    scope,
    tree,
    weekOptions,
  });

  return (
    <div className="space-y-5">
      <RepsPlansBoardView basePath="/admin/reps-plans" board={board} />
    </div>
  );
}
