"use client";

import { Fragment, useState } from "react";

import {
  EmployeeRowActions,
  SEVERITY_STYLES,
  egp,
  formatShortDate,
  type EmployeeRow,
  type EmployeeStatus,
} from "../payroll-copilot-workbench";

const STATUS_META: Record<EmployeeStatus, { label: string; className: string }> = {
  green: { label: "Green", className: "bg-emerald-100 text-emerald-700" },
  answered: { label: "Answered", className: "bg-sky-100 text-sky-700" },
  question: { label: "Question", className: "bg-amber-100 text-amber-700" },
  hold: { label: "On Hold", className: "bg-rose-100 text-rose-700" },
};

const STATUS_FILTERS: Array<{ key: "all" | EmployeeStatus; label: string }> = [
  { key: "all", label: "All" },
  { key: "question", label: "Questions" },
  { key: "hold", label: "On Hold" },
  { key: "answered", label: "Answered" },
  { key: "green", label: "Green" },
];

/**
 * Same column set and order as the real payroll sheet
 * (src/lib/payroll/salary-import.ts's payrollSheetHeaders / the upload
 * template), minus the boilerplate row-number/Month/Year/Arabic Name/
 * Gross Salary/Overtime/Bonus/governmental-tax columns and the trailing
 * Policy Comment — those aren't reviewed here. Width is a percentage of the
 * table so every column stays visible without wrapping or ellipsis; a
 * column that's still too narrow for its header clips silently at the edge
 * (acceptable per this app's no-truncation policy) rather than wrapping.
 */
const MONEY_COLUMNS: Array<{ key: keyof EmployeeRow; header: string; width: string }> = [
  { key: "baseSalary", header: "Base Salary", width: "3%" },
  { key: "netSalary", header: "Net Salary", width: "3%" },
  { key: "expenses", header: "Expenses", width: "2%" },
  { key: "incentive", header: "Incentive", width: "2%" },
  { key: "extraCostOfLiving", header: "Extra Cost of Living", width: "4%" },
  { key: "fuelAllowance", header: "Fuel Allowance", width: "3%" },
  { key: "otherAdditions", header: "Other Additions", width: "3%" },
  { key: "totalAdditions", header: "Total Additions", width: "3%" },
  { key: "crm", header: "CRM", width: "2%" },
  { key: "fingerPrint", header: "Finger Print", width: "3%" },
  { key: "unpaidVacations", header: "Unpaid Vacations", width: "4%" },
  { key: "medicalInsurance", header: "Medical Insurance", width: "4%" },
  { key: "loans", header: "Loans", width: "2%" },
  { key: "otherDeductions", header: "Other Deductions", width: "3%" },
  { key: "totalDeductions", header: "Total Deductions", width: "3%" },
  { key: "monthSalary", header: "Month Salary", width: "3%" },
  { key: "firstPart", header: "First Part", width: "3%" },
  { key: "secondPart", header: "Second Part", width: "3%" },
];

// 6 identity columns + money columns + 3 trailing (Payment Group/Status/Actions)
const COLUMN_COUNT = 6 + MONEY_COLUMNS.length + 3;

/**
 * A faithful mirror of the real post-upload payroll sheet's full column set
 * (src/lib/payroll/salary-import.ts), computed live from the current draft,
 * before "Generate payroll sheet" is ever clicked — every addition and
 * deduction line item broken out individually (not just the two totals), so
 * it reads exactly like the sheet the CEO already reviews every month. Same
 * row actions and 2-row question layout as Negotiation, so it can be
 * resolved from here too.
 */
