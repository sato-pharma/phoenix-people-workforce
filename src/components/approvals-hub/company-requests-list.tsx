"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { LANDING_FOCUS, LandingEmpty, landingActionClassName } from "@/components/employee-portal/landing-kit";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import type { CompanyRequestItem, CompanyRequestStatusTone } from "@/lib/approvals-hub/service";
import {
  phxFieldClassName,
  phxLabelTextClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

// The kit's status language: coloured small capitals and a 4px rail at the row's left — never a
// filled pill. Returned takes the kit's own orange-700 tone (landingTone), as the Action Center does.
const TONE_TEXT: Record<CompanyRequestStatusTone, string> = {
  pending: "text-amber-700",
  approved: "text-emerald-700",
  rejected: "text-rose-700",
  returned: "text-orange-700",
  neutral: "text-slate-600",
};

const TONE_RAIL: Record<CompanyRequestStatusTone, string> = {
  pending: "bg-amber-500",
  approved: "bg-emerald-500",
  rejected: "bg-rose-500",
  returned: "bg-orange-500",
  neutral: "bg-slate-300",
};

/** The white sheet: the kit's hairline and the soft depth token, in one string. */
const SHEET = `min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`;
/** A filter's label: the form kit's small capitals over its field; full width on a phone. */
const FILTER = "flex w-full flex-col gap-1 sm:w-auto";

type Props = {
  items: CompanyRequestItem[];
  emptyLabel: string;
  exportTitle: string;
  exportSheetName: string;
};

/**
 * "Company Requests" — every leave/excuse request (pending AND decided) company-wide, minus the
 * field force (District Manager / Medical Rep). CEO + Super Admin oversight only. Unlike the
 * decision-centric HistoryList, this renders all statuses (pending included) and the submitter's
 * title, with client-side filtering + xlsx export.
 */
export function CompanyRequestsList({ items, emptyLabel, exportTitle, exportSheetName }: Props) {
  const [employee, setEmployee] = useState("");
  const [status, setStatus] = useState<"all" | CompanyRequestStatusTone>("all");
  const [type, setType] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const types = useMemo(
    () => Array.from(new Set(items.map((i) => i.typeLabel).filter((t): t is string => Boolean(t)))).sort(),
    [items],
  );

  const filtered = useMemo(() => {
    const employeeLower = employee.trim().toLowerCase();
    return items.filter((item) => {
      if (employeeLower) {
        const haystack = `${item.employeeName} ${item.submitterTitle ?? ""}`.toLowerCase();
        if (!haystack.includes(employeeLower)) return false;
      }
      if (status !== "all" && item.statusTone !== status) return false;
      if (type !== "all" && item.typeLabel !== type) return false;
      const submittedDate = item.submittedAt.slice(0, 10);
      if (dateFrom && submittedDate < dateFrom) return false;
      if (dateTo && submittedDate > dateTo) return false;
      return true;
    });
  }, [items, employee, status, type, dateFrom, dateTo]);

  const exportColumns = [
    { key: "employee", label: "Employee" },
    { key: "title", label: "Title" },
    { key: "type", label: "Type" },
    { key: "status", label: "Status" },
    { key: "requestDate", label: "Request Date" },
    { key: "submittedAt", label: "Submitted" },
  ];
  const exportRows = filtered.map((item) => ({
    employee: item.employeeName,
    title: item.submitterTitle ?? "",
    type: item.typeLabel,
    status: item.statusLabel,
    requestDate: item.requestDate,
    submittedAt: item.submittedAt.slice(0, 10),
  }));

  const hasFilters = employee || status !== "all" || type !== "all" || dateFrom || dateTo;

  return (
    <div className="space-y-3">
      <div className={`flex flex-wrap items-end gap-2 px-3 py-2.5 sm:px-4 ${SHEET}`}>
        <label className={FILTER}>
          <span className={phxLabelTextClassName}>Employee / title</span>
          <input
            type="text"
            value={employee}
            onChange={(e) => setEmployee(e.target.value)}
            placeholder="Search…"
            className={cn(phxFieldClassName, "sm:w-44")}
          />
        </label>
        <label className={FILTER}>
          <span className={phxLabelTextClassName}>Status</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
            className={phxSelectClassName}
          >
            <option value="all">All</option>
            <option value="pending">Pending</option>
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
        {hasFilters ? (
          <button
            type="button"
            onClick={() => {
              setEmployee("");
              setStatus("all");
              setType("all");
              setDateFrom("");
              setDateTo("");
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
          <LandingEmpty>{items.length === 0 ? emptyLabel : "No requests match these filters."}</LandingEmpty>
        </div>
      ) : (
        <ul className={`divide-y divide-slate-200 ${SHEET}`}>
          {filtered.map((item) => (
            <li key={item.id} className="flex min-w-0 gap-3 px-3 py-3 sm:px-4">
              <span aria-hidden="true" className={`w-1 shrink-0 self-stretch ${TONE_RAIL[item.statusTone]}`} />
              <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  {/* Wraps, never ellipsises — see the note on the same line in approvals-workspace.
                      This line carries the job title too, so it was the first to overflow. */}
                  <p className="break-words text-sm font-bold text-slate-900" dir="auto">
                    {item.employeeName}
                    {item.submitterTitle ? <span className="font-medium text-slate-500"> · {item.submitterTitle}</span> : null}
                  </p>
                  <p className="break-words text-xs text-slate-600">
                    {item.typeLabel}
                    {item.requestDate ? ` · ${item.requestDate}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-3">
                  <span className={`text-phx-xs font-black uppercase tracking-[0.1em] ${TONE_TEXT[item.statusTone]}`}>
                    {item.statusLabel}
                  </span>
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
          ))}
        </ul>
      )}
    </div>
  );
}
