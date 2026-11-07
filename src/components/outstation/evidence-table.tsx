import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A column of the evidence table. `badge` is a pin or a type tag, `body` the words, `time` a clock
 * read down its column; the phone card lays the same three out on one line.
 */
export type EvidenceColumn = { hint?: string; label: string; role: "badge" | "body" | "time"; width: string | null };

/** One row: a cell per column role — a table has at most one column of each. */
export type EvidenceRow = { badge?: ReactNode; body: ReactNode; key: string; time?: ReactNode };

/**
 * The trip evidence as a zebra table: titled, fixed columns from a colgroup, rows alternating white
 * and a faint slate band, in the Phoenix CRM table's type (owner, 2026-11-07: "tidy this part by
 * putting in a zebra table, premium polish"). It never scrolls sideways; long Arabic names and
 * addresses wrap inside their cell.
 *
 * Desktop only, like every outstation table: below `md` the same rows are zebra cards — the badge,
 * the words, and the time under its own label ("Saved 12:11").
 */
export function EvidenceTable({ columns, rows, title }: { columns: ReadonlyArray<EvidenceColumn>; rows: ReadonlyArray<EvidenceRow>; title?: ReactNode }) {
  return (
    <div className="min-w-0" data-evidence-table>
      {title ? <p className="mb-1.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">{title}</p> : null}
      <ul className="border border-slate-200 bg-white text-xs md:hidden">
        {rows.map((row) => (
          <li className="flex items-start gap-2 border-t border-slate-100 px-2.5 py-1.5 first:border-t-0 even:bg-slate-50" key={row.key}>
            {columns.map((column) =>
              column.role === "badge" ? (
                <span className="shrink-0" key={column.label}>
                  {row[column.role]}
                </span>
              ) : column.role === "time" ? (
                <span className="shrink-0 text-right leading-tight" key={column.label}>
                  <span className="block text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-400">{column.label}</span>
                  <span className="tabular-nums font-bold text-slate-900">{row[column.role]}</span>
                </span>
              ) : (
                <span className="min-w-0 flex-1 break-words text-slate-700" key={column.label}>
                  {row[column.role]}
                </span>
              ),
            )}
          </li>
        ))}
      </ul>
      <div className="hidden md:block">
        <table className="w-full table-fixed border-collapse border border-slate-200 bg-white text-left text-xs">
          <colgroup>
            {columns.map((column) => (
              <col key={column.label} style={column.width ? { width: column.width } : undefined} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {columns.map((column) => (
                <th className={cn(thClassName, column.role === "time" && "text-right")} key={column.label} scope="col" title={column.hint}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className={evidenceRowClassName} key={row.key}>
                {columns.map((column) => (
                  <td className={column.role === "time" ? timeTdClassName : tdClassName} key={column.label}>
                    {row[column.role]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The zebra: every second row on a faint slate band. */
export const evidenceRowClassName = "align-top even:bg-slate-50";

const thClassName =
  "border-b border-slate-200 bg-slate-100 px-2.5 py-1.5 align-bottom whitespace-nowrap text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-500";

const tdClassName = "border-t border-slate-100 px-2.5 py-1.5 break-words text-slate-700";

/** A time, read down its column: right-aligned, tabular figures, never wrapped. */
const timeTdClassName = "border-t border-slate-100 px-2.5 py-1.5 text-right whitespace-nowrap tabular-nums font-bold text-slate-900";
