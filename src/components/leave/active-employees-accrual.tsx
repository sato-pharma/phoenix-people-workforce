"use client";

import { ChevronLeft, ChevronRight, Download, Filter, Gauge, Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";

import type { ActiveEmployeeAccrualReport, ActiveEmployeeAccrualRow } from "@/lib/leave/types";
import { cn } from "@/lib/utils";

import { buttonClassName, fieldClassName, formatDate, Panel, PanelHeader, SyncedTableContainer } from "./leave-ui-primitives";

const columns: Array<{ key: keyof ActiveEmployeeAccrualRow; label: string; className?: string }> = [
  { key: "employeeName", label: "Employee Name", className: "min-w-[220px]" },
  { key: "line", label: "Line" },
  { key: "area", label: "Area" },
  { key: "hiringDate", label: "Hiring Date" },
  { key: "serviceDuration", label: "Service Duration" },
  { key: "policyBasis", label: "Policy Basis", className: "min-w-[220px]" },
  { key: "annualEntitlement", label: "Annual Entitlement" },
  { key: "monthlyAccrual", label: "Monthly Accrual" },
  { key: "accruedToDate", label: "Accrued To Date" },
  { key: "usedConsumed", label: "Used / Consumed" },
  { key: "pending", label: "Pending" },
  { key: "carryForward", label: "Carry Forward" },
  { key: "adjustments", label: "Adjustments" },
  { key: "availableBalance", label: "Available Balance" },
  { key: "lastAccrualMonth", label: "Last Accrual Month" },
  { key: "lastLeaveTransactionDate", label: "Last Leave Transaction Date" },
];

function value(row: ActiveEmployeeAccrualRow, key: keyof ActiveEmployeeAccrualRow) {
  const raw = row[key];
  if (raw === null || raw === undefined || raw === "") return "-";
  if (key === "hiringDate" || key === "lastLeaveTransactionDate") return formatDate(String(raw));
  if (typeof raw === "number") return Number(raw.toFixed(2));
  return String(raw);
}

export function ActiveEmployeesAccrualTable({ report }: { report?: ActiveEmployeeAccrualReport | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [showFilters, setShowFilters] = useState(false);

  const createQueryString = useCallback(
    (params: Record<string, string | number | null>) => {
      const newParams = new URLSearchParams(searchParams.toString());
      Object.entries(params).forEach(([key, val]) => {
        if (val === null) newParams.delete(key);
        else newParams.set(key, String(val));
      });
      return newParams.toString();
    },
    [searchParams],
  );

  const handlePageChange = (newOffset: number) => {
    router.push(`${pathname}?${createQueryString({ offset: newOffset })}`, { scroll: false });
  };

  const handleFilterSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const params: Record<string, string | number | null> = {
      area: formData.get("area") as string || null,
      employee: formData.get("employee") as string || null,
      employeeHrId: formData.get("employeeHrId") as string || null,
      line: formData.get("line") as string || null,
      sortBy: formData.get("sortBy") as string || null,
      sortOrder: formData.get("sortOrder") as string || null,
      offset: 0, // Reset to first page on filter
    };
    router.push(`${pathname}?${createQueryString(params)}`, { scroll: false });
  };

  const pagination = report?.pagination;
  const totalRows = pagination?.totalRows ?? 0;
  const limit = pagination?.limit ?? 25;
  const offset = pagination?.offset ?? 0;
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(totalRows / limit);
  const exportQuery = searchParams.toString();
  const exportHref = `/api/leave/accrual/active-employees/export${exportQuery ? `?${exportQuery}` : ""}`;

  return (
    <div className="space-y-4">
      <Panel>
        <PanelHeader
          action={
            <div className="flex flex-wrap items-center gap-2">
              <a
                className={cn(buttonClassName, "border border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100")}
                href={exportHref}
              >
                <Download className="h-4 w-4" />
                Employees Accrual sheet download
              </a>
              <button
                className={cn(
                  buttonClassName,
                  "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
                  showFilters && "border-orange-200 bg-orange-50 text-orange-700",
                )}
                onClick={() => setShowFilters(!showFilters)}
                type="button"
              >
                <Filter className="h-4 w-4" />
                {showFilters ? "Hide Filters" : "Show Filters"}
              </button>
            </div>
          }
          description={report ? `${totalRows} active employee accrual record(s) for ${report.year}. Read-only; no balance mutation is available here.` : "Accrual report is unavailable."}
          icon={<Gauge className="h-5 w-5" />}
          title="Employees Accrual"
        />

        {showFilters && (
          <form className="grid gap-3 border-b border-slate-100 p-4 md:grid-cols-4 lg:grid-cols-6" onSubmit={handleFilterSubmit}>
            <div className="relative">
              <Search className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" />
              <input
                className={cn(fieldClassName, "pl-9")}
                defaultValue={searchParams.get("employee") ?? ""}
                name="employee"
                placeholder="Employee Name"
              />
            </div>
            <input
              className={fieldClassName}
              defaultValue={searchParams.get("employeeHrId") ?? ""}
              name="employeeHrId"
              placeholder="HR ID"
            />
            <input
              className={fieldClassName}
              defaultValue={searchParams.get("line") ?? ""}
              name="line"
              placeholder="Line Name"
            />
            <input
              className={fieldClassName}
              defaultValue={searchParams.get("area") ?? ""}
              name="area"
              placeholder="Area Name"
            />
            <select className={fieldClassName} defaultValue={searchParams.get("sortBy") ?? ""} name="sortBy">
              <option value="">Sort By</option>
              {columns.map((col) => (
                <option key={col.key} value={col.key}>
                  {col.label}
                </option>
              ))}
            </select>
            <select className={fieldClassName} defaultValue={searchParams.get("sortOrder") ?? "desc"} name="sortOrder">
              <option value="asc">Lowest to Highest</option>
              <option value="desc">Highest to Lowest</option>
            </select>
            <div className="md:col-span-4 lg:col-span-6 flex justify-end">
              <button className={cn(buttonClassName, "bg-slate-900 text-white hover:bg-slate-800")} type="submit">
                Apply Filters & Sorting
              </button>
            </div>
          </form>
        )}

        {!report || report.rows.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm font-semibold text-slate-500">No active employee accrual rows found.</div>
        ) : (
          <>
            <SyncedTableContainer>
          <table className="w-full min-w-[2600px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">
                {columns.map((column) => <th className={column.className ?? ""} key={column.key}><span className="block px-4 py-3">{column.label}</span></th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {report.rows.map((row) => (
                <tr className="transition hover:bg-slate-50/70" key={row.employeeHrId}>
                  {columns.map((column) => (
                    <td className={`px-4 py-4 align-top font-semibold text-slate-700 ${column.className ?? ""}`} key={column.key}>
                      {value(row, column.key)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </SyncedTableContainer>

            {totalPages > 1 && (
              <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50/50 px-4 py-3 sm:px-6">
                <div className="flex flex-1 justify-between sm:hidden">
                  <button
                    className={cn(buttonClassName, "bg-white ring-1 ring-slate-200")}
                    disabled={currentPage === 1}
                    onClick={() => handlePageChange(Math.max(0, offset - limit))}
                  >
                    Previous
                  </button>
                  <button
                    className={cn(buttonClassName, "bg-white ring-1 ring-slate-200")}
                    disabled={currentPage === totalPages}
                    onClick={() => handlePageChange(offset + limit)}
                  >
                    Next
                  </button>
                </div>
                <div className="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm text-slate-700">
                      Showing <span className="font-bold">{offset + 1}</span> to{" "}
                      <span className="font-bold">{Math.min(offset + limit, totalRows)}</span> of{" "}
                      <span className="font-bold">{totalRows}</span> results
                    </p>
                  </div>
                  <div>
                    <nav aria-label="Pagination" className="isolate inline-flex -space-x-px rounded-xl shadow-sm">
                      <button
                        className="relative inline-flex items-center rounded-l-xl border border-slate-200 bg-white px-2 py-2 text-slate-500 hover:bg-slate-50 focus:z-20 disabled:opacity-50"
                        disabled={currentPage === 1}
                        onClick={() => handlePageChange(Math.max(0, offset - limit))}
                      >
                        <span className="sr-only">Previous</span>
                        <ChevronLeft aria-hidden="true" className="h-5 w-5" />
                      </button>
                      <div className="relative inline-flex items-center border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700">
                        Page {currentPage} of {totalPages}
                      </div>
                      <button
                        className="relative inline-flex items-center rounded-r-xl border border-slate-200 bg-white px-2 py-2 text-slate-500 hover:bg-slate-50 focus:z-20 disabled:opacity-50"
                        disabled={currentPage === totalPages}
                        onClick={() => handlePageChange(offset + limit)}
                      >
                        <span className="sr-only">Next</span>
                        <ChevronRight aria-hidden="true" className="h-5 w-5" />
                      </button>
                    </nav>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
