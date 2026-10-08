// 🔴 A CHAIN VISIT IS ONE VISIT, AND IT IS IN BOTH MANAGERS' RECORDS (owner, 2026-10-08).
//
// His words: "the rep submits the chain visit and chooses, for example, two managers; it is counted one
// visit for the rep and for the two managers — one visit for the three, so the three have this visit in
// their records, but the one who submitted is the medical rep."
//
// Phoenix CRM saves a chain visit as ONE row carrying both managers: slot 1 (`double_visitor_*`) and
// slot 2 (`double_visitor2_*`). So the two sides of every double-visit figure read it differently:
//
// - The REP's side (received, visited, a company total) reads the ROW. It counts once, never twice.
// - A MANAGER's side (performed, given, his day, his coaching) reads `perDoubleVisitorRows`, which hands
//   each manager on the row his OWN view of it — himself in slot 1, the other manager in slot 2 — so the
//   second manager is counted exactly the way the first one is, by every reader written for slot 1.
//
// No person can be counted twice for one visit: slot 1 is `coalesce(manager, product_manager, senior)`,
// so slot 2 is never filled while slot 1 is empty, and the two slots always hold two different people.
// A vendor row has no slot 2 and passes through unchanged, so the old CRM's history reads as it did.

export type DoubleVisitorSlots = {
  double_visitor_hr_id: string | null;
  double_visitor_name: string | null;
  double_visitor2_hr_id?: string | null;
  double_visitor2_name?: string | null;
};

/** True when the row is a chain visit carrying a second manager in slot 2. */
export function hasSecondDoubleVisitor(row: DoubleVisitorSlots): boolean {
  return Boolean(row.double_visitor2_hr_id || row.double_visitor2_name);
}

/** The row as each manager on it sees it: slot 1's own view first, then slot 2's (the slots swapped). */
export function doubleVisitorViews<T extends DoubleVisitorSlots>(row: T): T[] {
  if (!hasSecondDoubleVisitor(row)) return [row];
  return [
    row,
    {
      ...row,
      double_visitor_hr_id: row.double_visitor2_hr_id ?? null,
      double_visitor_name: row.double_visitor2_name ?? null,
      double_visitor2_hr_id: row.double_visitor_hr_id,
      double_visitor2_name: row.double_visitor_name,
    },
  ];
}

/** Every manager-side reader iterates THIS: one entry per (visit, manager). Never a rep-side count. */
export function perDoubleVisitorRows<T extends DoubleVisitorSlots>(rows: readonly T[]): T[] {
  return rows.flatMap((row) => doubleVisitorViews(row));
}

/**
 * The row with only the managers `keep` admits, a kept slot 2 promoted into slot 1 when slot 1 is not
 * kept. Null when nobody on it is kept. A scope or an allow-list therefore removes one manager's credit
 * without ever removing the other's, and never drops the rep's visit while someone on it is admitted.
 */
export function keepDoubleVisitors<T extends DoubleVisitorSlots>(
  row: T,
  keep: (hrId: string | null) => boolean,
): T | null {
  const views = doubleVisitorViews(row);
  const kept = views.filter((view) => keep(view.double_visitor_hr_id));
  if (kept.length === views.length) return row;
  if (kept.length === 0) return null;
  return { ...kept[0], double_visitor2_hr_id: null, double_visitor2_name: null };
}

/** The camel-case visit-log and report-row shape of the same two slots. */
export type DoubleVisitorEntrySlots = {
  doubleVisitorHrId: string | null;
  doubleVisitorName: string | null;
  doubleVisitor2HrId?: string | null;
  doubleVisitor2Name?: string | null;
};

/** The visit log, one entry per (visit, manager) — the log-entry twin of perDoubleVisitorRows. Client-safe,
 * so a screen that totals managers from the log credits a chain visit's second manager as the server does. */
export function visitLogPerDoubleVisitor<T extends DoubleVisitorEntrySlots>(entries: readonly T[]): T[] {
  return entries.flatMap((entry) =>
    entry.doubleVisitor2HrId || entry.doubleVisitor2Name
      ? [
          entry,
          {
            ...entry,
            doubleVisitorHrId: entry.doubleVisitor2HrId ?? null,
            doubleVisitorName: entry.doubleVisitor2Name ?? null,
            doubleVisitor2HrId: entry.doubleVisitorHrId,
            doubleVisitor2Name: entry.doubleVisitorName,
          },
        ]
      : [entry],
  );
}
