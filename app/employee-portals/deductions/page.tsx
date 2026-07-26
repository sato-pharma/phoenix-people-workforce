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
import { compactDeductionHrId } from "@/lib/deductions-governance/service";
import { getPortalDeductions } from "@/lib/deductions/portal.ts";

export const dynamic = "force-dynamic";

type DeductionsPortalPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function DeductionsPortalPage(props: DeductionsPortalPageProps) {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/admin/deductions-governance");
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
    return (
      <EmployeePortalEmptyState
        message={
          error instanceof Error
            ? error.message
            : "Unable to load published deductions."
        }
        title="Deductions Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Payroll Governance"
      description="Approved and finalized salary deductions visible to you and, when applicable, your reporting line."
      title="Deductions"
    >
      <DeductionsPortalWorkspace
        comments={data.comments}
        lines={data.lines}
        ownCompactHrId={compactDeductionHrId(access.hrId ?? access.loginId)}
      />
    </EmployeePortalPageShell>
  );
}
