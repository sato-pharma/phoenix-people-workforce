import { PayrollPayslipsSection } from "@/components/employee-portal/dashboard/payroll-payslips-section";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { getPayslipPortalData } from "@/lib/employee-portal/service";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// One name for the page: the sidebar calls it "Payslips" under "Pay & Expenses", so the header does
// too — every state of the page, the unavailable one included, keeps the same header.
const PAGE_BADGE = "Pay & Expenses";
const PAGE_TITLE = "Payslips";
const PAGE_DESCRIPTION = "Your salary breakdown and every published payslip, month by month.";

export default async function EmployeePortalPayslipsPage() {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/payslips");
  }

  await assertPermission(access, "payslips", "read");

  let data = null;
  try {
    data = await getPayslipPortalData(access);
  } catch {
    data = null;
  }

  if (!data) {
    return (
      <EmployeePortalPageShell badge={PAGE_BADGE} description={PAGE_DESCRIPTION} title={PAGE_TITLE}>
        <EmployeePortalEmptyState
          message="Your payslips workspace is temporarily unavailable. Please try again in a moment."
          title="Payslips Unavailable"
        />
      </EmployeePortalPageShell>
    );
  }

  // The section is rendered directly (not through MedicalRepPayrollPage) so it can take the portal
  // surface — its header becomes a section toolbar under this page's own title. The profile check is
  // the same one MedicalRepPayrollPage makes, with the same words.
  return (
    <EmployeePortalPageShell badge={PAGE_BADGE} description={PAGE_DESCRIPTION} title={PAGE_TITLE}>
      {data.empty.profile ? (
        <EmployeePortalEmptyState
          message="Your employee profile is not linked yet. Please contact HR."
          title="Profile Not Linked"
        />
      ) : (
        <PayrollPayslipsSection data={data} surface="employee-portal" />
      )}
    </EmployeePortalPageShell>
  );
}
