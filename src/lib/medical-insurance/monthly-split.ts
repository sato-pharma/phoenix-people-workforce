// ─────────────────────────────────────────────────────────────────────────────────────────────
// Who carries the medical cover each month: the company or the employee. Pure, and free of Supabase, so one
// test pins it and a client component imports it.
//
// THE RULE (owner, 2026-11-17):
//   * The company carries 70% of the EMPLOYEE'S OWN cover, and the employee the other 30%.
//   * The employee's share of their own cover is never less than EGP 120 a month ("if the share of the rep
//     is less than 120 … make it at least 120"); the company carries the rest of that person's cover, so the
//     two shares still add back to the month.
//   * A spouse or child the employee puts on the policy is the employee's in full.
//   * EGP 85 a month of life insurance is added for EVERY PERSON COVERED (the employee and each family
//     member), and it is on the employee's share.
//
// WHAT THE RULE DOES NOT SAY, AND THIS FILE ASSUMES (each one is said on the Cost tab):
//   * A person's monthly cost is their annual premium plus the contract's 1.55% tax and supervision, divided
//     by twelve. The EGP 30 card and the EGP 90 issue fee are charged once, so they are in no month.
//   * The premium is the one the contract prices: the plan, and the insurer's age band (the year cover starts
//     less the year of birth).
//
// 🔴 ONLY THE SUPER ADMIN SEES THIS. It is built into `MedicalInsuranceMoneyView`, which is read only after
// medical_insurance_invoices:read has passed (view.ts). It decides nothing and moves nothing: no payroll, no
// deduction. Every amount is worked in whole piastres, and the company's part is the month less the employee's
// share, so the two always add back to the month.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { annualRate, ageBandWords, type MedicalInsuranceCategory, type MedicalInsuranceMemberType, type MedicalInsuranceRateCard } from "./cost";

/** The company's share of the employee's own cover, in basis points (owner, 2026-11-17). */
const COMPANY_SHARE_BASIS_POINTS = 7_000;
/** Life insurance a month for every person covered, on the employee's share (owner, 2026-11-17). */
export const LIFE_INSURANCE_PER_PERSON_MONTHLY = 85;
/** The least an employee carries of their own cover each month (owner, 2026-11-17). Never more than the month itself. */
export const EMPLOYEE_MINIMUM_OWN_SHARE_MONTHLY = 120;

export const MONTHLY_SPLIT_ASSUMPTIONS: readonly string[] = [
  "A month of cover is the person's annual premium plus the 1.55% tax and supervision, divided by twelve. The EGP 30 card and the EGP 90 issue fee are charged once and are in no month.",
  "The premium is the contract's: the person's plan, and the age band the insurer prices (the year their cover starts less the year of birth).",
];

export type MonthlySplitMember = {
  id: string;
  hrId: string | null;
  memberType: MedicalInsuranceMemberType;
  principalMemberId: string | null;
  name: string;
  category: MedicalInsuranceCategory;
  coverageStart: string;
  coverageEnd: string | null;
  birthDate: string | null;
};

export type MonthlySplitPerson = {
  memberId: string;
  name: string;
  memberType: MedicalInsuranceMemberType;
  category: MedicalInsuranceCategory;
  band: string | null;
  /** The month of cover: premium and tax over twelve. Null when the person cannot be priced. */
  monthly: number | null;
  unpricedReason: string | null;
  /** Set when cover starts after the day the split is read. */
  startsOn: string | null;
};

export type MonthlySplitRow = {
  key: string;
  /** The employee. Null when a family member's employee is no longer on the register. */
  employee: MonthlySplitPerson | null;
  hrId: string | null;
  family: MonthlySplitPerson[];
  /** The employee's own month, the company's part of it and the employee's 30% (at least EGP 120). */
  ownMonthly: number;
  companyPays: number;
  employeeOwnShare: number;
  /** The employee's 30% was under EGP 120, so it was raised to EGP 120. */
  raisedToMinimum: boolean;
  /** Every family member's month, all on the employee. */
  familyMonthly: number;
  people: number;
  lifeInsurance: number;
  /** The employee's 30%, the family in full and the life insurance. */
  employeePays: number;
  /** People in this row who cannot be priced, so the row is short by them. */
  unpriced: number;
};

