"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, ChevronUp, Download, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { CompanyVacationReportRow, CompanyVacationReportSource } from "@/lib/vacation/company-vacation-report";

const SOURCE_BADGE_CLASS: Record<CompanyVacationReportSource, string> = {
  "HR Approved": "bg-emerald-50 text-emerald-700 border-emerald-200",
  "HR Cancelled": "bg-slate-100 text-slate-600 border-slate-200",
  "HR Pending": "bg-amber-50 text-amber-700 border-amber-200",
  "HR Rejected": "bg-rose-50 text-rose-700 border-rose-200",
  "CRM Signal — Vacation": "bg-sky-50 text-sky-700 border-sky-200",
  "CRM Signal — Half-Day (Attendance Partial)": "bg-yellow-50 text-yellow-800 border-yellow-200",
};

const SOURCE_FILTERS: Array<CompanyVacationReportSource | "All"> = [
  "All",
  "HR Approved",
  "HR Pending",
  "HR Rejected",
  "HR Cancelled",
  "CRM Signal — Vacation",
  "CRM Signal — Half-Day (Attendance Partial)",
];

function SourceBadge({ source }: { source: CompanyVacationReportSource }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold", SOURCE_BADGE_CLASS[source])}>
      {source}
    </span>
  );
}

function isCrmSignalSource(source: CompanyVacationReportSource) {
  return source.startsWith("CRM Signal");
}

function rowKey(row: CompanyVacationReportRow) {
  return `${row.hrId}|${row.startDate}|${row.source}`;
}

type HasBalanceFilter = "All" | "Yes" | "No" | "N/A";

function hasBalanceFilterValue(row: CompanyVacationReportRow): HasBalanceFilter {
  if (row.hasBalance === null) return "N/A";
  return row.hasBalance ? "Yes" : "No";
}

function HasBalanceBadge({ hasBalance }: { hasBalance: boolean | null }) {
  if (hasBalance === null) {
    return <span className="text-xs text-slate-400">—</span>;
  }
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold",
        hasBalance ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700",
      )}
    >
      {hasBalance ? "Yes" : "No"}
    </span>
  );
}

/**
 * Turns one CRM Signal row into a real, approved, balance-deducting vacation request. Only
 * ever fires on an explicit click + confirm from a Super Admin, one row at a time — never
 * bulk. See app/api/vacation/company-report/approve/route.ts for what this actually does.
 */
function ApproveControl({
  disabled,
  onApprove,
  row,
}: {
  disabled: boolean;
  onApprove: (row: CompanyVacationReportRow) => Promise<void>;
  row: CompanyVacationReportRow;
}) {
  const [state, setState] = useState<"idle" | "pending" | "done" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (state === "done") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
        <Check className="h-3.5 w-3.5" /> Approved
      </span>
    );
  }

  const halfDayLabel = row.dayPart === "am_only" ? " (AM)" : row.dayPart === "pm_only" ? " (PM)" : "";
  const handleClick = async () => {
    const confirmed = window.confirm(
      `Approve this as a REAL vacation request for ${row.employeeName} (${row.hrId})?\n\n` +
      `${row.startDate}${row.endDate !== row.startDate ? ` – ${row.endDate}` : ""} · ${row.workingDays} day(s)${halfDayLabel}\n\n` +
      "This will create an approved vacation_requests record and deduct it from their actual leave entitlement. " +
      "This is not reversible from this page. Continue?",
    );
    if (!confirmed) return;
    setState("pending");
    setErrorMessage(null);
    try {
      await onApprove(row);
      setState("done");
    } catch (error) {
      setState("error");
      setErrorMessage(error instanceof Error ? error.message : "Approval failed.");
    }
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-semibold transition",
          state === "pending"
            ? "cursor-wait border-slate-200 bg-slate-100 text-slate-400"
            : "border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100",
        )}
        disabled={disabled || state === "pending"}
        onClick={handleClick}
        type="button"
      >
        {state === "pending" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {state === "pending" ? "Approving…" : "Approve as real leave"}
      </button>
      {state === "error" && errorMessage ? (
        <span className="max-w-[220px] text-[11px] text-rose-600">{errorMessage}</span>
      ) : null}
    </div>
  );
}

