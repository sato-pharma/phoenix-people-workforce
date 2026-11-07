import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The trip evidence as a zebra table: a titled, fixed-layout table whose rows alternate white and a
 * faint slate band, in the Phoenix CRM table's type (owner, 2026-11-07: "tidy this part by putting
 * in a zebra table, premium polish"). Fixed columns from a colgroup, so it fits its panel and never
 * scrolls sideways; long Arabic names and addresses wrap inside their cell.
 *
 * It switches on its OWN width (`@container`), not the screen's: in a column narrower than 20rem the
 * header row goes and each row stacks as a card, the time keeping its label ("Saved 12:11").
 */
export function EvidenceTable({
  children,
  columns,
  headers,
  title,
}: {
  children: ReactNode;
  /** One width per column (e.g. "4.5rem"); a column without one takes what is left. */
  columns: ReadonlyArray<string | null>;
  headers: ReadonlyArray<{ align?: "right"; hint?: string; label: string }>;
  /** The small heading above the table, with its count when there is one. */
  title?: ReactNode;
}) {
  return (
    <div className="@container min-w-0">
      {title ? <p className="mb-1.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">{title}</p> : null}
      <table
        className="w-full table-fixed border-collapse border border-slate-200 bg-white text-left text-xs @max-xs:block"
        data-evidence-table
      >
        <colgroup>
          {columns.map((width, index) => (
            <col key={index} style={width ? { width } : undefined} />
          ))}
        </colgroup>
        <thead className="@max-xs:hidden">
          <tr>
            {headers.map((header) => (
              <th
                className={cn(evidenceThClassName, header.align === "right" && "text-right")}
                key={header.label}
                scope="col"
                title={header.hint}
              >
                {header.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="@max-xs:block">{children}</tbody>
      </table>
    </div>
  );
}

const evidenceThClassName =
  "border-b border-slate-200 bg-slate-100 px-2.5 py-1.5 align-bottom text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-500";

/** The zebra: every second row on a faint slate band; a stacked card in a narrow column. */
export const evidenceRowClassName = "align-top even:bg-slate-50 @max-xs:block @max-xs:border-t @max-xs:border-slate-100 @max-xs:py-1";

export const evidenceTdClassName =
  "border-t border-slate-100 px-2.5 py-1.5 break-words text-slate-700 @max-xs:block @max-xs:border-t-0 @max-xs:py-0.5";

/**
 * A time, read down its column: right-aligned, tabular figures, never wrapped. Stacked, it is
 * left-aligned and names its clock from the cell's `data-label` ("Saved 12:11", "Check-in 12:07").
 */
export const evidenceTimeTdClassName =
  "border-t border-slate-100 px-2.5 py-1.5 text-right whitespace-nowrap tabular-nums font-bold text-slate-900 @max-xs:block @max-xs:border-t-0 @max-xs:py-0.5 @max-xs:text-left @max-xs:before:mr-1.5 @max-xs:before:text-phx-3xs @max-xs:before:font-black @max-xs:before:uppercase @max-xs:before:tracking-[0.12em] @max-xs:before:text-slate-400 @max-xs:before:content-[attr(data-label)]";
