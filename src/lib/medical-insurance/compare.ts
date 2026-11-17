// ─────────────────────────────────────────────────────────────────────────────────────────────
// A bill from Libano-Suisse against what the plan says it should be. Pure.
//
// The bill is recorded by hand (its number, kind, dates and total): Libano-Suisse's layout is not known yet,
// so nothing reads the file. What the plan says comes from the same year's cost the Cost tab shows:
//   * an opening bill against the opening statement;
//   * an additions endorsement against every joiner whose cover starts inside its dates;
//   * a deletions credit note against every leaver whose cover ends inside its dates (a negative amount).
// Planned people count too, flagged, because a bill can arrive before the register is updated.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { sumMoney } from "./cost";
import type { CostLine, PolicyYearCost } from "./eligibility";

export type MedicalInsuranceInvoiceKind = "opening" | "additions" | "deletions" | "other";

export const MEDICAL_INSURANCE_INVOICE_KINDS: readonly MedicalInsuranceInvoiceKind[] = ["opening", "additions", "deletions", "other"];

export const INVOICE_KIND_WORDS: Record<MedicalInsuranceInvoiceKind, string> = {
  additions: "Additions",
  deletions: "Deletions (credit note)",
  opening: "Opening bill",
  other: "Other",
};

export type ComparisonLine = {
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
};

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
    const expected = year.opening.total;
    return { billed, difference: sumMoney([billed, -expected]), expected, kind: invoice.kind, lines: [], unpriced: year.opening.unpriced };
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
