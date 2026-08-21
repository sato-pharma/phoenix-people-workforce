"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { SortableTh, TableSearchInput } from "@/components/ui/sortable-table";
import { useSortableTable } from "@/components/ui/use-sortable-table";
import type {
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

const THEAD = "px-3 py-2.5 text-[10px] font-black uppercase tracking-[0.12em] text-white";
const SELECT_CLASS =
  "h-9 w-full border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400";
const LABEL_CLASS = "block text-[9px] font-black uppercase tracking-[0.16em] text-slate-400";

const STATUS_LABEL: Record<RepDoctorStatus, string> = {
  missed: "Never visited",
  off_plan: "Off plan",
  seen: "Visited",
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
    kind: applied.kind ?? "",
    month,
    rep: applied.repKey ?? "",
    search: applied.search ?? "",
    status: applied.status ?? "",
  });
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const active = Boolean(applied.kind || applied.repKey || applied.search || applied.status);

  const push = (next: typeof draft) => {
    const params = new URLSearchParams();
    params.set("month", next.month);
    if (next.kind) params.set("kind", next.kind);
    if (next.rep) params.set("rep", next.rep);
    if (next.status) params.set("status", next.status);
    if (next.search.trim()) params.set("search", next.search.trim());
    router.push(`${basePath}?${params.toString()}`);
  };

  const clearAll = () => {
    const cleared = { kind: "", month: draft.month, rep: "", search: "", status: "" };
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
  { accessor: (r: RepDoctorListRepRow) => r.adherencePct, key: "adherencePct", type: "number" as const },
  { accessor: (r: RepDoctorListRepRow) => r.offPlanDoctors, key: "offPlanDoctors", type: "number" as const },
  { accessor: (r: RepDoctorListRepRow) => r.campaignCalls, key: "campaignCalls", type: "number" as const },
  { accessor: (r: RepDoctorListRepRow) => r.plannedAccounts, key: "plannedAccounts", type: "number" as const },
  { accessor: (r: RepDoctorListRepRow) => r.gradeA, key: "gradeA", type: "number" as const },
  { accessor: (r: RepDoctorListRepRow) => r.unverifiedCalls, key: "unverifiedCalls", type: "number" as const },
];

