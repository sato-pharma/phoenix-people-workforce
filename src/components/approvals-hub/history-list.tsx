"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import type { ResponderHistoryItem } from "@/lib/approvals-hub/service";

// Optionally carries who decided it (used only by the company-wide "All Decisions" tab).
export type HistoryListItem = ResponderHistoryItem & { decidedByName?: string | null };

type Props = {
  items: HistoryListItem[];
  emptyLabel: string;
  exportTitle: string;
  exportSheetName: string;
  // Show a "Decided by" column/filter — only meaningful on the company-wide tab.
  showDecidedBy?: boolean;
};

function decisionPill(decision: string): string {
  if (decision === "approved") return "bg-emerald-100 text-emerald-700";
  if (decision === "rejected") return "bg-rose-100 text-rose-700";
  return "bg-amber-100 text-amber-700";
}

export function HistoryList({ items, emptyLabel, exportTitle, exportSheetName, showDecidedBy }: Props) {
  const [employee, setEmployee] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [decision, setDecision] = useState<"all" | "approved" | "rejected" | "returned">("all");
  const [type, setType] = useState("all");

  const types = useMemo(() => Array.from(new Set(items.map((i) => i.subtype).filter((t): t is string => Boolean(t)))).sort(), [items]);

  const filtered = useMemo(() => {
    const employeeLower = employee.trim().toLowerCase();
    return items.filter((item) => {
      if (employeeLower && !item.employeeName.toLowerCase().includes(employeeLower)) return false;
      if (decision !== "all" && item.decision !== decision) return false;
      if (type !== "all" && item.subtype !== type) return false;
      const decidedDate = item.decidedAt.slice(0, 10);
      if (dateFrom && decidedDate < dateFrom) return false;
      if (dateTo && decidedDate > dateTo) return false;
      return true;
    });
  }, [items, employee, decision, type, dateFrom, dateTo]);

  const exportColumns = [
    { key: "employee", label: "Employee" },
    { key: "type", label: "Type" },
    ...(showDecidedBy ? [{ key: "decidedBy", label: "Decided By" }] : []),
    { key: "decision", label: "Decision" },
    { key: "decidedAt", label: "Decided At" },
    { key: "title", label: "Title" },
  ];
  const exportRows = filtered.map((item) => ({
    employee: item.employeeName,
    type: item.subtype ?? "",
    ...(showDecidedBy ? { decidedBy: item.decidedByName ?? "" } : {}),
    decision: item.decision,
    decidedAt: item.decidedAt,
    title: item.title,
  }));

  const hasFilters = employee || dateFrom || dateTo || decision !== "all" || type !== "all";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2 border border-[#e4e9ec] bg-white px-3 py-2.5">
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Employee</span>
          <input
            type="text"
            value={employee}
            onChange={(e) => setEmployee(e.target.value)}
            placeholder="Search name…"
            className="h-8 w-40 border border-slate-300 px-2 text-xs focus:border-orange-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">From</span>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="h-8 border border-slate-300 px-2 text-xs focus:border-orange-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">To</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="h-8 border border-slate-300 px-2 text-xs focus:border-orange-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Decision</span>
          <select
            value={decision}
            onChange={(e) => setDecision(e.target.value as typeof decision)}
            className="h-8 border border-slate-300 px-2 text-xs focus:border-orange-500 focus:outline-none"
          >
            <option value="all">All</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="returned">Returned</option>
          </select>
        </label>
        {types.length > 0 ? (
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Type</span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="h-8 border border-slate-300 px-2 text-xs focus:border-orange-500 focus:outline-none"
            >
              <option value="all">All</option>
              {types.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {hasFilters ? (
          <button
            type="button"
            onClick={() => {
              setEmployee("");
              setDateFrom("");
              setDateTo("");
              setDecision("all");
              setType("all");
            }}
            className="h-8 border border-slate-300 px-2.5 text-xs font-bold text-slate-600 hover:bg-slate-50"
          >
            Clear
          </button>
        ) : null}
        <ExportXlsxButton
          className="ml-auto h-8"
          title={exportTitle}
          sheetName={exportSheetName}
          columns={exportColumns}
          rows={exportRows}
        />
      </div>

      <div className="space-y-2">
        {filtered.length === 0 ? (
          <p className="border border-[#e4e9ec] bg-white px-4 py-8 text-center text-sm text-slate-500">
            {items.length === 0 ? emptyLabel : "No history matches these filters."}
          </p>
        ) : (
          filtered.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-3 border border-[#e4e9ec] bg-white px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-slate-900">{item.employeeName}</p>
                <p className="truncate text-xs text-slate-600">
                  {item.title}
                  {showDecidedBy && item.decidedByName ? ` · Decided by ${item.decidedByName}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ${decisionPill(item.decision)}`}>
                  {item.decision}
                </span>
                {item.href ? (
                  <Link href={item.href} className="text-[11px] font-bold text-orange-600 hover:text-orange-700">
                    View
                  </Link>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
