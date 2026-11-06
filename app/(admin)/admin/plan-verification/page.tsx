// Plan Verification — the plans a manager verifies.
//
// WAS TAB TWO of a two-tab District Manager page until 2026-08-31. The owner retired tab one
// (Doctor List) and its tab strip together — "retire it and its DM tab" — so this board now stands
// on its own and src/components/crm/district-manager-tabs.tsx is gone. A one-item tab strip is not
// a tab strip. Its replacement, Reps List, is a page of its own at /admin/reps-list and reaches the
// same managers through the CRM hub and the sidebar, not through a tab beside this one.
//
// The owner's specification: weekly and monthly plans the DM can verify or leave pending, with the
// verification written back into the CRM. iReports360 was retired on 6 November 2026 and that write
// went with it: an old-CRM plan is read-only now, and a plan filed in Phoenix CRM carries Phoenix's
// own Approve (owner, 2026-11-06: "phx crm replaced the old crm so any module was wired with old crm
// must wire with phx crm"). One button, approve only; a return is made on the Team tab.
//
// The role list and the scope live in src/lib/crm/plan-verification-access.ts. A district manager
// sees his own reps' plans and nobody else's. The Approve posts to /api/phoenix-crm/plans/decide,
// which asks phoenix_crm:approve and checks the viewer reviews that territory on its own.
//
// Period and plan ride in the URL, so every change re-runs the gate server-side.
import { redirect } from "next/navigation";

import { PlanVerificationBoardView } from "@/components/crm/plan-verification-board";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getPlanVerificationBoard } from "@/lib/crm/plan-board";
import { canAccessPlanVerification, getPlanVerificationScope } from "@/lib/crm/plan-verification-access";
import type { PlanKind } from "@/lib/crm/plan-verification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{ kind?: string; month?: string; plan?: string; year?: string }>;
};

/** The Cairo month, which is the month a manager means when he says "this month". */
function cairoToday(): { month: number; year: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    month: "2-digit",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).formatToParts(new Date());
  const month = Number(parts.find((part) => part.type === "month")?.value ?? "1");
  const year = Number(parts.find((part) => part.type === "year")?.value ?? "1970");
  return { month, year };
}

export default async function PlanVerificationPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  // The seats this whole page was written for — District Manager and Regional Manager — are PORTAL
  // seats, and the plan-verification NOTIFICATION links straight here. `app/(admin)/layout.tsx`
  // redirects every portal-mode viewer out of the admin shell before this page runs, so this line
  // never actually fires; it is the source-of-truth declaration that `portal-twins.ts` lifts up to
  // the layout, sending such a viewer to the portal Reps List plans tab (carrying `plan` and `week`)
  // instead of dropping them on the portal home. Before it, the only screen their crm_plans:approve
  // grant unlocks was unreachable from its own notification (audit, 2026-09-21).
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals/reps-list");
  // Two gates, both server-side: the explicit role list, then the permission matrix that is the
  // real security boundary. No access redirects rather than explaining — inside the admin shell an
  // unreachable page should behave as if it does not exist for that role.
  if (!canAccessPlanVerification(access)) redirect("/admin");
  if (!(await canAccess(access, "crm_plans", "read"))) redirect("/admin");
  // Approving is a SEPARATE grant, Phoenix CRM's own, asked again by its decide route. The CEO
  // account holds read and not approve, so it reads every plan and is shown no button — the same
  // segregation of duties that keeps it observational on the rest of the irreversible workflows.
  const canApprove = await canAccess(access, "phoenix_crm", "approve");

  const params = await searchParams;
  const today = cairoToday();
  // Every parameter falls back rather than erroring. A hand-typed month of 99 lands on the current
  // month, which is a readable board; a hand-typed plan id outside the viewer's reach resolves to
  // nothing, exactly as if it did not exist.
  const kind: PlanKind = params?.kind === "monthly" ? "monthly" : "weekly";
  const parsedMonth = Number.parseInt(params?.month ?? "", 10);
  const month = parsedMonth >= 1 && parsedMonth <= 12 ? parsedMonth : today.month;
  const parsedYear = Number.parseInt(params?.year ?? "", 10);
  const year = parsedYear >= 2020 && parsedYear <= today.year + 1 ? parsedYear : today.year;
  const parsedPlan = Number.parseInt(params?.plan ?? "", 10);
  const selectedPlanId = Number.isFinite(parsedPlan) && parsedPlan > 0 ? parsedPlan : undefined;

  // The CRM mirror starts in January of the previous year; offering more years than exist would
  // invite a manager to conclude a period is empty when it was never mirrored.
  const years = [today.year - 1, today.year];

  // Data fetch and JSX stay separated (JSX must not be constructed inside try/catch). A data
  // failure renders a plain explanation, never a crash page.
  let board: Awaited<ReturnType<typeof getPlanVerificationBoard>> | null = null;
  let loadError: string | null = null;
  try {
    const scope = await getPlanVerificationScope(access);
    board = await getPlanVerificationBoard({ kind, month, scope, selectedPlanId, year });
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Plan data is unavailable.";
  }

  if (!board) {
    return (
      <div className="border border-rose-200 bg-rose-50 px-5 py-4">
        <p className="text-sm font-bold text-rose-800">Plans could not load.</p>
        <p className="mt-1 text-xs text-rose-700">{loadError}</p>
      </div>
    );
  }

  return (
    <PlanVerificationBoardView
      basePath="/admin/plan-verification"
      board={board}
      canApprove={canApprove}
      years={years}
    />
  );
}
