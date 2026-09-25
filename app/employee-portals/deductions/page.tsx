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
import { getPortalDeductions } from "@/lib/deductions/portal.ts";
import { logPortalFailure } from "@/lib/observability/portal-logging";

export const dynamic = "force-dynamic";

// The sidebar's own words: "Deductions" under "Pay & Expenses". The unavailable state keeps the same
// header, so the page never loses its title when the data does not load.
const PAGE_BADGE = "Pay & Expenses";
const PAGE_TITLE = "Deductions";
const PAGE_DESCRIPTION = "Approved and finalized salary deductions recorded against you.";

type DeductionsPortalPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function DeductionsPortalPage(props: DeductionsPortalPageProps) {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/admin/deductions");
  }

  await assertPermission(access, "employee_profile", "read");
  const searchParams = await props.searchParams;
  const rawMonthKey = Array.isArray(searchParams.monthKey)
    ? searchParams.monthKey[0]
    : searchParams.monthKey;
  const monthKey = typeof rawMonthKey === "string" && rawMonthKey.trim()
    ? rawMonthKey.trim()
    : undefined;

  let data: Awaited<ReturnType<typeof getPortalDeductions>>;
  try {
    data = await getPortalDeductions({ access, monthKey });
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
        lines={data.lines}
        ownCompactHrId={compactDeductionsHrId(access.hrId ?? access.loginId)}
      />
    </EmployeePortalPageShell>
  );
}
