"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { egp, EXPENSE_SOURCE_LABELS, formatShortDate } from "@/components/outstation/expense-shared/formatters";
import type {
  ExpenseCommandRow,
  ExpenseDashboardVariant,
} from "@/components/outstation/expense-shared/types";

const RENDER_CAP = 250;

type SortDir = "asc" | "desc";

type ColumnKey =
  | "date"
  | "employee"
  | "destination"
  | "type"
  | "source"
  | "status"
  | "km"
  | "total"
  | "risk";

type Column = {
  key: ColumnKey;
  label: string;
  width?: string; // omit → flexible (shares remaining space under table-fixed)
  align: "left" | "right" | "center";
  numeric?: boolean;
  adminOnly?: boolean;
  sortValue: (row: ExpenseCommandRow) => string | number;
};

const COLUMNS: Column[] = [
  { key: "date", label: "Date", width: "92px", align: "left", sortValue: (r) => r.date ?? "" },
  { key: "employee", label: "Employee", align: "left", adminOnly: true, sortValue: (r) => r.specialist ?? "" },
  { key: "destination", label: "Destination", align: "left", sortValue: (r) => r.to || r.location || "" },
  { key: "type", label: "Type", width: "124px", align: "left", sortValue: (r) => r.tripType ?? "" },
  { key: "source", label: "Source", width: "112px", align: "left", sortValue: (r) => r.source },
  { key: "status", label: "Status", width: "104px", align: "left", sortValue: (r) => r.status ?? "" },
  { key: "km", label: "KM", width: "64px", align: "right", numeric: true, sortValue: (r) => r.km ?? 0 },
  { key: "total", label: "Total", width: "124px", align: "right", numeric: true, sortValue: (r) => r.total ?? 0 },
  { key: "risk", label: "Risk", width: "60px", align: "center", adminOnly: true, sortValue: (r) => (r.isHighRisk ? 1 : 0) },
];

const SOURCE_BADGE: Record<string, string> = {
  live: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  manual: "bg-violet-50 text-violet-700 ring-violet-200",
  historical: "bg-slate-100 text-slate-600 ring-slate-200",
};

const STATUS_BADGE: Record<string, string> = {
  Approved: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  Pending: "bg-amber-50 text-amber-700 ring-amber-200",
  Rejected: "bg-rose-50 text-rose-700 ring-rose-200",
};

const badgeBase =
  "inline-flex max-w-full items-center truncate rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ring-inset";

function alignClass(align: Column["align"]) {
  return align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
}

