"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CalendarDays, CheckCircle2, ClipboardCheck, Filter, Loader2, RefreshCw, Search, XCircle } from "lucide-react";

import type { PendingApprovalItem } from "@/lib/pending-approvals/service";
import { cn } from "@/lib/utils";

type PendingApprovalsResponse = {
  data?: PendingApprovalItem[];
  message?: string;
};

type ApprovalTab = "for-me" | "by-me";

const workflowFilterOptions: Array<{ label: string; value: PendingApprovalItem["workflow"] }> = [
  { label: "Vacation", value: "vacation" },
  { label: "Employee Excuse", value: "excuse" },
  { label: "Expense", value: "expense" },
  { label: "Outstation", value: "outstation" },
  { label: "Sales Import", value: "sales-import" },
  { label: "Accepted Offer", value: "offer" },
  { label: "Contract Renewal", value: "contract-renewal" },
  { label: "Resignation", value: "resignation" },
  { label: "Payroll Batch", value: "payroll-batch" },
];

function workflowFromQuery(value: string | null): PendingApprovalItem["workflow"] | "all" {
  if (!value) return "all";
  return workflowFilterOptions.some((option) => option.value === value)
    ? value as PendingApprovalItem["workflow"]
    : "all";
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "-";
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(date);
}

function workflowTone(workflow: PendingApprovalItem["workflow"]) {
  switch (workflow) {
    case "vacation":
    case "excuse":
      return "bg-sky-50 text-sky-700 ring-sky-100";
    case "expense":
    case "payroll-batch":
      return "bg-emerald-50 text-emerald-700 ring-emerald-100";
    case "outstation":
      return "bg-amber-50 text-amber-700 ring-amber-100";
    case "sales-import":
      return "bg-indigo-50 text-indigo-700 ring-indigo-100";
    default:
      return "bg-slate-100 text-slate-700 ring-slate-200";
  }
}

