import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// The one way a table row opens a panel beneath itself.
//
// Owner, 2026-10-28, on a district manager's day table that read as two rows per
// visit: "Fold in, joined panel". A line a row shows on EVERY row belongs in that
// row's own cells. A panel the row opens on a click stays, but it is part of the
// row, never a second one:
//
//   - no hairline between the row and its panel. RULE 2 in app/globals.css draws a
//     1px orange border on every cell with `!important`, so a hand-written
//     `<tr><td colSpan>` always reads as a new row. `tr[data-row-detail] > td` is
//     the ONE exception to that rule — its top edge is `hidden`, which is the only
//     border style that wins over the row above's bottom edge in a collapsed table;
//   - the row and its panel share the hover tint;
//   - the panel never repeats what the row already says — no date, person,
//     customer, status or amount the row's own cells show.
//
// The row that opens it carries `rowDetailToggleProps(id, open)` so a screen
// reader hears which panel the click controls. Pinned by
// tests/table-row-detail-joined.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** The `aria-*` pair the opening row (or its toggle button) carries. */
export function rowDetailToggleProps(id: string, open: boolean) {
  return { "aria-controls": id, "aria-expanded": open } as const;
}

export function TableRowDetail({
  children,
  className,
  colSpan,
  id,
}: {
  children: ReactNode;
  /** Padding or text classes for the panel's cell. Never a background — the panel wears its row's. */
  className?: string;
  /** Every column of the table, so the panel spans the whole row. */
  colSpan: number;
  /** The id the opening row names in `aria-controls`. */
  id?: string;
}) {
  return (
    <tr data-row-detail="" id={id}>
      <td className={cn("min-w-0 break-words px-3 pb-3 pt-1 align-top", className)} colSpan={colSpan}>
        {children}
      </td>
    </tr>
  );
}