export function ExpenseDetailTable({
  rows,
  variant = "admin",
}: {
  rows: ExpenseCommandRow[];
  variant?: ExpenseDashboardVariant;
}) {
  const [sortKey, setSortKey] = useState<ColumnKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const columns = useMemo(
    () => COLUMNS.filter((column) => variant === "admin" || !column.adminOnly),
    [variant],
  );

  const sorted = useMemo(() => {
    const column = columns.find((col) => col.key === sortKey) ?? columns[0];
    const factor = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const left = column.sortValue(a);
      const right = column.sortValue(b);
      if (typeof left === "number" && typeof right === "number") return (left - right) * factor;
      return String(left).localeCompare(String(right)) * factor;
    });
  }, [rows, columns, sortKey, sortDir]);

  const visible = sorted.slice(0, RENDER_CAP);

  function toggleSort(key: ColumnKey) {
    if (sortKey === key) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function renderCell(key: ColumnKey, row: ExpenseCommandRow) {
    switch (key) {
      case "date":
        return <span className="whitespace-nowrap text-slate-600">{formatShortDate(row.date)}</span>;
      case "employee": {
        const sub = [row.region, row.line].filter(Boolean).join(" · ");
        return (
          <div className="min-w-0">
            <div className="truncate font-semibold text-slate-800" title={row.specialist || undefined}>
              {row.specialist || "—"}
            </div>
            {sub ? (
              <div className="truncate text-[11px] text-slate-400" title={sub}>
                {sub}
              </div>
            ) : null}
          </div>
        );
      }
      case "destination":
        return (
          <span className="block truncate text-slate-700" title={row.to || row.location || undefined}>
            {row.to || row.location || "—"}
          </span>
        );
      case "type": {
        const transport = row.transportationType;
        return (
          <div className="min-w-0">
            <div className="truncate font-medium text-slate-700">{row.tripType || "—"}</div>
            {transport ? <div className="truncate text-[11px] text-slate-400">{transport}</div> : null}
          </div>
        );
      }
      case "source":
        return (
          <span className={`${badgeBase} ${SOURCE_BADGE[row.source] ?? SOURCE_BADGE.historical}`}>
            {EXPENSE_SOURCE_LABELS[row.source].split(" ")[0]}
          </span>
        );
      case "status":
        return (
          <span className={`${badgeBase} ${STATUS_BADGE[row.status] ?? "bg-slate-100 text-slate-600 ring-slate-200"}`}>
            {row.status || "—"}
          </span>
        );
      case "km":
        return <span className="tabular-nums text-slate-600">{Math.round(row.km ?? 0).toLocaleString()}</span>;
      case "total":
        return <span className="tabular-nums font-black text-[#0F172A]">{egp(row.total)}</span>;
      case "risk":
        return row.isHighRisk ? (
          <span
            className="inline-block h-2.5 w-2.5 rounded-full bg-rose-500 ring-2 ring-rose-100"
            title="Flagged"
          />
        ) : (
          <span className="text-slate-300">·</span>
        );
      default:
        return null;
    }
  }

  return (
    <AdminTableShell
      title="Expense ledger"
      description={`Every outstation expense matching the active filters.${
        sorted.length > RENDER_CAP ? ` Showing the first ${RENDER_CAP} of ${sorted.length.toLocaleString()}.` : ""
      } Full amount breakdown is in the charts above and the Excel export.`}
      action={
        <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-bold text-slate-600">
          {sorted.length.toLocaleString()} rows
        </span>
      }
    >
      <div className="w-full overflow-x-auto">
        <table className="w-full table-fixed border-collapse text-sm">
          <colgroup>
            {columns.map((column) => (
              <col key={column.key} style={column.width ? { width: column.width } : undefined} />
            ))}
          </colgroup>
          <thead>
            <tr className="bg-[#0F172A]">
              {columns.map((column) => {
                const active = sortKey === column.key;
                return (
                  <th
                    key={column.key}
                    className={`border-b border-[#1E293B] px-3 py-3 ${alignClass(column.align)} text-[10px] font-black uppercase tracking-[0.1em] text-slate-200`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(column.key)}
                      className={`inline-flex items-center gap-1 transition-colors hover:text-orange-300 ${
                        column.align === "right" ? "flex-row-reverse" : ""
                      } ${column.align === "center" ? "justify-center" : ""}`}
                    >
                      <span className="truncate">{column.label}</span>
                      {active ? (
                        sortDir === "asc" ? (
                          <ArrowUp className="h-3 w-3 shrink-0" />
                        ) : (
                          <ArrowDown className="h-3 w-3 shrink-0" />
                        )
                      ) : (
                        <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-30" />
                      )}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td
                  className="px-3 py-12 text-center text-sm font-semibold text-slate-400"
                  colSpan={columns.length}
                >
                  No expense rows match these filters.
                </td>
              </tr>
            ) : (
              visible.map((row, index) => (
                <tr
                  key={`${row.tripId}-${index}`}
                  className="border-b border-[#F6E8D8] bg-white transition-colors odd:bg-[#FFFCF8] hover:bg-[#FFF3E6]"
                >
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={`px-3 py-2.5 align-middle ${alignClass(column.align)} ${
                        column.numeric ? "tabular-nums" : ""
                      }`}
                    >
                      {renderCell(column.key, row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </AdminTableShell>
  );
}
