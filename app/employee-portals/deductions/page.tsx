import { redirect } from "next/navigation";

import { DeductionsPortalWorkspace } from "@/components/employee-portal/deductions-workspace";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import {
  assertPermission,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key";
import { getPortalDeductionLedger } from "@/lib/deductions/portal.ts";
import { logPortalFailure } from "@/lib/observability/portal-logging";

export const dynamic = "force-dynamic";

// The sidebar's own words: "Deductions" under "Pay & Expenses". The unavailable state keeps the same
// header, so the page never loses its title when the data does not load.
//
// The description changed with the page on 2026-10-09: it is no longer only the finalized ones. It
// now lists EVERY deduction raised against the person from the September salary on, with HR's answer
// on each, and the three filters are in the workspace itself — so this page takes no searchParams.
const PAGE_BADGE = "Pay & Expenses";
const PAGE_TITLE = "Deductions";
const PAGE_DESCRIPTION = "Every deduction raised against you, and what HR decided on each one.";

export default async function DeductionsPortalPage() {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/admin/deductions");
  }

  await assertPermission(access, "employee_profile", "read");

  let data: Awaited<ReturnType<typeof getPortalDeductionLedger>>;
  try {
    data = await getPortalDeductionLedger({ access });
  } catch (error) {
    // The reason goes to the server log, not the screen: what this throws is a database error, and
    // its wording means nothing to the person reading the page.
    logPortalFailure(
      { route: "/employee-portals/deductions", module: "deductions", role: access.role, hrId: access.hrId },
      error,
    );
    return (
      <EmployeePortalPageShell badge={PAGE_BADGE} description={PAGE_DESCRIPTION} title={PAGE_TITLE}>
        <EmployeePortalEmptyState
          message="We could not load your deductions right now. Please try again in a moment."
          title="Deductions Unavailable"
        />
      </EmployeePortalPageShell>
    );
  }

  return (
    <EmployeePortalPageShell badge={PAGE_BADGE} description={PAGE_DESCRIPTION} title={PAGE_TITLE}>
      <DeductionsPortalWorkspace
        comments={data.comments}
        firstMonthKey={data.firstMonthKey}
        ownCompactHrId={compactDeductionsHrId(access.hrId ?? access.loginId)}
        rows={data.rows}
      />
    </EmployeePortalPageShell>
  );
}
