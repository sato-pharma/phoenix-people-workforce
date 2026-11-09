"use client";

import type { ReactNode } from "react";

import {
  INCIDENT_COLUMN_HEADINGS,
  incidentCairoDate,
  incidentCairoTime,
  incidentCodeAndRef,
  incidentEmployeeName,
  incidentHrId,
  incidentMessage,
  incidentPersonOps,
  incidentScope,
  incidentStatus,
  incidentWhyParts,
  isSystemRow,
} from "@/lib/system-audit/incidents-display";
import type { SystemAuditPageRow, SystemAuditStatus } from "@/lib/system-audit/types";
import { cn } from "@/lib/utils";

/**
 * The Incidents list, fitted to its OWN width (never the viewport's — the tab can sit beside the
 * admin sidebar at any width):
 *
 *   · 1120px and up — all 11 columns, in the owner's order, with his headings.
 *   · 760–1119px   — 7 columns, fitted by MERGING: HR ID + Name in one cell, Date + Time in one
 *                    cell, and Status + Occurrences + Unique-vs-Shared in one cell. Type never
 *                    shrinks to make a column fit.
 *   · under 760px  — one card per incident.
 *
 * `table-fixed` with a `<colgroup>`, every cell wraps (`break-words`), nothing is cut with an
 * ellipsis and nothing scrolls sideways.
 */

const STATUS_TONE: Record<SystemAuditStatus, string> = {
  fixed_verified: "text-emerald-700",
  fix_implemented: "text-sky-800",
  investigating: "text-amber-800",
  not_fixed: "text-rose-700",
  no_defect: "text-slate-600",
  unknown: "text-slate-600",
};

const headCell = "px-2 py-2 text-left align-bottom text-phx-sm font-bold uppercase tracking-[0.06em] break-words";
const bodyCell = "px-2 py-2 align-top break-words";

function NameButton({ row, onOpen }: { row: SystemAuditPageRow; onOpen: (row: SystemAuditPageRow) => void }) {
  const system = isSystemRow(row);
  return (
    <button
      className={cn(
        "text-left font-semibold underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-orange-500",
        system ? "text-slate-500" : "text-slate-900",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(row);
      }}
      type="button"
    >
      <span className="break-words">{incidentEmployeeName(row)}</span>
    </button>
  );
}

function Message({ row }: { row: SystemAuditPageRow }) {
  const recorded = Boolean(row.userMessage?.trim());
  return <p className={cn("break-words", recorded ? "text-slate-800" : "italic text-slate-500")}>{incidentMessage(row)}</p>;
}

function Why({ row }: { row: SystemAuditPageRow }) {
  const { level, text } = incidentWhyParts(row);
  return (
    <p className="break-words text-slate-700">
      <span className="font-bold text-slate-900">{level}</span> — {text}
    </p>
  );
}

function Status({ row }: { row: SystemAuditPageRow }) {
  return <p className={cn("break-words font-bold", STATUS_TONE[row.status] ?? "text-slate-700")}>{incidentStatus(row)}</p>;
}

function Row({
  row,
  onOpen,
  selected,
  children,
}: {
  row: SystemAuditPageRow;
  onOpen: (row: SystemAuditPageRow) => void;
  selected: boolean;
  children: ReactNode;
}) {
  return (
    <tr
      className={cn("cursor-pointer border-b border-slate-100 hover:bg-orange-50/60", selected ? "bg-orange-50" : "")}
      onClick={() => onOpen(row)}
    >
      {children}
    </tr>
  );
}

function WideTable({ rows, onOpen, selectedId }: TableProps) {
  return (
    <table className="hidden w-full table-fixed border-collapse text-xs @min-[1120px]:table">
      <colgroup>
        <col className="w-[6%]" />
        <col className="w-[10%]" />
        <col className="w-[10%]" />
        <col className="w-[7%]" />
        <col className="w-[5%]" />
        <col className="w-[14%]" />
        <col className="w-[9%]" />
        <col className="w-[13%]" />
        <col className="w-[9%]" />
        <col className="w-[8%]" />
        <col className="w-[9%]" />
      </colgroup>
      <thead>
        <tr className="bg-[#0B0B0B] text-white">
          {INCIDENT_COLUMN_HEADINGS.map((heading) => (
            <th className={headCell} key={heading} scope="col">
              {heading}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <Row key={row.id} onOpen={onOpen} row={row} selected={row.id === selectedId}>
            <td className={cn(bodyCell, "font-mono text-slate-600")}>{incidentHrId(row)}</td>
            <td className={bodyCell}>
              <NameButton onOpen={onOpen} row={row} />
            </td>
            <td className={cn(bodyCell, "text-slate-700")}>{row.moduleLabel}</td>
            <td className={cn(bodyCell, "tabular-nums text-slate-700")}>{incidentCairoDate(row)}</td>
            <td className={cn(bodyCell, "tabular-nums text-slate-700")}>{incidentCairoTime(row)}</td>
            <td className={bodyCell}>
              <Message row={row} />
            </td>
            <td className={cn(bodyCell, "font-mono text-slate-600")}>{incidentCodeAndRef(row)}</td>
            <td className={bodyCell}>
              <Why row={row} />
            </td>
            <td className={bodyCell}>
              <Status row={row} />
            </td>
            <td className={cn(bodyCell, "tabular-nums font-bold text-slate-800")}>{incidentPersonOps(row)}</td>
            <td className={cn(bodyCell, "font-semibold text-slate-700")}>{incidentScope(row)}</td>
          </Row>
        ))}
      </tbody>
    </table>
  );
}

