// ─────────────────────────────────────────────────────────────────────────────────────────────
// What cover costs, from a policy's own rate card. Pure, so one test can pin it to the cent against
// the insurer's first invoice (EGP 306,122.04), and free of Supabase so a client component imports it.
//
// EVERY AMOUNT IS WORKED IN WHOLE PIASTRES. The insurer rounds each fee per product, half up, and
// 0.5% of 1,007.00 is 5.035: in floating point that lands on 5.0349 and rounds the wrong way. In
// piastres it is 503.5 exactly, and the invoice prints 5.04.
//
// A PART PERIOD IS CHARGED BY THE DAY, AND THAT IS AN ASSUMPTION. The policy has no clause for someone
// who joins or leaves part-way through a billing period, so `prorated` is carried out to the screen,
// where it is labelled as ours and not the contract's.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const MEDICAL_INSURANCE_PRODUCTS = ["AD", "CMM", "GTL", "PPDA", "PTD"] as const;
export type MedicalInsuranceProduct = (typeof MEDICAL_INSURANCE_PRODUCTS)[number];

export const MEDICAL_INSURANCE_PRODUCT_LABELS: Record<MedicalInsuranceProduct, string> = {
  AD: "Accidental death",
  CMM: "Medical",
  GTL: "Life",
  PPDA: "Partial disability",
  PTD: "Total disability",
};

export type MedicalInsuranceCategory = "A" | "B" | "C";
export const MEDICAL_INSURANCE_CATEGORIES: readonly MedicalInsuranceCategory[] = ["A", "B", "C"];

export type MedicalInsuranceMemberType = "employee" | "spouse" | "child";

export type MedicalInsuranceRateCard = {
  billingMonths: number;
  currency: string;
  sumInsured: number;
  medicalPerPerson: Record<MedicalInsuranceCategory, number>;
  /** Accidental death, life and the two disability covers: employees only, one rate for every category. */
  employeeCoversPerPerson: Record<Exclude<MedicalInsuranceProduct, "CMM">, number>;
  supervisoryFeeBasisPoints: number;
  stampBasisPoints: Record<MedicalInsuranceProduct, number>;
  /** Charged once, on the policy's first statement. */
  issueFee: { product: MedicalInsuranceProduct; fee: number; nominalStamp: number };
};

export type MedicalInsurancePeriod = { start: string; end: string };

export type ProductAmounts = Record<MedicalInsuranceProduct, number>;

const toPiastres = (egp: number) => Math.round(egp * 100);
const toEgp = (piastres: number) => Math.round(piastres) / 100;

export function emptyProductAmounts(): ProductAmounts {
  return { AD: 0, CMM: 0, GTL: 0, PPDA: 0, PTD: 0 };
}

function dayNumber(day: string): number {
  return Math.floor(Date.parse(`${day.slice(0, 10)}T00:00:00Z`) / 86_400_000);
}

/** Days from `start` to `end`, both counted. */
export function inclusiveDays(start: string, end: string): number {
  return dayNumber(end) - dayNumber(start) + 1;
}

export function addMonths(day: string, months: number): string {
  const [year, month, date] = day.slice(0, 10).split("-").map(Number);
  const moved = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(moved.getUTCFullYear(), moved.getUTCMonth() + 1, 0)).getUTCDate();
  moved.setUTCDate(Math.min(date, lastDay));
  return moved.toISOString().slice(0, 10);
}

function dayBefore(day: string): string {
  return new Date((dayNumber(day) - 1) * 86_400_000).toISOString().slice(0, 10);
}

/** The billing periods of a policy, in order: 1 Nov to 31 Jan, 1 Feb to 30 Apr, and so on. */
export function billingPeriods(policy: { startsOn: string; endsOn: string; billingMonths: number }): MedicalInsurancePeriod[] {
  const periods: MedicalInsurancePeriod[] = [];
  let start = policy.startsOn;
  while (start <= policy.endsOn && periods.length < 60) {
    const next = addMonths(start, policy.billingMonths);
    periods.push({ end: dayBefore(next), start });
    start = next;
  }
  return periods;
}

/** The period holding `day`, or the nearest one when the day falls outside the policy. */
export function billingPeriodFor(periods: readonly MedicalInsurancePeriod[], day: string): MedicalInsurancePeriod {
  return periods.find((period) => day >= period.start && day <= period.end) ?? (day < periods[0].start ? periods[0] : periods[periods.length - 1]);
}

export type CostableMember = {
  memberType: MedicalInsuranceMemberType;
  category: MedicalInsuranceCategory;
  coverageStart: string;
  coverageEnd: string | null;
};

export type MemberCost = {
  days: number;
  periodDays: number;
  prorated: boolean;
  products: ProductAmounts;
  total: number;
};

