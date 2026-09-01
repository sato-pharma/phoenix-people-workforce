"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import {
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import type { DashboardRow, ProbationDashboard } from "@/lib/probation/intelligence/dashboard";

// CEO exception dashboard: exception-first table of active probation cases with filters, search,
// and sorting. Risk is shown as colour + TEXT LABEL (accessibility). Each row links to the live
// consolidated report (Phase 7).

type FilterKey =
  | "all" | "onTrack" | "atRisk" | "seriousConcern" | "missingDvDays"
  | "pendingFeedback" | "overdueFeedback" | "day30Reached" | "day60Reached"
  | "day75Reached" | "hrPending" | "sfePending" | "contradictionsDetected" | "readyForDecision"
  | "crmUnmapped";

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "onTrack", label: "On Track" },
  { key: "atRisk", label: "At Risk" },
  { key: "seriousConcern", label: "Serious Concern" },
  { key: "missingDvDays", label: "Missing DV Days" },
  { key: "pendingFeedback", label: "Pending Feedback" },
  { key: "overdueFeedback", label: "Overdue Feedback" },
  { key: "day30Reached", label: "Day 30" },
  { key: "day60Reached", label: "Day 60" },
  { key: "day75Reached", label: "Day 75" },
  { key: "hrPending", label: "HR Pending" },
  { key: "sfePending", label: "SFE Pending" },
  { key: "contradictionsDetected", label: "Contradictions" },
  { key: "crmUnmapped", label: "CRM Unmapped" },
  { key: "readyForDecision", label: "Ready for Decision" },
];

const RISK_STYLE: Record<string, string> = {
  red: "bg-rose-50 text-rose-700 border-rose-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  green: "bg-emerald-50 text-emerald-700 border-emerald-200",
  grey: "bg-slate-100 text-slate-600 border-slate-200",
};

const RISK_ORDER: Record<string, number> = { red: 0, amber: 1, grey: 2, green: 3 };

/**
 * `row.risk` in the mobile card's accent colour. It uses the same red/amber/green/grey vocabulary
 * as RISK_STYLE and RISK_ORDER above — NOT the FilterKey names ("atRisk", "seriousConcern"), which
 * is the mistake this constant exists to stop: keyed on those, every card silently fell through to
 * the default and the whole list rendered one colour, which reads as "everybody is fine".
 */
const RISK_ACCENT: Record<string, "rose" | "amber" | "emerald" | "slate"> = {
  amber: "amber",
  green: "emerald",
  grey: "slate",
  red: "rose",
};

type SortKey = "risk" | "daysRemaining" | "score" | "name" | "day";

function matchesFilter(row: DashboardRow, f: FilterKey): boolean {
  if (f === "all") return true;
  if (f === "crmUnmapped") return row.crmUnmapped;
  return Boolean(row.flags[f as keyof typeof row.flags]);
}

