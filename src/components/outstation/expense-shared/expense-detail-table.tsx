"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { egp, EXPENSE_SOURCE_LABELS, formatShortDate } from "@/components/outstation/expense-shared/formatters";
import type {
  ExpenseCommandRow,
  ExpenseDashboardVariant,
} from "@/components/outstation/expense-shared/types";
import { phxSelectClassName } from "@/components/ui/form-tokens";

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
  /** Percent of the table, admin view then portal view (the portal drops the Employee column). Each view sums to 100. */
  widths: { admin: number; portal: number };
  align: "left" | "right" | "center";
  numeric?: boolean;
  adminOnly?: boolean;
  sortValue: (row: ExpenseCommandRow) => string | number;
};

const COLUMNS: Column[] = [
  { key: "date", label: "Date", widths: { admin: 9, portal: 10 }, align: "left", sortValue: (r) => r.date ?? "" },
  { key: "employee", label: "Employee", widths: { admin: 18, portal: 0 }, align: "left", adminOnly: true, sortValue: (r) => r.specialist ?? "" },
  { key: "destination", label: "Destination", widths: { admin: 20, portal: 28 }, align: "left", sortValue: (r) => r.to || r.location || "" },
  { key: "type", label: "Type", widths: { admin: 13, portal: 16 }, align: "left", sortValue: (r) => r.tripType ?? "" },
  { key: "source", label: "Source", widths: { admin: 9, portal: 11 }, align: "left", sortValue: (r) => r.source },
  { key: "status", label: "Status", widths: { admin: 10, portal: 12 }, align: "left", sortValue: (r) => r.status ?? "" },
  { key: "km", label: "KM", widths: { admin: 6, portal: 7 }, align: "right", numeric: true, sortValue: (r) => r.km ?? 0 },
  { key: "total", label: "Total", widths: { admin: 15, portal: 16 }, align: "right", numeric: true, sortValue: (r) => r.total ?? 0 },
];

// Literal class names, so Tailwind sees every width it has to generate.
const COLUMN_WIDTH_CLASS: Record<number, string> = {
  6: "w-[6%]",
  7: "w-[7%]",
  9: "w-[9%]",
  10: "w-[10%]",
  11: "w-[11%]",
  12: "w-[12%]",
  13: "w-[13%]",
  15: "w-[15%]",
  16: "w-[16%]",
  18: "w-[18%]",
  20: "w-[20%]",
  28: "w-[28%]",
};

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
  "inline-flex max-w-full items-center break-words px-2 py-0.5 text-phx-sm font-bold uppercase tracking-wide ring-1 ring-inset";

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
        return <span className="break-words text-slate-600">{formatShortDate(row.date)}</span>;
      case "employee": {
        const sub = [row.region, row.line].filter(Boolean).join(" · ");
        return (
          <div className="min-w-0">
            <div className="break-words font-semibold text-slate-800">
              {row.specialist || "—"}
            </div>
            {sub ? (
              <div className="break-words text-phx-xs text-slate-400">
                {sub}
              </div>
            ) : null}
          </div>
        );
      }
      case "destination":
        return (
          <span className="block break-words text-slate-700">
            {row.to || row.location || "—"}
          </span>
        );
      case "type": {
        const transport = row.transportationType;
        return (
          <div className="min-w-0">
            <div className="break-words font-medium text-slate-700">{row.tripType || "—"}</div>
            {transport ? <div className="break-words text-phx-xs text-slate-400">{transport}</div> : null}
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
        return <span className="tabular-nums font-black text-phx-ink">{egp(row.total)}</span>;
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
        <span className="inline-flex items-center border border-phx-line bg-phx-paper px-3 py-1 text-xs font-bold text-phx-ink-soft">
          {sorted.length.toLocaleString()} rows
        </span>
      }
    >
      {/* Sorting lives in the table header, which is desktop-only — so the phone gets its own
          control. Without it the mobile card list would be permanently stuck on the default
          date-descending order, which is a lost capability rather than a restyle. */}
      <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2.5 md:hidden">
        <label className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-400" htmlFor="expense-sort">
          Sort
        </label>
        <select
          className={`${phxSelectClassName} min-w-0 flex-1`}
          id="expense-sort"
          onChange={(event) => setSortKey(event.target.value as ColumnKey)}
          value={sortKey}
        >
          {columns.map((column) => (
            <option key={column.key} value={column.key}>
              {column.label}
            </option>
          ))}
        </select>
        <button
          className="shrink-0 border border-slate-200 bg-white px-2 py-1.5 text-xs font-bold text-slate-700"
          onClick={() => setSortDir((dir) => (dir === "asc" ? "desc" : "asc"))}
          type="button"
        >
          {sortDir === "asc" ? "Ascending" : "Descending"}
        </button>
      </div>

      <PortalResponsiveDataList
        empty={
          <p className="px-3 py-12 text-center text-sm font-semibold text-slate-400">
            No expense rows match these filters.
          </p>
        }
        getKey={(row, index) => `${row.tripId}-${index}`}
        items={visible}
        renderCard={(row) => {
          const sub = [row.region, row.line].filter(Boolean).join(" · ");
          return (
            <PortalRecordCard
              accent="orange"
              meta={[formatShortDate(row.date), variant === "admin" ? sub : ""].filter(Boolean).join(" · ")}
              status={<span className="text-sm font-black tabular-nums text-phx-ink">{egp(row.total)}</span>}
              title={(variant === "admin" ? row.specialist : row.to || row.location) || "—"}
            >
              <PortalRecordFields
                fields={[
                  { label: "Destination", value: row.to || row.location || "—" },
                  { label: "Type", value: [row.tripType, row.transportationType].filter(Boolean).join(" · ") || "—" },
                  { label: "Source", value: renderCell("source", row) },
                  { label: "Status", value: renderCell("status", row) },
                  { label: "KM", value: Math.round(row.km ?? 0).toLocaleString() },
                ]}
              />
            </PortalRecordCard>
          );
        }}
        renderTable={() => (
          <PortalDesktopTable
            className="table-fixed border-collapse"
            cols={
              <colgroup>
                {columns.map((column) => (
                  <col className={COLUMN_WIDTH_CLASS[column.widths[variant]]} key={column.key} />
                ))}
              </colgroup>
            }
          >
          <thead>
            <tr className="bg-phx-ink">
              {columns.map((column) => {
                const active = sortKey === column.key;
                return (
                  <th
                    key={column.key}
                    className={`border-b border-[#1E293B] px-3 py-3 ${alignClass(column.align)} text-phx-sm font-black uppercase tracking-[0.1em] text-slate-200`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(column.key)}
                      className={`inline-flex items-center gap-1 transition-colors hover:text-orange-300 ${
                        column.align === "right" ? "flex-row-reverse" : ""
                      } ${column.align === "center" ? "justify-center" : ""}`}
                    >
                      <span className="break-words text-left">{column.label}</span>
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
            {/* No empty branch here: PortalResponsiveDataList renders `empty` and never calls
                renderTable when the list is empty, so a copy of the empty row would be dead. */}
            {visible.map((row, index) => (
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
            ))}
          </tbody>
          </PortalDesktopTable>
        )}
      />
    </AdminTableShell>
  );
}
