import { PortalDesktopTable, PortalResponsiveDataList } from "@/components/employee-portal/portal-primitives";
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
  const column = (key: string) => columns.find((candidate) => candidate.key === key);
  const headerMenu = (key: string) => {
    const found = column(key);
    if (!found) return null;
    return (
      <TableHeaderMenu
        filterValue={columnFilters[found.key] ?? ""}
        label={found.label}
        onFilterChange={(value) => onColumnFilterChange(found.key, value)}
        onSortAsc={() => onSortChange(found.asc)}
        onSortDesc={() => onSortChange(found.desc)}
      />
    );
  };
  const headerCell = (keys: string[], width: string) => (
    <th className={cn("px-3 py-3 align-top font-semibold", width)} key={keys.join("-")}>
      <div className="space-y-1">{keys.map((key) => <div key={key}>{headerMenu(key)}</div>)}</div>
    </th>
  );
  const holdControl = (record: SalaryRecord, isOnHold: boolean) => (
    <div className="flex flex-wrap items-center gap-2">
      <Switch
        checked={isOnHold}
        label={isOnHold ? "Remove hold" : "Put on hold"}
        onChange={(checked) => onHoldChange(record.hrId, checked)}
      />
      {isOnHold && <Badge variant="danger">Hold</Badge>}
    </div>
  );
  const otherDeductions = (record: SalaryRecord) =>
    formatEGP(record.totalDeductions - record.socialInsurance - record.employmentIncomeTax);
  const shown = rows.slice(0, 250);

  return (
    <>
      <div className="border border-phx-line bg-white">
        <PortalResponsiveDataList
          empty={
            <p className="px-4 py-8 text-center text-sm text-text-secondary">No salary rows match the current filters.</p>
          }
          getKey={(record) => record.id}
          items={shown}
          renderCard={(record) => {
            const isOnHold = holds.has(record.hrId);
            return (
              <div className={cn("space-y-2 px-4 py-3", isOnHold && "bg-red-50/70")}>
                <div>
                  <p className="break-words font-medium text-text">{formatEmployeeDisplayName(record.fullName)}</p>
                  <p className="break-words text-xs text-text-secondary">
                    {[record.jobTitle, record.line, record.area].filter(Boolean).join(" · ") || "—"}
                  </p>
                  <p className="text-xs text-text-secondary">Hired {formatPayrollDate(record.hireDate)}</p>
                </div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                  <dt className="text-text-secondary">Additions</dt>
                  <dd className="break-words text-right font-mono font-semibold text-success">{formatEGP(record.totalAdditions)}</dd>
                  <dt className="text-text-secondary">Other deductions</dt>
                  <dd className="break-words text-right font-mono font-semibold text-danger">{otherDeductions(record)}</dd>
                  <dt className="text-text-secondary">Net</dt>
                  <dd className="break-words text-right font-mono font-bold text-text">{formatEGP(record.netSalary)}</dd>
                  <dt className="text-text-secondary">First part</dt>
                  <dd className="break-words text-right font-mono text-text-secondary">{formatEGP(record.firstPart)}</dd>
                  <dt className="text-text-secondary">Second part</dt>
                  <dd className="break-words text-right font-mono text-text-secondary">{formatEGP(record.secondPart)}</dd>
                </dl>
                {holdControl(record, isOnHold)}
              </div>
            );
          }}
          renderTable={() => (
            <PortalDesktopTable
              cols={
                <colgroup>
                  <col className="w-[20%]" />
                  <col className="w-[11%]" />
                  <col className="w-[14%]" />
                  <col className="w-[11%]" />
                  <col className="w-[11%]" />
                  <col className="w-[11%]" />
                  <col className="w-[12%]" />
                  <col className="w-[10%]" />
                </colgroup>
              }
            >
              <thead>
                <tr className="border-b border-phx-line bg-phx-paper text-xs uppercase tracking-[0.12em] text-phx-ink-soft">
                  {headerCell(["fullName", "jobTitle"], "")}
                  {headerCell(["hireDate"], "")}
                  {headerCell(["line", "area"], "")}
                  {headerCell(["totalAdditions"], "")}
                  {headerCell(["otherDeductions"], "")}
                  {headerCell(["netSalary"], "")}
                  {headerCell(["firstPart", "secondPart"], "")}
                  <th className="px-3 py-3 align-top font-semibold">
                    <span className="text-xs uppercase tracking-[0.12em] text-text-secondary">Salary Status</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.map((record) => {
                  const isOnHold = holds.has(record.hrId);
                  return (
                    <tr className={cn("transition-colors hover:bg-phx-paper", isOnHold && "bg-red-50/70")} key={record.id}>
                      <td className="break-words px-3 py-3">
                        <p className="font-medium text-text">{formatEmployeeDisplayName(record.fullName)}</p>
                        <p className="text-xs text-text-secondary">{record.jobTitle || "—"}</p>
                      </td>
                      <td className="break-words px-3 py-3 text-text-secondary">{formatPayrollDate(record.hireDate)}</td>
                      <td className="break-words px-3 py-3 text-text-secondary">
                        <p>{record.line || "—"}</p>
                        <p className="text-xs">{record.area || "—"}</p>
                      </td>
                      <td className="break-words px-3 py-3 font-mono font-semibold text-success">{formatEGP(record.totalAdditions)}</td>
                      <td className="break-words px-3 py-3 font-mono font-semibold text-danger">{otherDeductions(record)}</td>
                      <td className="break-words px-3 py-3 font-mono font-bold text-text">{formatEGP(record.netSalary)}</td>
                      <td className="break-words px-3 py-3 font-mono text-text-secondary">
                        <p>{formatEGP(record.firstPart)}</p>
                        <p>{formatEGP(record.secondPart)}</p>
                      </td>
                      <td className="px-3 py-3">{holdControl(record, isOnHold)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </PortalDesktopTable>
          )}
        />
      </div>
      {rows.length > 250 ? (
        <p className="mt-3 text-xs text-text-secondary">
          Showing first 250 rows. Use filters to narrow the report.
        </p>
      ) : null}
    </>
  );
}
