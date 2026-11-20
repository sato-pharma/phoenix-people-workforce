// ─────────────────────────────────────────────────────────────────────────────────────────────
// What cover costs under the Libano-Suisse policy, from the policy's own rate card. Pure, so one test can
// pin it to the issued policy's schedule (EGP 927,635.54 for 139 people), and free of Supabase so a client
// component imports it.
//
// THE CONTRACT (policy 50048950, document MED/6021-3, issued 22 November 2026, cover to 26 November 2027):
//   * The premium is per person for the policy's term, by plan and five-year age band. The code calls it the
//     annual rate, and the card holds it BEFORE TAX: the schedule's printed "Premium per age band group" already
//     carries the 1.55%, so each stored rate is the printed one divided by 1.0155, to the piastre (Libano-Suisse's
//     first invoice and Initial Breakdown, 20 November 2026, prove it: each person's year is the printed rate).
//   * On top of the premium: 1.55% tax and supervision, EGP 30 per member for the card, and EGP 90 issue fee.
//   * The band is picked by the insurer's age: the year cover starts less the year of birth (`pricingAge`).
//   * The year's premium and tax are paid in quarterly instalments (`premiumInstalments`); the first one also
//     carries every card and the issue fee.
//   * A joiner is charged the premium by the day, from the day they join to the policy's end; one who joins
//     from the policy's tenth month (its last quarter) pays 25% of it instead.
//   * A leaver is refunded for the rest of the term, whether or not a claim was made (the policy's annex);
//     this file counts it by the day from the day after they leave.
//
// WHAT THE CONTRACT DOES NOT SAY, AND THIS FILE ASSUMES (each one is shown on the Cost tab):
//   * A joiner's age is taken in the year of their own first day.
//   * The 1.55% is added to a joiner's charge and taken off a leaver's refund as well; the card fee is
//     charged on a joiner and never refunded; the issue fee is charged once, on the opening bill.
//
// EVERY AMOUNT IS WORKED IN WHOLE PIASTRES, so a tax of 1.55% never lands on the wrong side of a half.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type MedicalInsuranceCategory = "A" | "B" | "C";
export const MEDICAL_INSURANCE_CATEGORIES: readonly MedicalInsuranceCategory[] = ["A", "B", "C"];

export type MedicalInsuranceMemberType = "employee" | "spouse" | "child";

export type AgeBand = { from: number; to: number | null };

export type PlanTerms = {
  annualLimit: number;
  network: string;
  room: string;
  /** One rate per age band, in the order of `ageBands`. Null where the insurer has not quoted. */
  rates: Array<number | null>;
};

export type MedicalInsuranceRateCard = {
  currency: string;
  ageBands: AgeBand[];
  plans: Record<MedicalInsuranceCategory, PlanTerms>;
  taxBasisPoints: number;
  cardFeePerMember: number;
  issueFee: number;
  cardReissueFee: number;
  lastQuarterAdditionBasisPoints: number;
  /**
   * How many instalments the year's premium and tax are paid in (policy 50048950: 4, quarterly). The first one
   * also carries every card and the issue fee. Missing means one bill for the year.
   */
  premiumInstalments?: number;
  ageLimits: Record<MedicalInsuranceMemberType, number>;
};

export type MedicalInsurancePolicyDates = { startsOn: string; endsOn: string };

const toPiastres = (egp: number) => Math.round(egp * 100);
// `|| 0` turns a minus zero (a refund of nothing) into zero, so it never prints as "-0.00".
const toEgp = (piastres: number) => Math.round(piastres) / 100 || 0;

function dayNumber(day: string): number {
  return Math.floor(Date.parse(`${day.slice(0, 10)}T00:00:00Z`) / 86_400_000);
}

/** Days from `start` to `end`, both counted. */
function inclusiveDays(start: string, end: string): number {
  return dayNumber(end) - dayNumber(start) + 1;
}

