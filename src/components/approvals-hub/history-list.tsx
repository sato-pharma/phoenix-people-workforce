"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { LANDING_FOCUS, LandingEmpty, landingActionClassName } from "@/components/employee-portal/landing-kit";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import type { ResponderHistoryItem } from "@/lib/approvals-hub/service";
import {
  phxFieldClassName,
  phxLabelTextClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

// Optionally carries who decided it (used only by the company-wide "All Decisions" tab).
type HistoryListItem = ResponderHistoryItem & { decidedByName?: string | null };

type Props = {
  items: HistoryListItem[];
  emptyLabel: string;
  exportTitle: string;
  exportSheetName: string;
  // Show a "Decided by" column/filter — only meaningful on the company-wide tab.
  showDecidedBy?: boolean;
};

// The kit's status language: the decision in coloured small capitals and a 4px rail at the row's
// left — never a filled pill. Emerald approved, rose rejected, amber returned.
function decisionTone(decision: string): { text: string; rail: string } {
  if (decision === "approved") return { text: "text-emerald-700", rail: "bg-emerald-500" };
  if (decision === "rejected") return { text: "text-rose-700", rail: "bg-rose-500" };
  return { text: "text-amber-700", rail: "bg-amber-500" };
}

/** The white sheet: the kit's hairline and the soft depth token, in one string. */
const SHEET = `min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`;
/** A filter's label: the form kit's small capitals over its field; full width on a phone. */
const FILTER = "flex w-full flex-col gap-1 sm:w-auto";

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
      <div className={`flex flex-wrap items-end gap-2 px-3 py-2.5 sm:px-4 ${SHEET}`}>
        <label className={FILTER}>
          <span className={phxLabelTextClassName}>Employee</span>
          <input
            type="text"
            value={employee}
            onChange={(e) => setEmployee(e.target.value)}
            placeholder="Search name…"
            className={cn(phxFieldClassName, "sm:w-40")}
          />
        </label>
        <label className={FILTER}>
          <span className={phxLabelTextClassName}>From</span>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className={phxFieldClassName}
          />
        </label>
        <label className={FILTER}>
          <span className={phxLabelTextClassName}>To</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className={phxFieldClassName}
          />
        </label>
        <label className={FILTER}>
          <span className={phxLabelTextClassName}>Decision</span>
          <select
            value={decision}
            onChange={(e) => setDecision(e.target.value as typeof decision)}
            className={phxSelectClassName}
          >
            <option value="all">All</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="returned">Returned</option>
          </select>
        </label>
        {types.length > 0 ? (
          <label className={FILTER}>
            <span className={phxLabelTextClassName}>Type</span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className={phxSelectClassName}
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
            className={landingActionClassName("outline", "h-10")}
          >
            Clear
          </button>
        ) : null}
        <ExportXlsxButton
          className="h-10 sm:ml-auto"
          title={exportTitle}
          sheetName={exportSheetName}
          columns={exportColumns}
          rows={exportRows}
        />
      </div>

      {filtered.length === 0 ? (
        <div className={SHEET}>
          <LandingEmpty>{items.length === 0 ? emptyLabel : "No history matches these filters."}</LandingEmpty>
        </div>
      ) : (
        <ul className={`divide-y divide-slate-200 ${SHEET}`}>
          {filtered.map((item) => {
            const tone = decisionTone(item.decision);
            return (
              <li key={item.id} className="flex min-w-0 gap-3 px-3 py-3 sm:px-4">
                <span aria-hidden="true" className={`w-1 shrink-0 self-stretch ${tone.rail}`} />
                <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    {/* Wraps, never ellipsises — see the note on the same line in approvals-workspace. */}
                    <p className="break-words text-sm font-bold text-slate-900" dir="auto">{item.employeeName}</p>
                    <p className="break-words text-xs text-slate-600">
                      {item.title}
                      {showDecidedBy && item.decidedByName ? ` · Decided by ${item.decidedByName}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-3">
                    <span className={`text-phx-xs font-black uppercase tracking-[0.1em] ${tone.text}`}>{item.decision}</span>
                    {item.href ? (
                      <Link
                        href={item.href}
                        className={`text-phx-xs font-bold uppercase tracking-[0.1em] text-[#08111f] underline decoration-slate-300 underline-offset-4 transition-colors hover:decoration-[#08111f] motion-reduce:transition-none ${LANDING_FOCUS}`}
                      >
                        View
                      </Link>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
