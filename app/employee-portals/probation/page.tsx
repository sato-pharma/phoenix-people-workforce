import { redirect } from "next/navigation";

import { EmployeeProbationDashboard } from "@/components/employee-portal/employee-probation-dashboard";
import {
  ProbationFeedbackTasksPanel,
  type FeedbackTaskView,
} from "@/components/employee-portal/probation-feedback-tasks-panel";
import {
  ProbationScorecardLauncher,
  type ScorableProbationerView,
} from "@/components/employee-portal/probation-scorecard-launcher";
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
  canExportProbation,
  canViewProbationAnalytics,
  getProbationRows,
  isProbationSchemaMissing,
  probationErrorMessage,
} from "@/lib/probation/service";
import {
  listFeedbackTasks,
  resolveFeedbackTaskNames,
} from "@/lib/probation/intelligence/feedback-workflow";
import { listScorableProbationers } from "@/lib/probation/intelligence/manual-dv-day";
import { formatDateValue } from "@/lib/i18n/format";
import {
  getProbationOutcomesAnalytics,
  type OutcomesAnalytics,
} from "@/lib/probation/intelligence/outcomes-analytics";
import { ProbationAnalyticsView } from "@/components/probation/probation-analytics-view";
import type { ProbationRow } from "@/lib/probation/types";

export const dynamic = "force-dynamic";

// Human-readable evaluator role for the scorecard launcher — owner rule: names, never codes.
const EVALUATOR_ROLE_LABEL: Record<string, string> = {
  dm: "District Manager",
  nsm: "National Sales Manager",
  tm: "Training Manager",
  pm_gpm: "Product Manager",
};

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

export default async function EmployeePortalProbationPage() {
  const access = await resolveAuthenticatedPageAccess();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/probation");
  }

  await assertPermission(access, "probation", "read");

  // `?feedbackEmployeeHrId=` and `?cycle=` were read here until 2026-09-01, to auto-open the legacy
  // per-cycle feedback panel. Both went with it — the panel's table, employee_probation, has held
  // zero rows since the Case model took over provisioning, so it could only ever refuse. Live
  // feedback is the ProbationFeedbackTasksPanel below, which is submitted per DV-Day.
  const canSubmitManagerFeedback =
    access.role === "District Manager" ||
    access.role === "Regional Manager" ||
    access.role === "National Sales Manager" ||
    access.role === "Training Manager" ||
    access.role === "Product Manager" ||
    access.role === "Group Product Manager" ||
    access.role === "Manager" ||
    // The retired Talent Acquisition seat sat here (owner-requested 2026-07-24) because she was a
    // PORTAL role. Both successor bundles hold probation:read and submit feedback the same way, but
    // they are ADMIN-shell roles and reach app/(admin)/probation, so they do not belong in this
    // portal-side list. Case decisions (pass/terminate) stay isProbationAdministrator-only either way.
    false;

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

  // Manager feedback inbox (E2): the signed-in evaluator's open, validated Double-Visit days that still
  // owe structured feedback. Best-effort — the intelligence tables may not exist in every environment,
  // and this panel must never break the tracker below it.
  //
  // Loaded independently of `hasTracker` (2026-08-20): the tracker window hides anyone past day 90,
  // but their case stays open and their evaluators still owe feedback, so gating the inbox on it
  // could hide live, overdue work.
  let feedbackTasks: FeedbackTaskView[] = [];
  if (canSubmitManagerFeedback) {
    try {
      const nameByHrId = new Map<string, string>();
      for (const row of initialData ?? []) {
        if (row.full_name) nameByHrId.set(row.hr_id.toLowerCase(), row.full_name);
      }
      const tasks = await listFeedbackTasks(access);
      // Fill any name the tracker rows did not cover — never fall through to a bare HR code.
      const resolvedNames = await resolveFeedbackTaskNames(
        tasks.filter((t) => !nameByHrId.has(t.employeeHrId.toLowerCase())).map((t) => t.employeeHrId),
      );
      feedbackTasks = tasks.map((t) => ({
        dvDayId: t.dvDayId,
        employeeHrId: t.employeeHrId,
        employeeName:
          nameByHrId.get(t.employeeHrId.toLowerCase()) ??
          resolvedNames.get(t.employeeHrId.toLowerCase()) ??
          null,
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

  // "Score a probationer" (owner request 2026-08-20): the probationers in scope this evaluator has
  // NO open Double-Visit task for — the people the CRM-fed inbox above structurally cannot reach.
  // Kept disjoint from that inbox so no rep is listed twice. Best-effort, same as the inbox.
  let scorableProbationers: ScorableProbationerView[] = [];
  if (canSubmitManagerFeedback) {
    try {
      const scorable = await listScorableProbationers(access);
      scorableProbationers = scorable
        .filter((p) => !p.openDvDayId)
        .map((p) => ({
          employeeHrId: p.employeeHrId,
          employeeName: p.employeeName,
          evaluatorRoleLabel: EVALUATOR_ROLE_LABEL[p.evaluatorRole] ?? p.evaluatorRole,
          probationEndLabel: formatDateValue(p.probationEndDate),
          lineLabel: p.lineName ?? "Unassigned line",
          submittedCount: p.submittedCount,
          requiredCount: p.requiredCount,
        }));
    } catch {
      scorableProbationers = [];
    }
  }

  // Nothing to show — no scoped probationers, nothing to score, and not an analytics viewer.
  if (!hasTracker && feedbackTasks.length === 0 && scorableProbationers.length === 0 && !showAnalytics) {
    return (
      <EmployeePortalEmptyState
        message="No active probation records found for your current scope."
        title="Probation Tracker"
      />
    );
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
      <ProbationFeedbackTasksPanel tasks={feedbackTasks} />
      <ProbationScorecardLauncher probationers={scorableProbationers} />
      {hasTracker ? (
        <EmployeeProbationDashboard
          canExport={canExportProbation(access)}
          canSubmitManagerFeedback={canSubmitManagerFeedback}
          initialData={initialData!}
        />
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
