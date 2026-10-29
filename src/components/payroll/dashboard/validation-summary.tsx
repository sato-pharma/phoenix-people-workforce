import { PortalDesktopTable, PortalResponsiveDataList } from "@/components/employee-portal/portal-primitives";
import { humanizeCode } from "@/lib/format/code-label";
import { AlertTriangle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatCurrencyValue } from "@/lib/i18n/format";
import type { PayrollPeriodConflict } from "@/lib/payroll/types";

import { panelClassName, payrollPeriodLabel } from "./shared";

export type SalaryValidationIssue = {
  code: string;
  column?: string;
  hrId?: string;
  message: string;
  row: number;
};

export type SalaryValidationTotals = {
  baseSalary: number;
  bonus: number;
  crm: number;
  employmentIncomeTax: number;
  expenses: number;
  extraCostOfLiving: number;
  fingerPrint: number;
  firstPart: number;
  fuelAllowance: number;
  governmentalDeductions: number;
  grossSalary: number;
  incentive: number;
  loans: number;
  medicalInsurance: number;
  monthSalary: number;
  netSalary: number;
  otherAdditions: number;
  otherDeductions: number;
  overtime: number;
  secondPart: number;
  socialInsurance: number;
  totalAdditions: number;
  totalDeductions: number;
  unpaidVacations: number;
};

export type SalaryValidationResult = {
  detectedColumns: string[];
  duplicateHrIds: string[];
  failedRows: number;
  missingRequiredColumns: string[];
  payrollPeriod: {
    month: number;
    year: number;
  };
  payrollResignationCandidates?: Array<{
    area: string | null;
    fullName: string;
    hireDate: string | null;
    hrId: string;
    jobTitle: string | null;
    lastPayoutMonth: number;
    lastPayoutYear: number;
    line: string | null;
    nameAr: string | null;
    row: number;
  }>;
  periodConflict?: PayrollPeriodConflict;
  rowsToImport: Array<{
    area: string;
    hrId: string;
    fullName: string;
    jobTitle: string;
    line: string;
    monthSalary: number;
    row: number;
  }>;
  totalRows: number;
  validRows: number;
  validationErrors: SalaryValidationIssue[];
  validationTotals: SalaryValidationTotals;
  validationWarnings: SalaryValidationIssue[];
  warningRows: number;
};

function formatEGP(value: number) {
  return formatCurrencyValue(value);
}

