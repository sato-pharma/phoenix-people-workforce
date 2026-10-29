"use client";

import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import {
  SortableTh,
  TableSearchInput,
  TableNoResults,
} from "@/components/ui/sortable-table";
import { useSortableTable } from "@/components/ui/use-sortable-table";

// ── Types ────────────────────────────────────────────────────────────────────

export type ManagerOnLeave = { name: string; hrId: string; role: string };
export type AbsenteeRow = { name: string; hrId: string; department: string };
export type ChronicLateRow = { name: string; hrId: string; lateDays: number; lateRate: number };

// ── Managers on leave table ───────────────────────────────────────────────────

const MOL_COLS = [
  { key: "name",  accessor: (r: ManagerOnLeave) => r.name,  type: "string" as const, defaultDir: "asc" as const },
  { key: "role",  accessor: (r: ManagerOnLeave) => r.role,  type: "string" as const, defaultDir: "asc" as const },
];

function ManagersOnLeaveTable({ rows }: { rows: ManagerOnLeave[] }) {
  const table = useSortableTable(rows, {
    columns: MOL_COLS,
    searchAccessors: [(r) => r.name, (r) => r.role],
    initialSort: { key: "role", dir: "asc" },
  });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <TableSearchInput
          placeholder="Filter name or role…"
          value={table.query}
          onChange={table.setQuery}
          onClear={table.clearQuery}
          size="sm"
          className="min-w-0 flex-1"
        />
        <ExportXlsxButton
          title="Managers on Leave Today"
          sheetName="On Leave"
          label="Export"
          columns={[
            { key: "name", label: "Name" },
            { key: "role", label: "Role" },
            { key: "hrId", label: "HR ID" },
          ]}
          rows={rows.map((r) => ({ name: r.name, role: r.role, hrId: r.hrId }))}
          className="h-8 shrink-0"
        />
      </div>
      <div>
        <table className="w-full table-fixed border-collapse text-xs">
          <colgroup>
            <col className="w-[60%]" />
            <col className="w-[40%]" />
          </colgroup>
          <thead>
            <tr className="bg-slate-900 text-left">
              <SortableTh label="Name" sortKey="name" sort={table.sort} onSort={table.toggleSort}
                className="px-3 py-2 text-phx-2xs font-black uppercase tracking-[0.12em] text-white" />
              <SortableTh label="Role" sortKey="role" sort={table.sort} onSort={table.toggleSort}
                className="px-3 py-2 text-phx-2xs font-black uppercase tracking-[0.12em] text-white" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {table.rows.length === 0 ? (
              <TableNoResults colSpan={2} filtered={table.isFiltered} label="managers" />
            ) : (
              table.rows.map((r) => (
                <tr key={r.hrId} className="bg-white hover:bg-amber-50/60">
                  <td className="break-words px-3 py-2 font-semibold text-slate-800">{r.name}</td>
                  <td className="break-words px-3 py-2">
                    <span className="border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-phx-3xs font-bold text-amber-700">
                      {r.role}
                    </span>
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

// ── Absentees table ───────────────────────────────────────────────────────────

const ABS_COLS = [
  { key: "name",       accessor: (r: AbsenteeRow) => r.name,       type: "string" as const, defaultDir: "asc" as const },
  { key: "department", accessor: (r: AbsenteeRow) => r.department, type: "string" as const, defaultDir: "asc" as const },
];

function AbsenteesTable({ rows, allCount }: { rows: AbsenteeRow[]; allCount: number }) {
  const table = useSortableTable(rows, {
    columns: ABS_COLS,
    searchAccessors: [(r) => r.name, (r) => r.department],
    initialSort: { key: "name", dir: "asc" },
  });

  const truncated = allCount > rows.length;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <TableSearchInput
          placeholder="Filter name or dept…"
          value={table.query}
          onChange={table.setQuery}
          onClear={table.clearQuery}
          size="sm"
          className="min-w-0 flex-1"
        />
        <ExportXlsxButton
          title="Today's Absentees"
          sheetName="Absentees"
          label="Export"
          columns={[
            { key: "name", label: "Name" },
            { key: "department", label: "Department" },
            { key: "hrId", label: "HR ID" },
          ]}
          rows={rows.map((r) => ({ name: r.name, department: r.department, hrId: r.hrId }))}
          className="h-8 shrink-0"
        />
      </div>
      {truncated && (
        <p className="text-phx-2xs text-slate-400">
          Showing {rows.length} of {allCount} absentees.
        </p>
      )}
      <div>
        <table className="w-full table-fixed border-collapse text-xs">
          <colgroup>
            <col className="w-[60%]" />
            <col className="w-[40%]" />
          </colgroup>
          <thead>
            <tr className="bg-slate-900 text-left">
              <SortableTh label="Name" sortKey="name" sort={table.sort} onSort={table.toggleSort}
                className="px-3 py-2 text-phx-2xs font-black uppercase tracking-[0.12em] text-white" />
              <SortableTh label="Department" sortKey="department" sort={table.sort} onSort={table.toggleSort}
                className="px-3 py-2 text-phx-2xs font-black uppercase tracking-[0.12em] text-white" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {table.rows.length === 0 ? (
              <TableNoResults colSpan={2} filtered={table.isFiltered} label="absentees" />
            ) : (
              table.rows.map((r) => (
                <tr key={r.hrId} className="bg-white hover:bg-rose-50/60">
                  <td className="break-words px-3 py-2 font-semibold text-slate-800">{r.name}</td>
                  <td className="break-words px-3 py-2 text-slate-500">{r.department || "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Chronic late table ────────────────────────────────────────────────────────

const LATE_COLS = [
  { key: "name",     accessor: (r: ChronicLateRow) => r.name,     type: "string" as const, defaultDir: "asc" as const },
  { key: "lateDays", accessor: (r: ChronicLateRow) => r.lateDays, type: "number" as const },
  { key: "lateRate", accessor: (r: ChronicLateRow) => r.lateRate, type: "number" as const },
];

function ChronicLateTable({ rows }: { rows: ChronicLateRow[] }) {
  const table = useSortableTable(rows, {
    columns: LATE_COLS,
    searchAccessors: [(r) => r.name],
    initialSort: { key: "lateRate", dir: "desc" },
  });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <TableSearchInput
          placeholder="Filter name…"
          value={table.query}
          onChange={table.setQuery}
          onClear={table.clearQuery}
          size="sm"
          className="min-w-0 flex-1"
        />
        <ExportXlsxButton
          title="Chronic Late — 30-Day Window"
          sheetName="Chronic Late"
          label="Export"
          columns={[
            { key: "name",     label: "Name" },
            { key: "hrId",     label: "HR ID" },
            { key: "lateDays", label: "Late Days", numeric: true },
            { key: "lateRate", label: "Late Rate %", numeric: true },
          ]}
          rows={rows.map((r) => ({
            name: r.name,
            hrId: r.hrId,
            lateDays: r.lateDays,
            lateRate: parseFloat(r.lateRate.toFixed(1)),
          }))}
          className="h-8 shrink-0"
        />
      </div>
      <div>
        <table className="w-full table-fixed border-collapse text-xs">
          <colgroup>
            <col className="w-[60%]" />
            <col className="w-[20%]" />
            <col className="w-[20%]" />
          </colgroup>
          <thead>
            <tr className="bg-slate-900 text-left">
              <SortableTh label="Name" sortKey="name" sort={table.sort} onSort={table.toggleSort}
                className="px-3 py-2 text-phx-2xs font-black uppercase tracking-[0.12em] text-white" />
              <SortableTh label="Late Days" sortKey="lateDays" sort={table.sort} onSort={table.toggleSort} align="right"
                className="px-3 py-2 text-phx-2xs font-black uppercase tracking-[0.12em] text-white" />
              <SortableTh label="Rate" sortKey="lateRate" sort={table.sort} onSort={table.toggleSort} align="right"
                className="px-3 py-2 text-phx-2xs font-black uppercase tracking-[0.12em] text-white" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {table.rows.length === 0 ? (
              <TableNoResults colSpan={3} filtered={table.isFiltered} label="employees" />
            ) : (
              table.rows.map((r) => (
                <tr key={r.hrId} className="bg-white hover:bg-amber-50/40">
                  <td className="break-words px-3 py-2 font-semibold text-slate-800">{r.name}</td>
                  <td className="px-3 py-2 text-right font-bold text-slate-700">{r.lateDays}</td>
                  <td className={`px-3 py-2 text-right font-black ${r.lateRate >= 50 ? "text-rose-700" : r.lateRate >= 30 ? "text-amber-700" : "text-slate-600"}`}>
                    {r.lateRate.toFixed(0)}%
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

// ── Combined export ───────────────────────────────────────────────────────────

/**
 * Premium sortable + filterable + XLSX-exportable attendance tables for the CEO
 * Command Center: managers on leave, today's absentees, and chronic late offenders.
 */
export function CeoAttendanceTables({
  managersOnLeave,
  absentees,
  allAbsenteesCount,
  chronicLate,
}: {
  managersOnLeave: ManagerOnLeave[];
  absentees: AbsenteeRow[];
  allAbsenteesCount: number;
  chronicLate: ChronicLateRow[];
}) {
  const hasMol = managersOnLeave.length > 0;
  const hasAbs = absentees.length > 0;
  const hasLate = chronicLate.length > 0;

  if (!hasMol && !hasAbs && !hasLate) {
    return (
      <p className="py-4 text-center text-xs text-slate-400">No attendance data to show.</p>
    );
  }

  return (
    <div className="space-y-6 px-5 py-5">
      {hasMol && (
        <div>
          <p className="mb-3 text-phx-3xs font-black uppercase tracking-[0.16em] text-amber-600">
            Managers on leave today ({managersOnLeave.length})
          </p>
          <ManagersOnLeaveTable rows={managersOnLeave} />
        </div>
      )}
      {hasAbs && (
        <div>
          <p className="mb-3 text-phx-3xs font-black uppercase tracking-[0.16em] text-rose-600">
            Absent today ({allAbsenteesCount})
          </p>
          <AbsenteesTable rows={absentees} allCount={allAbsenteesCount} />
        </div>
      )}
      {hasLate && (
        <div>
          <p className="mb-3 text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400">
            Chronic late — 30-day window ({chronicLate.length})
          </p>
          <ChronicLateTable rows={chronicLate} />
        </div>
      )}
    </div>
  );
}
