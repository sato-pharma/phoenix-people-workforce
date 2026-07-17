import { StructuredFeedbackForm } from "@/components/probation/structured-feedback-form";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { getProbationConfig } from "@/lib/probation/intelligence/config";
import { listFeedbackTasks } from "@/lib/probation/intelligence/feedback-workflow";

export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<string, string> = { dm: "DM", tm: "TM", pm_gpm: "PM/GPM", nsm: "NSM" };

// Structured DV-Day feedback capture page (module completion C1). Reachable from the manager feedback
// inbox. The caller may only open a DV-Day that is one of THEIR open, validated feedback tasks (or all,
// if a probation administrator) — listFeedbackTasks is the authorization gate, so a stale/other/already-
// submitted DV-Day simply won't resolve.
export default async function StructuredFeedbackPage({
  params,
}: {
  params: Promise<{ dvDayId: string }>;
}) {
  const access = await resolveAuthenticatedPageAccess();
  await assertPermission(access, "probation", "read");

  const { dvDayId } = await params;
  const backHref = "/employee-portals/probation";

  const [config, tasks] = await Promise.all([
    getProbationConfig(),
    listFeedbackTasks(access).catch(() => []),
  ]);
  const task = tasks.find((t) => t.dvDayId === dvDayId);

  if (!task) {
    return (
      <EmployeePortalEmptyState
        title="Feedback task unavailable"
        message="This Double-Visit feedback task is not open for you — it may already be submitted, reassigned, or outside your scope. Return to your feedback tasks to see what's pending."
      />
    );
  }

  // Resolve the employee's human name (never surface bare codes).
  let employeeName = task.employeeHrId;
  try {
    const { data } = await getSupabaseAdmin()
      .from("employees")
      .select("full_name, nickname")
      .ilike("hr_id", task.employeeHrId)
      .maybeSingle();
    const row = data as { full_name?: string | null; nickname?: string | null } | null;
    if (row?.full_name) employeeName = resolveEmployeeDisplayName(row.full_name, row.nickname ?? null);
  } catch {
    // fall back to the HR_ID if the directory lookup fails
  }

  return (
    <EmployeePortalPageShell
      badge="People Operations"
      description="Structured Double-Visit feedback — scorecard, narrative, and development actions."
      errorBoundaryTitle="Feedback form unavailable"
      title="Double-Visit Feedback"
    >
      <StructuredFeedbackForm
        dvDayId={task.dvDayId}
        employeeName={employeeName}
        dvDate={task.dvDate}
        visitCount={task.visitCount}
        evaluatorRoleLabel={task.evaluatorRole ? ROLE_LABEL[task.evaluatorRole] ?? task.evaluatorRole : null}
        dimensions={config.scorecardDimensions}
        scale={config.scoringScale}
        backHref={backHref}
      />
    </EmployeePortalPageShell>
  );
}