export function RepDoctorListsRepTable({ month, rows }: { month: string; rows: RepDoctorListRepRow[] }) {
  const table = useSortableTable(rows, {
    columns: REP_COLS,
    initialSort: { dir: "asc", key: "adherencePct" },
    searchAccessors: [(r) => r.repName, (r) => r.agentHrId ?? ""],
  });

  const exportRows = table.rows.map((row) => ({
    a_b_c: `${row.gradeA} / ${row.gradeB} / ${row.gradeC}`,
    accounts: row.plannedAccounts,
    adherence: row.hasMeasurablePlan ? row.adherencePct : "",
    campaign_calls: row.campaignCalls,
    hr_id: row.agentHrId ?? "",
    missed: row.missedDoctors,
    off_plan: row.offPlanDoctors,
    planned: row.plannedDoctors,
    rep: row.repName,
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
            { key: "adherence", label: "Adherence %", numeric: true },
            { key: "off_plan", label: "Off Plan", numeric: true },
            { key: "accounts", label: "Accounts On List", numeric: true },
            { key: "a_b_c", label: "A / B / C" },
            { key: "unverified", label: "Unverified Calls", numeric: true },
          ]}
          rows={exportRows}
          sheetName="Rep Doctor Lists"
          subtitle={month}
          title="Rep Doctor Lists — by rep"
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-slate-900 text-left">
              <SortableTh className={THEAD} label="Rep" onSort={table.toggleSort} sort={table.sort} sortKey="repName" />
              <SortableTh align="right" className={`${THEAD} text-right`} label="On List" onSort={table.toggleSort} sort={table.sort} sortKey="plannedDoctors" />
              <SortableTh align="right" className={`${THEAD} text-right text-emerald-300`} label="Visited" onSort={table.toggleSort} sort={table.sort} sortKey="visitedDoctors" />
              <SortableTh align="right" className={`${THEAD} text-right text-rose-300`} label="Never Visited" onSort={table.toggleSort} sort={table.sort} sortKey="missedDoctors" />
              <SortableTh align="right" className={`${THEAD} text-right`} label="Adherence" onSort={table.toggleSort} sort={table.sort} sortKey="adherencePct" />
              <SortableTh align="right" className={`${THEAD} text-right text-amber-300`} label="Off Plan" onSort={table.toggleSort} sort={table.sort} sortKey="offPlanDoctors" />
              <SortableTh align="right" className={`${THEAD} text-right`} label="Campaign" onSort={table.toggleSort} sort={table.sort} sortKey="campaignCalls" />
              <SortableTh align="right" className={`${THEAD} text-right`} label="Accounts" onSort={table.toggleSort} sort={table.sort} sortKey="plannedAccounts" />
              <SortableTh align="right" className={`${THEAD} text-right`} label="A / B / C" onSort={table.toggleSort} sort={table.sort} sortKey="gradeA" />
              <SortableTh align="right" className={`${THEAD} text-right`} label="Unverified" onSort={table.toggleSort} sort={table.sort} sortKey="unverifiedCalls" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {table.rows.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-center text-xs text-slate-400" colSpan={10}>
                  No rep has a doctor list for this month. Press Refresh from CRM to pull it.
                </td>
              </tr>
            ) : (
              table.rows.map((row) => (
                <tr className="whitespace-nowrap bg-white hover:bg-slate-50" key={row.repKey}>
                  <td className="px-3 py-2 font-semibold text-slate-900">{row.repName}</td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-900">{row.plannedDoctors}</td>
                  <td className="px-3 py-2 text-right font-bold text-emerald-700">{row.visitedDoctors}</td>
                  <td className={`px-3 py-2 text-right font-bold ${row.missedDoctors > 0 ? "text-rose-700" : "text-slate-400"}`}>
                    {row.missedDoctors}
                  </td>
                  {/* A rep with no planned doctors has no percentage to show. Printing 0% here
                      states "reached none of their list" about someone who was never given one --
                      so the bar is suppressed and the cell says so instead. */}
                  <td className="px-3 py-2">
                    {row.hasMeasurablePlan ? (
                      <div className="flex items-center justify-end gap-2">
                        <div className="h-1 w-16 bg-slate-100">
                          <div
                            className={`h-full ${row.adherencePct >= 80 ? "bg-emerald-500" : row.adherencePct >= 50 ? "bg-amber-400" : "bg-rose-400"}`}
                            style={{ width: `${Math.max(2, row.adherencePct)}%` }}
                          />
                        </div>
                        <span
                          className={`min-w-[34px] text-right font-black ${row.adherencePct >= 80 ? "text-emerald-700" : row.adherencePct >= 50 ? "text-amber-700" : "text-rose-700"}`}
                        >
                          {row.adherencePct}%
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
                  <td className={`px-3 py-2 text-right font-bold ${row.offPlanDoctors > 0 ? "text-amber-700" : "text-slate-400"}`}>
                    {row.offPlanDoctors}
                  </td>
                  {/* Campaign calls prove the rep worked but name no doctor, so they sit BESIDE
                      adherence and never inside it. Without this column a rep who spent the month
                      on campaign work reads as a flat zero. */}
                  <td className={`px-3 py-2 text-right ${row.campaignCalls > 0 ? "text-sky-700 font-bold" : "text-slate-400"}`}>
                    {row.campaignCalls}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-600">{row.plannedAccounts}</td>
                  <td className="px-3 py-2 text-right text-slate-600">
                    {row.gradeA} / {row.gradeB} / {row.gradeC}
                  </td>
                  <td className={`px-3 py-2 text-right ${row.unverifiedCalls > 0 ? "text-amber-700" : "text-slate-400"}`}>
                    {row.unverifiedCalls}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const STATUS_SEVERITY: Record<RepDoctorStatus, number> = { missed: 0, off_plan: 1, seen: 2 };

const DOCTOR_COLS = [
  { accessor: (r: RepDoctorListDoctorRow) => r.contactName, defaultDir: "asc" as const, key: "contactName", type: "string" as const },
  { accessor: (r: RepDoctorListDoctorRow) => r.gradeRaw, key: "gradeRaw", type: "string" as const },
  { accessor: (r: RepDoctorListDoctorRow) => r.speciality, key: "speciality", type: "string" as const },
  { accessor: (r: RepDoctorListDoctorRow) => r.regionName, key: "regionName", type: "string" as const },
  { accessor: (r: RepDoctorListDoctorRow) => r.repName, key: "repName", type: "string" as const },
  { accessor: (r: RepDoctorListDoctorRow) => r.plannedCalls, key: "plannedCalls", type: "number" as const },
  { accessor: (r: RepDoctorListDoctorRow) => r.visits, key: "visits", type: "number" as const },
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
    doctor: row.contactName,
    grade: row.gradeRaw ?? "",
    last_visit: row.lastVisitDate ?? "",
    planned: row.plannedCalls,
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
            { key: "visits", label: "Visits", numeric: true },
            { key: "status", label: "Status" },
            { key: "last_visit", label: "Last Visit" },
          ]}
          rows={exportRows}
          sheetName="Doctor List"
          subtitle={month}
          title="Rep Doctor Lists — doctor by doctor"
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-slate-900 text-left">
              <SortableTh className={THEAD} label="Doctor" onSort={table.toggleSort} sort={table.sort} sortKey="contactName" />
              <SortableTh className={THEAD} label="Grade" onSort={table.toggleSort} sort={table.sort} sortKey="gradeRaw" />
              <SortableTh className={THEAD} label="Specialty" onSort={table.toggleSort} sort={table.sort} sortKey="speciality" />
              <SortableTh className={THEAD} label="Locality" onSort={table.toggleSort} sort={table.sort} sortKey="regionName" />
              <SortableTh className={THEAD} label="Rep" onSort={table.toggleSort} sort={table.sort} sortKey="repName" />
              <SortableTh align="right" className={`${THEAD} text-right`} label="Planned" onSort={table.toggleSort} sort={table.sort} sortKey="plannedCalls" />
              <SortableTh align="right" className={`${THEAD} text-right`} label="Visits" onSort={table.toggleSort} sort={table.sort} sortKey="visits" />
              <SortableTh className={THEAD} label="Status" onSort={table.toggleSort} sort={table.sort} sortKey="status" />
              <SortableTh className={THEAD} label="Last Visit" onSort={table.toggleSort} sort={table.sort} sortKey="lastVisitDate" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {table.rows.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-center text-xs text-slate-400" colSpan={9}>
                  No doctors match this filter.
                </td>
              </tr>
            ) : (
              table.rows.map((row) => (
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
                  <td className={`px-3 py-2 text-right font-bold ${row.visits > 0 ? "text-emerald-700" : "text-slate-400"}`}>
                    {row.visits}
                  </td>
                  <td
                    className={`px-3 py-2 font-bold ${row.status === "missed" ? "text-rose-700" : row.status === "off_plan" ? "text-amber-700" : "text-emerald-700"}`}
                  >
                    {STATUS_LABEL[row.status]}
                  </td>
                  <td className="px-3 py-2 text-slate-400">{row.lastVisitDate ?? "Never"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