function submittedDateKey(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

export function PendingApprovalsWorkspace({
  initialItems,
  initialTab = "for-me",
  initialTypeFilter = "all",
}: {
  initialItems: PendingApprovalItem[];
  initialTab?: ApprovalTab;
  initialTypeFilter?: PendingApprovalItem["workflow"] | "all" | string | null;
}) {
  const [activeTab, setActiveTab] = useState<ApprovalTab>(initialTab === "by-me" ? "by-me" : "for-me");
  const [items, setItems] = useState(initialItems);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<PendingApprovalItem | null>(null);
  const [rejectComment, setRejectComment] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [typeFilter, setTypeFilter] = useState<PendingApprovalItem["workflow"] | "all">(workflowFromQuery(initialTypeFilter));
  const [personFilter, setPersonFilter] = useState("");
  const [dateFromFilter, setDateFromFilter] = useState("");
  const [dateToFilter, setDateToFilter] = useState("");
  const forMeItems = useMemo(() => items.filter((item) => !item.isSubmittedByMe), [items]);
  const byMeItems = useMemo(() => items.filter((item) => item.isSubmittedByMe), [items]);
  // Only show filter options for workflow types that are actually present in the list
  const availableFilterOptions = useMemo(() => {
    const present = new Set(items.map((item) => item.workflow));
    return workflowFilterOptions.filter((option) => present.has(option.value));
  }, [items]);
  const activeTabItems = activeTab === "for-me" ? forMeItems : byMeItems;

  const filteredItems = useMemo(() => {
    const person = personFilter.trim().toLowerCase();
    return items.filter((item) => {
      if (activeTab === "for-me" && item.isSubmittedByMe) return false;
      if (activeTab === "by-me" && !item.isSubmittedByMe) return false;

      if (typeFilter !== "all" && item.workflow !== typeFilter) return false;

      if (person) {
        const haystack = [
          item.requester,
          item.requesterHrId,
          item.shortSummary,
          item.workflowLabel,
        ].join(" ").toLowerCase();
        if (!haystack.includes(person)) return false;
      }

      const submittedDate = submittedDateKey(item.submittedAt);
      if (dateFromFilter && (!submittedDate || submittedDate < dateFromFilter)) return false;
      if (dateToFilter && (!submittedDate || submittedDate > dateToFilter)) return false;
      return true;
    });
  }, [activeTab, dateFromFilter, dateToFilter, items, personFilter, typeFilter]);

  const activeTotalCount = activeTabItems.length;
  const activeFilteredCount = filteredItems.length;
  const activeDecisionCount = forMeItems.filter((item) => item.canDecide !== false).length;
  const hasActiveFilters = typeFilter !== "all" || Boolean(personFilter.trim()) || Boolean(dateFromFilter) || Boolean(dateToFilter);

  const grouped = useMemo(() => {
    const groups = new Map<string, PendingApprovalItem[]>();
    for (const item of filteredItems) {
      groups.set(item.workflowLabel, [...(groups.get(item.workflowLabel) ?? []), item]);
    }
    return Array.from(groups.entries());
  }, [filteredItems]);

  function clearFilters() {
    setTypeFilter("all");
    setPersonFilter("");
    setDateFromFilter("");
    setDateToFilter("");
  }

  async function refresh() {
    try {
      setRefreshing(true);
      const response = await fetch("/api/pending-approvals", { headers: { Accept: "application/json" } });
      const payload = await response.json().catch(() => ({})) as PendingApprovalsResponse;
      if (!response.ok) throw new Error(payload.message ?? "Pending approvals failed to load.");
      setItems(payload.data ?? []);
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Pending approvals failed to load.");
    } finally {
      setRefreshing(false);
    }
  }

  async function decide(item: PendingApprovalItem, decision: "approve" | "reject", comment?: string) {
    const key = `${item.workflow}:${item.id}`;
    try {
      setBusyKey(key);
      const response = await fetch(`/api/pending-approvals/${encodeURIComponent(item.workflow)}/${encodeURIComponent(item.id)}`, {
        body: JSON.stringify({ comment, decision }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({})) as PendingApprovalsResponse;
      if (!response.ok) throw new Error(payload.message ?? "Approval decision failed.");
      setItems((current) => current.filter((candidate) => !(candidate.workflow === item.workflow && candidate.id === item.id)));
      setError(null);
      setRejectTarget(null);
      setRejectComment("");
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : "Approval decision failed.");
    } finally {
      setBusyKey(null);
    }
  }

  function startReject(item: PendingApprovalItem) {
    setRejectTarget(item);
    setRejectComment("");
    setError(null);
  }

  const rejectCommentMissing = Boolean(rejectTarget?.requiresRejectComment && !rejectComment.trim());

  return (
    <div className="space-y-5">
      <section className="rounded-[22px] border border-white/80 bg-white/90 p-5 shadow-[0_18px_46px_rgba(15,23,42,0.07)] ring-1 ring-slate-200/70 backdrop-blur">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-[16px] bg-orange-50 text-orange-600 ring-1 ring-orange-100">
              <ClipboardCheck className="h-5 w-5" />
            </span>
            <div>
              <h1 className="text-2xl font-black tracking-tight text-slate-950">Pending Approvals</h1>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                {activeFilteredCount === activeTotalCount
                  ? `${activeFilteredCount} ${activeTab === "for-me" ? "pending items for you" : "requests pending by you"}`
                  : `${activeFilteredCount} of ${activeTotalCount} matching items in this tab`}
                {activeTab === "for-me" && activeDecisionCount > 0
                  ? `; ${activeDecisionCount} require your decision`
                  : ""}
              </p>
            </div>
          </div>
          <button
            className="inline-flex items-center justify-center gap-2 rounded-full border border-slate-200/80 bg-white px-4 py-2 text-sm font-black text-slate-700 shadow-[0_6px_16px_rgba(15,23,42,0.05)] transition hover:border-orange-200 hover:bg-orange-50/70 disabled:opacity-60"
            disabled={refreshing}
            onClick={() => void refresh()}
            type="button"
          >
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </button>
        </div>
        {error ? (
          <div className="mt-4 rounded-[16px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
            {error}
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            className={cn(
              "inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-black transition",
              activeTab === "for-me"
                ? "bg-orange-600 text-white shadow-[0_10px_22px_rgba(234,88,12,0.35)]"
                : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
            )}
            onClick={() => setActiveTab("for-me")}
            type="button"
          >
            Approvals for me
            <span className="rounded-full bg-white/25 px-2 py-0.5 text-[11px] font-black">{forMeItems.length}</span>
          </button>
          <button
            className={cn(
              "inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-black transition",
              activeTab === "by-me"
                ? "bg-orange-600 text-white shadow-[0_10px_22px_rgba(234,88,12,0.35)]"
                : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
            )}
            onClick={() => setActiveTab("by-me")}
            type="button"
          >
            Approvals by me
            <span className="rounded-full bg-white/25 px-2 py-0.5 text-[11px] font-black">{byMeItems.length}</span>
          </button>
        </div>
        <div className="mt-5 grid gap-3 rounded-[18px] border border-slate-200/70 bg-slate-50/70 p-3 lg:grid-cols-[1.3fr_1fr_1fr_1fr_auto]">
          <label className="relative block">
            <span className="sr-only">Requester</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              className="h-11 w-full rounded-[14px] border border-slate-200 bg-white pl-9 pr-3 text-sm font-semibold text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-orange-300 focus:ring-4 focus:ring-orange-100"
              onChange={(event) => setPersonFilter(event.target.value)}
              placeholder="Requester or HR ID"
              type="search"
              value={personFilter}
            />
          </label>
          <label className="relative block">
            <span className="sr-only">Approval type</span>
            <Filter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <select
              className="h-11 w-full appearance-none rounded-[14px] border border-slate-200 bg-white pl-9 pr-8 text-sm font-black text-slate-800 outline-none transition focus:border-orange-300 focus:ring-4 focus:ring-orange-100"
              onChange={(event) => setTypeFilter(workflowFromQuery(event.target.value))}
              value={typeFilter}
            >
              <option value="all">All approval types</option>
              {availableFilterOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="relative block">
            <span className="sr-only">Submitted from</span>
            <CalendarDays className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              className="h-11 w-full rounded-[14px] border border-slate-200 bg-white pl-9 pr-3 text-sm font-black text-slate-800 outline-none transition focus:border-orange-300 focus:ring-4 focus:ring-orange-100"
              onChange={(event) => setDateFromFilter(event.target.value)}
              type="date"
              value={dateFromFilter}
            />
          </label>
          <label className="relative block">
            <span className="sr-only">Submitted to</span>
            <CalendarDays className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              className="h-11 w-full rounded-[14px] border border-slate-200 bg-white pl-9 pr-3 text-sm font-black text-slate-800 outline-none transition focus:border-orange-300 focus:ring-4 focus:ring-orange-100"
              onChange={(event) => setDateToFilter(event.target.value)}
              type="date"
              value={dateToFilter}
            />
          </label>
          <button
            className="inline-flex h-11 items-center justify-center rounded-[14px] border border-slate-200 bg-white px-4 text-sm font-black text-slate-700 transition hover:border-orange-200 hover:bg-orange-50 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!hasActiveFilters}
            onClick={clearFilters}
            type="button"
          >
            Clear
          </button>
        </div>
      </section>

      {activeTotalCount === 0 ? (
        <div className="rounded-[22px] border border-dashed border-slate-300 bg-white/80 px-5 py-12 text-center shadow-[0_12px_30px_rgba(15,23,42,0.04)]">
          <p className="text-base font-black text-slate-900">No pending approvals in this tab</p>
          <p className="mt-2 text-sm text-slate-500">New items for this tab will appear here.</p>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="rounded-[22px] border border-dashed border-slate-300 bg-white/80 px-5 py-12 text-center shadow-[0_12px_30px_rgba(15,23,42,0.04)]">
          <p className="text-base font-black text-slate-900">No matching approvals</p>
          <p className="mt-2 text-sm text-slate-500">Adjust the filters to see assigned items.</p>
        </div>
      ) : (
        grouped.map(([label, groupItems]) => (
          <section className="overflow-hidden rounded-[22px] border border-white/80 bg-white/90 shadow-[0_18px_46px_rgba(15,23,42,0.07)] ring-1 ring-slate-200/70 backdrop-blur" key={label}>
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
              <h2 className="text-base font-black text-slate-950">{label}</h2>
              <span className="rounded-full bg-orange-50 px-3 py-1 text-xs font-black text-orange-700 ring-1 ring-orange-100">{groupItems.length}</span>
            </div>
            <div className="divide-y divide-slate-100">
              {groupItems.map((item) => {
                const key = `${item.workflow}:${item.id}`;
                const busy = busyKey === key;
                const canDecide = item.canDecide !== false;
                return (
                  <article className="grid gap-4 px-5 py-4 transition hover:bg-orange-50/40 lg:grid-cols-[1fr_auto]" key={key}>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={cn("rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.12em] ring-1", workflowTone(item.workflow))}>
                          {item.workflowLabel}
                        </span>
                        <span className="text-xs font-semibold text-slate-400">{formatDateTime(item.submittedAt)}</span>
                      </div>
                      <p className="mt-2 text-base font-black text-slate-950">{item.requester}</p>
                      <p className="mt-1 text-sm leading-6 text-slate-600">{item.shortSummary}</p>
                      <p className="mt-2 text-xs font-black uppercase tracking-[0.14em] text-slate-400">{item.currentStep}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                      <Link
                        className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-700 transition hover:border-orange-200 hover:bg-orange-50"
                        href={item.detailHref}
                      >
                        See Details
                      </Link>
                      {canDecide ? (
                        <>
                          <button
                            className="inline-flex items-center justify-center gap-1.5 rounded-full bg-emerald-600 px-3 py-2 text-xs font-black text-white shadow-[0_8px_18px_rgba(5,150,105,0.18)] transition hover:bg-emerald-700 disabled:opacity-60"
                            disabled={busy}
                            onClick={() => void decide(item, "approve")}
                            type="button"
                          >
                            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                            Approve
                          </button>
                          <button
                            className="inline-flex items-center justify-center gap-1.5 rounded-full bg-rose-600 px-3 py-2 text-xs font-black text-white shadow-[0_8px_18px_rgba(225,29,72,0.18)] transition hover:bg-rose-700 disabled:opacity-60"
                            disabled={busy}
                            onClick={() => startReject(item)}
                            type="button"
                          >
                            <XCircle className="h-3.5 w-3.5" />
                            Reject
                          </button>
                        </>
                      ) : (
                        <span className="inline-flex items-center justify-center rounded-full bg-amber-50 px-3 py-2 text-xs font-black text-amber-700 ring-1 ring-amber-100">
                          Waiting
                        </span>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ))
      )}

      {rejectTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="w-full max-w-lg rounded-[22px] border border-slate-200 bg-white p-5 shadow-2xl">
            <h2 className="text-lg font-black text-slate-950">Reject {rejectTarget.workflowLabel}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">{rejectTarget.shortSummary}</p>
            <label className="mt-4 block text-xs font-black uppercase tracking-[0.14em] text-slate-500" htmlFor="reject-comment">
              Comment{rejectTarget.requiresRejectComment ? " required" : ""}
            </label>
            <textarea
              className="mt-2 min-h-28 w-full rounded-[16px] border border-slate-200 px-3 py-2 text-sm text-slate-900 outline-none ring-orange-500/20 focus:ring-4"
              id="reject-comment"
              onChange={(event) => setRejectComment(event.target.value)}
              value={rejectComment}
            />
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-black text-slate-700 hover:bg-slate-50"
                onClick={() => setRejectTarget(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="inline-flex items-center justify-center gap-2 rounded-full bg-rose-600 px-4 py-2 text-sm font-black text-white hover:bg-rose-700 disabled:opacity-60"
                disabled={Boolean(busyKey) || rejectCommentMissing}
                onClick={() => void decide(rejectTarget, "reject", rejectComment)}
                type="button"
              >
                {busyKey ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                Reject
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