export type MonthlySplit = {
  rows: MonthlySplitRow[];
  totals: {
    employees: number;
    people: number;
    companyPays: number;
    employeesPay: number;
    lifeInsurance: number;
    /** Company plus employees: what the cover and life insurance cost a month. */
    total: number;
  };
  unpriced: number;
};

const toPiastres = (egp: number) => Math.round(egp * 100);
// `|| 0` turns a minus zero into zero, so it never prints as "-0.00".
const toEgp = (piastres: number) => Math.round(piastres) / 100 || 0;

/** A month of one person's cover in piastres: premium and tax over twelve. */
export function monthlyCoverPiastres(card: MedicalInsuranceRateCard, annual: number): number {
  return Math.round((toPiastres(annual) * (10_000 + card.taxBasisPoints)) / 10_000 / 12);
}

/**
 * A month of the employee's own cover, in piastres, split: the employee's 30%, raised to EGP 120 when it is
 * less (never above the month itself), and the company the rest. The two always add back to the month.
 */
export function splitOwnCover(monthlyPiastres: number): { company: number; employee: number; raisedToMinimum: boolean } {
  if (monthlyPiastres <= 0) return { company: 0, employee: 0, raisedToMinimum: false };
  const thirty = monthlyPiastres - Math.round((monthlyPiastres * COMPANY_SHARE_BASIS_POINTS) / 10_000);
  const minimum = Math.min(monthlyPiastres, toPiastres(EMPLOYEE_MINIMUM_OWN_SHARE_MONTHLY));
  const employee = Math.max(thirty, minimum);
  return { company: monthlyPiastres - employee, employee, raisedToMinimum: employee > thirty };
}

// ── The cost calculator (owner, 2026-11-27: "a cost calculator in the module … employee or family of employee
// … the birth year and the grade, and it calculates the cost") ─────────────────────────────────────────────

export type MonthlyCostQuote =
  | { priced: false; age: number | null; reason: string }
  | {
      priced: true;
      age: number;
      band: string;
      annual: number;
      /** A month of the person's cover: premium and tax over twelve. */
      monthly: number;
      /** The company's part of the month: 70% of an employee's own cover, nothing of a spouse or child. */
      companyPays: number;
      /** The cover's part on the employee: their 30% (at least EGP 120), or a relative's month in full. */
      employeeCover: number;
      raisedToMinimum: boolean;
      lifeInsurance: number;
      /** What the employee pays a month for this person: the cover's part on them and the life insurance. */
      employeePays: number;
      /** The contract's age limit, when this person is past it: a review, never a refusal. */
      ageNote: string | null;
    };

/**
 * What one person would cost a month, by who they are, their year of birth and their plan, priced as the Cost
 * tab prices a person on the register: the same rate card, the same age (the year cover starts less the year
 * of birth), the same 70/30 split with its EGP 120 floor and EGP 85 life insurance. A spouse or child is the
 * employee's in full. Pure; the Cost tab's calculator calls it in the browser.
 */