export function PayrollPreviewTab({
  employees,
  groupedHrIds,
  busy,
  onConfirmEmployee,
  onReportIssue,
  onHoldEmployee,
}: {
  employees: EmployeeRow[];
  groupedHrIds: Set<string>;
  busy: boolean;
  onConfirmEmployee: (hrId: string) => void;
  onReportIssue: (hrId: string, text: string) => void;
  onHoldEmployee: (hrId: string, reason: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | EmployeeStatus>("all");

  const normalizedQuery = query.trim().toLowerCase();
  const rows = employees.filter((employee) => {
    if (statusFilter !== "all" && employee.status !== statusFilter) return false;
    if (!normalizedQuery) return true;
    return (
      employee.fullName.toLowerCase().includes(normalizedQuery) ||
      employee.hrId.toLowerCase().includes(normalizedQuery)
    );
  });

  return (
    <div className="border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-900 px-4 py-2">
        <span className="flex items-center gap-2 text-sm font-semibold text-white">
          <span aria-hidden="true" className="h-4 w-1 shrink-0 bg-gradient-to-b from-orange-500 to-amber-400" />
          Payroll Preview ({employees.length}) — mirrors the real payroll sheet
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name or HR ID…"
            className="w-48 border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 placeholder:text-slate-400"
          />
          <div className="flex overflow-hidden border border-slate-600 text-xs font-semibold">
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter.key}
                type="button"
                onClick={() => setStatusFilter(filter.key)}
                className={`px-2 py-1 ${
                  statusFilter === filter.key
                    ? "bg-gradient-to-r from-orange-600 to-orange-500 text-white"
                    : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className="border-b border-slate-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
        This is a live preview computed from the current draft — it updates as you resolve questions across every
        tab. It is not the final sheet until you click &quot;Generate payroll sheet.&quot;
      </p>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-slate-500">
          {employees.length === 0 ? "No employees in this draft." : "No employees match this search/filter."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full table-fixed text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-[10px] uppercase tracking-wide text-slate-500">
                <th className="w-[3%] overflow-hidden whitespace-nowrap px-1 py-2" title="HR ID">
                  HR ID
                </th>
                <th className="w-[5%] overflow-hidden whitespace-nowrap px-1 py-2" title="Full Name">
                  Full Name
                </th>
                <th className="w-[3%] overflow-hidden whitespace-nowrap px-1 py-2" title="Job Title">
                  Job Title
                </th>
                <th className="w-[3%] overflow-hidden whitespace-nowrap px-1 py-2" title="Line">
                  Line
                </th>
                <th className="w-[4%] overflow-hidden whitespace-nowrap px-1 py-2" title="Area">
                  Area
                </th>
                <th className="w-[4%] overflow-hidden whitespace-nowrap px-1 py-2" title="Hire Date">
                  Hire Date
                </th>
                {MONEY_COLUMNS.map((column) => (
                  <th
                    key={column.key}
                    className="overflow-hidden whitespace-nowrap px-1 py-2"
                    style={{ width: column.width }}
                    title={column.header}
                  >
                    {column.header}
                  </th>
                ))}
                <th className="w-[4%] overflow-hidden whitespace-nowrap px-1 py-2" title="Payment Group">
                  Payment Group
                </th>
                <th className="w-[3%] overflow-hidden whitespace-nowrap px-1 py-2" title="Status">
                  Status
                </th>
                <th className="w-[18%] overflow-hidden whitespace-nowrap px-1 py-2" title="Actions">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((employee) => {
                const meta = STATUS_META[employee.status];
                return (
                  <Fragment key={employee.hrId}>
                    <tr className="hover:bg-slate-50">
                      <td className="overflow-hidden whitespace-nowrap px-1 py-2 font-mono text-[11px] text-slate-500">
                        {employee.hrId}
                      </td>
                      <td className="overflow-hidden whitespace-nowrap px-1 py-2 font-medium text-slate-900">
                        {employee.fullName}
                        {groupedHrIds.has(employee.hrId) ? (
                          <span className="ml-1 bg-slate-100 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                            Grouped
                          </span>
                        ) : null}
                      </td>
                      <td className="overflow-hidden whitespace-nowrap px-1 py-2 text-slate-600">
                        {employee.jobTitle || "—"}
                      </td>
                      <td className="overflow-hidden whitespace-nowrap px-1 py-2 text-slate-600">
                        {employee.line || "—"}
                      </td>
                      <td className="overflow-hidden whitespace-nowrap px-1 py-2 text-slate-600">
                        {employee.area || "—"}
                      </td>
                      <td className="overflow-hidden whitespace-nowrap px-1 py-2 text-slate-600">
                        {formatShortDate(employee.hireDate)}
                      </td>
                      {MONEY_COLUMNS.map((column) => (
                        <td
                          key={column.key}
                          className="overflow-hidden whitespace-nowrap px-1 py-2 font-mono text-[11px] text-slate-700"
                        >
                          {egp(employee[column.key] as number)}
                        </td>
                      ))}
                      <td className="overflow-hidden whitespace-nowrap px-1 py-2 text-slate-600">
                        {employee.paymentGroup}
                      </td>
                      <td className="px-1 py-2">
                        <span className={`px-1 py-0.5 text-[10px] font-semibold ${meta.className}`}>
                          {meta.label}
                        </span>
                      </td>
                      <td className="px-1 py-2">
                        <EmployeeRowActions
                          busy={busy}
                          onConfirm={() => onConfirmEmployee(employee.hrId)}
                          onReportIssue={(text) => onReportIssue(employee.hrId, text)}
                          onHold={(reason) => onHoldEmployee(employee.hrId, reason)}
                        />
                      </td>
                    </tr>
                    {employee.status === "question" ? (
                      <tr className="bg-amber-50/40">
                        <td className="px-1.5 py-2" colSpan={COLUMN_COUNT}>
                          {employee.flags.map((flag) => (
                            <p
                              key={flag.rule}
                              className={`border-l-4 pl-2 text-sm text-slate-700 ${SEVERITY_STYLES[flag.severity]}`}
                            >
                              {flag.question}
                            </p>
                          ))}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