/** One person's premium for one period, before fees. Null when their cover misses the period entirely. */
export function memberPeriodCost(rateCard: MedicalInsuranceRateCard, member: CostableMember, period: MedicalInsurancePeriod): MemberCost | null {
  const start = member.coverageStart > period.start ? member.coverageStart : period.start;
  const end = member.coverageEnd && member.coverageEnd < period.end ? member.coverageEnd : period.end;
  if (start > end) return null;

  const days = inclusiveDays(start, end);
  const periodDays = inclusiveDays(period.start, period.end);
  const share = (rate: number) => Math.round((toPiastres(rate) * days) / periodDays);

  const piastres = {
    AD: member.memberType === "employee" ? share(rateCard.employeeCoversPerPerson.AD) : 0,
    CMM: share(rateCard.medicalPerPerson[member.category]),
    GTL: member.memberType === "employee" ? share(rateCard.employeeCoversPerPerson.GTL) : 0,
    PPDA: member.memberType === "employee" ? share(rateCard.employeeCoversPerPerson.PPDA) : 0,
    PTD: member.memberType === "employee" ? share(rateCard.employeeCoversPerPerson.PTD) : 0,
  };

  const products = emptyProductAmounts();
  let total = 0;
  for (const product of MEDICAL_INSURANCE_PRODUCTS) {
    products[product] = toEgp(piastres[product]);
    total += piastres[product];
  }

  return { days, periodDays, prorated: days !== periodDays, products, total: toEgp(total) };
}

export type ProductStatementLine = {
  product: MedicalInsuranceProduct;
  label: string;
  people: number;
  premium: number;
  issueFee: number;
  fees: number;
  stamp: number;
  total: number;
};

export type PeriodStatement = {
  lines: ProductStatementLine[];
  premiumTotal: number;
  feesTotal: number;
  total: number;
};

/**
 * A period's premium totals, one per product, turned into the statement the insurer would print: the
 * supervisory fee and the stamp duty are worked on each product's premium and rounded there, so the
 * sum of the rounded figures is what matches, never a rate applied to the grand total. On the first
 * statement the life line also carries the issue fee and its nominal stamp.
 */
export function periodStatement(
  rateCard: MedicalInsuranceRateCard,
  premiums: ProductAmounts,
  people: Record<MedicalInsuranceProduct, number>,
  options: { includeIssueFee: boolean },
): PeriodStatement {
  let premiumTotal = 0;
  let feesTotal = 0;
  let grand = 0;

  const lines = MEDICAL_INSURANCE_PRODUCTS.map((product): ProductStatementLine => {
    const premium = toPiastres(premiums[product]);
    const fees = Math.round((premium * rateCard.supervisoryFeeBasisPoints) / 10_000);
    const stamp = Math.round((premium * rateCard.stampBasisPoints[product]) / 10_000);
    const issue = options.includeIssueFee && premium > 0 && rateCard.issueFee.product === product
      ? toPiastres(rateCard.issueFee.fee) + toPiastres(rateCard.issueFee.nominalStamp)
      : 0;
    const total = premium + issue + fees + stamp;

    premiumTotal += premium;
    feesTotal += issue + fees + stamp;
    grand += total;

    return {
      fees: toEgp(fees),
      issueFee: toEgp(issue),
      label: MEDICAL_INSURANCE_PRODUCT_LABELS[product],
      people: people[product],
      premium: toEgp(premium),
      product,
      stamp: toEgp(stamp),
      total: toEgp(total),
    };
  });

  return { feesTotal: toEgp(feesTotal), lines, premiumTotal: toEgp(premiumTotal), total: toEgp(grand) };
}

/** Adds one person's cost to running product totals and head counts, in piastres so nothing drifts. */
export function addToProductTotals(
  totals: ProductAmounts,
  people: Record<MedicalInsuranceProduct, number>,
  cost: MemberCost,
): void {
  for (const product of MEDICAL_INSURANCE_PRODUCTS) {
    if (cost.products[product] === 0) continue;
    totals[product] = toEgp(toPiastres(totals[product]) + toPiastres(cost.products[product]));
    people[product] += 1;
  }
}

/** A policy's stored rate card, read defensively: a card missing a figure refuses rather than prices at zero. */
export function parseRateCard(raw: unknown): MedicalInsuranceRateCard {
  const card = raw as MedicalInsuranceRateCard | null;
  const figures = card
    ? [
        card.billingMonths,
        card.supervisoryFeeBasisPoints,
        ...MEDICAL_INSURANCE_CATEGORIES.map((category) => card.medicalPerPerson?.[category]),
        card.employeeCoversPerPerson?.AD,
        card.employeeCoversPerPerson?.GTL,
        card.employeeCoversPerPerson?.PPDA,
        card.employeeCoversPerPerson?.PTD,
        ...MEDICAL_INSURANCE_PRODUCTS.map((product) => card.stampBasisPoints?.[product]),
        card.issueFee?.fee,
        card.issueFee?.nominalStamp,
      ]
    : [undefined];
  if (figures.some((figure) => typeof figure !== "number" || !Number.isFinite(figure))) {
    throw new Error("The policy's rate card is missing a figure, so no cost can be worked out.");
  }
  return card as MedicalInsuranceRateCard;
}
