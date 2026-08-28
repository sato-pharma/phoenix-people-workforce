"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { Fragment, useMemo, useState } from "react";

import {
  PortalDesktopTable,
  PortalPagination,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { SortableTh, TableSearchInput } from "@/components/ui/sortable-table";
import { useSortableTable } from "@/components/ui/use-sortable-table";
import type {
  DoctorCoverageDoctorRow,
  DoctorCoverageManagerRow,
  DoctorCoverageRepRow,
  DoctorCoverageStatus,
} from "@/lib/crm/sfe-doctor-coverage";

// Client half of the Doctor Coverage board: the two sortable tables.
// Styling copies the CEO/SFE table vocabulary verbatim (ceo-dv-table.tsx) — flat borders,
// slate-900 header rows, orange accents; the admin shell forces radius-0 and black thead globally.
//
// MonthPicker lived here until 2026-08-09 and is now doctor-coverage-filter-bar.tsx. It pushed
// `?month=` ALONE, so changing the month with a filter active silently dropped the filter and the
// board showed something other than what the controls said. Month and filters must move together.
//
// Desktop gets the full table, mobile gets cards — AGENTS.md §4, and not a cosmetic point here:
// this board is mounted at /employee-portals/doctor-coverage as well as the admin route, so a rep
// opens it on a phone. Until 2026-08-21 both tables sat in a bare `overflow-x-auto` at every width,
// which meant a ~700px table side-scrolling inside a 375px screen. PortalResponsiveDataList is the
// same primitive the other 44 responsive files use — never hand-roll a second one.
//
// The doctor drill-down is the bulk of the board's rows — a company-wide "all lines" panel runs
// into the thousands. Measured on production 2026-08-21: BOTH /admin/doctor-coverage and
// /employee-portals/doctor-coverage shipped ~19MB of HTML because PortalResponsiveDataList renders
// every row twice (card markup AND table markup, CSS-hides one half) with no cap, so all ~7,175
// doctors were serialised into both halves on every load — a Medical Rep on mobile data paid for
// it regardless of which half showed. Paginated client-side, same PAGE_SIZE/PortalPagination
// pattern as marketing-customer-database.tsx and my-visits-workspace.tsx: only the current page's
// rows are ever rendered into either half, so the shipped markup drops from ~7,175 rows to
// PAGE_SIZE. Search, sort, status filter, and the xlsx export still operate over the FULL `rows`
// prop — only what gets drawn on screen is windowed. The rep table stays unpaginated; it holds one
// row per rep (~100), nowhere near the doctor count.

const REP_THEAD = "px-3 py-2.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-white";
const DOCTOR_PAGE_SIZE = 25;

/** What a rep with NO graded panel shows where a percentage would go. An em dash, never "0%" and
 * never an empty cell: the owner's standing rule is that text is never truncated or elided, and a
 * blank would read as a missing value rather than a deliberate "nothing to score here". */
const NO_PANEL_MARKER = "—";

// Coverage tone lives in one place so the mobile card and the desktop meter can never disagree
// about where 50% and 80% sit.
const coverageAccent = (pct: number): "amber" | "emerald" | "rose" =>
  pct >= 80 ? "emerald" : pct >= 50 ? "amber" : "rose";
const coverageText = (pct: number) =>
  pct >= 80 ? "text-emerald-700" : pct >= 50 ? "text-amber-700" : "text-rose-700";
const coverageBar = (pct: number) => (pct >= 80 ? "bg-emerald-500" : pct >= 50 ? "bg-amber-400" : "bg-rose-400");

const REP_COLS = [
  { accessor: (r: DoctorCoverageRepRow) => r.repName, defaultDir: "asc" as const, key: "repName", type: "string" as const },
  { accessor: (r: DoctorCoverageRepRow) => r.panelSize, key: "panelSize", type: "number" as const },
  { accessor: (r: DoctorCoverageRepRow) => r.green, key: "green", type: "number" as const },
  { accessor: (r: DoctorCoverageRepRow) => r.yellow, key: "yellow", type: "number" as const },
  { accessor: (r: DoctorCoverageRepRow) => r.red, key: "red", type: "number" as const },
  {
    // NULL, not 0, for a rep with no assigned list. `useSortableTable` sinks a missing value to the
    // bottom in BOTH directions, which is the only way to honour the core's rule that "a rep with
    // NO panel is not a 0% performer and must never head that ranking" — the core sorts them last,
    // and this hook re-sorts the array the moment it mounts, so a plain `0` put every rep with no
    // list straight back at the top of a worst-first table.
    accessor: (r: DoctorCoverageRepRow) => (r.hasPanel ? r.coveragePct : null),
    key: "coveragePct",
    type: "number" as const,
  },
  { accessor: (r: DoctorCoverageRepRow) => r.offListDoctors, key: "offListDoctors", type: "number" as const },
  { accessor: (r: DoctorCoverageRepRow) => r.campaignCalls, key: "campaignCalls", type: "number" as const },
  { accessor: (r: DoctorCoverageRepRow) => r.aDoctors, key: "aDoctors", type: "number" as const },
];

export function DoctorCoverageRepTable({ rows }: { rows: DoctorCoverageRepRow[] }) {
  const table = useSortableTable(rows, {
    columns: REP_COLS,
    initialSort: { dir: "asc", key: "coveragePct" },
    searchAccessors: [(r) => r.repName, (r) => r.agentHrId ?? ""],
  });

  return (
    <div className="space-y-3 p-5">
      <TableSearchInput
        onChange={table.setQuery}
        onClear={table.clearQuery}
        placeholder="Search rep…"
        value={table.query}
      />
      <PortalResponsiveDataList
        empty={<p className="px-3 py-6 text-center text-xs text-slate-400">No assigned doctor lists in this month.</p>}
        getKey={(row) => row.repKey}
        items={table.rows}
        renderCard={(row) => (
          <PortalRecordCard
            accent={row.hasPanel ? coverageAccent(row.coveragePct) : "slate"}
            meta={
              row.hasPanel
                ? `${row.panelSize} assigned ${row.panelSize === 1 ? "doctor" : "doctors"} on the list`
                : "No assigned list this month — work counted beside coverage"
            }
            status={
              row.hasPanel ? (
                <span className={`text-sm font-black ${coverageText(row.coveragePct)}`}>{row.coveragePct}%</span>
              ) : (
                <span className="text-sm font-black text-slate-400">{NO_PANEL_MARKER}</span>
              )
            }
            title={row.repName}
          >
            <PortalRecordFields
              fields={[
                { label: "Covered", value: <span className="text-emerald-700">{row.green}</span> },
                {
                  label: "Under-visited",
                  value: <span className={row.yellow > 0 ? "text-amber-700" : "text-slate-400"}>{row.yellow}</span>,
                },
                {
                  label: "Not visited",
                  value: <span className={row.red > 0 ? "text-rose-700" : "text-slate-400"}>{row.red}</span>,
                },
                { label: "A / B / C", value: `${row.aDoctors} / ${row.bDoctors} / ${row.cDoctors}` },
                {
                  label: "Off-list visits",
                  value: (
                    <span className={row.offListDoctors > 0 ? "text-sky-700" : "text-slate-400"}>
                      {row.offListDoctors}
                    </span>
                  ),
                },
                {
                  label: "Campaign calls",
                  value: (
                    <span className={row.campaignCalls > 0 ? "text-sky-700" : "text-slate-400"}>{row.campaignCalls}</span>
                  ),
                },
              ]}
            />
          </PortalRecordCard>
        )}
        renderTable={() => (
          <PortalDesktopTable className="text-xs" minWidth="940px">
            <thead>
              <tr className="bg-slate-900 text-left">
                <SortableTh className={REP_THEAD} label="Rep" onSort={table.toggleSort} sort={table.sort} sortKey="repName" />
                <SortableTh align="right" className={`${REP_THEAD} text-right`} label="Panel" onSort={table.toggleSort} sort={table.sort} sortKey="panelSize" />
                <SortableTh align="right" className={`${REP_THEAD} text-right text-emerald-300`} label="Covered" onSort={table.toggleSort} sort={table.sort} sortKey="green" />
                <SortableTh align="right" className={`${REP_THEAD} text-right text-amber-300`} label="Under" onSort={table.toggleSort} sort={table.sort} sortKey="yellow" />
                <SortableTh align="right" className={`${REP_THEAD} text-right text-rose-300`} label="Not seen" onSort={table.toggleSort} sort={table.sort} sortKey="red" />
                <SortableTh align="right" className={`${REP_THEAD} text-right`} label="Coverage" onSort={table.toggleSort} sort={table.sort} sortKey="coveragePct" />
                <SortableTh align="right" className={`${REP_THEAD} text-right text-sky-300`} label="Off-list" onSort={table.toggleSort} sort={table.sort} sortKey="offListDoctors" />
                <SortableTh align="right" className={`${REP_THEAD} text-right text-sky-300`} label="Campaign" onSort={table.toggleSort} sort={table.sort} sortKey="campaignCalls" />
                <SortableTh align="right" className={`${REP_THEAD} text-right`} label="A / B / C" onSort={table.toggleSort} sort={table.sort} sortKey="aDoctors" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {table.rows.map((row) => (
                <tr className="bg-white hover:bg-slate-50" key={row.repKey}>
                  <td className="whitespace-nowrap px-3 py-2 font-semibold text-slate-900">{row.repName}</td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-900">{row.panelSize}</td>
                  <td className="px-3 py-2 text-right font-bold text-emerald-700">{row.green}</td>
                  <td className={`px-3 py-2 text-right font-bold ${row.yellow > 0 ? "text-amber-700" : "text-slate-400"}`}>{row.yellow}</td>
                  <td className={`px-3 py-2 text-right font-bold ${row.red > 0 ? "text-rose-700" : "text-slate-400"}`}>{row.red}</td>
                  <td className="px-3 py-2">
                    {/* A rep with no graded panel has nothing to score. Printing 0% here would say
                        they covered none of their doctors, when the truth is they have none — and
                        for a rep whose month was campaign work, that reads as idle. Marker, not a
                        number. Same treatment Rep Doctor Lists gives a rep with no measurable plan. */}
                    {row.hasPanel ? (
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
                      <div className="flex items-center justify-end gap-2">
                        <span className="text-right text-phx-xs font-semibold text-slate-400">No assigned list</span>
                        <span className="min-w-[34px] text-right font-black text-slate-400">{NO_PANEL_MARKER}</span>
                      </div>
                    )}
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-bold ${row.offListDoctors > 0 ? "text-sky-700" : "text-slate-400"}`}
                  >
                    {row.offListDoctors}
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-bold ${row.campaignCalls > 0 ? "text-sky-700" : "text-slate-400"}`}
                  >
                    {row.campaignCalls}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-600">
                    {row.aDoctors} / {row.bDoctors} / {row.cDoctors}
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

// ── Districts ────────────────────────────────────────────────────────────────────────────────
//
// OWNER'S RULING 2026-08-27: "the district manager doesn't have a list. The list of the district
// manager is the list of his teams." So this table scores a manager on his team's combined list,
// and every row opens to show the reps it is made of — which is the shape he asked for in the same
// breath: one screen where you can open a district and see the reps inside it.
//
// Two groups, told apart STRUCTURALLY by `isDistrict` rather than by job title. The districts get
// the full sortable table; the National Sales Managers and the Regional Manager get a compact strip
// underneath, because expanding one of those would just redraw the rep table.
//
// The CEO used to sit in that strip and no longer does. He is the top of the reporting tree, so the
// walk reached him from every rep and gave him a row carrying whatever the board was scoped to as
// though it were his own assigned doctor list. Owner, 2026-08-28: "the CEO ... He never assigned to
// visits." He is dropped structurally in sfe-doctor-coverage.ts, and a scoped viewer no longer gets
// rows for anyone above his own seat either.

const DISTRICT_COLS = [
  {
    accessor: (r: DoctorCoverageManagerRow) => r.managerName,
    defaultDir: "asc" as const,
    key: "managerName",
    type: "string" as const,
  },
  { accessor: (r: DoctorCoverageManagerRow) => r.teamSize, key: "teamSize", type: "number" as const },
  { accessor: (r: DoctorCoverageManagerRow) => r.panelSize, key: "panelSize", type: "number" as const },
  { accessor: (r: DoctorCoverageManagerRow) => r.green, key: "green", type: "number" as const },
  { accessor: (r: DoctorCoverageManagerRow) => r.yellow, key: "yellow", type: "number" as const },
  { accessor: (r: DoctorCoverageManagerRow) => r.red, key: "red", type: "number" as const },
  // Same null-for-no-panel rule as the rep table above, and for the same reason.
  {
    accessor: (r: DoctorCoverageManagerRow) => (r.hasPanel ? r.coveragePct : null),
    key: "coveragePct",
    type: "number" as const,
  },
  { accessor: (r: DoctorCoverageManagerRow) => r.offListDoctors, key: "offListDoctors", type: "number" as const },
  { accessor: (r: DoctorCoverageManagerRow) => r.campaignCalls, key: "campaignCalls", type: "number" as const },
];

function CoverageMeter({ hasPanel, pct }: { hasPanel: boolean; pct: number }) {
  if (!hasPanel) {
    return (
      <div className="flex items-center justify-end gap-2">
        <span className="text-right text-phx-xs font-semibold text-slate-400">No assigned list</span>
        <span className="min-w-[34px] text-right font-black text-slate-400">{NO_PANEL_MARKER}</span>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1 w-16 bg-slate-100">
        <div className={`h-full ${coverageBar(pct)}`} style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      <span className={`min-w-[34px] text-right font-black ${coverageText(pct)}`}>{pct}%</span>
    </div>
  );
}

export function DoctorCoverageDistrictTable({
  managers,
  reps,
}: {
  managers: DoctorCoverageManagerRow[];
  reps: DoctorCoverageRepRow[];
}) {
  const districts = useMemo(() => managers.filter((row) => row.isDistrict), [managers]);
  const regions = useMemo(() => managers.filter((row) => !row.isDistrict), [managers]);
  const repByKey = useMemo(() => new Map(reps.map((rep) => [rep.repKey, rep])), [reps]);
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(() => new Set<string>());
  const toggleOpen = (managerKey: string) =>
    setOpenKeys((current) => {
      const next = new Set(current);
      if (next.has(managerKey)) next.delete(managerKey);
      else next.add(managerKey);
      return next;
    });

  const table = useSortableTable(districts, {
    columns: DISTRICT_COLS,
    initialSort: { dir: "asc", key: "coveragePct" },
    searchAccessors: [(r) => r.managerName, (r) => r.title ?? ""],
  });

  const teamOf = (row: DoctorCoverageManagerRow) =>
    row.teamRepKeys.map((repKey) => repByKey.get(repKey)).filter((rep): rep is DoctorCoverageRepRow => Boolean(rep));

  return (
    <div className="space-y-3 p-5">
      <TableSearchInput
        onChange={table.setQuery}
        onClear={table.clearQuery}
        placeholder="Search district or manager…"
        value={table.query}
      />
      <PortalResponsiveDataList
        empty={<p className="px-3 py-6 text-center text-xs text-slate-400">No districts in this month.</p>}
        getKey={(row) => row.managerKey}
        items={table.rows}
        renderCard={(row) => {
          const isOpen = openKeys.has(row.managerKey);
          const team = teamOf(row);
          return (
            <PortalRecordCard
              accent={row.hasPanel ? coverageAccent(row.coveragePct) : "slate"}
              actions={
                <button
                  aria-expanded={isOpen}
                  className="flex items-center gap-1 border border-slate-200 px-2 py-1 text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-600"
                  onClick={() => toggleOpen(row.managerKey)}
                  type="button"
                >
                  {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  {row.teamSize} {row.teamSize === 1 ? "rep" : "reps"}
                </button>
              }
              meta={
                row.hasPanel
                  ? `${row.panelSize} assigned ${row.panelSize === 1 ? "doctor" : "doctors"} across the team`
                  : "No rep on this team holds an assigned list this month"
              }
              status={
                row.hasPanel ? (
                  <span className={`text-sm font-black ${coverageText(row.coveragePct)}`}>{row.coveragePct}%</span>
                ) : (
                  <span className="text-sm font-black text-slate-400">{NO_PANEL_MARKER}</span>
                )
              }
              title={row.managerName}
            >
              <PortalRecordFields
                fields={[
                  { label: "Role", value: row.title ?? "Not recorded" },
                  { label: "Covered", value: <span className="text-emerald-700">{row.green}</span> },
                  {
                    label: "Under-visited",
                    value: <span className={row.yellow > 0 ? "text-amber-700" : "text-slate-400"}>{row.yellow}</span>,
                  },
                  {
                    label: "Not visited",
                    value: <span className={row.red > 0 ? "text-rose-700" : "text-slate-400"}>{row.red}</span>,
                  },
                  {
                    label: "Off-list visits",
                    value: (
                      <span className={row.offListDoctors > 0 ? "text-sky-700" : "text-slate-400"}>
                        {row.offListDoctors}
                      </span>
                    ),
                  },
                  {
                    label: "Campaign calls",
                    value: (
                      <span className={row.campaignCalls > 0 ? "text-sky-700" : "text-slate-400"}>
                        {row.campaignCalls}
                      </span>
                    ),
                  },
                ]}
              />
              {isOpen ? (
                <div className="mt-3 divide-y divide-slate-100 border-t border-slate-100">
                  {team.length === 0 ? (
                    <p className="py-3 text-xs text-slate-400">No rep rows on this board for this district.</p>
                  ) : (
                    team.map((rep) => (
                      <div className="flex items-center justify-between gap-3 py-2" key={rep.repKey}>
                        <span className="min-w-0 text-xs font-semibold text-slate-700">{rep.repName}</span>
                        <span className="shrink-0 text-phx-xs font-bold text-slate-500">
                          {rep.hasPanel ? `${rep.green} / ${rep.panelSize}` : "No assigned list"}
                        </span>
                        <span
                          className={`shrink-0 text-xs font-black ${rep.hasPanel ? coverageText(rep.coveragePct) : "text-slate-400"}`}
                        >
                          {rep.hasPanel ? `${rep.coveragePct}%` : NO_PANEL_MARKER}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              ) : null}
            </PortalRecordCard>
          );
        }}
        renderTable={() => (
          <PortalDesktopTable className="text-xs" minWidth="980px">
            <thead>
              <tr className="bg-slate-900 text-left">
                <SortableTh className={REP_THEAD} label="District" onSort={table.toggleSort} sort={table.sort} sortKey="managerName" />
                <SortableTh align="right" className={`${REP_THEAD} text-right`} label="Reps" onSort={table.toggleSort} sort={table.sort} sortKey="teamSize" />
                <SortableTh align="right" className={`${REP_THEAD} text-right`} label="Team panel" onSort={table.toggleSort} sort={table.sort} sortKey="panelSize" />
                <SortableTh align="right" className={`${REP_THEAD} text-right text-emerald-300`} label="Covered" onSort={table.toggleSort} sort={table.sort} sortKey="green" />
                <SortableTh align="right" className={`${REP_THEAD} text-right text-amber-300`} label="Under" onSort={table.toggleSort} sort={table.sort} sortKey="yellow" />
                <SortableTh align="right" className={`${REP_THEAD} text-right text-rose-300`} label="Not seen" onSort={table.toggleSort} sort={table.sort} sortKey="red" />
                <SortableTh align="right" className={`${REP_THEAD} text-right`} label="Coverage" onSort={table.toggleSort} sort={table.sort} sortKey="coveragePct" />
                <SortableTh align="right" className={`${REP_THEAD} text-right text-sky-300`} label="Off-list" onSort={table.toggleSort} sort={table.sort} sortKey="offListDoctors" />
                <SortableTh align="right" className={`${REP_THEAD} text-right text-sky-300`} label="Campaign" onSort={table.toggleSort} sort={table.sort} sortKey="campaignCalls" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {table.rows.map((row) => {
                const isOpen = openKeys.has(row.managerKey);
                return (
                  <Fragment key={row.managerKey}>
                    <tr className="bg-white hover:bg-slate-50">
                      <td className="px-3 py-2">
                        <button
                          aria-expanded={isOpen}
                          className="flex items-center gap-1.5 text-left font-semibold text-slate-900"
                          onClick={() => toggleOpen(row.managerKey)}
                          type="button"
                        >
                          {isOpen ? (
                            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                          )}
                          <span>{row.managerName}</span>
                          <span className="text-phx-2xs font-bold uppercase tracking-[0.1em] text-slate-400">
                            {row.title ?? "Role not recorded"}
                          </span>
                        </button>
                      </td>
                      <td className="px-3 py-2 text-right font-semibold text-slate-600">{row.teamSize}</td>
                      <td className="px-3 py-2 text-right font-semibold text-slate-900">{row.panelSize}</td>
                      <td className="px-3 py-2 text-right font-bold text-emerald-700">{row.green}</td>
                      <td className={`px-3 py-2 text-right font-bold ${row.yellow > 0 ? "text-amber-700" : "text-slate-400"}`}>{row.yellow}</td>
                      <td className={`px-3 py-2 text-right font-bold ${row.red > 0 ? "text-rose-700" : "text-slate-400"}`}>{row.red}</td>
                      <td className="px-3 py-2">
                        <CoverageMeter hasPanel={row.hasPanel} pct={row.coveragePct} />
                      </td>
                      <td className={`px-3 py-2 text-right font-bold ${row.offListDoctors > 0 ? "text-sky-700" : "text-slate-400"}`}>{row.offListDoctors}</td>
                      <td className={`px-3 py-2 text-right font-bold ${row.campaignCalls > 0 ? "text-sky-700" : "text-slate-400"}`}>{row.campaignCalls}</td>
                    </tr>
                    {isOpen
                      ? teamOf(row).map((rep) => (
                          <tr className="bg-slate-50/70" key={`${row.managerKey}:${rep.repKey}`}>
                            <td className="whitespace-nowrap py-1.5 pl-10 pr-3 text-slate-700">{rep.repName}</td>
                            <td className="px-3 py-1.5" />
                            <td className="px-3 py-1.5 text-right text-slate-700">{rep.panelSize}</td>
                            <td className="px-3 py-1.5 text-right text-emerald-700">{rep.green}</td>
                            <td className={`px-3 py-1.5 text-right ${rep.yellow > 0 ? "text-amber-700" : "text-slate-400"}`}>{rep.yellow}</td>
                            <td className={`px-3 py-1.5 text-right ${rep.red > 0 ? "text-rose-700" : "text-slate-400"}`}>{rep.red}</td>
                            <td className="px-3 py-1.5">
                              <CoverageMeter hasPanel={rep.hasPanel} pct={rep.coveragePct} />
                            </td>
                            <td className={`px-3 py-1.5 text-right ${rep.offListDoctors > 0 ? "text-sky-700" : "text-slate-400"}`}>{rep.offListDoctors}</td>
                            <td className={`px-3 py-1.5 text-right ${rep.campaignCalls > 0 ? "text-sky-700" : "text-slate-400"}`}>{rep.campaignCalls}</td>
                          </tr>
                        ))
                      : null}
                    {isOpen && row.teamRepKeys.length === 0 ? (
                      <tr className="bg-slate-50/70">
                        <td className="py-1.5 pl-10 pr-3 text-slate-400" colSpan={9}>
                          No rep rows on this board for this district.
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </PortalDesktopTable>
        )}
      />

      {regions.length > 0 ? (
        <div className="border-t border-slate-200 pt-3">
          <p className="mb-2 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">
            Above the district line
          </p>
          <div className="divide-y divide-slate-100">
            {regions.map((row) => (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2" key={row.managerKey}>
                <span className="min-w-52 text-xs font-semibold text-slate-800">{row.managerName}</span>
                <span className="min-w-44 text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-400">
                  {row.title ?? "Role not recorded"}
                </span>
                <span className="min-w-20 text-phx-xs font-bold text-slate-500">
                  {row.teamSize} {row.teamSize === 1 ? "rep" : "reps"}
                </span>
                <span className="min-w-28 text-phx-xs font-bold text-slate-500">{row.panelSize} assigned</span>
                <span className="min-w-32 flex-1">
                  <CoverageMeter hasPanel={row.hasPanel} pct={row.coveragePct} />
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// "Not visited", not "Lapsed". The panel is the rep's assigned list now, so a red row means an
// assigned doctor who was not seen this month — there is no recency test in front of him, and
// "Lapsed" implied one that no longer exists.
const STATUS_LABEL: Record<DoctorCoverageStatus, string> = {
  green: "Covered",
  red: "Not visited",
  yellow: "Under-visited",
};

const STATUS_SEVERITY: Record<DoctorCoverageStatus, number> = { green: 2, red: 0, yellow: 1 };

const STATUS_ACCENT: Record<DoctorCoverageStatus, "emerald" | "amber" | "rose"> = {
  green: "emerald",
  red: "rose",
  yellow: "amber",
};

const STATUS_BADGE: Record<DoctorCoverageStatus, string> = {
  green: "bg-emerald-50 text-emerald-700",
  red: "bg-rose-50 text-rose-700",
  yellow: "bg-amber-50 text-amber-700",
};

function StatusBadge({ status }: { status: DoctorCoverageStatus }) {
  return (
    <span className={`px-1.5 py-0.5 text-phx-2xs font-black uppercase tracking-[0.1em] ${STATUS_BADGE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

const DOCTOR_COLS = [
  { accessor: (r: DoctorCoverageDoctorRow) => r.contactName, defaultDir: "asc" as const, key: "contactName", type: "string" as const },
  { accessor: (r: DoctorCoverageDoctorRow) => r.gradeRaw, key: "gradeRaw", type: "string" as const },
  { accessor: (r: DoctorCoverageDoctorRow) => r.speciality, key: "speciality", type: "string" as const },
  { accessor: (r: DoctorCoverageDoctorRow) => r.repName, key: "repName", type: "string" as const },
  { accessor: (r: DoctorCoverageDoctorRow) => r.visitsThisMonth, key: "visitsThisMonth", type: "number" as const },
  { accessor: (r: DoctorCoverageDoctorRow) => STATUS_SEVERITY[r.status], defaultDir: "asc" as const, key: "status", type: "number" as const },
  { accessor: (r: DoctorCoverageDoctorRow) => r.lastVisitDate, key: "lastVisitDate", type: "string" as const },
];

type StatusFilter = "all" | DoctorCoverageStatus;

export function DoctorCoverageDoctorTable({ month, rows }: { month: string; rows: DoctorCoverageDoctorRow[] }) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [page, setPage] = useState(1);
  const filtered = useMemo(
    () => (statusFilter === "all" ? rows : rows.filter((row) => row.status === statusFilter)),
    [rows, statusFilter],
  );
  const table = useSortableTable(filtered, {
    columns: DOCTOR_COLS,
    initialSort: { dir: "asc", key: "status" },
    searchAccessors: [(r) => r.contactName, (r) => r.repName, (r) => r.speciality ?? ""],
  });

  // Windowed for display only — search/sort/filter above and the export below still see every
  // row in `rows`. Selecting a status chip or typing a search resets to page 1 explicitly (never
  // via a setState-in-useEffect, which lints as an error here); `safePage` also self-clamps so a
  // page deep into a large filter never goes out of range when the filter shrinks the set.
  const totalPages = Math.max(1, Math.ceil(table.rows.length / DOCTOR_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedRows = useMemo(
    () => table.rows.slice((safePage - 1) * DOCTOR_PAGE_SIZE, safePage * DOCTOR_PAGE_SIZE),
    [safePage, table.rows],
  );
  const pageLabel =
    table.rows.length === 0
      ? "0 doctors"
      : `${(safePage - 1) * DOCTOR_PAGE_SIZE + 1}-${Math.min(safePage * DOCTOR_PAGE_SIZE, table.rows.length)} of ${table.rows.length} doctors`;

  function selectStatusFilter(value: StatusFilter) {
    setStatusFilter(value);
    setPage(1);
  }

  function handleQueryChange(value: string) {
    table.setQuery(value);
    setPage(1);
  }

  function clearQuery() {
    table.clearQuery();
    setPage(1);
  }

  // Export always carries the FULL unfiltered list — the sheet is the audit artifact.
  const exportRows = rows.map((row) => ({
    doctor: row.contactName,
    grade: row.gradeRaw,
    last_visit: row.lastVisitDate ?? "—",
    rep: row.repName,
    speciality: row.speciality ?? "—",
    status: STATUS_LABEL[row.status],
    target: row.targetVisits,
    visits: row.visitsThisMonth,
  }));

  const chip = (value: StatusFilter, label: string, count: number) => (
    <button
      className={`border px-2.5 py-1 text-phx-2xs font-black uppercase tracking-[0.12em] ${
        statusFilter === value
          ? "border-slate-900 bg-slate-900 text-white"
          : "border-slate-200 bg-white text-slate-500 hover:border-orange-300 hover:text-orange-700"
      }`}
      key={value}
      onClick={() => selectStatusFilter(value)}
      type="button"
    >
      {label} · {count}
    </button>
  );

  return (
    <div className="space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TableSearchInput
          onChange={handleQueryChange}
          onClear={clearQuery}
          placeholder="Search doctor, rep, specialty…"
          value={table.query}
        />
        <div className="flex flex-wrap items-center gap-2">
          {chip("all", "All", rows.length)}
          {chip("yellow", "Under-visited", rows.filter((row) => row.status === "yellow").length)}
          {chip("red", "Not visited", rows.filter((row) => row.status === "red").length)}
          {chip("green", "Covered", rows.filter((row) => row.status === "green").length)}
          <ExportXlsxButton
            columns={[
              { key: "doctor", label: "Doctor" },
              { key: "grade", label: "Grade" },
              { key: "speciality", label: "Specialty" },
              { key: "rep", label: "Assigned Rep" },
              { key: "visits", label: "Visits", numeric: true },
              { key: "target", label: "Target", numeric: true },
              { key: "status", label: "Status" },
              { key: "last_visit", label: "Last Visit" },
            ]}
            rows={exportRows}
            sheetName="Doctor Coverage"
            subtitle={month}
            title="Doctor Coverage & Frequency"
          />
        </div>
      </div>
      <PortalResponsiveDataList
        empty={<p className="px-3 py-6 text-center text-xs text-slate-400">No doctors match this filter.</p>}
        getKey={(row) => String(row.contactCrmId)}
        items={pagedRows}
        renderCard={(row) => (
          <PortalRecordCard
            accent={STATUS_ACCENT[row.status]}
            meta={row.speciality ?? "Unspecified"}
            status={<StatusBadge status={row.status} />}
            title={row.contactName}
          >
            <PortalRecordFields
              fields={[
                { label: "Grade", value: row.gradeRaw },
                {
                  label: "Visits",
                  value: (
                    <>
                      <span className="text-slate-900">{row.visitsThisMonth}</span>
                      <span className="text-slate-400"> / {row.targetVisits}</span>
                    </>
                  ),
                },
                { label: "Assigned Rep", value: row.repName },
                { label: "Last Visit", value: row.lastVisitDate ?? "—" },
              ]}
            />
          </PortalRecordCard>
        )}
        renderTable={() => (
          <PortalDesktopTable className="text-xs" minWidth="820px">
            <thead>
              <tr className="bg-slate-900 text-left">
                <SortableTh className={REP_THEAD} label="Doctor" onSort={table.toggleSort} sort={table.sort} sortKey="contactName" />
                <SortableTh className={REP_THEAD} label="Grade" onSort={table.toggleSort} sort={table.sort} sortKey="gradeRaw" />
                <SortableTh className={REP_THEAD} label="Specialty" onSort={table.toggleSort} sort={table.sort} sortKey="speciality" />
                <SortableTh className={REP_THEAD} label="Assigned Rep" onSort={table.toggleSort} sort={table.sort} sortKey="repName" />
                <SortableTh align="right" className={`${REP_THEAD} text-right`} label="Visits" onSort={table.toggleSort} sort={table.sort} sortKey="visitsThisMonth" />
                <SortableTh className={REP_THEAD} label="Status" onSort={table.toggleSort} sort={table.sort} sortKey="status" />
                <SortableTh className={REP_THEAD} label="Last Visit" onSort={table.toggleSort} sort={table.sort} sortKey="lastVisitDate" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pagedRows.map((row) => (
                <tr className="bg-white hover:bg-slate-50" key={row.contactCrmId}>
                  <td className="px-3 py-2 font-semibold text-slate-900">{row.contactName}</td>
                  <td className="px-3 py-2">
                    <span className="border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-phx-2xs font-bold text-slate-600">{row.gradeRaw}</span>
                  </td>
                  <td className="px-3 py-2 text-slate-600">{row.speciality ?? "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-700">{row.repName}</td>
                  <td className="px-3 py-2 text-right">
                    <span className="font-bold text-slate-900">{row.visitsThisMonth}</span>
                    <span className="text-slate-400"> / {row.targetVisits}</span>
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="px-3 py-2 text-slate-600">{row.lastVisitDate ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />
      <PortalPagination label={pageLabel}>
        <button
          className="rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-black text-slate-600 disabled:opacity-40"
          disabled={safePage <= 1}
          onClick={() => setPage((current) => Math.max(1, current - 1))}
          type="button"
        >
          Previous
        </button>
        <button
          className="rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-black text-slate-600 disabled:opacity-40"
          disabled={safePage >= totalPages}
          onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
          type="button"
        >
          Next
        </button>
      </PortalPagination>
    </div>
  );
}
