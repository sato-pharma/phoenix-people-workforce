// ─────────────────────────────────────────────────────────────────────────────────────────────
// Who should be on the policy, and what to do about the difference from who is (owner, 2026-11-04:
// "everyone from day one but note that the policy started 1 nov and ofcourse i can make exceptions and
// full control"). Pure, and it decides nothing: it lists what the register and the rule disagree on,
// and a person acts on the list.
//
// THE RULE. An employee belongs from the later of their joining date and the policy's start, until their
// exit day. An exception beats the rule in either direction, and carries its reason.
//
// THE LAST DAY IS `employeeExitDay`'s: the later of the last working date and the resignation date. So
// someone serving notice is still covered, and leaves the list on the day they actually leave.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { formatLeftDay } from "@/lib/employees/left-flag";

import {
  addToProductTotals,
  emptyProductAmounts,
  memberPeriodCost,
  periodStatement,
  type MedicalInsuranceCategory,
  type MedicalInsuranceMemberType,
  type MedicalInsurancePeriod,
  type MedicalInsuranceProduct,
  type MedicalInsuranceRateCard,
  type MemberCost,
  type PeriodStatement,
} from "./cost";

/** How far ahead a joiner or leaver appears on the list as coming up. */
export const MEDICAL_INSURANCE_HORIZON_DAYS = 30;

export type EmployeeFacts = {
  hrId: string;
  name: string;
  jobTitle: string | null;
  lineName: string | null;
  hireDate: string | null;
  exitDay: string | null;
  employmentStatus: string | null;
  /** The Employee Master's own answer for who is active. */
  active: boolean;
};

export type MemberFacts = {
  id: string;
  hrId: string | null;
  memberType: MedicalInsuranceMemberType;
  principalMemberId: string | null;
  certificateNumber: string | null;
  name: string;
  category: MedicalInsuranceCategory;
  coverageStart: string;
  coverageEnd: string | null;
};

export type ExceptionFacts = {
  id: string;
  hrId: string;
  decision: "keep_out" | "keep_in";
  reason: string;
};

export type CoverWindow = { from: string; until: string | null };

const DEPARTED_STATUSES = new Set(["resigned", "terminated"]);

/**
 * The stretch of the policy an employee's own record says they belong in. Null for someone who never
 * belongs: a declined offer never started, and ledger rows and placeholders are nobody.
 */
export function employeeCoverWindow(employee: EmployeeFacts, policy: { startsOn: string; endsOn: string }): CoverWindow | null {
  const status = String(employee.employmentStatus ?? "").trim().toLowerCase();
  const departed = DEPARTED_STATUSES.has(status);
  if (!employee.active && !departed) return null;

  const from = employee.hireDate && employee.hireDate > policy.startsOn ? employee.hireDate : policy.startsOn;
  if (from > policy.endsOn) return null;

  const until = employee.exitDay && (departed || employee.exitDay >= from) ? employee.exitDay : null;
  // Left, with no day on record: the record cannot place them inside the policy, so they do not belong.
  if (departed && !until) return null;
  // Gone before cover could begin.
  if (until && until < from) return null;
  return { from, until };
}

