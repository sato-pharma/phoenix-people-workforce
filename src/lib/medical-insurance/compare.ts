// ─────────────────────────────────────────────────────────────────────────────────────────────
// An invoice against the plan, per certificate and per cover. Pure. It reports differences and decides
// nothing: what to pay, dispute or carry to the next statement is decided by a person, and nothing here
// writes a payment or a deduction anywhere.
//
// THE CERTIFICATE IS THE GRAIN. The insurer bills a spouse and children inside the employee's certificate,
// so a family is compared as one row, the plan's people grouped the same way.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import {
  emptyProductAmounts,
  MEDICAL_INSURANCE_PRODUCT_LABELS,
  MEDICAL_INSURANCE_PRODUCTS,
  type MedicalInsuranceCategory,
  type MedicalInsuranceProduct,
  type ProductAmounts,
} from "./cost";
import type { MedicalInsurancePlan, PlannedPerson } from "./eligibility";
import { billedByProduct, type ParsedInvoice } from "./invoice-parser";

export type ComparisonStatus = "match" | "differs" | "billed_not_planned" | "planned_not_billed";

export const COMPARISON_STATUS_WORDS: Record<ComparisonStatus, string> = {
  billed_not_planned: "Billed, not on the plan",
  differs: "Amount differs",
  match: "Matches",
  planned_not_billed: "On the plan, not billed",
};

export type ComparisonRow = {
  key: string;
  certificate: string | null;
  name: string;
  hrId: string | null;
  category: MedicalInsuranceCategory | null;
  planned: ProductAmounts;
  billed: ProductAmounts;
  plannedTotal: number;
  billedTotal: number;
  difference: number;
  status: ComparisonStatus;
  note: string | null;
};

export type ComparisonProductRow = {
  product: MedicalInsuranceProduct;
  label: string;
  plannedPeople: number;
  billedPeople: number;
  plannedPremium: number;
  billedPremium: number;
  plannedCharges: number;
  billedCharges: number;
  plannedTotal: number;
  billedTotal: number;
  difference: number;
};

export type InvoiceComparison = {
  periodStart: string;
  periodEnd: string;
  rows: ComparisonRow[];
  products: ComparisonProductRow[];
  plannedPremium: number;
  billedPremium: number;
  plannedTotal: number;
  billedTotal: number;
  difference: number;
  /** What was billed above plan, row by row, before fees. */
  overBilled: number;
  /** What the plan holds that was not billed, row by row, before fees. */
  underBilled: number;
  counts: Record<ComparisonStatus, number>;
  /** People who belong in the period and could not be priced. */
  unpriced: number;
  prorated: number;
  /** Things about the file itself that stop this comparison being complete. */
  warnings: string[];
};

const PLAN_CATEGORY: Record<string, MedicalInsuranceCategory> = { "001": "A", "002": "B", "003": "C" };

const cents = (value: number) => Math.round(value * 100);
const egp = (piastres: number) => piastres / 100;

function sumAmounts(people: readonly PlannedPerson[]): ProductAmounts {
  const totals = emptyProductAmounts();
  for (const person of people) {
    if (!person.cost) continue;
    for (const product of MEDICAL_INSURANCE_PRODUCTS) {
      totals[product] = egp(cents(totals[product]) + cents(person.cost.products[product]));
    }
  }
  return totals;
}

function totalOf(amounts: ProductAmounts): number {
  return egp(MEDICAL_INSURANCE_PRODUCTS.reduce((sum, product) => sum + cents(amounts[product]), 0));
}

function joinNotes(people: readonly PlannedPerson[]): string | null {
  const notes = [...new Set(people.map((person) => person.note).filter((note): note is string => Boolean(note)))];
  return notes.length > 0 ? notes.join("; ") : null;
}

