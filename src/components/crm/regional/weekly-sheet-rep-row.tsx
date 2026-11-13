"use client";

import { useState, type ReactNode } from "react";

import { TableRowDetail, rowDetailToggleProps } from "@/components/ui/table-row-detail";

/**
 * A rep's row on the Weekly Sheet's desktop table when it has AM accounts to open. The only client piece of the
 * screen: it holds whether the accounts are open, and draws them as the row's own joined panel (`TableRowDetail`),
 * never as a second row. Every figure and word arrives already rendered from the server view — this file decides
 * nothing about a grade.
 */
export function WeeklySheetRepRow({
  anchor,
  cells,
  children,
  colSpan,
  lastCell,
  showLabel,
}: {
  /** The row's id, so "Reps to look at" can open it. */
  anchor: string;
  /** Every cell but the last, already drawn. */
  cells: ReactNode;
  /** The accounts, drawn in the panel. */
  children: ReactNode;
  colSpan: number;
  /** The last cell's figures; the toggle sits under them. */
  lastCell: ReactNode;
  /** The toggle's words while closed, e.g. "Show 4 accounts". */
  showLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const detailId = `${anchor}-accounts`;
  return (
    <>
      <tr className="scroll-mt-4 border-b border-slate-100 align-top" id={anchor}>
        {cells}
        <td className="break-words px-4 py-3">
          {lastCell}
          <button
            className="mt-1 text-left text-phx-xs font-black uppercase tracking-[0.1em] text-orange-700 hover:underline"
            onClick={() => setOpen((value) => !value)}
            type="button"
            {...rowDetailToggleProps(detailId, open)}
          >
            {open ? "Hide accounts" : showLabel}
          </button>
        </td>
      </tr>
      {open ? (
        <TableRowDetail className="px-0 pb-0 pt-0" colSpan={colSpan} id={detailId}>
          {children}
        </TableRowDetail>
      ) : null}
    </>
  );
}
