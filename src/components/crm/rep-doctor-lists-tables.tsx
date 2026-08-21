"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import {
  coverageAccent,
  coverageBar,
  coverageText,
  frequencyBar,
  frequencyText,
} from "@/components/crm/rep-doctor-kpi-tone";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { SortableTh, TableSearchInput } from "@/components/ui/sortable-table";
import { useSortableTable } from "@/components/ui/use-sortable-table";
import type {
  RepDoctorFrequencyStatus,
  RepDoctorListDoctorRow,
  RepDoctorListFilters,
  RepDoctorListRepRow,
  RepDoctorStatus,
} from "@/lib/crm/rep-doctor-lists";

// Client half of Rep Doctor Lists. Styling copies the Doctor Coverage tables verbatim
// (doctor-coverage-tables.tsx) — flat borders, slate-900 header rows, orange accents — because
// this board sits directly beside it in the same shell and must not read as a one-off.
//
// Every control is a URL parameter, so each change re-runs the server-side access gate rather than
// filtering a payload already in the browser. Month and filters move TOGETHER for the reason the
// sibling documents: pushing `?month=` alone silently dropped an active filter.
//
// Desktop table / mobile cards via PortalResponsiveDataList — AGENTS.md §4. The sibling board moved
// the same way on 2026-08-21 and the two must stay identical; a 10-column table side-scrolling
// inside a phone is what this replaces.

const THEAD = "px-3 py-2.5 text-[10px] font-black uppercase tracking-[0.12em] text-white";
const SELECT_CLASS =
  "h-9 w-full border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400";
const LABEL_CLASS = "block text-[9px] font-black uppercase tracking-[0.16em] text-slate-400";

const STATUS_LABEL: Record<RepDoctorStatus, string> = {
  missed: "Never visited",
  off_plan: "Off plan",
  seen: "Visited",
};

const STATUS_ACCENT: Record<RepDoctorStatus, "emerald" | "amber" | "rose"> = {
  missed: "rose",
  off_plan: "amber",
  seen: "emerald",
};

const STATUS_TEXT: Record<RepDoctorStatus, string> = {
  missed: "text-rose-700",
  off_plan: "text-amber-700",
  seen: "text-emerald-700",
};

const FREQUENCY_LABEL: Record<RepDoctorFrequencyStatus, string> = {
  missed: "Never visited",
  not_due: "Not due yet",
  off_plan: "Off plan",
  on_plan: "On plan",
  over: "Over plan",
  under: "Under plan",
};

const FREQUENCY_TEXT: Record<RepDoctorFrequencyStatus, string> = {
  missed: "text-rose-700",
  not_due: "text-slate-400",
  off_plan: "text-amber-700",
  on_plan: "text-emerald-700",
  // Over-visiting is a deviation on the owner's rule, not a bonus — it must never read as a pass.
  over: "text-sky-700",
  under: "text-amber-700",
};

const KIND_LABEL: Record<string, string> = {
  hcp: "Account",
  sp: "Doctor",
  unclassified: "Unclassified",
};

