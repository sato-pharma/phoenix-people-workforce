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
//
// The rule carried over from the MetLife policy unchanged (owner, 2026-11-04); under Libano-Suisse
// (2026-11-17) it also checks the contract's age limits: an employee or spouse over 64, and a child over 18.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import {
  additionCharge,
  addDays,
  ageBandWords,
  ageOn,
  annualRate,
  deletionRefund,
  openingStatement,
  sumMoney,
  type MedicalInsuranceCategory,
  type MedicalInsuranceMemberType,
  type MedicalInsurancePolicyDates,
  type MedicalInsuranceRateCard,
  type Movement,
  type OpeningStatement,
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
  /** The member's own, else their employee record's. Prices the premium. */
  birthDate: string | null;
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
  /** The category someone decided for a joiner who is not on the register yet. It beats the suggestion. */
  decidedCategory: MedicalInsuranceCategory | null;
  dependants: number;
  /** A removal for someone who should never have been on the policy: refunded from its first day. */
  voidFromStart?: boolean;
};

/**
 * The category that goes on the insurer's additions form: one picked for this file, else the register's,
 * else the one decided for the joiner, else the one the same job holds. Null means nobody has decided.
 */
export function additionCategory(action: MedicalInsuranceAction, picked?: unknown): MedicalInsuranceCategory | null {
  if (picked === "A" || picked === "B" || picked === "C") return picked;
  return action.category ?? action.decidedCategory ?? action.suggestedCategory;
}

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
  /** The contract's oldest age per kind of member. Without it no age is checked. */
  ageLimits?: Record<MedicalInsuranceMemberType, number>;
}): MedicalInsuranceActions {
  const { ageLimits, asOf, employees, exceptions, members, policy } = input;
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
      decidedCategory: null,
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
      decidedCategory: null,
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
        voidFromStart: true,
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
      decidedCategory: null,
      suggestedCategory: null,
      timing: "now",
    });
  }

  // The contract's age limits, read on the day each person's cover starts.
  if (ageLimits) {
    const flagged = new Set(actions.map((action) => action.key));
    for (const member of members) {
      if (!isOpenOn(member, asOf) || flagged.has(`remove:${member.id}`)) continue;
      const age = ageOn(member.birthDate, member.coverageStart);
      const limit = ageLimits[member.memberType];
      let reason: string | null = null;
      if (age === null) reason = "No date of birth, so the premium cannot be priced";
      else if (age > limit && member.memberType === "child") reason = `Aged ${age}: the plan covers children up to ${limit}`;
      else if (age > limit) reason = `Aged ${age}: over ${limit} needs a health statement, and conditions from before the policy are not covered`;
      if (!reason) continue;
      const principal = member.principalMemberId ? members.find((other) => other.id === member.principalMemberId) : undefined;
      actions.push({
        category: member.category,
        certificateNumber: member.certificateNumber,
        decidedCategory: null,
        dependants: 0,
        effectiveOn: member.coverageStart,
        hrId: member.hrId,
        jobTitle: null,
        key: `age:${member.id}`,
        kind: "review",
        lineName: null,
        memberId: member.id,
        memberType: member.memberType,
        name: member.name,
        reason: principal ? `${reason} (family of ${principal.name})` : reason,
        suggestedCategory: null,
        timing: "now",
      });
    }
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

export type CostLineKind = "opening" | "addition" | "deletion" | "planned_addition" | "planned_deletion";

export type CostLine = {
  key: string;
  kind: CostLineKind;
  memberId: string | null;
  hrId: string | null;
  name: string;
  memberType: MedicalInsuranceMemberType;
  category: MedicalInsuranceCategory | null;
  /** The day cover starts (opening, addition) or the last covered day (deletion). */
  day: string;
  age: number | null;
  band: string | null;
  annual: number | null;
  movement: Movement | null;
  /** Why this person cannot be priced. Null when they can. */
  unpricedReason: string | null;
  note: string | null;
};

export type PolicyYearCost = {
  opening: OpeningStatement;
  openingPeople: CostLine[];
  /** Joiners and leavers already on the register, newest first. */
  movements: CostLine[];
  /** What the rule says is still to be done: people to add, and covers to end. */
  planned: CostLine[];
  /**
   * The day-one joiners' share of the opening bill: premium per band, tax and cards (the issue fee is already
   * counted). Those lines carry no movement, so this is the amount the "Still to do" table shows for them.
   */
  plannedOpening: { people: number; total: number };
  totals: {
    opening: number;
    additions: number;
    deletions: number;
    /** Opening plus the movements on the register. */
    recorded: number;
    planned: number;
    /** Recorded plus planned: the year as the people stand today. */
    projected: number;
  };
  unpriced: number;
};

type Price = { age: number | null; annual: number | null; band: string | null; reason: string | null };

/**
 * What is still to be done, in money: the day-one joiners' share of the opening bill plus every planned charge
 * and refund. The "Still to do" figure and the total under its table both read this, so they cannot disagree.
 */
export function plannedLinesTotal(year: Pick<PolicyYearCost, "planned" | "plannedOpening">): number {
  return sumMoney([year.plannedOpening.total, ...year.planned.map((entry) => entry.movement?.total ?? 0)]);
}

/**
 * The year's cost under the contract: the opening bill for everyone on the policy from its first day, then
 * every joiner's charge and leaver's refund on the register, then what the rule says is still to be done.
 * The age that prices a person is their age on the day their cover starts.
 */
export function buildPolicyYearCost(input: {
  actions: readonly MedicalInsuranceAction[];
  birthDates: ReadonlyMap<string, string | null>;
  members: readonly MemberFacts[];
  policy: MedicalInsurancePolicyDates;
  rateCard: MedicalInsuranceRateCard;
}): PolicyYearCost {
  const { actions, birthDates, members, policy, rateCard } = input;
  const openingPeople: CostLine[] = [];
  const openingPriced: Array<{ birthDate: string | null; category: MedicalInsuranceCategory; coverageStart: string }> = [];
  const movements: CostLine[] = [];
  const planned: CostLine[] = [];
  let unpriced = 0;

  const priceOf = (category: MedicalInsuranceCategory | null, birthDate: string | null, coverageStart: string): Price => {
    if (!category) return { age: ageOn(birthDate, coverageStart), annual: null, band: null, reason: "Plan not decided" };
    const rate = annualRate(rateCard, { birthDate, category, coverageStart });
    const band = rate.band >= 0 ? ageBandWords(rateCard.ageBands[rate.band]) : null;
    return rate.priced ? { age: rate.age, annual: rate.annual, band, reason: null } : { age: rate.age, annual: null, band, reason: rate.reason };
  };

  const line = (
    kind: CostLineKind,
    who: { id: string | null; category: MedicalInsuranceCategory | null; hrId: string | null; memberType: MedicalInsuranceMemberType; name: string },
    day: string,
    price: Price,
    movement: Movement | null,
    note: string | null,
  ): CostLine => ({
    age: price.age,
    annual: price.annual,
    band: price.band,
    category: who.category,
    day,
    hrId: who.hrId,
    key: `${kind}:${who.id ?? who.hrId ?? who.name}`,
    kind,
    memberId: who.id,
    memberType: who.memberType,
    movement,
    name: who.name,
    note,
    unpricedReason: price.reason,
  });

  const removalByMember = new Map(
    actions.filter((action) => action.kind === "remove" && action.memberId).map((action) => [action.memberId as string, action]),
  );

  for (const member of members) {
    const price = priceOf(member.category, member.birthDate, member.coverageStart);
    if (price.annual === null) unpriced += 1;

    if (member.coverageStart <= policy.startsOn) {
      openingPeople.push(line("opening", member, policy.startsOn, price, null, null));
      openingPriced.push({ birthDate: member.birthDate, category: member.category, coverageStart: policy.startsOn });
    } else {
      const charge = price.annual === null ? null : additionCharge(rateCard, policy, price.annual, member.coverageStart);
      movements.push(line("addition", member, member.coverageStart, price, charge, null));
    }

    if (member.coverageEnd && member.coverageEnd < policy.endsOn) {
      const refund = price.annual === null ? null : deletionRefund(rateCard, policy, price.annual, member.coverageEnd);
      movements.push(line("deletion", member, member.coverageEnd, price, refund, member.memberType === "employee" ? null : "Family member"));
      continue;
    }
    if (member.coverageEnd) continue;

    // The rule says this cover should end: the person, or the employee they sit under, is leaving or gone.
    const owner = member.memberType === "employee" ? member : members.find((other) => other.id === member.principalMemberId);
    const removal = removalByMember.get(member.id) ?? (owner ? removalByMember.get(owner.id) : undefined);
    if (!removal) continue;
    const lastDay = removal.voidFromStart ? addDays(member.coverageStart, -1) : removal.effectiveOn;
    const note = owner && owner.id !== member.id ? `${removal.reason}: family of ${owner.name}` : removal.reason;
    const refund = price.annual === null ? null : deletionRefund(rateCard, policy, price.annual, lastDay);
    planned.push(line("planned_deletion", member, lastDay < member.coverageStart ? member.coverageStart : lastDay, price, refund, note));
  }

  // Someone to add from the policy's first day belongs on the opening bill; a later joiner is an endorsement.
  const openingAdds: Array<{ birthDate: string | null; category: MedicalInsuranceCategory; coverageStart: string }> = [];
  for (const action of actions) {
    if (action.kind !== "add" || !action.hrId) continue;
    const category = additionCategory(action);
    const birthDate = birthDates.get(action.hrId) ?? null;
    const from = action.effectiveOn < policy.startsOn ? policy.startsOn : action.effectiveOn;
    const price = priceOf(category, birthDate, from);
    if (price.annual === null) unpriced += 1;
    const fromStart = from === policy.startsOn;
    if (fromStart && category && price.annual !== null) openingAdds.push({ birthDate, category, coverageStart: from });
    const charge = price.annual === null || fromStart ? null : additionCharge(rateCard, policy, price.annual, from);
    const note = action.decidedCategory
      ? `To be added, plan ${category} decided`
      : category
        ? `To be added, plan ${category} as the same job holds`
        : "To be added, plan not decided";
    planned.push(
      line(
        "planned_addition",
        { category, hrId: action.hrId, id: null, memberType: "employee", name: action.name },
        from,
        price,
        charge,
        fromStart ? `${note}, on the opening bill` : note,
      ),
    );
  }

  const opening = openingStatement(rateCard, openingPriced);
  const addsStatement = openingStatement(rateCard, openingAdds);

  movements.sort((a, b) => b.day.localeCompare(a.day) || a.name.localeCompare(b.name));
  planned.sort((a, b) => a.day.localeCompare(b.day) || a.name.localeCompare(b.name));

  const additions = sumMoney(movements.filter((entry) => entry.kind === "addition").map((entry) => entry.movement?.total ?? 0));
  const deletions = sumMoney(movements.filter((entry) => entry.kind === "deletion").map((entry) => entry.movement?.total ?? 0));
  const recorded = sumMoney([opening.total, additions, deletions]);
  // A day-one joiner adds premium, tax and card to the opening bill; its issue fee is already counted.
  const plannedOpening = openingAdds.length > 0 ? sumMoney([addsStatement.total, opening.people > 0 ? -addsStatement.issueFee : 0]) : 0;
  const plannedTotal = plannedLinesTotal({ planned, plannedOpening: { people: openingAdds.length, total: plannedOpening } });

  return {
    movements,
    opening,
    openingPeople,
    planned,
    plannedOpening: { people: openingAdds.length, total: plannedOpening },
    totals: {
      additions,
      deletions,
      opening: opening.total,
      planned: plannedTotal,
      projected: sumMoney([recorded, plannedTotal]),
      recorded,
    },
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

// ── Moving someone under another employee ──────────────────────────────────────────────────────

/** The register facts a family move reads. */
export type FamilyMoveRow = Pick<MemberFacts, "coverageEnd" | "hrId" | "id" | "memberType" | "name" | "principalMemberId">;

export type FamilyMovePlan = {
  memberType: "child" | "spouse";
  principalMemberId: string;
  /** The family row carries its employee's HR id, as one added under them does. */
  hrId: string | null;
  /** Anyone who sat under the person being moved goes with them, under the same employee. */
  dependantIds: string[];
};

/**
 * Put someone on the register under an employee as their spouse or child (owner, 2026-11-17: "add
 * family for a certain employee example saeed and his family are family to dr anwar"). It is for a
 * person with no employee record of their own, or a family row going to another employee. An
 * employee with their own record keeps their own certificate. Returns the plan, or why it cannot be.
 */
export function planFamilyMove(member: FamilyMoveRow, principal: FamilyMoveRow | undefined, relation: unknown, members: readonly FamilyMoveRow[]): FamilyMovePlan | string {
  if (relation !== "spouse" && relation !== "child") return "Choose whether they are a spouse or a child.";
  if (member.memberType === "employee" && member.hrId) return `${member.name} has their own employee record, so they stay on their own certificate.`;
  if (!principal || principal.memberType !== "employee" || principal.coverageEnd) return "Choose an employee who is on cover.";
  if (principal.id === member.id) return `Choose an employee other than ${member.name}.`;
  if (member.principalMemberId === principal.id && member.memberType === relation) return `${member.name} is already under ${principal.name} as their ${relation}.`;
  const dependantIds = member.memberType === "employee" ? members.filter((row) => row.principalMemberId === member.id).map((row) => row.id) : [];
  return { dependantIds, hrId: principal.hrId, memberType: relation, principalMemberId: principal.id };
}
