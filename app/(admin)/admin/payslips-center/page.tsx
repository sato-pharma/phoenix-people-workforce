import { redirect } from "next/navigation";
import { FileText } from "lucide-react";

import {
  AdminInsightChip,
  AdminPageHero,
  AdminStatCard,
  AdminTableShell,
  adminPanelClassName,
} from "@/components/admin/admin-design-system";
// The payslip history moved into this client component on 2026-09-01 so it can be cards on a phone
// and a table from `md` up — see its header. This page became reachable from the HR sidebar that
// day, and the HR shell is used on a phone.
import { PayslipsCenterRows } from "@/components/payroll/payslips-center-rows";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { canAccess } from "@/lib/auth/permissions";
import { canExportPayslipDocument } from "@/lib/payroll/payslip-center";
import { guardSeatPage } from "@/lib/auth/seat-page-guard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getPayslipCenterEmployeeOptions, resolvePayslipCenterAudience, searchPayslipCenter } from "@/lib/payroll/payslip-center";
import { formatEmployeeDisplayName } from "@/lib/utils";
import { phxSelectClassName } from "@/components/ui/form-tokens";

export const dynamic = "force-dynamic";

type AdminPayslipsCenterPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-EG", {
    currency: "EGP",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(value);
}


export default async function AdminPayslipsCenterPage(
  props: AdminPayslipsCenterPageProps,
) {
  const access = await resolveAccessContextFromPage();
  guardSeatPage(access, "/admin/payslips-center");
  // The audience, not a scope literal. Company-scope payroll roles resolve to "company" exactly as
  // before; the HR Business Partner resolves to the two job titles the owner named on 2026-09-01
  // (District Sales Managers, Medical Representatives) plus her own record. A viewer with neither
  // still lands on their own payslip. Resolved by the domain module so this page and the data
  // functions can never disagree about who is being served.
  const audience = resolvePayslipCenterAudience(access);
  if (!audience) {
    redirect("/payslips");
  }
  if (!await canAccess(access, "payslips", "read")) {
    redirect("/employee-portals");
  }

  const searchParams = await props.searchParams;
  const [employeeOptions, data] = await Promise.all([
    getPayslipCenterEmployeeOptions(access),
    searchPayslipCenter(access, searchParams.employee),
  ]);
  const latestNet = data.rows[0] ? formatMoney(data.rows[0].netSalary) : "-";
  // Same predicate the API route enforces — never a second role literal. The button and its route
  // must agree, and the CEO deliberately fails both while still reading this page.
  const canExportPayslipImage = canExportPayslipDocument(access);
  const employeeSummary = data.employees[0]
    ? `${formatEmployeeDisplayName(data.employees[0].fullName)} - ${data.employees[0].jobTitle} - ${data.employees[0].line}`
    : "Matching payslip history";

  return (
    <div className="space-y-6">
      <AdminPageHero
          badges={
            <div className="flex flex-wrap gap-2">
              <AdminInsightChip>Payslips Center</AdminInsightChip>
              <AdminInsightChip tone="orange">Admin only</AdminInsightChip>
              {audience.kind === "job-titles" ? (
                <AdminInsightChip>District Sales Managers, Medical Representatives and you</AdminInsightChip>
              ) : null}
            </div>
          }
          description={
            audience.kind === "job-titles"
              ? "Choose a District Sales Manager or Medical Representative — or yourself — and open their historical payslips across payroll batches. Other job titles are not part of your access, so they do not appear in the list."
              : "Choose an employee from the admin dropdown and open their historical payslips across payroll batches."
          }
          eyebrow="Payroll Operations"
          icon={<FileText className="h-3.5 w-3.5" />}
          title="Payslips Center"
        />

        <Card className={`${adminPanelClassName} p-5`}>
          <form action="/admin/payslips-center" className="grid gap-3 lg:grid-cols-[1fr_auto]">
            <label className="block">
              <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
                Employee
              </span>
              <select
                className={phxSelectClassName}
                defaultValue={data.query}
                name="employee"
              >
                <option value="">Select employee...</option>
                {employeeOptions.map((employee) => (
                  <option key={employee.value} value={employee.value}>
                    {employee.label}
                  </option>
                ))}
              </select>
            </label>
            <Button className="h-11 rounded-xl px-6" type="submit">
              Show Payslips
            </Button>
          </form>
        </Card>

        <div className="grid gap-3 md:grid-cols-3">
          <AdminStatCard description="Employees matching your search" icon={<FileText className="h-5 w-5" />} label="Employees" value={data.employees.length} />
          <AdminStatCard description="Historical payslip records found" icon={<FileText className="h-5 w-5" />} label="Payslips" value={data.rows.length} />
          <AdminStatCard description="Latest net salary in result" icon={<FileText className="h-5 w-5" />} label="Latest Net" value={latestNet} />
        </div>

        {!data.query ? (
          <Card className={`${adminPanelClassName} p-8 text-center`}>
            <p className="text-base font-black text-phx-ink">Choose an employee to start.</p>
            <p className="mt-2 text-sm text-phx-ink-soft">This admin center is separate from the employee portal payslip view.</p>
            {audience.kind === "job-titles" ? (
              <p className="mt-2 text-sm text-phx-ink-soft">
                The list holds District Sales Managers and Medical Representatives, plus your own
                payslips once your first one is published.
              </p>
            ) : null}
          </Card>
        ) : data.rows.length === 0 ? (
          <Card className={`${adminPanelClassName} p-8 text-center`}>
            <p className="text-base font-black text-phx-ink">No payslips found.</p>
            <p className="mt-2 text-sm text-phx-ink-soft">Try a different spelling, HR ID, or employee code.</p>
          </Card>
        ) : (
          <AdminTableShell description={employeeSummary} title="Employee Payslip History">
            <PayslipsCenterRows canExportPayslipImage={canExportPayslipImage} rows={data.rows} />
          </AdminTableShell>
        )}
    </div>
  );
}
