import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  formatCurrencyValue,
  formatDateValue,
} from "@/lib/i18n/format";
import type { SalaryRecord } from "@/lib/payroll/types";
import { cn, formatEmployeeDisplayName } from "@/lib/utils";

import { TableHeaderMenu } from "./table-header-menu";

type SalaryReportColumn = {
  asc: string;
  desc: string;
  key: string;
  label: string;
};

function formatEGP(value: number) {
  return formatCurrencyValue(value);
}

function formatPayrollDate(value: string | null | undefined) {
  return formatDateValue(value);
}

export function SalaryReportTable({
  columnFilters,
  columns,
  holds,
  onColumnFilterChange,
  onHoldChange,
  onSortChange,
  rows,
}: {
  columnFilters: Record<string, string>;
  columns: SalaryReportColumn[];
  holds: Set<string>;
  onColumnFilterChange: (key: string, value: string) => void;
  onHoldChange: (hrId: string, checked: boolean) => void;
  onSortChange: (sort: string) => void;
  rows: SalaryRecord[];
}) {
  return (
    <>
      <div className="overflow-x-auto rounded-2xl border border-[#E2E8F0] bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.75)]">
        <table className="w-full min-w-[1180px] text-left text-sm">
          <thead>
            <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-xs uppercase tracking-[0.12em] text-[#64748B]">
              {columns.map((column) => (
                <th className="sticky top-0 z-10 px-4 py-3 font-semibold" key={column.key}>
                  <TableHeaderMenu
                    filterValue={columnFilters[column.key] ?? ""}
                    label={column.label}
                    onFilterChange={(value) => onColumnFilterChange(column.key, value)}
                    onSortAsc={() => onSortChange(column.asc)}
                    onSortDesc={() => onSortChange(column.desc)}
                  />
                </th>
              ))}
              <th className="sticky top-0 z-10 px-4 py-3 font-semibold">
                <span className="text-xs uppercase tracking-[0.12em] text-text-secondary">Salary Status</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-sm text-text-secondary" colSpan={columns.length + 1}>
                  No salary rows match the current filters.
                </td>
              </tr>
            ) : (
              rows.slice(0, 250).map((record) => {
                const isOnHold = holds.has(record.hrId);
                return (
                  <tr
                    className={cn(
                      "transition-colors hover:bg-[#F8FAFC]",
                      isOnHold && "bg-red-50/70",
                    )}
                    key={record.id}
                  >
                    <td className="px-4 py-3 font-mono text-xs text-text-secondary">{record.hrId}</td>
                    <td className="px-4 py-3 font-medium text-text">{formatEmployeeDisplayName(record.fullName)}</td>
                    <td className="px-4 py-3 text-text-secondary">{formatPayrollDate(record.hireDate)}</td>
                    <td className="px-4 py-3 text-text-secondary">{record.line || "-"}</td>
                    <td className="px-4 py-3 text-text-secondary">{record.area || "-"}</td>
                    <td className="px-4 py-3 text-text-secondary">{record.jobTitle || "-"}</td>
                    <td className="px-4 py-3 font-mono font-semibold text-success">{formatEGP(record.totalAdditions)}</td>
                    <td className="px-4 py-3 font-mono font-semibold text-danger">
                      {formatEGP(record.totalDeductions - record.socialInsurance - record.employmentIncomeTax)}
                    </td>
                    <td className="px-4 py-3 font-mono font-bold text-text">{formatEGP(record.netSalary)}</td>
                    <td className="px-4 py-3 font-mono text-text-secondary">{formatEGP(record.firstPart)}</td>
                    <td className="px-4 py-3 font-mono text-text-secondary">{formatEGP(record.secondPart)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={isOnHold}
                          label={isOnHold ? "Remove hold" : "Put on hold"}
                          onChange={(checked) => onHoldChange(record.hrId, checked)}
                        />
                        {isOnHold && (
                          <Badge variant="danger">Hold</Badge>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {rows.length > 250 ? (
        <p className="mt-3 text-xs text-text-secondary">
          Showing first 250 rows. Use filters to narrow the report.
        </p>
      ) : null}
    </>
  );
}
