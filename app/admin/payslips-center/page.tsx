import Link from "next/link";
import { redirect } from "next/navigation";
import { FileImage, FileText } from "lucide-react";

import {
  AdminInsightChip,
  AdminPageHero,
  AdminStatCard,
  AdminTableShell,
  adminPanelClassName,
} from "@/components/admin/admin-design-system";
import { AppShell } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { canAccess, getPayrollScope } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getPayslipCenterEmployeeOptions, searchPayslipCenter } from "@/lib/payroll/payslip-center";
import { formatEmployeeDisplayName } from "@/lib/utils";

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

function periodLabel(month: number, year: number) {
  return new Intl.DateTimeFormat("en", { month: "short", year: "numeric" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

function payslipStatusTone(status: string) {
  return status === "approved" || status === "locked" ? "success" : "neutral";
}

export default async function AdminPayslipsCenterPage(
  props: AdminPayslipsCenterPageProps,
) {
  const access = await resolveAccessContextFromPage();
  if (getPayrollScope(access) !== "COMPANY") {
    redirect("/payslips");
  }
  if (!await canAccess(access, "payslips", "read")) {
    redirect("/employee-portals");
  }

  const searchParams = await props.searchParams;
  const [employeeOptions, data] = await Promise.all([
    getPayslipCenterEmployeeOptions(),
    searchPayslipCenter(searchParams.employee),
  ]);
  const latestNet = data.rows[0] ? formatMoney(data.rows[0].netSalary) : "-";
  const canExportPayslipImage = access.role === "Super Admin";
  const employeeSummary = data.employees[0]
    ? `${formatEmployeeDisplayName(data.employees[0].fullName)} - ${data.employees[0].jobTitle} - ${data.employees[0].line}`
    : "Matching payslip history";
  const payslipCenterReturnTo = data.query
    ? `/admin/payslips-center?employee=${encodeURIComponent(data.query)}`
    : "/admin/payslips-center";

  return (
    <AppShell navigationMode="admin">
      <div className="space-y-6">
        <AdminPageHero
          badges={
            <div className="flex flex-wrap gap-2">
              <AdminInsightChip>Payslips Center</AdminInsightChip>
              <AdminInsightChip tone="orange">Admin only</AdminInsightChip>
            </div>
          }
          description="Choose an employee from the admin dropdown and open their historical payslips across payroll batches."
          eyebrow="Payroll Operations"
          icon={<FileText className="h-3.5 w-3.5" />}
          title="Payslips Center"
        />

        <Card className={`${adminPanelClassName} p-5`}>
          <form action="/admin/payslips-center" className="grid gap-3 lg:grid-cols-[1fr_auto]">
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
                Employee
              </span>
              <select
                className="h-11 w-full rounded-xl border border-[#D8E0EA] bg-white px-3 text-sm font-semibold text-[#0F172A] outline-none transition focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/12"
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
            <p className="text-base font-black text-[#0F172A]">Choose an employee to start.</p>
            <p className="mt-2 text-sm text-[#64748B]">This admin center is separate from the employee portal payslip view.</p>
          </Card>
        ) : data.rows.length === 0 ? (
          <Card className={`${adminPanelClassName} p-8 text-center`}>
            <p className="text-base font-black text-[#0F172A]">No payslips found.</p>
            <p className="mt-2 text-sm text-[#64748B]">Try a different spelling, HR ID, or employee code.</p>
          </Card>
        ) : (
          <AdminTableShell description={employeeSummary} title="Employee Payslip History">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead>
                  <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-[10px] font-black uppercase tracking-[0.12em] text-[#64748B]">
                    {["Employee", "HR ID", "Period", "Line", "Gross", "Additions", "Deductions", "Net", "Status", "Action"].map((column) => (
                      <th className="px-3 py-3" key={column}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E2E8F0]">
                  {data.rows.map((row) => (
                    <tr className="transition hover:bg-[#FCFDFE]" key={`${row.batchId}-${row.recordId}`}>
                      <td className="px-3 py-3">
                        <p className="font-semibold text-[#0F172A]">{formatEmployeeDisplayName(row.fullName)}</p>
                        <p className="mt-1 text-xs text-[#64748B]">{row.jobTitle}</p>
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-[#64748B]">{row.hrId || row.employeeCode || "-"}</td>
                      <td className="px-3 py-3 font-semibold text-[#0F172A]">{periodLabel(row.month, row.year)}</td>
                      <td className="px-3 py-3 text-[#64748B]">{row.line}</td>
                      <td className="px-3 py-3 font-semibold text-[#0F172A]">{formatMoney(row.grossSalary)}</td>
                      <td className="px-3 py-3 text-emerald-700">{formatMoney(row.totalAdditions)}</td>
                      <td className="px-3 py-3 text-rose-700">{formatMoney(row.totalDeductions)}</td>
                      <td className="px-3 py-3 font-black text-[#0F172A]">{formatMoney(row.netSalary)}</td>
                      <td className="px-3 py-3">
                        <Badge variant={payslipStatusTone(row.status)}>{row.status}</Badge>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-2">
                          <Link
                            className="inline-flex h-9 items-center justify-center rounded-xl border border-[#D8E0EA] px-4 text-sm font-semibold text-[#0F172A] transition hover:bg-[#F8FAFC]"
                            href={`/api/payroll/${row.batchId}/payslips?employeeHrId=${encodeURIComponent(row.hrId || row.employeeCode)}&returnTo=${encodeURIComponent(payslipCenterReturnTo)}`}
                            target="_blank"
                          >
                            Open Payslip
                          </Link>
                          {canExportPayslipImage ? (
                            <Link
                              className="inline-flex h-9 items-center justify-center rounded-xl border border-[#FDBA74] bg-[#FFF7ED] px-4 text-sm font-semibold text-[#9A3412] transition hover:bg-[#FFEDD5]"
                              href={`/api/payroll/${row.batchId}/payslips/image?employeeHrId=${encodeURIComponent(row.hrId || row.employeeCode)}`}
                            >
                              <FileImage className="mr-2 h-4 w-4" />
                              Export Image
                            </Link>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </AdminTableShell>
        )}
      </div>
    </AppShell>
  );
}