export function quoteMonthlyCost(input: {
  birthYear: number;
  category: MedicalInsuranceCategory;
  coverageStart: string;
  memberType: MedicalInsuranceMemberType;
  rateCard: MedicalInsuranceRateCard;
}): MonthlyCostQuote {
  const { birthYear, category, coverageStart, memberType, rateCard } = input;
  if (!Number.isInteger(birthYear) || birthYear < 1900 || birthYear > Number(coverageStart.slice(0, 4))) {
    return { age: null, priced: false, reason: "Type a year of birth, four digits, not after the year cover starts" };
  }
  const rate = annualRate(rateCard, { birthDate: `${birthYear}-01-01`, category, coverageStart });
  if (!rate.priced) return { age: rate.age, priced: false, reason: rate.reason };
  const monthly = monthlyCoverPiastres(rateCard, rate.annual);
  const own = memberType === "employee" ? splitOwnCover(monthly) : { company: 0, employee: monthly, raisedToMinimum: false };
  const life = toPiastres(LIFE_INSURANCE_PER_PERSON_MONTHLY);
  const limit = rateCard.ageLimits?.[memberType];
  let ageNote: string | null = null;
  if (typeof limit === "number" && rate.age > limit) {
    ageNote = memberType === "child"
      ? `Aged ${rate.age}: the plan covers children up to ${limit}`
      : `Aged ${rate.age}: over ${limit} needs a health statement, and conditions from before the policy are not covered`;
  }
  return {
    age: rate.age,
    ageNote,
    annual: rate.annual,
    band: ageBandWords(rateCard.ageBands[rate.band]),
    companyPays: toEgp(own.company),
    employeeCover: toEgp(own.employee),
    employeePays: toEgp(own.employee + life),
    lifeInsurance: toEgp(life),
    monthly: toEgp(monthly),
    priced: true,
    raisedToMinimum: own.raisedToMinimum,
  };
}

/**
 * Cover that ends on its own first day was never in force: it is how a removal "voided from its first day"
 * is recorded (the register refuses an end before the start), for someone who was not an employee on the
 * policy dates. It costs nothing and charges nothing, in every month (owner, 2026-11-27: a leaver voided
 * from 1 December was still charged EGP 205 for December).
 */
export function wasNeverInForce(member: Pick<MonthlySplitMember, "coverageEnd" | "coverageStart">): boolean {
  return member.coverageEnd !== null && member.coverageEnd <= member.coverageStart;
}

/**
 * The monthly split for everyone whose cover has not ended by `asOf` (cover that starts later is counted and
 * shows its start day). One row per employee with their family under them; a family member whose employee is
 * not on the register stands as a row of their own and is the employee's in full.
 */
export function buildMonthlySplit(input: { asOf: string; members: readonly MonthlySplitMember[]; rateCard: MedicalInsuranceRateCard }): MonthlySplit {
  const { asOf, members, rateCard } = input;
  const open = members.filter((member) => !wasNeverInForce(member) && (member.coverageEnd === null || member.coverageEnd >= asOf));

  const person = (member: MonthlySplitMember): { piastres: number | null; view: MonthlySplitPerson } => {
    const rate = annualRate(rateCard, { birthDate: member.birthDate, category: member.category, coverageStart: member.coverageStart });
    const piastres = rate.priced ? monthlyCoverPiastres(rateCard, rate.annual) : null;
    const view: MonthlySplitPerson = {
      band: rate.band >= 0 ? ageBandWords(rateCard.ageBands[rate.band]) : null,
      category: member.category,
      memberId: member.id,
      memberType: member.memberType,
      monthly: piastres === null ? null : toEgp(piastres),
      name: member.name,
      startsOn: member.coverageStart > asOf ? member.coverageStart : null,
      unpricedReason: rate.priced ? null : rate.reason,
    };
    return { piastres, view };
  };

  const employees = open.filter((member) => member.memberType === "employee");
  const employeeIds = new Set(employees.map((member) => member.id));
  const familyOf = new Map<string, MonthlySplitMember[]>();
  const strays: MonthlySplitMember[] = [];
  for (const member of open) {
    if (member.memberType === "employee") continue;
    if (member.principalMemberId && employeeIds.has(member.principalMemberId)) {
      familyOf.set(member.principalMemberId, [...(familyOf.get(member.principalMemberId) ?? []), member]);
    } else {
      strays.push(member);
    }
  }

  const lifePerPerson = toPiastres(LIFE_INSURANCE_PER_PERSON_MONTHLY);

  const build = (key: string, head: MonthlySplitMember | null, family: readonly MonthlySplitMember[]): MonthlySplitRow => {
    const own = head ? person(head) : null;
    const relatives = family.map(person);
    const ownPiastres = own?.piastres ?? 0;
    const { company, employee, raisedToMinimum } = splitOwnCover(ownPiastres);
    const familyPiastres = relatives.reduce((sum, relative) => sum + (relative.piastres ?? 0), 0);
    const people = (head ? 1 : 0) + relatives.length;
    const life = lifePerPerson * people;
    return {
      companyPays: toEgp(company),
      employee: own ? own.view : null,
      employeeOwnShare: toEgp(employee),
      employeePays: toEgp(employee + familyPiastres + life),
      family: relatives.map((relative) => relative.view),
      familyMonthly: toEgp(familyPiastres),
      hrId: head?.hrId ?? null,
      key,
      lifeInsurance: toEgp(life),
      ownMonthly: toEgp(ownPiastres),
      people,
      raisedToMinimum,
      unpriced: [own, ...relatives].filter((entry) => entry && entry.piastres === null).length,
    };
  };

  const rows = [
    ...employees.map((head) => build(head.id, head, familyOf.get(head.id) ?? [])),
    ...strays.map((stray) => build(stray.id, null, [stray])),
  ].sort((left, right) => (left.employee?.name ?? left.family[0]?.name ?? "").localeCompare(right.employee?.name ?? right.family[0]?.name ?? ""));

  const sum = (pick: (row: MonthlySplitRow) => number) => rows.reduce((total, row) => total + toPiastres(pick(row)), 0);
  const companyPays = sum((row) => row.companyPays);
  const employeesPay = sum((row) => row.employeePays);
  return {
    rows,
    totals: {
      companyPays: toEgp(companyPays),
      employees: employees.length,
      employeesPay: toEgp(employeesPay),
      lifeInsurance: toEgp(sum((row) => row.lifeInsurance)),
      people: rows.reduce((total, row) => total + row.people, 0),
      total: toEgp(companyPays + employeesPay),
    },
    unpriced: rows.reduce((total, row) => total + row.unpriced, 0),
  };
}

