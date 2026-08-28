// Reps Plans — READ-ONLY board inside the Phoenix admin shell.
//
// The owner's own KPI, split so that a call nobody can check cannot inflate it: two AM accounts and
// ten PM clinics every working day, reported twice — what the rep recorded, and what the GPS
// check-ins prove. The rules live in src/lib/crm/call-rate.ts (pure) and the shaping in
// src/lib/crm/reps-plans.ts; this page only wires the fetch to the board.
//
// SUPER ADMIN ONLY for now. The role list is NOT maintained here — it lives in
// src/lib/crm/reps-plans-access.ts, so the page and the nav entry cannot drift apart on who may
// open it.
//
// Month and rep ride in the URL, so every change re-runs the gate server-side (same posture as Rep
// Doctor Lists next door).
import { redirect } from "next/navigation";

import { RepsPlansBoardView } from "@/components/crm/reps-plans-board";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadCallRateReport } from "@/lib/crm/call-rate-service";
import { cairoTodayIso } from "@/lib/crm/dates";
import { buildRepsPlansBoard, repsPlansRange, resolveRepsPlansMonth } from "@/lib/crm/reps-plans";
import { canAccessRepsPlans } from "@/lib/crm/reps-plans-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{
    month?: string;
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
  const range = repsPlansRange(month, today);

  // Data fetch and JSX stay separated (react-hooks/error-boundaries: JSX must not be constructed
  // inside try/catch). A data failure renders a plain explanation, never a crash page — and never a
  // zero, which on this board would read as "every rep did nothing".
  let report: Awaited<ReturnType<typeof loadCallRateReport>> | null = null;
  let loadError: string | null = null;
  try {
    report = await loadCallRateReport({ dateFrom: range.dateFrom, dateTo: range.dateTo });
  } catch (error) {
    loadError = error instanceof Error ? error.message : "CRM visit data is unavailable.";
  }

  if (!report) {
    return (
      <div className="border border-rose-200 bg-rose-50 px-5 py-4">
        <p className="text-sm font-bold text-rose-800">Reps Plans could not load.</p>
        <p className="mt-1 text-xs text-rose-700">{loadError}</p>
      </div>
    );
  }

  const board = buildRepsPlansBoard(report, {
    isCurrentMonth: range.isCurrentMonth,
    month,
    repKey: params?.rep ?? null,
  });

  return (
    <div className="space-y-5">
      <RepsPlansBoardView basePath="/admin/reps-plans" board={board} />
    </div>
  );
}