function dayKey(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function addDays(day: string, days: number): string {
  return new Date(dayKey(day) + days * 86_400_000).toISOString().slice(0, 10);
}

export type MedicalInsuranceActionKind = "add" | "remove" | "review";

export type MedicalInsuranceAction = {
  key: string;
  kind: MedicalInsuranceActionKind;
  /** `now` is overdue or due today; `soon` falls inside the horizon. */
  timing: "now" | "soon";
  hrId: string | null;
  name: string;
  jobTitle: string | null;
  lineName: string | null;
  /** The day cover should begin or end. */
  effectiveOn: string;
  reason: string;
  memberId: string | null;
  memberType: MedicalInsuranceMemberType;
  certificateNumber: string | null;
  category: MedicalInsuranceCategory | null;
  suggestedCategory: MedicalInsuranceCategory | null;
  dependants: number;
};

export type KeptException = ExceptionFacts & { name: string };

export type MedicalInsuranceActions = {
  actions: MedicalInsuranceAction[];
  exceptions: KeptException[];
};

function isOpenOn(member: MemberFacts, day: string): boolean {
  return !member.coverageEnd || member.coverageEnd >= day;
}

/**
 * The commonest category among people already covered in the same job, or null when nobody is. A
 * suggestion for whoever adds the joiner, never a decision: the category is what the employee is
 * entitled to, and no column on their record states it.
 */
export function suggestCategory(jobTitle: string | null, members: readonly MemberFacts[], employeesByHrId: ReadonlyMap<string, EmployeeFacts>): MedicalInsuranceCategory | null {
  const wanted = String(jobTitle ?? "").trim().toLowerCase();
  if (!wanted) return null;
  const counts = new Map<MedicalInsuranceCategory, number>();
  for (const member of members) {
    if (member.memberType !== "employee" || !member.hrId) continue;
    const title = String(employeesByHrId.get(member.hrId)?.jobTitle ?? "").trim().toLowerCase();
    if (title === wanted) counts.set(member.category, (counts.get(member.category) ?? 0) + 1);
  }
  let best: MedicalInsuranceCategory | null = null;
  let bestCount = 0;
  for (const [category, count] of counts) {
    if (count > bestCount) {
      best = category;
      bestCount = count;
    }
  }
  return best;
}

/** Everything the rule and the register disagree on, as of a day. */
export function buildMedicalInsuranceActions(input: {
  asOf: string;
  employees: readonly EmployeeFacts[];
  exceptions: readonly ExceptionFacts[];
  members: readonly MemberFacts[];
  policy: { startsOn: string; endsOn: string };
}): MedicalInsuranceActions {
  const { asOf, employees, exceptions, members, policy } = input;
  const horizon = addDays(asOf, MEDICAL_INSURANCE_HORIZON_DAYS);
  const employeesByHrId = new Map(employees.map((employee) => [employee.hrId, employee]));
  const exceptionByHrId = new Map(exceptions.map((exception) => [exception.hrId, exception]));
  const openEmployeeRows = new Map<string, MemberFacts>();
  for (const member of members) {
    if (member.memberType === "employee" && member.hrId && isOpenOn(member, asOf)) openEmployeeRows.set(member.hrId, member);
  }

  const actions: MedicalInsuranceAction[] = [];

  for (const employee of employees) {
    if (openEmployeeRows.has(employee.hrId)) continue;
    if (exceptionByHrId.get(employee.hrId)?.decision === "keep_out") continue;
    const window = employeeCoverWindow(employee, policy);
    if (!window || (window.until && window.until < asOf) || window.from > horizon) continue;

    actions.push({
      category: null,
      certificateNumber: null,
      dependants: 0,
      effectiveOn: window.from,
      hrId: employee.hrId,
      jobTitle: employee.jobTitle,
      key: `add:${employee.hrId}`,
      kind: "add",
      lineName: employee.lineName,
      memberId: null,
      memberType: "employee",
      name: employee.name,
      reason: employee.hireDate && employee.hireDate > policy.startsOn ? "Joined after the policy started" : "Working when the policy started, and not on it",
      suggestedCategory: suggestCategory(employee.jobTitle, members, employeesByHrId),
      timing: window.from <= asOf ? "now" : "soon",
    });
  }

  for (const member of members) {
    if (member.memberType !== "employee" || !isOpenOn(member, asOf)) continue;
    const dependants = members.filter((other) => other.principalMemberId === member.id && isOpenOn(other, asOf)).length;
    const base = {
      category: member.category,
      certificateNumber: member.certificateNumber,
      dependants,
      memberId: member.id,
      memberType: member.memberType,
      name: member.name,
      suggestedCategory: null,
    };

    const employee = member.hrId ? employeesByHrId.get(member.hrId) : undefined;
    if (!employee) {
      actions.push({
        ...base,
        effectiveOn: member.coverageStart,
        hrId: member.hrId,
        jobTitle: null,
        key: `review:${member.id}`,
        kind: "review",
        lineName: null,
        reason: "On the policy with no Phoenix employee record",
        timing: "now",
      });
      continue;
    }
    if (exceptionByHrId.get(employee.hrId)?.decision === "keep_in") continue;

    const shared = { ...base, hrId: employee.hrId, jobTitle: employee.jobTitle, key: `remove:${member.id}`, kind: "remove" as const, lineName: employee.lineName };
    const window = employeeCoverWindow(employee, policy);
    if (!window) {
      const declined = String(employee.employmentStatus ?? "").trim().toLowerCase() === "declined_offer";
      actions.push({
        ...shared,
        effectiveOn: member.coverageStart,
        reason: declined ? "Declined the offer and never started" : "Not an employee on the policy dates",
        timing: "now",
      });
    } else if (window.until && !member.coverageEnd && window.until <= horizon) {
      actions.push({
        ...shared,
        effectiveOn: window.until,
        reason: window.until <= asOf ? "Has left" : "Is leaving",
        timing: window.until <= asOf ? "now" : "soon",
      });
    }
  }

  // An open spouse or child under a certificate that has ended has nothing to sit under.
  for (const member of members) {
    if (member.memberType === "employee" || !member.principalMemberId || !isOpenOn(member, asOf)) continue;
    const principal = members.find((other) => other.id === member.principalMemberId);
    if (!principal || isOpenOn(principal, asOf)) continue;
    actions.push({
      category: member.category,
      certificateNumber: member.certificateNumber,
      dependants: 0,
      effectiveOn: principal.coverageEnd ?? asOf,
      hrId: principal.hrId,
      jobTitle: null,
      key: `remove:${member.id}`,
      kind: "remove",
      lineName: null,
      memberId: member.id,
      memberType: member.memberType,
      name: member.name,
      reason: `Family of ${principal.name}, whose cover has ended`,
      suggestedCategory: null,
      timing: "now",
    });
  }

  const rank: Record<MedicalInsuranceActionKind, number> = { add: 1, remove: 0, review: 2 };
  actions.sort((a, b) =>
    (a.timing === b.timing ? 0 : a.timing === "now" ? -1 : 1)
    || rank[a.kind] - rank[b.kind]
    || a.effectiveOn.localeCompare(b.effectiveOn)
    || a.name.localeCompare(b.name));

  const nameOf = (hrId: string) =>
    employeesByHrId.get(hrId)?.name ?? members.find((member) => member.hrId === hrId)?.name ?? "Name not on record";

  return {
    actions,
    exceptions: exceptions.map((exception) => ({ ...exception, name: nameOf(exception.hrId) })),
  };
}

export type PlannedPerson = {
  key: string;
  memberId: string | null;
  hrId: string | null;
  name: string;
  memberType: MedicalInsuranceMemberType;
  certificateNumber: string | null;
  category: MedicalInsuranceCategory | null;
  coverageStart: string;
  coverageEnd: string | null;
  cost: MemberCost | null;
  /** Why this person's plan differs from the register, in words. Null when it does not. */
  note: string | null;
  /** On the register, and the rule says they should not have been billed for this period at all. */
  outOfPlan: boolean;
};

export type MedicalInsurancePlan = {
  period: MedicalInsurancePeriod;
  people: PlannedPerson[];
  statement: PeriodStatement;
  /** People who belong in the period and could not be priced, because no category is known. */
  unpriced: number;
  prorated: number;
};

/**
 * What a period should cost: the people the rule says belong in it, at the rate card.
 *
 * The register's row is the start, and the employee's record cuts it. Someone billed who left before the
 * period began stays on this list at no cost and with the reason, because that row is exactly what the
 * comparison has to name. Someone who belongs and has no row yet is added at the category their job
 * suggests, and counted as unpriced if there is none.
 */
export function buildMedicalInsurancePlan(input: {
  employees: readonly EmployeeFacts[];
  exceptions: readonly ExceptionFacts[];
  members: readonly MemberFacts[];
  period: MedicalInsurancePeriod;
  policy: { startsOn: string; endsOn: string };
  rateCard: MedicalInsuranceRateCard;
}): MedicalInsurancePlan {
  const { employees, exceptions, members, period, policy, rateCard } = input;
  const employeesByHrId = new Map(employees.map((employee) => [employee.hrId, employee]));
  const exceptionByHrId = new Map(exceptions.map((exception) => [exception.hrId, exception]));
  const membersById = new Map(members.map((member) => [member.id, member]));
  const people: PlannedPerson[] = [];
  const coveredHrIds = new Set<string>();

  for (const member of members) {
    const owner = member.memberType === "employee" ? member : member.principalMemberId ? membersById.get(member.principalMemberId) : undefined;
    const employee = owner?.hrId ? employeesByHrId.get(owner.hrId) : undefined;
    const exception = owner?.hrId ? exceptionByHrId.get(owner.hrId) : undefined;
    if (member.memberType === "employee" && member.hrId && (!member.coverageEnd || member.coverageEnd >= period.start)) coveredHrIds.add(member.hrId);

    let end = member.coverageEnd;
    let note: string | null = null;
    let outOfPlan = false;

    if (employee && exception?.decision !== "keep_in") {
      const window = employeeCoverWindow(employee, policy);
      const who = member.memberType === "employee" ? "" : `${employee.name}: `;
      if (!window) {
        outOfPlan = true;
        const declined = String(employee.employmentStatus ?? "").trim().toLowerCase() === "declined_offer";
        note = `${who}${declined ? "declined the offer" : "not an employee on these dates"}`;
      } else if (window.until && (!end || window.until < end)) {
        end = window.until;
        if (window.until < period.start) {
          outOfPlan = true;
          note = `${who}left on ${formatLeftDay(window.until)}, before this period`;
        } else if (window.until < period.end) {
          note = `${who}leaves on ${formatLeftDay(window.until)}, charged by the day`;
        }
      }
    }

    const cost = outOfPlan ? null : memberPeriodCost(rateCard, { category: member.category, coverageEnd: end, coverageStart: member.coverageStart, memberType: member.memberType }, period);
    if (!cost && !outOfPlan) continue;
    if (!note && cost?.prorated) note = "Part of the period, charged by the day";

    people.push({
      category: member.category,
      certificateNumber: member.certificateNumber,
      cost,
      coverageEnd: end,
      coverageStart: member.coverageStart,
      hrId: member.hrId,
      key: member.id,
      memberId: member.id,
      memberType: member.memberType,
      name: member.name,
      note,
      outOfPlan,
    });
  }

  let unpriced = 0;
  for (const employee of employees) {
    if (coveredHrIds.has(employee.hrId) || exceptionByHrId.get(employee.hrId)?.decision === "keep_out") continue;
    const window = employeeCoverWindow(employee, policy);
    if (!window || window.from > period.end || (window.until && window.until < period.start)) continue;

    const category = suggestCategory(employee.jobTitle, members, employeesByHrId);
    if (!category) unpriced += 1;
    const cost = category
      ? memberPeriodCost(rateCard, { category, coverageEnd: window.until, coverageStart: window.from, memberType: "employee" }, period)
      : null;
    people.push({
      category,
      certificateNumber: null,
      cost,
      coverageEnd: window.until,
      coverageStart: window.from,
      hrId: employee.hrId,
      key: `planned:${employee.hrId}`,
      memberId: null,
      memberType: "employee",
      name: employee.name,
      note: category ? `To be added, at category ${category} as the same job holds` : "To be added, category not decided",
      outOfPlan: false,
    });
  }

  const premiums = emptyProductAmounts();
  const counts: Record<MedicalInsuranceProduct, number> = { AD: 0, CMM: 0, GTL: 0, PPDA: 0, PTD: 0 };
  let prorated = 0;
  for (const person of people) {
    if (!person.cost) continue;
    addToProductTotals(premiums, counts, person.cost);
    if (person.cost.prorated) prorated += 1;
  }

  return {
    people,
    period,
    prorated,
    statement: periodStatement(rateCard, premiums, counts, { includeIssueFee: period.start === policy.startsOn }),
    unpriced,
  };
}

export type MedicalInsuranceMovement = {
  month: string;
  joined: Array<{ name: string; day: string }>;
  left: Array<{ name: string; day: string }>;
};

/** Who came on and went off the register, month by month, newest first. Day-one members are not a movement. */
export function buildMedicalInsuranceMovements(members: readonly MemberFacts[], policyStart: string): MedicalInsuranceMovement[] {
  const months = new Map<string, MedicalInsuranceMovement>();
  const monthOf = (key: string) => {
    let row = months.get(key);
    if (!row) {
      row = { joined: [], left: [], month: key };
      months.set(key, row);
    }
    return row;
  };
  for (const member of members) {
    if (member.coverageStart > policyStart) monthOf(member.coverageStart.slice(0, 7)).joined.push({ day: member.coverageStart, name: member.name });
    if (member.coverageEnd) monthOf(member.coverageEnd.slice(0, 7)).left.push({ day: member.coverageEnd, name: member.name });
  }
  return [...months.values()].sort((a, b) => b.month.localeCompare(a.month));
}
