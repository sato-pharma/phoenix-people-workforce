"use client";

import { useMemo, useState } from "react";

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

const REP_THEAD = "px-3 py-2.5 text-[10px] font-black uppercase tracking-[0.12em] text-white";
const DOCTOR_PAGE_SIZE = 25;

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
  { accessor: (r: DoctorCoverageRepRow) => r.coveragePct, key: "coveragePct", type: "number" as const },
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
        empty={<p className="px-3 py-6 text-center text-xs text-slate-400">No graded doctor visits in this month.</p>}
        getKey={(row) => row.repKey}
        items={table.rows}
        renderCard={(row) => (
          <PortalRecordCard
            accent={coverageAccent(row.coveragePct)}
            meta={`${row.panelSize} graded ${row.panelSize === 1 ? "doctor" : "doctors"} in panel`}
            status={<span className={`text-sm font-black ${coverageText(row.coveragePct)}`}>{row.coveragePct}%</span>}
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
                  label: "Lapsed",
                  value: <span className={row.red > 0 ? "text-rose-700" : "text-slate-400"}>{row.red}</span>,
                },
                { label: "A / B / C", value: `${row.aDoctors} / ${row.bDoctors} / ${row.cDoctors}` },
              ]}
            />
          </PortalRecordCard>
        )}
        renderTable={() => (
          <PortalDesktopTable className="text-xs" minWidth="720px">
            <thead>
              <tr className="bg-slate-900 text-left">
                <SortableTh className={REP_THEAD} label="Rep" onSort={table.toggleSort} sort={table.sort} sortKey="repName" />
                <SortableTh align="right" className={`${REP_THEAD} text-right`} label="Panel" onSort={table.toggleSort} sort={table.sort} sortKey="panelSize" />
                <SortableTh align="right" className={`${REP_THEAD} text-right text-emerald-300`} label="Covered" onSort={table.toggleSort} sort={table.sort} sortKey="green" />
                <SortableTh align="right" className={`${REP_THEAD} text-right text-amber-300`} label="Under" onSort={table.toggleSort} sort={table.sort} sortKey="yellow" />
                <SortableTh align="right" className={`${REP_THEAD} text-right text-rose-300`} label="Lapsed" onSort={table.toggleSort} sort={table.sort} sortKey="red" />
                <SortableTh align="right" className={`${REP_THEAD} text-right`} label="Coverage" onSort={table.toggleSort} sort={table.sort} sortKey="coveragePct" />
                <SortableTh align="right" className={`${REP_THEAD} text-right`} label="A / B / C" onSort={table.toggleSort} sort={table.sort} sortKey="aDoctors" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {table.rows.map((row) => (
                <tr className="bg-white hover:bg-slate-50" key={row.repKey}>
                  <td className="px-3 py-2 font-semibold text-slate-900">{row.repName}</td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-900">{row.panelSize}</td>
                  <td className="px-3 py-2 text-right font-bold text-emerald-700">{row.green}</td>
                  <td className={`px-3 py-2 text-right font-bold ${row.yellow > 0 ? "text-amber-700" : "text-slate-400"}`}>{row.yellow}</td>
                  <td className={`px-3 py-2 text-right font-bold ${row.red > 0 ? "text-rose-700" : "text-slate-400"}`}>{row.red}</td>
                  <td className="px-3 py-2">
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

const STATUS_LABEL: Record<DoctorCoverageStatus, string> = {
  green: "Covered",
  red: "Lapsed",
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
    <span className={`px-1.5 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] ${STATUS_BADGE[status]}`}>
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
      className={`border px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.12em] ${
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
          {chip("red", "Lapsed", rows.filter((row) => row.status === "red").length)}
          {chip("green", "Covered", rows.filter((row) => row.status === "green").length)}
          <ExportXlsxButton
            columns={[
              { key: "doctor", label: "Doctor" },
              { key: "grade", label: "Grade" },
              { key: "speciality", label: "Specialty" },
              { key: "rep", label: "Primary Rep" },
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
                { label: "Primary Rep", value: row.repName },
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
                <SortableTh className={REP_THEAD} label="Primary Rep" onSort={table.toggleSort} sort={table.sort} sortKey="repName" />
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
                    <span className="border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">{row.gradeRaw}</span>
                  </td>
                  <td className="px-3 py-2 text-slate-600">{row.speciality ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-700">{row.repName}</td>
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
