/**
 * The kind of cost a claim is for — Traveling, Meeting or Other — and the filter Expense Approvals
 * offers on it (owner, 2026-11-23: "I want to be able to filter by, for example, meeting, for
 * example, other, for example, traveling").
 *
 * The kind is the claim's own `expense_type`: the three values Submit Expense offers, and the only
 * three production holds (332 traveling, 24 meeting, 7 other on 23 Nov 2026). Anything else reads as
 * Traveling, because a claim whose type nobody recognises is checked as a trip — never excused as a
 * cost that owes no trip days and no photos.
 *
 * Pure and import-free, so the page, the address, the history read and the checks share one
 * definition (tests/expense-desk-kind.test.ts).
 */

import type { ClaimKind } from "@/lib/outstation/approvals/types";

/** The order the filter prints them in. */
export const CLAIM_KINDS = ["traveling", "meeting", "other"] as const satisfies ReadonlyArray<ClaimKind>;

/** The words Submit Expense asks it in. */
export const CLAIM_KIND_LABEL: Record<ClaimKind, string> = { meeting: "Meeting", other: "Other", traveling: "Traveling" };

/** The filter's own "no filter" button. */
export const ALL_KINDS_LABEL = "All kinds";

export function claimKindOf(expenseType: unknown): ClaimKind {
  const key = String(expenseType ?? "").trim().toLowerCase();
  return key === "meeting" || key === "other" ? key : "traveling";
}

/** A kind named in the address or in a request; null for anything else, so junk filters nothing. */
export function claimKindFromParam(value: string | null | undefined): ClaimKind | null {
  const key = String(value ?? "").trim().toLowerCase();
  return key === "traveling" || key === "meeting" || key === "other" ? key : null;
}

/** How many of these claims are of each kind — the figure beside each filter button. */
export function kindCounts(claims: ReadonlyArray<{ kind?: ClaimKind | null }>): Record<ClaimKind, number> {
  const out: Record<ClaimKind, number> = { meeting: 0, other: 0, traveling: 0 };
  for (const claim of claims) out[claimKindOf(claim.kind)] += 1;
  return out;
}

/**
 * The history read's filter for a kind, as PostgREST reads it: `column` and `pattern` for a kind
 * that is one stored value, or one `or` condition for Traveling — every stored type that is not one
 * of the other two, an empty one included. Matches `claimKindOf` on every value production holds.
 */
export function claimKindFilter(kind: ClaimKind): { column: "expense_type"; pattern: string } | { or: string } {
  if (kind === "traveling") return { or: "expense_type.is.null,and(expense_type.not.ilike.meeting,expense_type.not.ilike.other)" };
  return { column: "expense_type", pattern: kind };
}