export function ProbationDashboardView({ data }: { data: ProbationDashboard }) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("risk");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let r = data.rows.filter((row) => matchesFilter(row, filter));
    if (q) {
      r = r.filter((row) =>
        (row.employeeName ?? row.employeeHrId).toLowerCase().includes(q) ||
        (row.lineName ?? "").toLowerCase().includes(q) ||
        (row.managerName ?? "").toLowerCase().includes(q),
      );
    }
    const sorted = [...r];
    sorted.sort((a, b) => {
      switch (sort) {
        case "daysRemaining": return (a.daysRemaining ?? 999) - (b.daysRemaining ?? 999);
        case "score": return (b.provisionalScore ?? -1) - (a.provisionalScore ?? -1);
        case "name": return (a.employeeName ?? "").localeCompare(b.employeeName ?? "");
        case "day": return (b.currentDay ?? 0) - (a.currentDay ?? 0);
        default: return RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || (a.daysRemaining ?? 999) - (b.daysRemaining ?? 999);
      }
    });
    return sorted;
  }, [data.rows, filter, query, sort]);

  const s = data.summary;

  return (
    <div className="flex flex-col gap-4">
      {s.provisioningFailures > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          <strong>{s.provisioningFailures}</strong> unresolved probation provisioning failure{s.provisioningFailures === 1 ? "" : "s"} — some newly hired employees may have no probation case. Review the provisioning failures log.
        </div>
      )}
      {/* Summary tiles */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
        {[
          { label: "Total", value: s.total, tone: "grey" },
          { label: "On Track", value: s.onTrack, tone: "green" },
          { label: "Action Req.", value: s.actionRequired, tone: "amber" },
          { label: "Deadline Risk", value: s.deadlineRisk, tone: "red" },
          { label: "Ready", value: s.readyForDecision, tone: "green" },
          { label: "Overdue FB", value: s.overdueFeedback, tone: "red" },
          { label: "Contradictions", value: s.contradictions, tone: "amber" },
          { label: "CRM Unmapped", value: s.crmUnmapped, tone: "amber" },
        ].map((t) => (
          <div key={t.label} className={`rounded border p-2 ${RISK_STYLE[t.tone]}`}>
            <div className="text-lg font-semibold">{t.value}</div>
            <div className="text-phx-xs">{t.label}</div>
          </div>
        ))}
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search employee, line, manager…"
          className="h-9 min-w-[220px] flex-1 rounded border border-slate-200 px-3 text-sm"
        />
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="h-9 rounded border border-slate-200 px-2 text-sm">
          <option value="risk">Sort: Risk</option>
          <option value="daysRemaining">Sort: Days remaining</option>
          <option value="score">Sort: Score</option>
          <option value="day">Sort: Probation day</option>
          <option value="name">Sort: Name</option>
        </select>
      </div>

      {/* Filter chips */}
      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-full border px-3 py-1 text-xs ${filter === f.key ? "border-slate-800 bg-slate-800 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Eight columns and a 900px floor, so below `md` this is cards, not a sideways drag — the
          owner's fits-the-screen rule, enforced by tests/hr-shell-mobile-tables.test.ts now that
          this page is a row in the HR sidebar. Read-only pattern (PortalResponsiveDataList) is the
          right one here: a row holds no unsaved edit, because filter, search and sort all live in
          this enclosing component's own state. */}
      <PortalResponsiveDataList
        empty={
          <PortalEmptyState
            message="No probation cases match this filter."
            title="Nothing to show"
          />
        }
        getKey={(row) => String(row.caseId)}
        items={rows}
        renderCard={(row) => (
          <PortalRecordCard
            accent={RISK_ACCENT[row.risk] ?? "slate"}
            actions={
              <Link
                className="inline-flex h-9 items-center justify-center rounded-xl border border-slate-200 px-4 text-sm font-semibold text-blue-600"
                href={`/probation/cases/${row.caseId}`}
              >
                Open report
              </Link>
            }
            meta={
              <span>
                {row.jobTitle ?? "—"} · {row.lineName ?? "—"}
                {row.crmUnmapped ? " · CRM unmapped" : ""}
              </span>
            }
            status={
              <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium ${RISK_STYLE[row.risk]}`}>
                {row.riskLabel}
              </span>
            }
            title={row.employeeName ?? row.employeeHrId}
          >
            <PortalRecordFields
              fields={[
                { label: "Manager", value: row.managerName ?? "—" },
                {
                  label: "Day",
                  value:
                    row.currentDay == null
                      ? "—"
                      : `${row.currentDay}${row.daysRemaining == null ? "" : ` (${row.daysRemaining}d left)`}`,
                },
                {
                  label: "Double visits",
                  value: `${row.dvFeedbackCompleted}/${row.dvRequired}${row.feedbackOverdue > 0 ? ` · ${row.feedbackOverdue} overdue` : ""}`,
                },
                {
                  label: "SFE / HR",
                  value: `SFE ${row.sfeStatus === "submitted" ? "✓" : "—"} · HR ${row.hrStatus === "submitted" ? "✓" : "—"}`,
                },
                {
                  label: "Score",
                  value: `${row.finalScore ?? row.provisionalScore ?? "—"}${row.contradictionsCount > 0 ? ` · ⚠${row.contradictionsCount}` : ""}${row.openActions > 0 ? ` · ${row.openActions} open` : ""}`,
                },
              ]}
            />
          </PortalRecordCard>
        )}
        renderTable={() => (
          <div className="hidden overflow-x-auto rounded-lg border border-slate-200 md:block">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-slate-50 text-left text-phx-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Employee</th>
                  <th className="px-3 py-2">Line / Manager</th>
                  <th className="px-3 py-2">Day</th>
                  <th className="px-3 py-2">DV</th>
                  <th className="px-3 py-2">SFE / HR</th>
                  <th className="px-3 py-2">Score</th>
                  <th className="px-3 py-2">Risk</th>
                  <th className="px-3 py-2">Report</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.caseId} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-slate-800">{row.employeeName ?? row.employeeHrId}</span>
                        {row.crmUnmapped && (
                          <span
                            title="This rep never appears as a CRM agent — Double-Visit credit can't be attributed. Fix the CRM identity mapping; a zero here is a data gap, not poor performance."
                            className="inline-flex items-center rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-phx-2xs font-medium text-amber-700"
                          >
                            CRM unmapped
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-400">{row.jobTitle ?? ""}</div>
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      <div>{row.lineName ?? "—"}</div>
                      <div className="text-xs text-slate-400">{row.managerName ?? "—"}</div>
                    </td>
                    <td className="px-3 py-2 text-slate-700">
                      {row.currentDay ?? "—"}
                      {row.daysRemaining != null && <span className="ml-1 text-xs text-slate-400">({row.daysRemaining}d left)</span>}
                    </td>
                    <td className="px-3 py-2 text-slate-700">
                      {row.dvFeedbackCompleted}/{row.dvRequired}
                      {row.feedbackOverdue > 0 && <span className="ml-1 text-xs text-rose-600">{row.feedbackOverdue} overdue</span>}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className={row.sfeStatus === "submitted" ? "text-emerald-600" : "text-slate-400"}>SFE {row.sfeStatus === "submitted" ? "✓" : "—"}</span>
                      {" · "}
                      <span className={row.hrStatus === "submitted" ? "text-emerald-600" : "text-slate-400"}>HR {row.hrStatus === "submitted" ? "✓" : "—"}</span>
                    </td>
                    <td className="px-3 py-2 text-slate-800">
                      {row.finalScore ?? row.provisionalScore ?? "—"}
                      {row.contradictionsCount > 0 && <span className="ml-1 text-xs text-amber-600">⚠{row.contradictionsCount}</span>}
                      {row.openActions > 0 && (
                        <span className="ml-1 text-xs text-blue-600" title={`${row.openActions} open development action(s)`}>&bull;{row.openActions} act</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium ${RISK_STYLE[row.risk]}`}>
                        {row.riskLabel}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <Link href={`/probation/cases/${row.caseId}`} className="text-xs font-medium text-blue-600 hover:underline">
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      />
      <p className="text-phx-xs text-slate-400">
        {rows.length} of {data.rows.length} cases · generated {data.generatedAt.slice(0, 16).replace("T", " ")}
      </p>
    </div>
  );
}
