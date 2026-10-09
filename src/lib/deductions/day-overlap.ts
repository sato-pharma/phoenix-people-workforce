// Unified Deductions module: which candidate rows on ONE screen charge the same employee on the same
// day. Pure — no DB I/O — and client-safe, so the workspace can flag them as it lists them.
//
// The publish gate (findDayCollisions in conflict.ts) deliberately counts two rows of one category and
// one source as a single claim, so a duplicate written by one source is invisible to it. Measured on
// production 2026-09: one resigned representative carried an Approved and a Pending CRM row for the
// same day, both 533.33 EGP. Nothing flagged it; approving the second — or "Select all, approve" in the
// bulk bar — would have charged the day twice.

import { resolveAppliedDeductionDates } from "./calculations.ts";
import type { DeductionsCategory } from "./types.ts";

export type OverlapRow = {
  id: string;
  employeeHrId: string;
  category: DeductionsCategory;
  dates: readonly string[];
  decision?: { decisionStatus?: string | null; appliedDates?: readonly string[] | null } | null;
};

export type SameDayOverlap = { otherIds: string[]; dates: string[] };

/**
 * A manual Loan / Other entry is anchored to `${monthKey}-01` as a placeholder, not a detected day
 * (connectors/manual.ts), so those two categories never claim a day.
 */
const CATEGORIES_WITHOUT_DAY_CLAIMS: ReadonlySet<DeductionsCategory> = new Set<DeductionsCategory>(["loan", "other"]);

/**
 * For every row that shares a CHARGED day with another row of the same employee and category, the other
 * rows' ids and the shared days. A day only counts while it is still charged: a row marked "Do Not Take
 * Action" charges nothing, and a day the reviewer unticked is not applied — flagging either would tell
 * them to clear something they have already cleared.
 */
export function findSameDayOverlaps(rows: readonly OverlapRow[]): Map<string, SameDayOverlap> {
  const byDay = new Map<string, string[]>();
  for (const row of rows) {
    if (CATEGORIES_WITHOUT_DAY_CLAIMS.has(row.category)) continue;
    if ((row.decision?.decisionStatus ?? "Pending") === "Do Not Take Action") continue;
    const employee = String(row.employeeHrId ?? "").trim().toLowerCase();
    if (!employee) continue;
    for (const date of resolveAppliedDeductionDates({ dates: row.dates, decision: row.decision })) {
      if (typeof date !== "string" || !date.trim()) continue;
      const key = `${employee}\u0000${row.category}\u0000${date.trim()}`;
      const ids = byDay.get(key) ?? [];
      if (!ids.includes(row.id)) ids.push(row.id);
      byDay.set(key, ids);
    }
  }

  const found = new Map<string, { others: Set<string>; dates: Set<string> }>();
  for (const [key, ids] of byDay) {
    if (ids.length < 2) continue;
    const date = key.slice(key.lastIndexOf("\u0000") + 1);
    for (const id of ids) {
      const entry = found.get(id) ?? { others: new Set<string>(), dates: new Set<string>() };
      for (const other of ids) if (other !== id) entry.others.add(other);
      entry.dates.add(date);
      found.set(id, entry);
    }
  }

  const result = new Map<string, SameDayOverlap>();
  for (const [id, entry] of found) result.set(id, { otherIds: [...entry.others].sort(), dates: [...entry.dates].sort() });
  return result;
}