export function ValidationSummary({ result }: { result: SalaryValidationResult }) {
  const resignationAlarms = result.validationWarnings.filter(
    (issue) => issue.code === "employee_not_found",
  );
  const payrollWarnings = result.validationWarnings.filter(
    (issue) => issue.code !== "employee_not_found",
  );
  const resignationCandidates = result.payrollResignationCandidates ?? [];
  const resignationAlarmCount =
    resignationCandidates.length ||
    new Set(resignationAlarms.map((issue) => issue.hrId ?? `${issue.row}`)).size;
  const resignationPreview = (
    resignationCandidates.length > 0
      ? resignationCandidates.map((candidate) => ({
          fullName: candidate.fullName,
          hrId: candidate.hrId,
          row: candidate.row,
        }))
      : resignationAlarms.map((issue) => ({
          fullName: "Missing employee",
          hrId: issue.hrId ?? "-",
          row: issue.row,
        }))
  ).slice(0, 8);
  const payrollWarningRows = new Set(payrollWarnings.map((issue) => issue.row)).size;
  const issuePreview = [
    ...result.validationErrors.map((issue) => ({ ...issue, severity: "error" })),
    ...payrollWarnings.map((issue) => ({
      ...issue,
      severity: "warning",
    })),
  ].slice(0, 12);
  const totalSections = [
    {
      items: [
        ["Base Salary", result.validationTotals.baseSalary],
        ["Gross Salary", result.validationTotals.grossSalary],
        ["Net Salary", result.validationTotals.netSalary],
        ["Month Salary", result.validationTotals.monthSalary],
        ["First Part", result.validationTotals.firstPart],
        ["Second Part", result.validationTotals.secondPart],
      ],
      title: "Salary Totals",
    },
    {
      items: [
        ["Expenses", result.validationTotals.expenses],
        ["Incentive", result.validationTotals.incentive],
        ["Overtime", result.validationTotals.overtime],
        ["Bonus", result.validationTotals.bonus],
        ["Extra Cost of Living", result.validationTotals.extraCostOfLiving],
        ["Fuel Allowance", result.validationTotals.fuelAllowance],
        ["Other Additions", result.validationTotals.otherAdditions],
        ["Total Additions", result.validationTotals.totalAdditions],
      ],
      title: "Additions Totals",
    },
    {
      items: [
        ["Social Insurance", result.validationTotals.socialInsurance],
        ["Employment Income Tax", result.validationTotals.employmentIncomeTax],
        ["Governmental Deductions", result.validationTotals.governmentalDeductions],
        ["CRM", result.validationTotals.crm],
        ["Finger Print", result.validationTotals.fingerPrint],
        ["Unpaid Vacations", result.validationTotals.unpaidVacations],
        ["Medical Insurance", result.validationTotals.medicalInsurance],
        ["Loans", result.validationTotals.loans],
        ["Other Deductions", result.validationTotals.otherDeductions],
        ["Total Deductions", result.validationTotals.totalDeductions],
      ],
      title: "Deductions Totals",
    },
  ] as const;

  return (
    <Card className={`${panelClassName} p-5`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-phx-ink">
            Salary Upload Validation
          </h2>
          <p className="mt-1 text-sm text-phx-ink-soft">
            {payrollPeriodLabel(
              result.payrollPeriod.month,
              result.payrollPeriod.year,
            )}{" "}
            was checked before import.
          </p>
        </div>
        <Badge variant={result.failedRows === 0 ? "success" : "danger"}>
          {result.failedRows === 0 ? "Ready" : "Needs fixes"}
        </Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-5">
        {[
          ["Rows", result.totalRows],
          ["Valid", result.validRows],
          ["Alarms", resignationAlarmCount],
          ["Warnings", payrollWarningRows],
          ["Failed", result.failedRows],
        ].map(([label, value]) => (
          <div className="border border-phx-line bg-[#FCFDFE] p-4" key={label}>
            <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-phx-ink-soft">{label}</p>
            <p className="mt-2 text-2xl font-black tracking-[-0.03em] text-phx-ink">{value}</p>
          </div>
        ))}
      </div>

      {resignationAlarmCount > 0 && (
        <div className="mt-4 border border-phx-accent-line bg-phx-accent-soft p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#FFEDD5] text-phx-accent-press">
              <AlertTriangle className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-black text-[#9A3412]">
                Resignation alarm: {resignationAlarmCount} employees may have resigned and are not in the employee directory.
              </p>
              <p className="mt-1 text-sm text-[#9A3412]">
                These rows stay inside payroll import and totals, and they are sent to the resignation report.
              </p>
              {resignationPreview.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {resignationPreview.map((candidate) => (
                    <span
                      className="rounded-full border border-[#FED7AA] bg-white px-3 py-1 text-xs font-semibold text-[#9A3412]"
                      key={`${candidate.row}-${candidate.hrId}`}
                    >
                      {candidate.fullName}
                    </span>
                  ))}
                  {resignationAlarmCount > resignationPreview.length && (
                    <span className="rounded-full border border-[#FED7AA] bg-white px-3 py-1 text-xs font-semibold text-[#9A3412]">
                      +{resignationAlarmCount - resignationPreview.length} more
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="mt-4 overflow-hidden border border-phx-line">
        <div className="border-b border-phx-line bg-phx-paper px-4 py-3">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-phx-ink-soft">
            Validation Totals
          </p>
          <p className="mt-1 text-xs text-phx-ink-soft">
            Calculated from all importable payroll rows. Missing-directory HR IDs remain included.
          </p>
        </div>
        <div className="grid divide-y divide-phx-line lg:grid-cols-3 lg:divide-x lg:divide-y-0">
          {totalSections.map((section) => (
            <div className="p-4" key={section.title}>
              <p className="mb-3 text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink">
                {section.title}
              </p>
              <dl className="space-y-2">
                {section.items.map(([label, value]) => (
                  <div className="flex items-center justify-between gap-3 text-sm" key={label}>
                    <dt className="text-phx-ink-soft">{label}</dt>
                    <dd className="font-mono font-semibold text-phx-ink">{formatEGP(value)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </div>

      {result.missingRequiredColumns.length > 0 && (
        <div className="mt-4 rounded-[20px] border border-[#FCA5A5] bg-[#FEF2F2] p-4 text-sm text-[#B91C1C]">
          Missing headers: {result.missingRequiredColumns.join(", ")}
        </div>
      )}

      {result.duplicateHrIds.length > 0 && (
        <div className="mt-4 rounded-[20px] border border-[#FCA5A5] bg-[#FEF2F2] p-4 text-sm text-[#B91C1C]">
          Duplicate HR_IDs: {result.duplicateHrIds.join(", ")}
        </div>
      )}

      <div className="mt-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-text-secondary">
          Detected Columns
        </p>
        <div className="flex flex-wrap gap-2">
          {result.detectedColumns.map((column) => (
            <Badge key={column} variant="neutral">
              {column}
            </Badge>
          ))}
        </div>
      </div>

      {issuePreview.length > 0 && (
        <div className="mt-4 overflow-hidden border border-phx-line">
          <PortalResponsiveDataList
            empty={null}
            getKey={(issue, index) => `${issue.row}-${issue.code}-${index}`}
            items={issuePreview}
            renderCard={(issue) => (
              <div className="space-y-1 px-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-mono text-xs text-phx-ink-soft">
                    Row {issue.row} · HR ID {issue.hrId ?? "—"} · {issue.column ?? "—"}
                  </p>
                  <Badge variant={issue.severity === "error" ? "danger" : "warning"}>{humanizeCode(issue.code)}</Badge>
                </div>
                <p className="break-words text-sm text-phx-ink">{issue.message}</p>
              </div>
            )}
            renderTable={() => (
              <PortalDesktopTable
                cols={
                  <colgroup>
                    <col className="w-[8%]" />
                    <col className="w-[12%]" />
                    <col className="w-[16%]" />
                    <col className="w-[18%]" />
                    <col className="w-[46%]" />
                  </colgroup>
                }
              >
                <thead>
                  <tr className="border-b border-phx-line bg-phx-paper">
                    {["Row", "HR ID", "Column", "Type", "Message"].map((column) => (
                      <th className="px-3 py-3 font-medium text-phx-ink-soft" key={column}>
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {issuePreview.map((issue, index) => (
                    <tr key={`${issue.row}-${issue.code}-${index}`}>
                      <td className="break-words px-3 py-3 font-mono text-xs text-phx-ink-soft">{issue.row}</td>
                      <td className="break-words px-3 py-3 font-mono text-xs text-phx-ink-soft">{issue.hrId ?? "—"}</td>
                      <td className="break-words px-3 py-3 text-phx-ink-soft">{issue.column ?? "—"}</td>
                      <td className="px-3 py-3">
                        <Badge variant={issue.severity === "error" ? "danger" : "warning"}>
                          {humanizeCode(issue.code)}
                        </Badge>
                      </td>
                      <td className="break-words px-3 py-3 text-phx-ink">{issue.message}</td>
                    </tr>
                  ))}
                </tbody>
              </PortalDesktopTable>
            )}
          />
        </div>
      )}
    </Card>
  );
}
