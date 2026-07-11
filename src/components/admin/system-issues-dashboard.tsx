"use client";

import { AlertTriangle, CloudOff, Loader2, Search, ServerCog, UsersRound, X } from "lucide-react";
import { useMemo, useState } from "react";

import type { ErrorEventPage } from "@/lib/error-monitor/service";
import type { UserAttemptSummary } from "@/lib/error-monitor/service";
import type { GcpLogFetchResult } from "@/lib/observability/gcp-logs";

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleString("en-GB", {
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      month: "short",
      second: "2-digit",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

type MergedIssueRow = {
  id: string;
  timestamp: string;
  origin: "app" | "gcp";
  severity: string;
  hrId: string | null;
  moduleLabel: string;
  message: string;
  route: string | null;
};

function severityBadgeClasses(severity: string) {
  const upper = severity.toUpperCase();
  if (upper === "CRITICAL" || upper === "ALERT" || upper === "EMERGENCY") {
    return "bg-rose-100 text-rose-700 ring-rose-200";
  }
  if (upper === "ERROR") return "bg-red-50 text-red-600 ring-red-100";
  if (upper === "WARNING") return "bg-amber-50 text-amber-700 ring-amber-100";
  return "bg-slate-100 text-slate-600 ring-slate-200";
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      className={`flex h-10 items-center gap-2 rounded-xl px-4 text-xs font-black transition ${
        active
          ? "bg-[#0B0B0B] text-white shadow-[0_12px_26px_rgba(15,23,42,0.18)]"
          : "border border-[#E2E8F0] bg-white text-[#64748B] hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700"
      }`}
      onClick={onClick}
      type="button"
    >
      {icon}
      {label}
      <span
        className={`rounded-full px-2 py-0.5 text-[10px] ${active ? "bg-white/15 text-white" : "bg-[#F1F5F9] text-[#64748B]"}`}
      >
        {count.toLocaleString("en-US")}
      </span>
    </button>
  );
}

export function SystemIssuesDashboard({
  initialAppErrors,
  initialGcpLogs,
  initialAttempts,
}: {
  initialAppErrors: ErrorEventPage;
  initialGcpLogs: GcpLogFetchResult;
  initialAttempts: UserAttemptSummary;
}) {
  const [activeTab, setActiveTab] = useState<"issues" | "users">("issues");

  const [attempts, setAttempts] = useState<UserAttemptSummary>(initialAttempts);
  const [attemptsLoading, setAttemptsLoading] = useState(false);
  const [hrIdDraft, setHrIdDraft] = useState("");
  const [dateFromDraft, setDateFromDraft] = useState("");
  const [dateToDraft, setDateToDraft] = useState("");

  const mergedIssues: MergedIssueRow[] = useMemo(() => {
    const appRows: MergedIssueRow[] = initialAppErrors.events.map((event) => ({
      hrId: event.hrId,
      id: `app-${event.id}`,
      message: event.message,
      moduleLabel: event.moduleLabel,
      origin: "app",
      route: event.route,
      severity: event.source === "server" ? "ERROR" : "WARNING",
      timestamp: event.createdAt,
    }));
    const gcpRows: MergedIssueRow[] = initialGcpLogs.entries.map((entry) => ({
      hrId: null,
      id: `gcp-${entry.id}`,
      message: entry.message,
      moduleLabel: entry.revision ? `Cloud Run (${entry.revision})` : "Cloud Run",
      origin: "gcp",
      route: null,
      severity: entry.severity,
      timestamp: entry.timestamp,
    }));
    return [...appRows, ...gcpRows].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  }, [initialAppErrors.events, initialGcpLogs.entries]);

  async function fetchAttempts() {
    setAttemptsLoading(true);
    try {
      const params = new URLSearchParams();
      if (hrIdDraft) params.set("hrId", hrIdDraft);
      if (dateFromDraft) params.set("dateFrom", dateFromDraft);
      if (dateToDraft) params.set("dateTo", dateToDraft);
      const res = await fetch(`/api/admin/system-issues/attempts?${params.toString()}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Failed to fetch attempt summary");
      }
      const result = (await res.json()) as UserAttemptSummary;
      setAttempts(result);
    } catch (err) {
      console.error(err);
    } finally {
      setAttemptsLoading(false);
    }
  }

  function clearAttemptFilters() {
    setHrIdDraft("");
    setDateFromDraft("");
    setDateToDraft("");
    setAttemptsLoading(true);
    fetch("/api/admin/system-issues/attempts")
      .then((res) => res.json())
      .then((result: UserAttemptSummary) => setAttempts(result))
      .catch((err) => console.error(err))
      .finally(() => setAttemptsLoading(false));
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        <TabButton
          active={activeTab === "issues"}
          count={mergedIssues.length}
          icon={<ServerCog className="h-3.5 w-3.5" />}
          label="Issues & Errors"
          onClick={() => setActiveTab("issues")}
        />
        <TabButton
          active={activeTab === "users"}
          count={attempts.rows.length}
          icon={<UsersRound className="h-3.5 w-3.5" />}
          label="Per-User Attempts"
          onClick={() => setActiveTab("users")}
        />
      </div>

      {activeTab === "issues" ? (
        <div className="space-y-4">
          {!initialGcpLogs.available && (
            <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-800">
              <CloudOff className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="text-xs font-semibold">
                <p>GCP Cloud Logging is not connected — showing Supabase application errors only.</p>
                <p className="mt-1 font-mono font-normal text-amber-700">{initialGcpLogs.error}</p>
              </div>
            </div>
          )}
          <div className="overflow-hidden rounded-3xl border border-[#E2E8F0] bg-white/95 shadow-[0_18px_42px_rgba(15,23,42,0.07)]">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1000px]">
                <thead>
                  <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                    {["Time", "Origin", "Severity", "HR ID", "Module", "Message", "Route"].map((h) => (
                      <th
                        className="px-5 py-4 text-left text-[10px] font-black uppercase tracking-widest text-[#64748B]"
                        key={h}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F1F5F9]">
                  {mergedIssues.length === 0 ? (
                    <tr>
                      <td className="px-5 py-8 text-center text-sm text-[#64748B]" colSpan={7}>
                        No issues found.
                      </td>
                    </tr>
                  ) : (
                    mergedIssues.map((row) => (
                      <tr className="transition-colors hover:bg-orange-50/35" key={row.id}>
                        <td className="whitespace-nowrap px-5 py-4 font-mono text-xs font-semibold text-[#64748B]">
                          {formatDate(row.timestamp)}
                        </td>
                        <td className="px-5 py-4">
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ring-1 ${
                              row.origin === "app"
                                ? "bg-sky-50 text-sky-700 ring-sky-100"
                                : "bg-violet-50 text-violet-700 ring-violet-100"
                            }`}
                          >
                            {row.origin === "app" ? "App (Supabase)" : "GCP Infra"}
                          </span>
                        </td>
                        <td className="px-5 py-4">
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ring-1 ${severityBadgeClasses(row.severity)}`}
                          >
                            {row.severity}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-5 py-4 text-sm font-bold text-[#0F172A]">
                          {row.hrId ?? "-"}
                        </td>
                        <td className="px-5 py-4 text-sm text-[#64748B]">{row.moduleLabel}</td>
                        <td className="max-w-lg px-5 py-4 text-sm font-medium text-[#0F172A]">
                          <span className="line-clamp-2">{row.message}</span>
                        </td>
                        <td className="max-w-xs px-5 py-4 font-mono text-xs text-[#64748B]">
                          <span className="line-clamp-1">{row.route ?? "-"}</span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {attempts.truncated && (
            <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="text-xs font-semibold">
                Row cap reached while aggregating — narrow the date range for a fully accurate count.
              </p>
            </div>
          )}
          <div className="rounded-3xl border border-[#E2E8F0] bg-white/95 p-5 shadow-[0_18px_42px_rgba(15,23,42,0.07)]">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#64748B]" />
                <input
                  className="h-10 w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] pl-8 pr-3 text-xs font-semibold text-[#0F172A] placeholder:text-[#64748B] focus:outline-none focus:ring-2 focus:ring-[#F97316]/30"
                  onChange={(e) => setHrIdDraft(e.target.value)}
                  placeholder="HR ID..."
                  value={hrIdDraft}
                />
              </div>
              <input
                className="h-10 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-xs font-semibold text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#F97316]/30"
                onChange={(e) => setDateFromDraft(e.target.value)}
                type="date"
                value={dateFromDraft}
              />
              <input
                className="h-10 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-xs font-semibold text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#F97316]/30"
                onChange={(e) => setDateToDraft(e.target.value)}
                type="date"
                value={dateToDraft}
              />
              <div className="flex gap-2">
                <button
                  className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#0B0B0B] px-4 text-xs font-black text-white shadow-[0_12px_26px_rgba(15,23,42,0.18)] transition hover:bg-[#F97316] disabled:opacity-50"
                  disabled={attemptsLoading}
                  onClick={fetchAttempts}
                  type="button"
                >
                  {attemptsLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                  Apply
                </button>
                <button
                  className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-[#E2E8F0] bg-white px-3 text-xs font-black text-[#64748B] transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700"
                  onClick={clearAttemptFilters}
                  type="button"
                >
                  <X className="h-3.5 w-3.5" />
                  Clear
                </button>
              </div>
            </div>
          </div>

          <div className="overflow-hidden rounded-3xl border border-[#E2E8F0] bg-white/95 shadow-[0_18px_42px_rgba(15,23,42,0.07)]">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1100px]">
                <thead>
                  <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                    {["HR ID", "Type", "Module", "Route", "Attempts", "First Seen", "Last Seen", "Sample"].map((h) => (
                      <th
                        className="px-5 py-4 text-left text-[10px] font-black uppercase tracking-widest text-[#64748B]"
                        key={h}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F1F5F9]">
                  {attemptsLoading ? (
                    <tr>
                      <td className="px-5 py-8 text-center text-sm text-[#64748B]" colSpan={8}>
                        <Loader2 className="mx-auto h-5 w-5 animate-spin text-[#F97316]" />
                      </td>
                    </tr>
                  ) : attempts.rows.length === 0 ? (
                    <tr>
                      <td className="px-5 py-8 text-center text-sm text-[#64748B]" colSpan={8}>
                        No attempts found.
                      </td>
                    </tr>
                  ) : (
                    attempts.rows.map((row) => (
                      <tr
                        className="transition-colors hover:bg-orange-50/35"
                        key={`${row.hrId}|${row.category}|${row.moduleKey}|${row.route ?? ""}`}
                      >
                        <td className="whitespace-nowrap px-5 py-4 text-sm font-bold text-[#0F172A]">{row.hrId}</td>
                        <td className="px-5 py-4">
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ring-1 ${
                              row.category === "app_error"
                                ? "bg-sky-50 text-sky-700 ring-sky-100"
                                : "bg-rose-50 text-rose-700 ring-rose-100"
                            }`}
                          >
                            {row.category === "app_error" ? "App Error" : "Failed Login"}
                          </span>
                        </td>
                        <td className="px-5 py-4 text-sm text-[#64748B]">{row.moduleLabel}</td>
                        <td className="max-w-xs px-5 py-4 font-mono text-xs text-[#64748B]">
                          <span className="line-clamp-1">{row.route ?? "-"}</span>
                        </td>
                        <td className="whitespace-nowrap px-5 py-4 text-sm font-black text-[#0F172A]">
                          {row.attemptCount.toLocaleString("en-US")}
                        </td>
                        <td className="whitespace-nowrap px-5 py-4 font-mono text-xs text-[#64748B]">
                          {formatDate(row.firstSeen)}
                        </td>
                        <td className="whitespace-nowrap px-5 py-4 font-mono text-xs text-[#64748B]">
                          {formatDate(row.lastSeen)}
                        </td>
                        <td className="max-w-sm px-5 py-4 text-sm text-[#0F172A]">
                          <span className="line-clamp-1">{row.sampleMessage}</span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
