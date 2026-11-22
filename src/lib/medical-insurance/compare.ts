// ─────────────────────────────────────────────────────────────────────────────────────────────
// A bill from Libano-Suisse against what the plan says it should be. Pure.
//
// The bill is recorded by hand (its number, kind, dates and total): Libano-Suisse's layout is not known yet,
// so nothing reads the file. What the plan says comes from the same year's cost the Cost tab shows:
//   * an opening bill against the opening statement, or, for a policy paid in instalments (policy 50048950 is
//     quarterly), against the instalment its first covered day falls in: the year's premium and tax split
//     evenly, the first one also carrying every card and the issue fee (invoice INV6021-2026-1, 22 November
//     2026 to 21 February 2027: 235,503.75 premium and tax, 4,260 cards and issue fee);
//   * an additions endorsement against every joiner whose cover starts inside its dates;
//   * a deletions credit note against every leaver whose cover ends inside its dates (a negative amount).
// Planned people count too, flagged, because a bill can arrive before the register is updated.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { instalmentNumber, openingInstalment, sumMoney } from "./cost";
import type { CostLine, PolicyYearCost } from "./eligibility";

export type MedicalInsuranceInvoiceKind = "opening" | "additions" | "deletions" | "other";

export const MEDICAL_INSURANCE_INVOICE_KINDS: readonly MedicalInsuranceInvoiceKind[] = ["opening", "additions", "deletions", "other"];

export const INVOICE_KIND_WORDS: Record<MedicalInsuranceInvoiceKind, string> = {
  additions: "Additions",
  deletions: "Deletions (credit note)",
  opening: "Opening bill or premium instalment",
  other: "Other",
};

type ComparisonLine = {
  name: string;
  day: string;
  planned: boolean;
  amount: number | null;
  unpricedReason: string | null;
};

export type InvoiceComparison = {
  kind: MedicalInsuranceInvoiceKind;
  billed: number;
  /** Null for a bill of kind `other`, which the plan has nothing to say about. */
  expected: number | null;
  difference: number | null;
  /** The people the expectation is made of; empty on an opening bill, whose statement is the Cost tab's. */
  lines: ComparisonLine[];
  /** People inside the bill's dates whom the plan cannot price, so the expectation is short by them. */
  unpriced: number;
  /** Which instalment an opening bill was held against, on a policy paid in instalments; null otherwise. */
  instalment?: { number: number; of: number } | null;
};

/**
 * What is wrong with a bill's dates, in the words the form shows, or null. An opening bill needs its first covered
 * day: on a policy paid in instalments that day picks the quarter, and without it every instalment would be held
 * against the first one, cards and issue fee included (the form did not ask for it until 20 November 2026).
 */
export function invoiceDatesProblem(kind: MedicalInsuranceInvoiceKind, coversFrom: string | null, coversTo: string | null): string | null {
  if (coversFrom && coversTo && coversTo < coversFrom) return "The bill's last day is before its first.";
  if (kind === "opening" && !coversFrom) return "Enter the first day the bill covers, so it is compared with the right instalment.";
  return null;
}

function inside(line: CostLine, from: string | null, to: string | null): boolean {
  return (!from || line.day >= from) && (!to || line.day <= to);
}

export function compareInvoiceToPlan(
  invoice: { kind: MedicalInsuranceInvoiceKind; totalDue: number; coversFrom: string | null; coversTo: string | null },
  year: PolicyYearCost,
): InvoiceComparison {
  const billed = invoice.totalDue;
  if (invoice.kind === "other") return { billed, difference: null, expected: null, kind: invoice.kind, lines: [], unpriced: 0 };

  if (invoice.kind === "opening") {
    const count = year.premiumInstalments;
    const number = instalmentNumber({ startsOn: year.policyStartsOn }, count, invoice.coversFrom);
    const expected = openingInstalment(year.opening, count, number);
    return {
      billed,
      difference: sumMoney([billed, -expected]),
      expected,
      instalment: count > 1 ? { number, of: count } : null,
      kind: invoice.kind,
      lines: [],
      unpriced: year.opening.unpriced,
    };
  }

  const wanted = invoice.kind === "additions" ? ["addition", "planned_addition"] : ["deletion", "planned_deletion"];
  // A planned joiner from the policy's first day belongs on the opening bill (no movement, and priced),
  // so they are left out of an additions endorsement.
  const chosen = [...year.movements, ...year.planned].filter(
    (line) => wanted.includes(line.kind) && (line.movement !== null || line.unpricedReason !== null) && inside(line, invoice.coversFrom, invoice.coversTo),
  );
  const lines = chosen.map((line) => ({
    amount: line.movement?.total ?? null,
    day: line.day,
    name: line.name,
    planned: line.kind.startsWith("planned_"),
    unpricedReason: line.unpricedReason,
  }));
  const expected = sumMoney(lines.map((line) => line.amount ?? 0));
  return {
    billed,
    difference: sumMoney([billed, -expected]),
    expected,
    kind: invoice.kind,
    lines,
    unpriced: lines.filter((line) => line.amount === null).length,
  };
}