export function compareInvoiceToPlan(invoice: ParsedInvoice, plan: MedicalInsurancePlan, options: { expectedPolicyNumber?: string | null } = {}): InvoiceComparison {
  const groups = new Map<string, PlannedPerson[]>();
  for (const person of plan.people) {
    const key = person.certificateNumber ? `cert:${person.certificateNumber}` : `person:${person.key}`;
    const group = groups.get(key);
    if (group) group.push(person);
    else groups.set(key, [person]);
  }

  const rows: ComparisonRow[] = [];

  for (const member of invoice.members) {
    const key = `cert:${member.certificate}`;
    const group = groups.get(key) ?? [];
    groups.delete(key);

    const billed = billedByProduct(member);
    const planned = sumAmounts(group);
    const billedTotal = totalOf(billed);
    const plannedTotal = totalOf(planned);
    const principal = group.find((person) => person.memberType === "employee") ?? group[0];
    const billedPlan = member.lines.find((line) => line.product === "CMM" && line.premium > 0)?.plan ?? null;
    const billedCategory = billedPlan ? PLAN_CATEGORY[billedPlan] ?? null : null;

    let status: ComparisonStatus;
    let note = joinNotes(group);
    if (group.length === 0) {
      status = "billed_not_planned";
      note = "On the invoice, and no one on the register holds this certificate";
    } else if (group.every((person) => person.outOfPlan)) {
      status = "billed_not_planned";
    } else if (cents(billedTotal) === cents(plannedTotal)) {
      status = "match";
    } else {
      status = "differs";
      if (billedCategory && principal?.category && billedCategory !== principal.category) {
        const word = `Billed at category ${billedCategory}, the register holds ${principal.category}`;
        note = note ? `${word}; ${note}` : word;
      }
    }

    rows.push({
      billed,
      billedTotal,
      category: principal?.category ?? billedCategory,
      certificate: member.certificate,
      difference: egp(cents(billedTotal) - cents(plannedTotal)),
      hrId: principal?.hrId ?? null,
      key,
      name: principal?.name ?? member.name,
      note,
      planned,
      plannedTotal,
      status,
    });
  }

  for (const [key, group] of groups) {
    const planned = sumAmounts(group);
    const plannedTotal = totalOf(planned);
    // Someone the rule has already taken off, and the insurer did not bill either: nothing to report.
    if (group.every((person) => person.outOfPlan)) continue;
    const principal = group.find((person) => person.memberType === "employee") ?? group[0];
    rows.push({
      billed: emptyProductAmounts(),
      billedTotal: 0,
      category: principal.category,
      certificate: principal.certificateNumber,
      difference: egp(-cents(plannedTotal)),
      hrId: principal.hrId,
      key,
      name: principal.name,
      note: joinNotes(group),
      planned,
      plannedTotal,
      status: "planned_not_billed",
    });
  }

  const order: Record<ComparisonStatus, number> = { billed_not_planned: 0, differs: 1, match: 3, planned_not_billed: 2 };
  rows.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));

  const counts: Record<ComparisonStatus, number> = { billed_not_planned: 0, differs: 0, match: 0, planned_not_billed: 0 };
  let overBilled = 0;
  let underBilled = 0;
  for (const row of rows) {
    counts[row.status] += 1;
    const difference = cents(row.difference);
    if (difference > 0) overBilled += difference;
    else underBilled -= difference;
  }

  const planLines = new Map(plan.statement.lines.map((line) => [line.product, line]));
  const billedProducts = new Map(invoice.products.map((entry) => [entry.code, entry]));
  const billedPeopleOf = (product: MedicalInsuranceProduct) =>
    invoice.members.reduce((sum, member) => sum + member.lines.filter((line) => line.product === product && line.premium > 0).length, 0);

  const products = MEDICAL_INSURANCE_PRODUCTS.map((product): ComparisonProductRow => {
    const planned = planLines.get(product);
    const billed = billedProducts.get(product);
    const plannedPremium = planned?.premium ?? 0;
    const billedPremium = billed ? egp(cents(billed.premium) + cents(billed.adjustments)) : 0;
    const plannedTotal = planned?.total ?? 0;
    const billedTotal = billed?.totalDue ?? 0;
    return {
      billedCharges: egp(cents(billedTotal) - cents(billedPremium)),
      billedPeople: billedPeopleOf(product),
      billedPremium,
      billedTotal,
      difference: egp(cents(billedTotal) - cents(plannedTotal)),
      label: MEDICAL_INSURANCE_PRODUCT_LABELS[product],
      plannedCharges: egp(cents(plannedTotal) - cents(plannedPremium)),
      plannedPeople: planned?.people ?? 0,
      plannedPremium,
      plannedTotal,
      product,
    };
  });

  const warnings = [...invoice.problems];
  if (options.expectedPolicyNumber && invoice.policyNumber && invoice.policyNumber !== options.expectedPolicyNumber) {
    warnings.unshift(`This invoice is for policy ${invoice.policyNumber}, and the policy on file is ${options.expectedPolicyNumber}.`);
  }
  if (invoice.periodStart !== plan.period.start || invoice.periodEnd !== plan.period.end) {
    warnings.unshift("The invoice's billing period is not one of the policy's own periods, so the plan was worked for the invoice's dates.");
  }
  if (plan.unpriced > 0) {
    warnings.push(`${plan.unpriced} ${plan.unpriced === 1 ? "person belongs" : "people belong"} in this period with no category decided, so the plan total is short by their cost.`);
  }

  return {
    billedPremium: invoice.premiumTotal,
    billedTotal: invoice.totalDue,
    counts,
    difference: egp(cents(invoice.totalDue) - cents(plan.statement.total)),
    overBilled: egp(overBilled),
    periodEnd: invoice.periodEnd,
    periodStart: invoice.periodStart,
    plannedPremium: plan.statement.premiumTotal,
    plannedTotal: plan.statement.total,
    products,
    prorated: plan.prorated,
    rows,
    underBilled: egp(underBilled),
    unpriced: plan.unpriced,
    warnings,
  };
}