export function addDays(day: string, days: number): string {
  return new Date((dayNumber(day) + days) * 86_400_000).toISOString().slice(0, 10);
}

export function addMonths(day: string, months: number): string {
  const [year, month, date] = day.slice(0, 10).split("-").map(Number);
  const moved = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(moved.getUTCFullYear(), moved.getUTCMonth() + 1, 0)).getUTCDate();
  moved.setUTCDate(Math.min(date, lastDay));
  return moved.toISOString().slice(0, 10);
}

/** Whole years of age on a day. Null without a birth date, or for a birth date after the day. */
export function ageOn(birthDate: string | null | undefined, day: string): number | null {
  if (!birthDate || !/^\d{4}-\d{2}-\d{2}/.test(birthDate)) return null;
  const [by, bm, bd] = birthDate.slice(0, 10).split("-").map(Number);
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age -= 1;
  return age < 0 ? null : age;
}

/**
 * The age the insurer prices with: the year of the day cover starts less the year of birth, so someone born
 * on 3 December 1996 is priced at 30 for cover from 22 November 2026. Libano-Suisse's Initial Breakdown for
 * policy 50048950 (20 November 2026) priced all 139 people this way; the exact age on the day priced only 136
 * of them. Null without a birth date, or for a birth year after the day's.
 */
export function pricingAge(birthDate: string | null | undefined, day: string): number | null {
  if (!birthDate || !/^\d{4}-\d{2}-\d{2}/.test(birthDate)) return null;
  const age = Number(day.slice(0, 4)) - Number(birthDate.slice(0, 4));
  return age < 0 ? null : age;
}

function ageBandIndex(card: MedicalInsuranceRateCard, age: number): number {
  return card.ageBands.findIndex((band) => age >= band.from && (band.to === null || age <= band.to));
}

export function ageBandWords(band: AgeBand | undefined): string {
  if (!band) return "No band";
  return band.to === null ? `${band.from} and over` : `${band.from} to ${band.to}`;
}

/** The first day of the policy's last quarter: from here a joiner pays a quarter of the year. */
export function lastQuarterStart(policy: MedicalInsurancePolicyDates): string {
  return addMonths(policy.startsOn, 9);
}

export type PersonToPrice = {
  category: MedicalInsuranceCategory;
  birthDate: string | null;
  /** The day cover starts. Its year sets the priced age (`pricingAge`), and so the band. */
  coverageStart: string;
};

export type Rate =
  | { priced: true; age: number; band: number; annual: number }
  | { priced: false; age: number | null; band: number; reason: string };

/** A person's annual premium. Unpriced, with the reason in words, when no birth date or no quoted rate. */
export function annualRate(card: MedicalInsuranceRateCard, person: PersonToPrice): Rate {
  const age = pricingAge(person.birthDate, person.coverageStart);
  if (age === null) return { age: null, band: -1, priced: false, reason: "No date of birth" };
  const band = ageBandIndex(card, age);
  const rate = band >= 0 ? card.plans[person.category]?.rates[band] : null;
  if (typeof rate !== "number") {
    return { age, band, priced: false, reason: `Plan ${person.category} is not quoted for ages ${ageBandWords(card.ageBands[band])}` };
  }
  return { age, annual: rate, band, priced: true };
}

type BandLine = { band: number; label: string; people: number; rate: number | null; premium: number };

export type PlanLine = { category: MedicalInsuranceCategory; people: number; premium: number; bands: BandLine[] };

export type OpeningStatement = {
  plans: PlanLine[];
  people: number;
  priced: number;
  unpriced: number;
  premium: number;
  tax: number;
  cards: number;
  issueFee: number;
  total: number;
};

/**
 * The year's opening bill, laid out as the policy's schedule is: per plan, per age band, the band's premium
 * as the rate times its people, to the piastre (the issued policy prints rates in piastres, so a band's total
 * is never rounded to the pound); then the tax on the premium, the card fee per person and the issue fee.
 * Unpriced people are counted and carry a card, but no premium.
 */