/** What payroll takes from one employee for a payroll month (payrollChargesForWindow). */
export type PayrollMedicalInsuranceCharge = {
  hrId: string;
  name: string;
  /** `employeePays` of the employee's monthly split row: their own share, their family in full, the life insurance. */
  amount: number;
  /** People in the row who cannot be priced. Payroll refuses to charge a row that is short by them. */
  unpriced: number;
};

/**
 * What each employee pays for a payroll month, from the same split the Cost tab and the Medical Cover Statement
 * show (owner, 2026-11-24: "in december implement everyone med ins deductions from medical insurance module").
 * A person is in the month when their cover touches any day of `from`..`to`, and is charged the whole month, the
 * way the Employee Master's flat figure was. Cover voided from its first day is in no month (`wasNeverInForce`). Only an employee with an HR id can be charged: a relative is charged
 * on the employee's row, and a relative whose employee is no longer on the register is charged to nobody.
 */
export function payrollChargesForWindow(input: {
  from: string;
  to: string;
  members: readonly MonthlySplitMember[];
  rateCard: MedicalInsuranceRateCard;
}): PayrollMedicalInsuranceCharge[] {
  const { from, to } = input;
  const inMonth = input.members.filter(
    (member) => !wasNeverInForce(member) && member.coverageStart <= to && (member.coverageEnd === null || member.coverageEnd >= from),
  );
  const split = buildMonthlySplit({ asOf: from, members: inMonth, rateCard: input.rateCard });
  return split.rows
    .filter((row): row is MonthlySplitRow & { employee: MonthlySplitPerson; hrId: string } => row.employee !== null && Boolean(row.hrId))
    .map((row) => ({ amount: row.employeePays, hrId: row.hrId, name: row.employee.name, unpriced: row.unpriced }));
}

/**
 * The rows a Medical Cover Statement can be made for (cost-letter.ts): an employee still on the register, by
 * name. A relative whose employee left has no one to hand it to. Here, not in cost-letter.ts, so the tab that
 * lists them does not carry the PDF renderer into the browser.
 */
export function costLetterRows(rows: readonly MonthlySplitRow[]): MonthlySplitRow[] {
  return rows.filter((row) => row.employee !== null).sort((a, b) => (a.employee?.name ?? "").localeCompare(b.employee?.name ?? ""));
}