export function RepDoctorListsControls({
  applied,
  basePath,
  month,
  repOptions,
}: {
  applied: RepDoctorListFilters;
  basePath: string;
  month: string;
  repOptions: Array<{ repKey: string; repName: string }>;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState({
    frequency: applied.frequency ?? "",
    kind: applied.kind ?? "",
    month,
    rep: applied.repKey ?? "",
    search: applied.search ?? "",
    status: applied.status ?? "",
  });
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const active = Boolean(applied.frequency || applied.kind || applied.repKey || applied.search || applied.status);

  const push = (next: typeof draft) => {
    const params = new URLSearchParams();
    params.set("month", next.month);
    if (next.frequency) params.set("frequency", next.frequency);
    if (next.kind) params.set("kind", next.kind);
    if (next.rep) params.set("rep", next.rep);
    if (next.status) params.set("status", next.status);
    if (next.search.trim()) params.set("search", next.search.trim());
    router.push(`${basePath}?${params.toString()}`);
  };

  const clearAll = () => {
    const cleared = { frequency: "", kind: "", month: draft.month, rep: "", search: "", status: "" };
    setDraft(cleared);
    push(cleared);
  };

  // Pulls the displayed month's plan from the vendor, then re-renders the server component so the
  // new rows appear without a manual reload. Failures are shown in words, never swallowed — a
  // silent no-op here would look identical to "the CRM has no plan for this month".
  const refresh = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncMessage(null);
    try {
      const response = await fetch("/api/crm/rep-doctor-lists/sync", {
        body: JSON.stringify({ month: draft.month }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; result?: { agents: number; contacts: number; upserted: number } }
        | null;
      if (!response.ok) {
        setSyncMessage(payload?.error ?? `The CRM refused the request (HTTP ${response.status}).`);
        return;
      }
      const result = payload?.result;
      setSyncMessage(
        result
          ? `Pulled ${result.upserted} planned calls — ${result.agents} reps, ${result.contacts} contacts.`
          : "Refreshed.",
      );
      router.refresh();
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : "The refresh could not reach the CRM.");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <label className="space-y-1">
          <span className={LABEL_CLASS}>Month</span>
          <input
            className={SELECT_CLASS}
            onChange={(event) => setDraft({ ...draft, month: event.target.value })}
            type="month"
            value={draft.month}
          />
        </label>

        <label className="space-y-1">
          <span className={LABEL_CLASS}>Rep</span>
          <select className={SELECT_CLASS} onChange={(e) => setDraft({ ...draft, rep: e.target.value })} value={draft.rep}>
            <option value="">All reps</option>
            {repOptions.map((rep) => (
              <option key={rep.repKey} value={rep.repKey}>
                {rep.repName}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1">
          <span className={LABEL_CLASS}>Status</span>
          <select className={SELECT_CLASS} onChange={(e) => setDraft({ ...draft, status: e.target.value })} value={draft.status}>
            <option value="">All statuses</option>
            <option value="missed">Never visited</option>
            <option value="seen">Visited</option>
            <option value="off_plan">Off plan</option>
          </select>
        </label>

        <label className="space-y-1">
          <span className={LABEL_CLASS}>Frequency</span>
          <select
            className={SELECT_CLASS}
            onChange={(e) => setDraft({ ...draft, frequency: e.target.value })}
            value={draft.frequency}
          >
            <option value="">All frequencies</option>
            <option value="on_plan">On plan</option>
            <option value="under">Under plan</option>
            <option value="over">Over plan</option>
            <option value="missed">Never visited</option>
            <option value="not_due">Not due yet</option>
            <option value="off_plan">Off plan</option>
          </select>
        </label>

        <label className="space-y-1">
          <span className={LABEL_CLASS}>Type</span>
          <select className={SELECT_CLASS} onChange={(e) => setDraft({ ...draft, kind: e.target.value })} value={draft.kind}>
            <option value="">Doctors &amp; accounts</option>
            <option value="sp">Doctors only</option>
            <option value="hcp">Accounts only</option>
            <option value="unclassified">Unclassified only</option>
          </select>
        </label>

        <label className="space-y-1">
          <span className={LABEL_CLASS}>Search</span>
          <input
            className={SELECT_CLASS}
            onChange={(event) => setDraft({ ...draft, search: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") push(draft);
            }}
            placeholder="Doctor, specialty or rep"
            type="search"
            value={draft.search}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          className="h-9 border border-slate-200 bg-slate-900 px-4 text-[11px] font-black uppercase tracking-[0.12em] text-white hover:bg-slate-700"
          onClick={() => push(draft)}
          type="button"
        >
          Apply
        </button>
        {active ? (
          <button
            className="h-9 border border-slate-200 bg-white px-4 text-[11px] font-black uppercase tracking-[0.12em] text-slate-600 hover:border-orange-400"
            onClick={clearAll}
            type="button"
          >
            Clear filters
          </button>
        ) : null}
        <button
          className="inline-flex h-9 items-center gap-2 border border-slate-200 bg-white px-4 text-[11px] font-black uppercase tracking-[0.12em] text-slate-600 hover:border-orange-400 disabled:opacity-50"
          disabled={syncing}
          onClick={refresh}
          type="button"
        >
          {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {syncing ? "Pulling from CRM" : "Refresh from CRM"}
        </button>
        {syncMessage ? (
          <span className="whitespace-nowrap text-[11px] font-semibold text-slate-500">{syncMessage}</span>
        ) : null}
        {active ? (
          <span className="whitespace-nowrap text-[11px] font-semibold text-amber-700">
            Filtered — every figure below counts only the matching rows.
          </span>
        ) : null}
      </div>
    </div>
  );
}

const REP_COLS = [
  { accessor: (r: RepDoctorListRepRow) => r.repName, defaultDir: "asc" as const, key: "repName", type: "string" as const },
  { accessor: (r: RepDoctorListRepRow) => r.plannedDoctors, key: "plannedDoctors", type: "number" as const },
  { accessor: (r: RepDoctorListRepRow) => r.visitedDoctors, key: "visitedDoctors", type: "number" as const },
  { accessor: (r: RepDoctorListRepRow) => r.missedDoctors, key: "missedDoctors", type: "number" as const },
  { accessor: (r: RepDoctorListRepRow) => r.coveragePct, key: "coveragePct", type: "number" as const },
  { accessor: (r: RepDoctorListRepRow) => r.frequencyPct, key: "frequencyPct", type: "number" as const },
  { accessor: (r: RepDoctorListRepRow) => r.onPlanDoctors, key: "onPlanDoctors", type: "number" as const },
  { accessor: (r: RepDoctorListRepRow) => r.underDoctors, key: "underDoctors", type: "number" as const },
  { accessor: (r: RepDoctorListRepRow) => r.overDoctors, key: "overDoctors", type: "number" as const },
  { accessor: (r: RepDoctorListRepRow) => r.offPlanDoctors, key: "offPlanDoctors", type: "number" as const },
  { accessor: (r: RepDoctorListRepRow) => r.campaignCalls, key: "campaignCalls", type: "number" as const },
  { accessor: (r: RepDoctorListRepRow) => r.plannedAccounts, key: "plannedAccounts", type: "number" as const },
  { accessor: (r: RepDoctorListRepRow) => r.gradeA, key: "gradeA", type: "number" as const },
  { accessor: (r: RepDoctorListRepRow) => r.underPlannedVsGrade, key: "underPlannedVsGrade", type: "number" as const },
  { accessor: (r: RepDoctorListRepRow) => r.unverifiedCalls, key: "unverifiedCalls", type: "number" as const },
];

export function RepDoctorListsRepTable({ month, rows }: { month: string; rows: RepDoctorListRepRow[] }) {
  const table = useSortableTable(rows, {
    columns: REP_COLS,
    initialSort: { dir: "asc", key: "coveragePct" },
    searchAccessors: [(r) => r.repName, (r) => r.agentHrId ?? ""],
  });

  const exportRows = table.rows.map((row) => ({
    a_b_c: `${row.gradeA} / ${row.gradeB} / ${row.gradeC}`,
    accounts: row.plannedAccounts,
    campaign_calls: row.campaignCalls,
    // Blank, never 0, for a rep with no plan — a 0 in a spreadsheet column headed "Coverage %"
    // outlives every caveat on the screen it was exported from.
    coverage: row.hasMeasurablePlan ? row.coveragePct : "",
    frequency: row.hasMeasurablePlan ? row.frequencyPct : "",
    hr_id: row.agentHrId ?? "",
    missed: row.missedDoctors,
    off_plan: row.offPlanDoctors,
    on_plan: row.onPlanDoctors,
    over: row.overDoctors,
    planned: row.plannedDoctors,
    rep: row.repName,
    under: row.underDoctors,
    under_vs_grade: row.underPlannedVsGrade,
    unverified: row.unverifiedCalls,
    visited: row.visitedDoctors,
  }));

  return (
    <div className="space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TableSearchInput onChange={table.setQuery} onClear={table.clearQuery} placeholder="Search rep…" value={table.query} />
        <ExportXlsxButton
          columns={[
            { key: "rep", label: "Rep" },
            { key: "hr_id", label: "HR ID" },
            { key: "planned", label: "Doctors On List", numeric: true },
            { key: "visited", label: "Visited", numeric: true },
            { key: "missed", label: "Never Visited", numeric: true },
            { key: "coverage", label: "Coverage %", numeric: true },
            { key: "frequency", label: "Frequency %", numeric: true },
            { key: "on_plan", label: "On Plan", numeric: true },
            { key: "under", label: "Under Plan", numeric: true },
            { key: "over", label: "Over Plan", numeric: true },
            { key: "off_plan", label: "Off Plan", numeric: true },
            { key: "accounts", label: "Accounts On List", numeric: true },
            { key: "a_b_c", label: "A / B / C" },
            { key: "under_vs_grade", label: "Planned Below Grade", numeric: true },
            { key: "unverified", label: "Unverified Calls", numeric: true },
          ]}
          rows={exportRows}
          sheetName="Rep Doctor Lists"
          subtitle={month}
          title="Rep Doctor Lists — by rep"
        />
      </div>
      <PortalResponsiveDataList
        empty={
          <p className="px-3 py-6 text-center text-xs text-slate-400">
            No rep has a doctor list for this month. Press Refresh from CRM to pull it.
          </p>
        }
        getKey={(row) => row.repKey}
        items={table.rows}
        renderCard={(row) => (
          <PortalRecordCard
            accent={row.hasMeasurablePlan ? coverageAccent(row.coveragePct) : "slate"}
            meta={`${row.plannedDoctors} on list · ${row.plannedAccounts} accounts`}
            // BOTH KPIs sit in the badge, labelled, because neither one answers the owner's question
            // on its own: coverage says he touched the doctor, frequency says he touched him the
            // right number of times, and a rep can be 100% on the first and 70% on the second.
            //
            // A rep with no planned doctors has no percentage to show. Printing 0% here states
            // "reached none of their list" about someone who was never given one -- so the card
            // says so in words instead, exactly as the desktop cell does.
            status={
              row.hasMeasurablePlan ? (
                <span className="flex items-start gap-3">
                  <span className="flex flex-col items-end leading-tight">
                    <span className={`text-sm font-black ${coverageText(row.coveragePct)}`}>{row.coveragePct}%</span>
                    <span className="whitespace-nowrap text-[8px] font-black uppercase tracking-[0.12em] text-slate-400">
                      Coverage
                    </span>
                  </span>
                  <span className="flex flex-col items-end leading-tight">
                    <span className={`text-sm font-black ${frequencyText(row.frequencyPct)}`}>{row.frequencyPct}%</span>
                    <span className="whitespace-nowrap text-[8px] font-black uppercase tracking-[0.12em] text-slate-400">
                      Frequency
                    </span>
                  </span>
                </span>
              ) : (
                <span className="whitespace-nowrap text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400">
                  No plan
                </span>
              )
            }
            title={row.repName}
          >
            <PortalRecordFields
              fields={[
                { label: "Visited", value: <span className="text-emerald-700">{row.visitedDoctors}</span> },
                {
                  label: "Never visited",
                  value: <span className={row.missedDoctors > 0 ? "text-rose-700" : "text-slate-400"}>{row.missedDoctors}</span>,
                },
                { label: "On plan", value: <span className="text-emerald-700">{row.onPlanDoctors}</span> },
                // Under and over share one field on the card. Both are deviations on the owner's
                // rule, and splitting them into two of six slots would crowd out the context that
                // makes them readable.
                {
                  label: "Under / over",
                  value: (
                    <span className="whitespace-nowrap">
                      <span className={row.underDoctors > 0 ? "text-amber-700" : "text-slate-400"}>{row.underDoctors}</span>
                      <span className="text-slate-300"> / </span>
                      <span className={row.overDoctors > 0 ? "text-sky-700" : "text-slate-400"}>{row.overDoctors}</span>
                    </span>
                  ),
                },
                {
                  label: "Off plan",
                  value: <span className={row.offPlanDoctors > 0 ? "text-amber-700" : "text-slate-400"}>{row.offPlanDoctors}</span>,
                },
                // Campaign calls prove the rep worked but name no doctor, so they sit BESIDE both
                // KPIs and never inside either — same rule the desktop column follows.
                {
                  label: "Campaign",
                  value: <span className={row.campaignCalls > 0 ? "text-sky-700" : "text-slate-400"}>{row.campaignCalls}</span>,
                },
                { label: "A / B / C", value: `${row.gradeA} / ${row.gradeB} / ${row.gradeC}` },
                {
                  label: "Unverified",
                  value: <span className={row.unverifiedCalls > 0 ? "text-amber-700" : "text-slate-400"}>{row.unverifiedCalls}</span>,
                },
              ]}
            />
          </PortalRecordCard>
        )}
        renderTable={() => (
          <PortalDesktopTable className="text-xs" minWidth="1440px">
            <thead>
              <tr className="bg-slate-900 text-left">
                <SortableTh className={THEAD} label="Rep" onSort={table.toggleSort} sort={table.sort} sortKey="repName" />
                <SortableTh align="right" className={`${THEAD} text-right`} label="On List" onSort={table.toggleSort} sort={table.sort} sortKey="plannedDoctors" />
                <SortableTh align="right" className={`${THEAD} text-right text-emerald-300`} label="Visited" onSort={table.toggleSort} sort={table.sort} sortKey="visitedDoctors" />
                <SortableTh align="right" className={`${THEAD} text-right text-rose-300`} label="Never Visited" onSort={table.toggleSort} sort={table.sort} sortKey="missedDoctors" />
                <SortableTh align="right" className={`${THEAD} text-right`} label="Coverage" onSort={table.toggleSort} sort={table.sort} sortKey="coveragePct" />
                <SortableTh align="right" className={`${THEAD} text-right`} label="Frequency" onSort={table.toggleSort} sort={table.sort} sortKey="frequencyPct" />
                <SortableTh align="right" className={`${THEAD} text-right text-emerald-300`} label="On Plan" onSort={table.toggleSort} sort={table.sort} sortKey="onPlanDoctors" />
                <SortableTh align="right" className={`${THEAD} text-right text-amber-300`} label="Under" onSort={table.toggleSort} sort={table.sort} sortKey="underDoctors" />
                <SortableTh align="right" className={`${THEAD} text-right text-sky-300`} label="Over" onSort={table.toggleSort} sort={table.sort} sortKey="overDoctors" />
                <SortableTh align="right" className={`${THEAD} text-right text-amber-300`} label="Off Plan" onSort={table.toggleSort} sort={table.sort} sortKey="offPlanDoctors" />
                <SortableTh align="right" className={`${THEAD} text-right`} label="Campaign" onSort={table.toggleSort} sort={table.sort} sortKey="campaignCalls" />
                <SortableTh align="right" className={`${THEAD} text-right`} label="Accounts" onSort={table.toggleSort} sort={table.sort} sortKey="plannedAccounts" />
                <SortableTh align="right" className={`${THEAD} text-right`} label="A / B / C" onSort={table.toggleSort} sort={table.sort} sortKey="gradeA" />
                <SortableTh align="right" className={`${THEAD} text-right`} label="Below Grade" onSort={table.toggleSort} sort={table.sort} sortKey="underPlannedVsGrade" />
                <SortableTh align="right" className={`${THEAD} text-right`} label="Unverified" onSort={table.toggleSort} sort={table.sort} sortKey="unverifiedCalls" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {table.rows.map((row) => (
                <tr className="whitespace-nowrap bg-white hover:bg-slate-50" key={row.repKey}>
                  <td className="px-3 py-2 font-semibold text-slate-900">{row.repName}</td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-900">{row.plannedDoctors}</td>
                  <td className="px-3 py-2 text-right font-bold text-emerald-700">{row.visitedDoctors}</td>
                  <td className={`px-3 py-2 text-right font-bold ${row.missedDoctors > 0 ? "text-rose-700" : "text-slate-400"}`}>
                    {row.missedDoctors}
                  </td>
                  {/* A rep with no planned doctors has no percentage to show. Printing 0% here
                      states "reached none of their list" about someone who was never given one --
                      so the bar is suppressed and the cell says so instead. Both KPI cells follow
                      the same rule; they are never independently measurable. */}
                  <td className="px-3 py-2">
                    {row.hasMeasurablePlan ? (
                      <div className="flex items-center justify-end gap-2">
                        <div className="h-1 w-16 bg-slate-100">
                          <div
                            className={`h-full ${coverageBar(row.coveragePct)}`}
                            style={{ width: `${Math.max(2, row.coveragePct)}%` }}
                          />
                        </div>
                        <span className={`min-w-[34px] text-right font-black ${coverageText(row.coveragePct)}`}>
                          {row.coveragePct}%
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-center justify-end">
                        <span className="whitespace-nowrap text-right text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400">
                          No plan
                        </span>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {row.hasMeasurablePlan ? (
                      <div className="flex items-center justify-end gap-2">
                        <div className="h-1 w-16 bg-slate-100">
                          <div
                            className={`h-full ${frequencyBar(row.frequencyPct)}`}
                            style={{ width: `${Math.max(2, row.frequencyPct)}%` }}
                          />
                        </div>
                        <span className={`min-w-[34px] text-right font-black ${frequencyText(row.frequencyPct)}`}>
                          {row.frequencyPct}%
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-center justify-end">
                        <span className="whitespace-nowrap text-right text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400">
                          No plan
                        </span>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-bold text-emerald-700">{row.onPlanDoctors}</td>
                  <td className={`px-3 py-2 text-right font-bold ${row.underDoctors > 0 ? "text-amber-700" : "text-slate-400"}`}>
                    {row.underDoctors}
                  </td>
                  {/* Over-visiting is a deviation, not an achievement — the owner's rule is an exact
                      match. Sky rather than green so it can never be read as a pass. */}
                  <td className={`px-3 py-2 text-right font-bold ${row.overDoctors > 0 ? "text-sky-700" : "text-slate-400"}`}>
                    {row.overDoctors}
                  </td>
                  <td className={`px-3 py-2 text-right font-bold ${row.offPlanDoctors > 0 ? "text-amber-700" : "text-slate-400"}`}>
                    {row.offPlanDoctors}
                  </td>
                  {/* Campaign calls prove the rep worked but name no doctor, so they sit BESIDE both
                      KPIs and never inside either. Without this column a rep who spent the month
                      on campaign work reads as a flat zero. */}
                  <td className={`px-3 py-2 text-right ${row.campaignCalls > 0 ? "text-sky-700 font-bold" : "text-slate-400"}`}>
                    {row.campaignCalls}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-600">{row.plannedAccounts}</td>
                  <td className="px-3 py-2 text-right text-slate-600">
                    {row.gradeA} / {row.gradeB} / {row.gradeC}
                  </td>
                  {/* Doctors whose PLAN asks for fewer calls than their grade norm — a signal about
                      the plan, not about the rep, and never inside either percentage. */}
                  <td className={`px-3 py-2 text-right ${row.underPlannedVsGrade > 0 ? "text-amber-700" : "text-slate-400"}`}>
                    {row.underPlannedVsGrade}
                  </td>
                  <td className={`px-3 py-2 text-right ${row.unverifiedCalls > 0 ? "text-amber-700" : "text-slate-400"}`}>
                    {row.unverifiedCalls}
                  </td>
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />
    </div>
  );
}

const STATUS_SEVERITY: Record<RepDoctorStatus, number> = { missed: 0, off_plan: 1, seen: 2 };

// Sort order for the frequency column: worst first, so the default view opens on the problems. A
// doctor who is not due yet sorts last — he is not a finding.
const FREQUENCY_SEVERITY: Record<RepDoctorFrequencyStatus, number> = {
  missed: 0,
  under: 1,
  over: 2,
  off_plan: 3,
  on_plan: 4,
  not_due: 5,
};

const DOCTOR_COLS = [
  { accessor: (r: RepDoctorListDoctorRow) => r.contactName, defaultDir: "asc" as const, key: "contactName", type: "string" as const },
  { accessor: (r: RepDoctorListDoctorRow) => r.gradeRaw, key: "gradeRaw", type: "string" as const },
  { accessor: (r: RepDoctorListDoctorRow) => r.speciality, key: "speciality", type: "string" as const },
  { accessor: (r: RepDoctorListDoctorRow) => r.regionName, key: "regionName", type: "string" as const },
  { accessor: (r: RepDoctorListDoctorRow) => r.repName, key: "repName", type: "string" as const },
  { accessor: (r: RepDoctorListDoctorRow) => r.plannedCalls, key: "plannedCalls", type: "number" as const },
  { accessor: (r: RepDoctorListDoctorRow) => r.plannedCallsToDate, key: "plannedCallsToDate", type: "number" as const },
  { accessor: (r: RepDoctorListDoctorRow) => r.visits, key: "visits", type: "number" as const },
  // Sorted on the signed delta, not on the status, so "furthest off plan in either direction" is one
  // click. The status column below sorts on severity instead.
  { accessor: (r: RepDoctorListDoctorRow) => r.frequencyDelta, defaultDir: "asc" as const, key: "frequencyDelta", type: "number" as const },
  { accessor: (r: RepDoctorListDoctorRow) => FREQUENCY_SEVERITY[r.frequencyStatus], defaultDir: "asc" as const, key: "frequencyStatus", type: "number" as const },
  { accessor: (r: RepDoctorListDoctorRow) => STATUS_SEVERITY[r.status], defaultDir: "asc" as const, key: "status", type: "number" as const },
  { accessor: (r: RepDoctorListDoctorRow) => r.lastVisitDate, key: "lastVisitDate", type: "string" as const },
];

export function RepDoctorListsDoctorTable({ month, rows }: { month: string; rows: RepDoctorListDoctorRow[] }) {
  const table = useSortableTable(rows, {
    columns: DOCTOR_COLS,
    initialSort: { dir: "asc", key: "status" },
    searchAccessors: [(r) => r.contactName, (r) => r.speciality ?? "", (r) => r.repName],
  });

  const exportRows = table.rows.map((row) => ({
    delta: row.frequencyDelta,
    doctor: row.contactName,
    frequency: FREQUENCY_LABEL[row.frequencyStatus],
    grade: row.gradeRaw ?? "",
    grade_norm: row.gradeNormCalls ?? "",
    last_visit: row.lastVisitDate ?? "",
    planned: row.plannedCalls,
    planned_to_date: row.plannedCallsToDate,
    region: row.regionName ?? "",
    rep: row.repName,
    speciality: row.speciality ?? "",
    status: STATUS_LABEL[row.status],
    type: KIND_LABEL[row.kind] ?? row.kind,
    visits: row.visits,
  }));

  return (
    <div className="space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TableSearchInput onChange={table.setQuery} onClear={table.clearQuery} placeholder="Search doctor…" value={table.query} />
        <ExportXlsxButton
          columns={[
            { key: "doctor", label: "Doctor" },
            { key: "grade", label: "Grade" },
            { key: "speciality", label: "Specialty" },
            { key: "type", label: "Type" },
            { key: "region", label: "Locality" },
            { key: "rep", label: "Rep" },
            { key: "planned", label: "Planned Calls", numeric: true },
            { key: "planned_to_date", label: "Planned To Date", numeric: true },
            { key: "visits", label: "Visits", numeric: true },
            { key: "delta", label: "Visits vs Plan", numeric: true },
            { key: "frequency", label: "Frequency" },
            { key: "grade_norm", label: "Grade Norm", numeric: true },
            { key: "status", label: "Coverage" },
            { key: "last_visit", label: "Last Visit" },
          ]}
          rows={exportRows}
          sheetName="Doctor List"
          subtitle={month}
          title="Rep Doctor Lists — doctor by doctor"
        />
      </div>
      <PortalResponsiveDataList
        empty={<p className="px-3 py-6 text-center text-xs text-slate-400">No doctors match this filter.</p>}
        getKey={(row) => `${row.repKey}:${row.contactCrmId}:${row.status}`}
        items={table.rows}
        renderCard={(row) => (
          <PortalRecordCard
            accent={STATUS_ACCENT[row.status]}
            meta={`${row.speciality ?? "Unspecified"} · ${KIND_LABEL[row.kind] ?? row.kind}`}
            status={
              <span className={`text-[10px] font-black uppercase tracking-[0.1em] ${STATUS_TEXT[row.status]}`}>
                {STATUS_LABEL[row.status]}
              </span>
            }
            title={row.contactName}
          >
            <PortalRecordFields
              fields={[
                { label: "Grade", value: row.gradeRaw ?? "—" },
                { label: "Locality", value: row.regionName ?? "—" },
                { label: "Rep", value: row.repName },
                // The owner's own framing — "he planned three times, did he visit three times". Plan
                // first, actual second, in the whole-month terms he thinks in; the to-date nuance is
                // carried by the frequency status beneath rather than by changing this number.
                {
                  label: "Plan / done",
                  value: (
                    <span className="whitespace-nowrap">
                      <span className="text-slate-600">{row.plannedCalls}</span>
                      <span className="text-slate-300"> / </span>
                      <span className={row.visits > 0 ? "text-emerald-700" : "text-slate-400"}>{row.visits}</span>
                    </span>
                  ),
                },
                {
                  label: "Frequency",
                  value: (
                    <span className={`whitespace-nowrap font-bold ${FREQUENCY_TEXT[row.frequencyStatus]}`}>
                      {FREQUENCY_LABEL[row.frequencyStatus]}
                    </span>
                  ),
                },
                { label: "Last Visit", value: row.lastVisitDate ?? "Never" },
              ]}
            />
          </PortalRecordCard>
        )}
        renderTable={() => (
          <PortalDesktopTable className="text-xs" minWidth="1260px">
            <thead>
              <tr className="bg-slate-900 text-left">
                <SortableTh className={THEAD} label="Doctor" onSort={table.toggleSort} sort={table.sort} sortKey="contactName" />
                <SortableTh className={THEAD} label="Grade" onSort={table.toggleSort} sort={table.sort} sortKey="gradeRaw" />
                <SortableTh className={THEAD} label="Specialty" onSort={table.toggleSort} sort={table.sort} sortKey="speciality" />
                <SortableTh className={THEAD} label="Locality" onSort={table.toggleSort} sort={table.sort} sortKey="regionName" />
                <SortableTh className={THEAD} label="Rep" onSort={table.toggleSort} sort={table.sort} sortKey="repName" />
                <SortableTh align="right" className={`${THEAD} text-right`} label="Planned" onSort={table.toggleSort} sort={table.sort} sortKey="plannedCalls" />
                <SortableTh align="right" className={`${THEAD} text-right`} label="Due" onSort={table.toggleSort} sort={table.sort} sortKey="plannedCallsToDate" />
                <SortableTh align="right" className={`${THEAD} text-right`} label="Visits" onSort={table.toggleSort} sort={table.sort} sortKey="visits" />
                <SortableTh align="right" className={`${THEAD} text-right`} label="+/-" onSort={table.toggleSort} sort={table.sort} sortKey="frequencyDelta" />
                <SortableTh className={THEAD} label="Frequency" onSort={table.toggleSort} sort={table.sort} sortKey="frequencyStatus" />
                <SortableTh className={THEAD} label="Coverage" onSort={table.toggleSort} sort={table.sort} sortKey="status" />
                <SortableTh className={THEAD} label="Last Visit" onSort={table.toggleSort} sort={table.sort} sortKey="lastVisitDate" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {table.rows.map((row) => (
                <tr className="whitespace-nowrap bg-white hover:bg-slate-50" key={`${row.repKey}:${row.contactCrmId}:${row.status}`}>
                  <td className="px-3 py-2 font-semibold text-slate-900">{row.contactName}</td>
                  <td
                    className={`px-3 py-2 font-black ${row.gradeRaw === "A" || row.gradeRaw === "A+" ? "text-rose-700" : row.gradeRaw === "B" ? "text-amber-700" : "text-slate-400"}`}
                  >
                    {row.gradeRaw ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{row.speciality ?? "Unspecified"}</td>
                  <td className="px-3 py-2 text-slate-400">{row.regionName ?? "—"}</td>
                  <td className="px-3 py-2 font-medium text-slate-700">{row.repName}</td>
                  <td className="px-3 py-2 text-right text-slate-600">{row.plannedCalls}</td>
                  {/* Calls the plan has already asked for. Equal to Planned once the month closes;
                      it is the number Visits is actually judged against mid-month, so it is shown
                      rather than left implicit inside the status. */}
                  <td
                    className={`px-3 py-2 text-right ${row.plannedCallsToDate < row.plannedCalls ? "text-slate-600" : "text-slate-300"}`}
                  >
                    {row.plannedCallsToDate}
                  </td>
                  <td className={`px-3 py-2 text-right font-bold ${row.visits > 0 ? "text-emerald-700" : "text-slate-400"}`}>
                    {row.visits}
                  </td>
                  {/* Signed on purpose: "how far off, and which way" is the whole question. An exact
                      match shows a dash rather than a 0, so the exceptions are what the eye finds. */}
                  <td className={`px-3 py-2 text-right font-bold ${FREQUENCY_TEXT[row.frequencyStatus]}`}>
                    {row.frequencyDelta === 0 ? (
                      <span className="text-slate-300">—</span>
                    ) : (
                      `${row.frequencyDelta > 0 ? "+" : ""}${row.frequencyDelta}`
                    )}
                  </td>
                  <td className={`px-3 py-2 font-bold ${FREQUENCY_TEXT[row.frequencyStatus]}`}>
                    {FREQUENCY_LABEL[row.frequencyStatus]}
                  </td>
                  <td className={`px-3 py-2 font-bold ${STATUS_TEXT[row.status]}`}>{STATUS_LABEL[row.status]}</td>
                  <td className="px-3 py-2 text-slate-400">{row.lastVisitDate ?? "Never"}</td>
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />
    </div>
  );
}