export function CompanyVacationReportTable({
  endDate,
  rows,
  startDate,
}: {
  endDate: string;
  rows: CompanyVacationReportRow[];
  startDate: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<CompanyVacationReportSource | "All">("All");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [lineName, setLineName] = useState("All");
  const [hasBalance, setHasBalance] = useState<HasBalanceFilter>("All");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const lineOptions = useMemo(() => {
    const names = new Set<string>();
    for (const row of rows) {
      if (row.lineName) names.add(row.lineName);
    }
    return ["All", ...[...names].sort((left, right) => left.localeCompare(right))];
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (source !== "All" && row.source !== source) return false;
      if (lineName !== "All" && (row.lineName ?? "") !== lineName) return false;
      if (hasBalance !== "All" && hasBalanceFilterValue(row) !== hasBalance) return false;
      if (fromDate && row.endDate < fromDate) return false;
      if (toDate && row.startDate > toDate) return false;
      if (!needle) return true;
      return `${row.employeeName} ${row.hrId} ${row.jobTitle ?? ""} ${row.lineName ?? ""}`.toLowerCase().includes(needle);
    });
  }, [rows, query, source, lineName, hasBalance, fromDate, toDate]);

  const resetAdvancedFilters = () => {
    setLineName("All");
    setHasBalance("All");
    setFromDate("");
    setToDate("");
  };

  const advancedFiltersActive = lineName !== "All" || hasBalance !== "All" || Boolean(fromDate) || Boolean(toDate);

  const totals = useMemo(() => {
    const byEmployee = new Map<string, number>();
    for (const row of filtered) {
      byEmployee.set(row.hrId, (byEmployee.get(row.hrId) ?? 0) + row.workingDays);
    }
    return { employees: byEmployee.size, totalDays: filtered.reduce((sum, row) => sum + row.workingDays, 0) };
  }, [filtered]);

  const handleApprove = async (row: CompanyVacationReportRow) => {
    const response = await fetch("/api/vacation/company-report/approve", {
      body: JSON.stringify({
        dayPart: row.dayPart,
        detail: row.detail,
        endDate: row.endDate,
        hrId: row.hrId,
        startDate: row.startDate,
        workingDays: row.workingDays,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.success) {
      throw new Error(body?.message || "Approval failed.");
    }
    router.refresh();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-3">
          <input
            className="w-64 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search employee, HR ID, job title..."
            type="text"
            value={query}
          />
          <select
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
            onChange={(event) => setSource(event.target.value as CompanyVacationReportSource | "All")}
            value={source}
          >
            {SOURCE_FILTERS.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
          <button
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-semibold transition",
              advancedFiltersActive
                ? "border-orange-300 bg-orange-50 text-orange-700"
                : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50",
            )}
            onClick={() => setShowAdvanced((value) => !value)}
            type="button"
          >
            Advanced Filters{advancedFiltersActive ? " •" : ""}
            {showAdvanced ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </div>
        <div className="flex items-center gap-4">
          <p className="text-xs text-slate-500">
            {filtered.length} rows · {totals.employees} employees · {totals.totalDays} total days
          </p>
          <a
            className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
            href={`/api/vacation/company-report/export?startDate=${startDate}&endDate=${endDate}`}
          >
            <Download className="h-3.5 w-3.5" />
            Export Excel
          </a>
        </div>
      </div>

      {showAdvanced ? (
        <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
            Line
            <select
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-normal"
              onChange={(event) => setLineName(event.target.value)}
              value={lineName}
            >
              {lineOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
            Has Balance
            <select
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-normal"
              onChange={(event) => setHasBalance(event.target.value as HasBalanceFilter)}
              value={hasBalance}
            >
              <option value="All">All</option>
              <option value="Yes">Yes</option>
              <option value="No">No</option>
              <option value="N/A">N/A (CRM Signal)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
            From
            <input
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-normal"
              onChange={(event) => setFromDate(event.target.value)}
              type="date"
              value={fromDate}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
            To
            <input
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-normal"
              onChange={(event) => setToDate(event.target.value)}
              type="date"
              value={toDate}
            />
          </label>
          {advancedFiltersActive ? (
            <button
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"
              onClick={resetAdvancedFilters}
              type="button"
            >
              Clear
            </button>
          ) : null}
        </div>
      ) : null}

      <p className="rounded-lg border border-orange-200 bg-orange-50 px-4 py-2 text-xs text-orange-800">
        <strong>Approve as real leave</strong> on a CRM Signal row creates an approved vacation request and deducts it from that
        employee&apos;s actual entitlement — one row at a time, only when you click it. HR-sourced rows are already real records.
        <strong> Has Balance</strong> / <strong>Balance After</strong> reflect an actual deduction, so they only show a value for
        <strong> HR Approved</strong> rows (excluding compensatory days, which are always fully paid outside the leave balance) —
        Pending/Rejected/Cancelled and CRM Signal rows show <strong>—</strong> since nothing was actually deducted for them.
      </p>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full min-w-[1020px] text-sm">
          <thead>
            <tr className="bg-slate-900 text-left text-xs font-semibold uppercase tracking-wide text-white">
              <th className="px-4 py-3">HR ID</th>
              <th className="px-4 py-3">Employee</th>
              <th className="px-4 py-3">Job Title</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Start</th>
              <th className="px-4 py-3">End</th>
              <th className="px-4 py-3">Days</th>
              <th className="px-4 py-3">Has Balance</th>
              <th className="px-4 py-3">Balance After</th>
              <th className="px-4 py-3">Detail</th>
              <th className="sticky right-0 bg-slate-900 px-4 py-3 shadow-[-4px_0_6px_-4px_rgba(0,0,0,0.3)]">Review</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map((row, index) => (
              <tr key={`${rowKey(row)}-${index}`} className="align-top">
                <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-500">{row.hrId}</td>
                <td className="px-4 py-3 font-semibold text-slate-900">{row.employeeName}</td>
                <td className="px-4 py-3 text-slate-600">{row.jobTitle ?? "—"}</td>
                <td className="px-4 py-3"><SourceBadge source={row.source} /></td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-600">{row.startDate}</td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-600">{row.endDate}</td>
                <td className="whitespace-nowrap px-4 py-3 font-semibold text-slate-900">{row.workingDays}</td>
                <td className="whitespace-nowrap px-4 py-3"><HasBalanceBadge hasBalance={row.hasBalance} /></td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-600">{row.balanceAfterDays ?? "—"}</td>
                <td className="px-4 py-3 text-slate-500">{row.detail}</td>
                <td className="sticky right-0 bg-white px-4 py-3 shadow-[-4px_0_6px_-4px_rgba(0,0,0,0.15)]">
                  {isCrmSignalSource(row.source) ? (
                    <ApproveControl disabled={false} onApprove={handleApprove} row={row} />
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  )}
                </td>
              </tr>
            ))}
            {filtered.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-sm text-slate-400" colSpan={11}>No rows match this filter.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