function MergedTable({ rows, onOpen, selectedId }: TableProps) {
  return (
    <table className="hidden w-full table-fixed border-collapse text-xs @min-[760px]:table @min-[1120px]:hidden">
      <colgroup>
        <col className="w-[16%]" />
        <col className="w-[13%]" />
        <col className="w-[11%]" />
        <col className="w-[18%]" />
        <col className="w-[11%]" />
        <col className="w-[17%]" />
        <col className="w-[14%]" />
      </colgroup>
      <thead>
        <tr className="bg-[#0B0B0B] text-white">
          <th className={headCell} scope="col">
            {INCIDENT_COLUMN_HEADINGS[1]} / {INCIDENT_COLUMN_HEADINGS[0]}
          </th>
          <th className={headCell} scope="col">
            {INCIDENT_COLUMN_HEADINGS[2]}
          </th>
          <th className={headCell} scope="col">
            Error Date / Time (Cairo)
          </th>
          <th className={headCell} scope="col">
            {INCIDENT_COLUMN_HEADINGS[5]}
          </th>
          <th className={headCell} scope="col">
            {INCIDENT_COLUMN_HEADINGS[6]}
          </th>
          <th className={headCell} scope="col">
            {INCIDENT_COLUMN_HEADINGS[7]}
          </th>
          <th className={headCell} scope="col">
            {INCIDENT_COLUMN_HEADINGS[8]} · Occurrences · Unique vs Shared
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <Row key={row.id} onOpen={onOpen} row={row} selected={row.id === selectedId}>
            <td className={bodyCell}>
              <NameButton onOpen={onOpen} row={row} />
              {isSystemRow(row) ? null : <p className="mt-0.5 font-mono text-phx-sm text-slate-500">{incidentHrId(row)}</p>}
            </td>
            <td className={cn(bodyCell, "text-slate-700")}>{row.moduleLabel}</td>
            <td className={cn(bodyCell, "tabular-nums text-slate-700")}>
              <p>{incidentCairoDate(row)}</p>
              <p className="text-slate-500">{incidentCairoTime(row)}</p>
            </td>
            <td className={bodyCell}>
              <Message row={row} />
            </td>
            <td className={cn(bodyCell, "font-mono text-slate-600")}>{incidentCodeAndRef(row)}</td>
            <td className={bodyCell}>
              <Why row={row} />
            </td>
            <td className={bodyCell}>
              <Status row={row} />
              <p className="mt-1 break-words text-slate-700">
                <span className="font-bold tabular-nums">{incidentPersonOps(row)}</span>
                {isSystemRow(row) ? "" : row.personOps === 1 ? " time for this employee" : " times for this employee"}
              </p>
              <p className="mt-1 break-words font-semibold text-slate-600">{incidentScope(row)}</p>
            </td>
          </Row>
        ))}
      </tbody>
    </table>
  );
}

function CardField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-phx-sm font-bold uppercase text-slate-400">{label}</dt>
      <dd className="break-words text-slate-800">{children}</dd>
    </div>
  );
}

function Cards({ rows, onOpen, selectedId }: TableProps) {
  return (
    <ul className="space-y-2 @min-[760px]:hidden">
      {rows.map((row) => (
        <li
          className={cn("border bg-white p-3 text-xs", row.id === selectedId ? "border-orange-500" : "border-slate-200")}
          key={row.id}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <NameButton onOpen={onOpen} row={row} />
              {isSystemRow(row) ? null : <p className="font-mono text-phx-sm text-slate-500">{incidentHrId(row)}</p>}
            </div>
            <p className="max-w-[45%] text-right tabular-nums text-slate-600">
              {incidentCairoDate(row)} · {incidentCairoTime(row)}
            </p>
          </div>
          <p className="mt-1 break-words font-semibold text-slate-700">{row.moduleLabel}</p>
          <div className="mt-2">
            <Message row={row} />
          </div>
          <dl className="mt-2 grid grid-cols-1 gap-2 @min-[420px]:grid-cols-2">
            <CardField label={INCIDENT_COLUMN_HEADINGS[6]}>
              <span className="font-mono">{incidentCodeAndRef(row)}</span>
            </CardField>
            <CardField label={INCIDENT_COLUMN_HEADINGS[8]}>
              <Status row={row} />
            </CardField>
            <CardField label={INCIDENT_COLUMN_HEADINGS[7]}>
              <Why row={row} />
            </CardField>
            <CardField label={INCIDENT_COLUMN_HEADINGS[9]}>
              <span className="font-bold tabular-nums">{incidentPersonOps(row)}</span>
            </CardField>
            <CardField label={INCIDENT_COLUMN_HEADINGS[10]}>{incidentScope(row)}</CardField>
          </dl>
          <button
            className="mt-2 text-xs font-bold text-orange-700 underline-offset-2 hover:underline"
            onClick={() => onOpen(row)}
            type="button"
          >
            Open the full record
          </button>
        </li>
      ))}
    </ul>
  );
}

type TableProps = {
  rows: SystemAuditPageRow[];
  onOpen: (row: SystemAuditPageRow) => void;
  selectedId: string | null;
};

export function IncidentsTable(props: TableProps) {
  return (
    <div className="@container min-w-0">
      <WideTable {...props} />
      <MergedTable {...props} />
      <Cards {...props} />
    </div>
  );
}
