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
//
// 🔴 Since 2026-10-27 (owner: "Everything is applicable") a Phoenix visit may carry more than two people
// besides the rep — the district and regional managers, a product manager and the Training Manager at
// once. Everyone past slot 2 rides in `double_visitor_more`, and each of them gets his OWN view of the row
// the same way: himself in slot 1, the first of the others in slot 2, the rest in `more`.

export type DoubleVisitorSlots = {
  double_visitor_hr_id: string | null;
  double_visitor_name: string | null;
  double_visitor2_hr_id?: string | null;
  double_visitor2_name?: string | null;
  double_visitor_more?: Array<{ hr_id: string; name: string | null }>;
};

type Visitor = { hr_id: string | null; name: string | null };

/** Everyone on the row besides the rep, in slot order: slot 1, slot 2, then the rest. */
function visitorsOf(row: DoubleVisitorSlots): Visitor[] {
  const out: Visitor[] = [{ hr_id: row.double_visitor_hr_id, name: row.double_visitor_name }];
  if (row.double_visitor2_hr_id || row.double_visitor2_name) out.push({ hr_id: row.double_visitor2_hr_id ?? null, name: row.double_visitor2_name ?? null });
  for (const more of row.double_visitor_more ?? []) out.push({ hr_id: more.hr_id, name: more.name });
  return out;
}

/** The row with these people in its slots, in this order; `more` dropped when nobody stands past slot 2. */
function withVisitors<T extends DoubleVisitorSlots>(row: T, visitors: readonly Visitor[]): T {
  const rest = { ...row };
  delete rest.double_visitor_more;
  const more = visitors.slice(2).map((visitor) => ({ hr_id: visitor.hr_id ?? "", name: visitor.name }));
  return {
    ...(rest as T),
    double_visitor_hr_id: visitors[0]?.hr_id ?? null,
    double_visitor_name: visitors[0]?.name ?? null,
    double_visitor2_hr_id: visitors[1]?.hr_id ?? null,
    double_visitor2_name: visitors[1]?.name ?? null,
    ...(more.length > 0 ? { double_visitor_more: more } : {}),
  };
}

/** True when the row is a chain visit carrying a second manager in slot 2. */
export function hasSecondDoubleVisitor(row: DoubleVisitorSlots): boolean {
  return Boolean(row.double_visitor2_hr_id || row.double_visitor2_name);
}

/** The row as each manager on it sees it: slot 1's own view first (the row itself), then each other
 * person's — himself in slot 1, the first of the others in slot 2 (for two people: the slots swapped). */
export function doubleVisitorViews<T extends DoubleVisitorSlots>(row: T): T[] {
  if (!hasSecondDoubleVisitor(row) && !(row.double_visitor_more?.length)) return [row];
  const visitors = visitorsOf(row);
  return visitors.map((visitor, index) => (index === 0 ? row : withVisitors(row, [visitor, ...visitors.filter((_, other) => other !== index)])));
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
  const visitors = visitorsOf(row);
  const kept = visitors.filter((visitor) => keep(visitor.hr_id));
  if (kept.length === visitors.length) return row;
  if (kept.length === 0) return null;
  return withVisitors(row, kept);
}

/** The camel-case visit-log and report-row shape of the same two slots. */
export type DoubleVisitorEntrySlots = {
  doubleVisitorHrId: string | null;
  doubleVisitorName: string | null;
  doubleVisitor2HrId?: string | null;
  doubleVisitor2Name?: string | null;
  /** Everyone past slot 2 (2026-10-27) — each credited exactly as slot 1. */
  doubleVisitorMore?: Array<{ hrId: string; name: string | null }>;
};

/** The visit log, one entry per (visit, manager) — the log-entry twin of perDoubleVisitorRows. Client-safe,
 * so a screen that totals managers from the log credits a chain visit's second manager as the server does. */
export function visitLogPerDoubleVisitor<T extends DoubleVisitorEntrySlots>(entries: readonly T[]): T[] {
  return entries.flatMap((entry) => {
    const visitors: Array<{ hrId: string | null; name: string | null }> = [{ hrId: entry.doubleVisitorHrId, name: entry.doubleVisitorName }];
    if (entry.doubleVisitor2HrId || entry.doubleVisitor2Name) visitors.push({ hrId: entry.doubleVisitor2HrId ?? null, name: entry.doubleVisitor2Name ?? null });
    for (const more of entry.doubleVisitorMore ?? []) visitors.push(more);
    if (visitors.length === 1) return [entry];
    return visitors.map((visitor, index) => {
      if (index === 0) return entry;
      const others = visitors.filter((_, other) => other !== index);
      const rest = { ...entry };
      delete rest.doubleVisitorMore;
      const more = others.slice(1).map((other) => ({ hrId: other.hrId ?? "", name: other.name }));
      return {
        ...(rest as T),
        doubleVisitorHrId: visitor.hrId,
        doubleVisitorName: visitor.name,
        doubleVisitor2HrId: others[0]?.hrId ?? null,
        doubleVisitor2Name: others[0]?.name ?? null,
        ...(more.length > 0 ? { doubleVisitorMore: more } : {}),
      };
    });
  });
}