export function openingStatement(card: MedicalInsuranceRateCard, people: readonly PersonToPrice[]): OpeningStatement {
  const counts = new Map<string, number>();
  let unpriced = 0;
  for (const person of people) {
    const rate = annualRate(card, person);
    if (!rate.priced) {
      unpriced += 1;
      continue;
    }
    const key = `${person.category}:${rate.band}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let premiumPiastres = 0;
  const plans = (["A", "B", "C"] as const).map((category): PlanLine => {
    const bands: BandLine[] = [];
    let planPiastres = 0;
    let planPeople = 0;
    card.ageBands.forEach((band, index) => {
      const count = counts.get(`${category}:${index}`) ?? 0;
      if (count === 0) return;
      const rate = card.plans[category].rates[index];
      const bandPiastres = toPiastres(rate ?? 0) * count;
      bands.push({ band: index, label: ageBandWords(band), people: count, premium: toEgp(bandPiastres), rate });
      planPiastres += bandPiastres;
      planPeople += count;
    });
    premiumPiastres += planPiastres;
    return { bands, category, people: planPeople, premium: toEgp(planPiastres) };
  });

  const tax = Math.round((premiumPiastres * card.taxBasisPoints) / 10_000);
  const cards = toPiastres(card.cardFeePerMember) * people.length;
  const issue = people.length > 0 ? toPiastres(card.issueFee) : 0;
  return {
    cards: toEgp(cards),
    issueFee: toEgp(issue),
    people: people.length,
    plans,
    premium: toEgp(premiumPiastres),
    priced: people.length - unpriced,
    tax: toEgp(tax),
    total: toEgp(premiumPiastres + tax + cards + issue),
    unpriced,
  };
}

/** How many instalments the card says the year is paid in; one when it does not say. */
export function premiumInstalmentCount(card: Pick<MedicalInsuranceRateCard, "premiumInstalments">): number {
  return card.premiumInstalments ?? 1;
}

/**
 * Which instalment a bill is, 1 to `count`, from the first day it covers: the year is cut into `count` equal
 * runs of months from the policy's first day (quarterly: 22 November, 22 February, 22 May, 22 August). A bill
 * that gives no first day is taken as the first.
 */
export function instalmentNumber(policy: Pick<MedicalInsurancePolicyDates, "startsOn">, count: number, coversFrom: string | null): number {
  if (count <= 1 || !coversFrom) return 1;
  const [y1, m1, d1] = policy.startsOn.slice(0, 10).split("-").map(Number);
  const [y2, m2, d2] = coversFrom.slice(0, 10).split("-").map(Number);
  const months = (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);
  return Math.min(Math.max(Math.floor(months / (12 / count)) + 1, 1), count);
}

/**
 * One instalment of the opening statement: the year's premium and tax split evenly, the first one also carrying
 * every card and the issue fee. With one instalment it is the whole opening bill.
 */
export function openingInstalment(opening: Pick<OpeningStatement, "premium" | "tax" | "cards" | "issueFee">, count: number, number: number): number {
  const share = Math.round((toPiastres(opening.premium) + toPiastres(opening.tax)) / Math.max(count, 1));
  const fees = number === 1 ? toPiastres(opening.cards) + toPiastres(opening.issueFee) : 0;
  return toEgp(share + fees);
}

export type Movement = {
  kind: "addition" | "deletion";
  /** For an addition the first covered day; for a deletion the last. */
  day: string;
  days: number;
  policyDays: number;
  lastQuarter: boolean;
  annual: number;
  premium: number;
  tax: number;
  card: number;
  /** Positive for a charge, negative for a refund. */
  total: number;
};

/** A joiner's charge: by the day to the policy's end, or a quarter of the year from the last quarter on. */
export function additionCharge(card: MedicalInsuranceRateCard, policy: MedicalInsurancePolicyDates, annual: number, from: string): Movement {
  const policyDays = inclusiveDays(policy.startsOn, policy.endsOn);
  const days = Math.max(0, inclusiveDays(from, policy.endsOn));
  const lastQuarter = from >= lastQuarterStart(policy);
  const premium = lastQuarter
    ? Math.round((toPiastres(annual) * card.lastQuarterAdditionBasisPoints) / 10_000)
    : Math.round((toPiastres(annual) * days) / policyDays);
  const tax = Math.round((premium * card.taxBasisPoints) / 10_000);
  const cardFee = toPiastres(card.cardFeePerMember);
  return {
    annual,
    card: toEgp(cardFee),
    day: from,
    days,
    kind: "addition",
    lastQuarter,
    policyDays,
    premium: toEgp(premium),
    tax: toEgp(tax),
    total: toEgp(premium + tax + cardFee),
  };
}

/** A leaver's refund: by the day, from the day after their last covered day to the policy's end. */
export function deletionRefund(card: MedicalInsuranceRateCard, policy: MedicalInsurancePolicyDates, annual: number, lastCoveredDay: string): Movement {
  const policyDays = inclusiveDays(policy.startsOn, policy.endsOn);
  const days = lastCoveredDay >= policy.endsOn ? 0 : Math.min(policyDays, inclusiveDays(addDays(lastCoveredDay, 1), policy.endsOn));
  const premium = Math.round((toPiastres(annual) * days) / policyDays);
  const tax = Math.round((premium * card.taxBasisPoints) / 10_000);
  return {
    annual,
    card: 0,
    day: lastCoveredDay,
    days,
    kind: "deletion",
    lastQuarter: false,
    policyDays,
    premium: toEgp(-premium),
    tax: toEgp(-tax),
    total: toEgp(-(premium + tax)),
  };
}

export function sumMoney(values: readonly number[]): number {
  return toEgp(values.reduce((sum, value) => sum + toPiastres(value), 0));
}

/** A policy's stored rate card, read defensively: a card missing a figure refuses rather than prices at zero. */
export function parseRateCard(raw: unknown): MedicalInsuranceRateCard {
  const card = raw as MedicalInsuranceRateCard | null;
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value);
  const bands = Array.isArray(card?.ageBands) ? card.ageBands : [];
  const sound =
    card !== null &&
    bands.length > 0 &&
    bands.every((band) => number(band?.from) && (band.to === null || number(band.to))) &&
    (["A", "B", "C"] as const).every((category) => {
      const plan = card.plans?.[category];
      return plan && Array.isArray(plan.rates) && plan.rates.length === bands.length && plan.rates.every((rate) => rate === null || (number(rate) && rate > 0));
    }) &&
    [card.taxBasisPoints, card.cardFeePerMember, card.issueFee, card.cardReissueFee, card.lastQuarterAdditionBasisPoints].every(number) &&
    (card.premiumInstalments === undefined || (Number.isInteger(card.premiumInstalments) && card.premiumInstalments >= 1 && card.premiumInstalments <= 12)) &&
    number(card.ageLimits?.employee) && number(card.ageLimits?.spouse) && number(card.ageLimits?.child);
  if (!sound) throw new Error("The policy's rate card is missing a figure, so no cost can be worked out.");
  return card as MedicalInsuranceRateCard;
}

/** The card with one plan's band rates replaced. Each rate is a positive number or null (not quoted). */
export function withPlanRates(card: MedicalInsuranceRateCard, category: MedicalInsuranceCategory, rates: ReadonlyArray<number | null>): MedicalInsuranceRateCard {
  if (rates.length !== card.ageBands.length) throw new Error("Every age band needs a rate or a blank.");
  return parseRateCard({ ...card, plans: { ...card.plans, [category]: { ...card.plans[category], rates: [...rates] } } });
}
