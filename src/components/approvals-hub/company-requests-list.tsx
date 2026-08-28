"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import type { CompanyRequestItem, CompanyRequestStatusTone } from "@/lib/approvals-hub/service";

const TONE_CLASSES: Record<CompanyRequestStatusTone, string> = {
  pending: "bg-amber-100 text-amber-700",
  approved: "bg-emerald-100 text-emerald-700",
  rejected: "bg-rose-100 text-rose-700",
  returned: "bg-orange-100 text-orange-700",
  neutral: "bg-slate-100 text-slate-600",
};

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
      <div className="flex flex-wrap items-end gap-2 border border-phx-line bg-white px-3 py-2.5">
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Employee / title</span>
          <input
            type="text"
            value={employee}
            onChange={(e) => setEmployee(e.target.value)}
            placeholder="Search…"
            className="h-8 w-44 border border-slate-300 px-2 text-xs focus:border-orange-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Status</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
            className="h-8 border border-slate-300 px-2 text-xs focus:border-orange-500 focus:outline-none"
          >
            <option value="all">All</option>
            <option value="pending">Pending</option>
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
          <p className="border border-phx-line bg-white px-4 py-8 text-center text-sm text-slate-500">
            {items.length === 0 ? emptyLabel : "No requests match these filters."}
          </p>
        ) : (
          filtered.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between gap-3 border border-phx-line bg-white px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-slate-900">
                  {item.employeeName}
                  {item.submitterTitle ? <span className="font-medium text-slate-500"> · {item.submitterTitle}</span> : null}
                </p>
                <p className="truncate text-xs text-slate-600">
                  {item.typeLabel}
                  {item.requestDate ? ` · ${item.requestDate}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ${TONE_CLASSES[item.statusTone]}`}
                >
                  {item.statusLabel}
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
