import { redirect } from "next/navigation";

import { EmployeeProbationDashboard } from "@/components/employee-portal/employee-probation-dashboard";
import {
  ProbationFeedbackTasksPanel,
  type FeedbackTaskView,
} from "@/components/employee-portal/probation-feedback-tasks-panel";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { ScopeBadge } from "@/components/employee-portal/scope-badge";
import {
  assertPermission,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import {
  employeeDirectoryErrorMessage,
  isEmployeeDirectoryEnvMissing,
  isEmployeeDirectorySchemaMissing,
  isEmployeeDirectoryTimeout,
} from "@/lib/employees/employee-directory";
import {
  canViewProbationAnalytics,
  getProbationRows,
  isProbationSchemaMissing,
  probationErrorMessage,
} from "@/lib/probation/service";
import { listFeedbackTasks } from "@/lib/probation/intelligence/feedback-workflow";
import {
  getProbationOutcomesAnalytics,
  type OutcomesAnalytics,
} from "@/lib/probation/intelligence/outcomes-analytics";
import { ProbationAnalyticsView } from "@/components/probation/probation-analytics-view";
import type { ProbationRow } from "@/lib/probation/types";

export const dynamic = "force-dynamic";

/* ---------- error handling ---------- */

function probationPageError(error: unknown) {
  if (isEmployeeDirectoryTimeout(error))
    return "Supabase request timed out. Check your connection and try again.";
  if (isEmployeeDirectoryEnvMissing(error))
    return "Supabase environment variables are missing.";
  if (isEmployeeDirectorySchemaMissing(error))
    return "Supabase schema is not ready. Run supabase/phoenix-schema.sql in Supabase SQL editor.";
  if (isProbationSchemaMissing(error))
    return "Probation review schema is not ready.";
  return (
    probationErrorMessage(error) || employeeDirectoryErrorMessage(error)
  );
}

/* ---------- page ---------- */

export default async function EmployeePortalProbationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAuthenticatedPageAccess();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/probation");
  }

  await assertPermission(access, "probation", "read");

  const params = await searchParams;
  const feedbackEmployeeHrId = typeof params.feedbackEmployeeHrId === "string" ? params.feedbackEmployeeHrId : null;
  const feedbackCycle = typeof params.cycle === "string" ? parseInt(params.cycle, 10) : null;

  const canSubmitManagerFeedback =
    access.role === "District Manager" ||
    access.role === "Regional Manager" ||
    access.role === "National Sales Manager" ||
    access.role === "Training Manager" ||
    access.role === "Product Manager" ||
    access.role === "Group Product Manager" ||
    access.role === "Manager" ||
    // Owner-requested 2026-07-24: she submits feedback alongside HR (Super Admin), not
    // instead of it — case decisions (pass/terminate) stay isProbationAdministrator-only.
    access.role === "Talent Acquisition";

  const canManageDvCheckboxes = access.role === "Super Admin";

  let initialData: ProbationRow[] | null = null;
  let initialError: string | null = null;

  try {
    initialData = await getProbationRows(access);
  } catch (error) {
    initialError = probationPageError(error);
  }

  if (initialError) {
    return (
      <EmployeePortalEmptyState
        message={initialError}
        title="Probation Tracker Unavailable"
      />
    );
  }

  // Probation Analytics (owner rule 2026-07-17): the historical-outcomes dashboard is visible to the
  // feedback-submitting manager tiers (National Sales Manager, PM/GPM) inside their PORTAL — mirroring
  // SFE / admin / CEO on the admin /probation/analytics route (those roles are admin-mode). Best-effort:
  // an analytics fetch failure must never break the tracker below.
  const showAnalytics = canViewProbationAnalytics(access);
  let analyticsData: OutcomesAnalytics | null = null;
  if (showAnalytics) {
    try {
      analyticsData = await getProbationOutcomesAnalytics();
    } catch {
      analyticsData = null;
    }
  }

  const hasTracker = Boolean(initialData && initialData.length > 0);

  // Nothing to show — no scoped probationers AND not an analytics viewer.
  if (!hasTracker && !showAnalytics) {
    return (
      <EmployeePortalEmptyState
        message="No active probation records found for your current scope."
        title="Probation Tracker"
      />
    );
  }

  // Manager feedback inbox (E2): the signed-in evaluator's open, validated Double-Visit days that still
  // owe structured feedback. Best-effort — the intelligence tables may not exist in every environment,
  // and this panel must never break the tracker below it.
  let feedbackTasks: FeedbackTaskView[] = [];
  if (hasTracker && canSubmitManagerFeedback) {
    try {
      const nameByHrId = new Map<string, string>();
      for (const row of initialData!) {
        if (row.full_name) nameByHrId.set(row.hr_id.toLowerCase(), row.full_name);
      }
      const tasks = await listFeedbackTasks(access);
      feedbackTasks = tasks.map((t) => ({
        dvDayId: t.dvDayId,
        employeeHrId: t.employeeHrId,
        employeeName: nameByHrId.get(t.employeeHrId.toLowerCase()) ?? null,
        evaluatorRole: t.evaluatorRole,
        dvDate: t.dvDate,
        visitCount: t.visitCount,
        slaState: t.sla.state,
        hoursUntilDue: t.sla.hoursUntilDue,
        hoursOverdue: t.sla.hoursOverdue,
      }));
    } catch {
      feedbackTasks = [];
    }
  }

  return (
    <EmployeePortalPageShell
      badge="People Operations"
      description="Track probation timelines and risk zones for your scoped team."
      errorBoundaryTitle="Probation Tracker unavailable"
      title="Probation Tracker"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ScopeBadge scope={access.scope} />
      </div>
      {hasTracker ? (
        <>
          <ProbationFeedbackTasksPanel tasks={feedbackTasks} />
          <EmployeeProbationDashboard
            canManageDvCheckboxes={canManageDvCheckboxes}
            canSubmitManagerFeedback={canSubmitManagerFeedback}
            feedbackCycle={feedbackCycle}
            feedbackEmployeeHrId={feedbackEmployeeHrId}
            initialData={initialData!}
          />
        </>
      ) : (
        <p className="rounded-lg border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
          No probationers are currently in your scoped team.
        </p>
      )}
      {showAnalytics && analyticsData && (
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-800">Probation — Historical Outcomes</h2>
          <p className="mb-3 mt-1 text-xs text-slate-500">
            Decided cases only — pass/terminate rates and average score by line, manager, and month.
          </p>
          <ProbationAnalyticsView data={analyticsData} />
        </section>
      )}
    </EmployeePortalPageShell>
  );
}
