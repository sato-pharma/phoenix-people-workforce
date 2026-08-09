"use client";

import { useMemo, useState } from "react";

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

const REP_THEAD = "px-3 py-2.5 text-[10px] font-black uppercase tracking-[0.12em] text-white";

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
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
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
            {table.rows.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-center text-xs text-slate-400" colSpan={7}>
                  No graded doctor visits in this month.
                </td>
              </tr>
            ) : (
              table.rows.map((row) => (
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
                          className={`h-full ${row.coveragePct >= 80 ? "bg-emerald-500" : row.coveragePct >= 50 ? "bg-amber-400" : "bg-rose-400"}`}
                          style={{ width: `${Math.max(2, row.coveragePct)}%` }}
                        />
                      </div>
                      <span className={`min-w-[34px] text-right font-black ${row.coveragePct >= 80 ? "text-emerald-700" : row.coveragePct >= 50 ? "text-amber-700" : "text-rose-700"}`}>
                        {row.coveragePct}%
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right text-slate-600">
                    {row.aDoctors} / {row.bDoctors} / {row.cDoctors}
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

const STATUS_LABEL: Record<DoctorCoverageStatus, string> = {
  green: "Covered",
  red: "Lapsed",
  yellow: "Under-visited",
};

const STATUS_SEVERITY: Record<DoctorCoverageStatus, number> = { green: 2, red: 0, yellow: 1 };

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
  const filtered = useMemo(
    () => (statusFilter === "all" ? rows : rows.filter((row) => row.status === statusFilter)),
    [rows, statusFilter],
  );
  const table = useSortableTable(filtered, {
    columns: DOCTOR_COLS,
    initialSort: { dir: "asc", key: "status" },
    searchAccessors: [(r) => r.contactName, (r) => r.repName, (r) => r.speciality ?? ""],
  });

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
      onClick={() => setStatusFilter(value)}
      type="button"
    >
      {label} · {count}
    </button>
  );

  return (
    <div className="space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TableSearchInput
          onChange={table.setQuery}
          onClear={table.clearQuery}
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
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
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
            {table.rows.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-center text-xs text-slate-400" colSpan={7}>
                  No doctors match this filter.
                </td>
              </tr>
            ) : (
              table.rows.map((row) => (
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
                    <span
                      className={`px-1.5 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] ${
                        row.status === "green"
                          ? "bg-emerald-50 text-emerald-700"
                          : row.status === "yellow"
                            ? "bg-amber-50 text-amber-700"
                            : "bg-rose-50 text-rose-700"
                      }`}
                    >
                      {STATUS_LABEL[row.status]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-600">{row.lastVisitDate ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
