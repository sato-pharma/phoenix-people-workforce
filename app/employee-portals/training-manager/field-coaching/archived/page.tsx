import { redirect } from "next/navigation";

import { CoachingArchivedList } from "@/components/coaching/coaching-archived-list";
import {
  EmployeePortalActionBar,
  EmployeePortalActionLink,
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listArchivedCoachingEvaluations, type CoachingArchivedEvaluationRow } from "@/lib/coaching/archived";

export const dynamic = "force-dynamic";

const fieldCoachingHref = "/employee-portals/training-manager/field-coaching";

// The resigned reps' evaluations, kept verbatim at import, for the Training Manager's reference
// (owner, 2026-10-24: her predecessor's historical work is shown to her). The archive is read with the
// service-role client and carries no scope of its own, so this page is the gate: a portal Training
// Manager with coaching read, the same seat the Field Coaching list admits.
export default async function TrainingManagerArchivedCoachingPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/coaching/archived");
  }
  if (access.role !== "Training Manager") {
    redirect("/employee-portals");
  }

  if (!(await canAccess(access, "coaching", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="Your account is not authorized to view archived coaching evaluations."
        title="Coaching Access Unavailable"
      />
    );
  }

  let rows: CoachingArchivedEvaluationRow[] = [];
  try {
    rows = await listArchivedCoachingEvaluations({});
  } catch {
    return (
      <EmployeePortalEmptyState
        message="Unable to load the archived coaching evaluations. Please try again later."
        title="Archived Evaluations Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Coaching"
      description="Field coaching evaluations for reps who have resigned, or could not be matched at import, preserved verbatim so the coach's scoring and written notes are never lost."
      title="Resigned Coaching Evaluations"
    >
      <EmployeePortalActionBar
        actions={<EmployeePortalActionLink href={fieldCoachingHref} label="Back to Field Coaching" />}
      />
      <CoachingArchivedList rows={rows} />
    </EmployeePortalPageShell>
  );
}
