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
//   * The premium is the one the contract prices: the plan, and the age band on the day cover starts.
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
  "The premium is the contract's: the person's plan, and their age band on the day their cover starts.",
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

/**
 * The monthly split for everyone whose cover has not ended by `asOf` (cover that starts later is counted and
 * shows its start day). One row per employee with their family under them; a family member whose employee is
 * not on the register stands as a row of their own and is the employee's in full.
 */
export function buildMonthlySplit(input: { asOf: string; members: readonly MonthlySplitMember[]; rateCard: MedicalInsuranceRateCard }): MonthlySplit {
  const { asOf, members, rateCard } = input;
  const open = members.filter((member) => member.coverageEnd === null || member.coverageEnd >= asOf);

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
