import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import { hrBundleGrants } from "../src/lib/auth/hr-functions.ts";
import { permissionMatrix } from "../src/lib/auth/permissions.ts";
import { compareInvoiceToPlan } from "../src/lib/medical-insurance/compare.ts";
import {
  additionCharge,
  annualRate,
  deletionRefund,
  lastQuarterStart,
  openingStatement,
  parseRateCard,
  withPlanRates,
  type MedicalInsuranceCategory,
  type MedicalInsuranceRateCard,
  type PersonToPrice,
} from "../src/lib/medical-insurance/cost.ts";
import {
  additionCategory,
  buildMedicalInsuranceActions,
  buildPolicyYearCost,
  employeeCoverWindow,
  planFamilyMove,
  plannedLinesTotal,
  type EmployeeFacts,
  type MedicalInsuranceAction,
  type MemberFacts,
} from "../src/lib/medical-insurance/eligibility.ts";
import { buildMonthlySplit, LIFE_INSURANCE_PER_PERSON_MONTHLY, monthlyCoverPiastres, splitOwnCover } from "../src/lib/medical-insurance/monthly-split.ts";
import { employeeRecordWords } from "../src/lib/medical-insurance/view.ts";
import {
  buildLibanoMemberFileWorkbook,
  libanoDay,
  libanoMemberCells,
  LIBANO_MEMBER_FILE_HEADERS,
  splitLibanoName,
} from "../src/lib/medical-insurance/workbooks.ts";

import { stripComments } from "./support/comment-strip.ts";

const POLICY = { endsOn: "2027-11-14", startsOn: "2026-11-15" };
const MIGRATION = "supabase/migrations/20261117041500_medical_insurance_libano_suisse.sql";

/** The rate card exactly as the migration seeds it, so the test pins what production prices with. */
function seededRateCard(): MedicalInsuranceRateCard {
  const sql = readFileSync(MIGRATION, "utf8");
  const start = sql.indexOf("'{\n    \"currency\"");
  const end = sql.indexOf("}'::jsonb", start);
  assert.ok(start > 0 && end > start, "the migration seeds the policy's rate card");
  return parseRateCard(JSON.parse(sql.slice(start + 1, end + 1)));
}

const CARD = seededRateCard();

function employee(overrides: Partial<EmployeeFacts> = {}): EmployeeFacts {
  return {
    active: true,
    employmentStatus: "active",
    exitDay: null,
    hireDate: "2024-01-01",
    hrId: "T-1",
    jobTitle: "Medical Rep",
    lineName: null,
    name: "Test Person",
    ...overrides,
  };
}

function member(overrides: Partial<MemberFacts> = {}): MemberFacts {
  return {
    birthDate: "1990-01-01",
    category: "C",
    certificateNumber: "1",
    coverageEnd: null,
    coverageStart: POLICY.startsOn,
    hrId: "T-1",
    id: "m-1",
    memberType: "employee",
    name: "Test Person",
    principalMemberId: null,
    ...overrides,
  };
}

function actionsFor(employees: EmployeeFacts[], members: MemberFacts[], exceptions: Array<{ id: string; hrId: string; decision: "keep_in" | "keep_out"; reason: string }> = [], asOf = "2026-11-17") {
  return buildMedicalInsuranceActions({ asOf, employees, exceptions, members, policy: POLICY }).actions;
}

/**
 * The signed renewal offer (Rev 1.3, 5 November 2026), band by band: the same 104 people at the seeded
 * rates print the offer's own totals, to the pound.
 */
function testTheSignedOfferIsReproducedToThePound() {
  // [plan, the band's first age, how many people]
  const offer: Array<[MedicalInsuranceCategory, number, number]> = [
    ["A", 25, 1], ["A", 40, 1], ["A", 45, 1], ["A", 50, 1], ["A", 55, 4], ["A", 60, 1],
    ["B", 30, 12], ["B", 35, 8], ["B", 40, 2], ["B", 45, 1], ["B", 50, 2],
    ["C", 0, 3], ["C", 18, 23], ["C", 25, 28], ["C", 30, 11], ["C", 35, 4], ["C", 50, 1],
  ];
  const people: PersonToPrice[] = [];
  for (const [category, from, count] of offer) {
    // One year into the band on the policy's first day.
    const birthDate = `${2026 - (from + 1)}-01-01`;
    for (let index = 0; index < count; index += 1) people.push({ birthDate, category, coverageStart: POLICY.startsOn });
  }

  const statement = openingStatement(CARD, people);
  assert.equal(statement.people, 104);
  assert.equal(statement.unpriced, 0);
  assert.deepEqual(statement.plans.map((plan) => [plan.category, plan.people, plan.premium]), [["A", 9, 234_645], ["B", 25, 172_339], ["C", 70, 305_316]]);
  const bandA55 = statement.plans[0].bands.find((band) => band.label === "55 to 59");
  assert.equal(bandA55?.premium, 123_458, "Plan A 55 to 59 prints 123,458, not 4 x 30,865");
  assert.equal(statement.premium, 712_300, "the offer's premium");
  assert.equal(statement.tax, 11_040.65, "1.55% tax and supervision");
  assert.equal(statement.cards, 3_120, "EGP 30 a member for the card");
  assert.equal(statement.issueFee, 90, "the issue fee, once");
  assert.equal(statement.total, 726_550.65);

  const old = annualRate(CARD, { birthDate: "1960-01-01", category: "C", coverageStart: POLICY.startsOn });
  assert.equal(old.priced, false, "a band the offer did not quote is never priced at zero");
  assert.equal(annualRate(CARD, { birthDate: null, category: "A", coverageStart: POLICY.startsOn }).priced, false, "no birth date, no price");
  assert.throws(() => parseRateCard({ ...CARD, taxBasisPoints: undefined }), /missing a figure/);
  assert.equal(withPlanRates(CARD, "C", CARD.plans.C.rates.map((rate, index) => (index === 6 ? 8000 : rate))).plans.C.rates[6], 8000, "a quoted band can be filled in");
}

/** A joiner pays by the day to the policy's end; from the last quarter a quarter of the year. */
function testAJoinerIsChargedByTheDayAndTheLastQuarterAtAQuarter() {
  assert.equal(lastQuarterStart(POLICY), "2027-08-15");

  const february = additionCharge(CARD, POLICY, 9989, "2027-02-15");
  assert.equal(february.policyDays, 365);
  assert.equal(february.days, 273);
  assert.equal(february.lastQuarter, false);
  assert.equal(february.premium, 7471.22);
  assert.equal(february.tax, 115.8);
  assert.equal(february.card, 30);
  assert.equal(february.total, 7617.02);

  const dayBefore = additionCharge(CARD, POLICY, 9989, "2027-08-14");
  assert.equal(dayBefore.lastQuarter, false, "the day before the last quarter is still by the day");

  const lastQuarter = additionCharge(CARD, POLICY, 9989, "2027-08-15");
  assert.equal(lastQuarter.lastQuarter, true);
  assert.equal(lastQuarter.premium, 2497.25, "25% of the year");
  assert.equal(lastQuarter.tax, 38.71);
  assert.equal(lastQuarter.total, 2565.96);
}

/** A leaver is refunded by the day from the day after they leave; the card is never refunded. */
function testALeaverIsRefundedByTheDay() {
  const refund = deletionRefund(CARD, POLICY, 9989, "2027-02-14");
  assert.equal(refund.days, 273);
  assert.equal(refund.premium, -7471.22);
  assert.equal(refund.tax, -115.8);
  assert.equal(refund.card, 0);
  assert.equal(refund.total, -7587.02);
  assert.equal(deletionRefund(CARD, POLICY, 9989, POLICY.endsOn).total, 0, "covered to the end: nothing back");
  assert.equal(deletionRefund(CARD, POLICY, 9989, "2026-11-14").days, 365, "never on the policy: the whole year back");
}

function testEveryoneBelongsFromDayOneAndTheRecordDecidesTheEnd() {
  assert.deepEqual(employeeCoverWindow(employee(), POLICY), { from: POLICY.startsOn, until: null }, "working before the policy: from its start");
  assert.deepEqual(employeeCoverWindow(employee({ hireDate: "2026-11-22" }), POLICY), { from: "2026-11-22", until: null }, "a joiner: from their first day");
  assert.equal(employeeCoverWindow(employee({ active: false, employmentStatus: "declined_offer" }), POLICY), null, "a declined offer never belongs");
  assert.equal(employeeCoverWindow(employee({ active: false, employmentStatus: "placeholder" }), POLICY), null, "a placeholder is nobody");
  assert.equal(employeeCoverWindow(employee({ active: false, employmentStatus: "resigned", exitDay: "2026-10-15" }), POLICY), null, "left before the policy");
  assert.equal(employeeCoverWindow(employee({ active: false, employmentStatus: "resigned" }), POLICY), null, "left with no day on record");
  assert.deepEqual(employeeCoverWindow(employee({ exitDay: "2026-12-15" }), POLICY), { from: POLICY.startsOn, until: "2026-12-15" }, "serving notice: covered until they go");
}

function testTheListNamesWhoToAddAndWhoToRemove() {
  const missing = actionsFor([employee()], []);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].kind, "add");
  assert.equal(missing[0].timing, "now");
  assert.equal(missing[0].memberType, "employee");

  const joiner = actionsFor([employee({ hireDate: "2026-11-20" })], []);
  assert.equal(joiner[0].timing, "soon", "a joiner inside the horizon is coming up");
  assert.equal(actionsFor([employee({ hireDate: "2027-03-01" })], []).length, 0, "beyond the horizon is not on the list");

  const left = actionsFor([employee({ active: false, employmentStatus: "resigned", exitDay: "2026-11-16" })], [member()]);
  assert.equal(left[0].kind, "remove");
  assert.equal(left[0].reason, "Has left");
  assert.equal(left[0].effectiveOn, "2026-11-16");

  const gone = actionsFor([employee({ active: false, employmentStatus: "resigned", exitDay: "2026-10-01" })], [member()]);
  assert.equal(gone[0].kind, "remove", "on the policy but gone before it began");
  assert.equal(gone[0].voidFromStart, true, "refunded from the policy's first day");

  const declined = actionsFor([employee({ active: false, employmentStatus: "declined_offer" })], [member()]);
  assert.equal(declined[0].reason, "Declined the offer and never started");

  const notice = actionsFor([employee({ exitDay: "2026-11-25" })], [member()]);
  assert.equal(notice[0].timing, "soon", "someone serving notice is still covered, and shown as coming up");

  const stranger = actionsFor([], [member({ hrId: null })]);
  assert.equal(stranger[0].kind, "review", "no Phoenix record is for a person to check");

  assert.equal(actionsFor([employee()], [member()]).length, 0, "a working employee on the register is nothing to do");

  const [add] = missing;
  assert.equal(add.decidedCategory, null, "nobody has decided a joiner's plan until someone does");
  assert.equal(additionCategory({ ...add, suggestedCategory: null }), null, "with nothing decided or suggested, the file waits for a decision");
  assert.equal(additionCategory({ ...add, decidedCategory: "A", suggestedCategory: "C" }), "A", "a decided plan beats the suggestion");
  assert.equal(additionCategory({ ...add, category: "B", decidedCategory: "A" }), "B", "the register's plan beats a decision made before they were on it");
  assert.equal(additionCategory({ ...add, decidedCategory: "A" }, "C"), "C", "a plan picked for this file beats them all");
}

function testAnExceptionBeatsTheRuleEitherWay() {
  assert.equal(actionsFor([employee()], [], [{ decision: "keep_out", hrId: "T-1", id: "e", reason: "Own cover" }]).length, 0);
  const keptIn = actionsFor([employee({ active: false, employmentStatus: "resigned", exitDay: "2026-11-16" })], [member()], [{ decision: "keep_in", hrId: "T-1", id: "e", reason: "Agreed" }]);
  assert.equal(keptIn.length, 0);
}

function testFamilyFollowTheirEmployee() {
  const spouse = member({ hrId: "T-1", id: "m-2", memberType: "spouse", name: "Test Spouse", principalMemberId: "m-1" });
  const leaving = actionsFor([employee({ active: false, employmentStatus: "resigned", exitDay: "2026-11-16" })], [member(), spouse]);
  assert.equal(leaving.length, 1, "family leave with their employee, on the employee's line");
  assert.equal(leaving[0].dependants, 1);

  const stranded = actionsFor([employee({ active: false, employmentStatus: "resigned", exitDay: "2026-11-16" })], [member({ coverageEnd: "2026-11-16" }), spouse]);
  const row = stranded.find((action) => action.memberId === "m-2");
  assert.ok(row, "a family row left open under an ended cover is listed");
  assert.equal(row.kind, "remove");
  assert.equal(row.memberType, "spouse");
}

/** Someone with no record of their own, and their family, are put under an employee as family. */
function testSomeoneIsPutUnderAnEmployeeWithTheirFamily() {
  const head = member({ hrId: "T-1", id: "m-1", name: "Test Head" });
  const noRecord = member({ hrId: null, id: "m-9", name: "Test Relative" });
  const relativesSpouse = member({ hrId: null, id: "m-10", memberType: "spouse", name: "Test Relative Spouse", principalMemberId: "m-9" });
  const relativesChild = member({ hrId: null, id: "m-11", memberType: "child", name: "Test Relative Child", principalMemberId: "m-9" });
  const register = [head, noRecord, relativesSpouse, relativesChild];

  const moved = planFamilyMove(noRecord, head, "child", register);
  assert.ok(typeof moved !== "string", "a person with no record goes under the employee");
  assert.equal(moved.memberType, "child");
  assert.equal(moved.principalMemberId, "m-1");
  assert.equal(moved.hrId, "T-1", "the family row carries the employee's HR id, as one added under them does");
  assert.deepEqual(moved.dependantIds, ["m-10", "m-11"], "their own spouse and child move with them");

  const respouse = planFamilyMove(relativesSpouse, head, "spouse", register);
  assert.ok(typeof respouse !== "string", "a family row can go to another employee");
  assert.deepEqual(respouse.dependantIds, [], "a family row brings nobody with it");

  assert.match(String(planFamilyMove(head, member({ hrId: "T-2", id: "m-2", name: "Test Other" }), "spouse", register)), /own employee record/, "an employee with a record keeps their own certificate");
  assert.match(String(planFamilyMove(noRecord, head, "parent", register)), /spouse or a child/, "the insurer's sheet has only spouse and child");
  assert.match(String(planFamilyMove(noRecord, relativesSpouse, "child", register)), /on cover/, "only an employee row can hold family");
  assert.match(String(planFamilyMove(noRecord, member({ coverageEnd: "2026-11-30", hrId: "T-3", id: "m-3", name: "Test Ended" }), "child", register)), /on cover/, "nobody is put under an ended cover");
  assert.match(String(planFamilyMove(noRecord, noRecord, "child", register)), /other than/, "nobody sits under themselves");
  assert.match(String(planFamilyMove(relativesSpouse, noRecord, "spouse", register)), /already under/, "a move that changes nothing is said so");
}

/** Medical insurance is optional: one press excludes, and the add list stops asking (owner, 2026-11-17). */
function testSomeoneWhoDeclinesIsExcluded() {
  assert.equal(actionsFor([employee()], [], [{ decision: "keep_out", hrId: "T-1", id: "e", reason: "Does not want medical insurance" }]).length, 0, "an excluded employee is not asked for again");
  const actionsSource = stripComments(readFileSync("src/components/medical-insurance/medical-insurance-actions.tsx", "utf8"));
  assert.match(actionsSource, /decision: "keep_out", hrId: action.hrId, reason: DECLINED_REASON/, "the Exclude press records a keep-off exception with the decline reason");
  const membersSource = stripComments(readFileSync("src/components/medical-insurance/medical-insurance-members.tsx", "utf8"));
  assert.match(membersSource, /action: "end", coverageEnd: member.coverageStart, endReason: declined, keepOut: true/, "excluding someone on the register ends them from their first day and keeps them off");
}

/** The contract's age limits: over 64 for an employee or spouse, over 18 for a child, and no birth date. */
/** A late joiner on the register from the policy's first day is flagged, and the fix is their own first day. */
function testALateJoinerIsCoveredFromTheDayTheyJoin() {
  const early = actionsFor([employee({ hireDate: "2026-11-22" })], [member({ coverageStart: "2026-11-15" })]);
  const row = early.find((action) => action.key === "start:m-1");
  assert.ok(row, "cover that starts before the person joined is listed");
  assert.equal(row.kind, "review");
  assert.equal(row.lateStart, true);
  assert.equal(row.effectiveOn, "2026-11-22", "cover should start on the day they join");
  assert.equal(row.timing, "now");

  assert.equal(actionsFor([employee({ hireDate: "2026-11-22" })], [member({ coverageStart: "2026-11-22" })]).length, 0, "cover from the first day is nothing to do");
  assert.equal(actionsFor([employee({ hireDate: "2020-01-01" })], [member({ coverageStart: "2026-11-15" })]).length, 0, "someone working before the policy started is covered from its first day");
}

/** Each employee on the lists carries their own HR number, hire day, line and area; family carry none of theirs. */
function testEachEmployeeShowsTheirHrNumberHireDayLineAndArea() {
  const joiner = employee({ areaName: "Fayoum", hireDate: "2026-11-15", hrId: "PD-0042", lineName: "Pedia" });
  const [add] = actionsFor([joiner], []);
  assert.equal(add.hireDate, "2026-11-15", "the add row carries the hire day");
  assert.equal(add.areaName, "Fayoum", "the add row carries the area");
  assert.equal(add.lineName, "Pedia");
  assert.deepEqual(employeeRecordWords(add), ["PD-0042 · joined 15 Nov 2026", "Pedia · Fayoum"]);

  const spouse = member({ hrId: "PD-0042", id: "m-2", memberType: "spouse", name: "Test Spouse", principalMemberId: "m-1" });
  const leaving = actionsFor([{ ...joiner, active: false, employmentStatus: "resigned", exitDay: "2026-11-16" }], [member({ coverageEnd: "2026-11-16", hrId: "PD-0042" }), spouse]);
  const family = leaving.find((action) => action.memberId === "m-2");
  assert.ok(family);
  assert.equal(family.hireDate, undefined, "a spouse never shows the employee's hire day as their own");

  assert.deepEqual(employeeRecordWords({ hrId: "PD-0042" }), ["PD-0042"], "a missing piece is left out, never a blank");
  assert.deepEqual(employeeRecordWords({ hrId: null }), [], "nothing on record is nothing shown");
}

function testTheContractsAgeLimitsAreReviewed() {
  const review = (members: MemberFacts[]) =>
    buildMedicalInsuranceActions({ ageLimits: CARD.ageLimits, asOf: "2026-11-17", employees: [employee()], exceptions: [], members, policy: POLICY }).actions.filter((action) => action.key.startsWith("age:"));

  assert.equal(review([member({ birthDate: "1962-01-01" })]).length, 0, "64 on the first day is inside the limit");
  const old = review([member({ birthDate: "1961-01-01" })]);
  assert.equal(old.length, 1);
  assert.match(old[0].reason, /^Aged 65: over 64 needs a health statement/);

  const child = review([member(), member({ birthDate: "2007-01-01", id: "m-3", memberType: "child", name: "Test Child", principalMemberId: "m-1" })]);
  assert.equal(child.length, 1);
  assert.match(child[0].reason, /^Aged 19: the plan covers children up to 18 \(family of Test Person\)$/);
  assert.equal(review([member(), member({ birthDate: "2008-11-15", id: "m-3", memberType: "child", principalMemberId: "m-1" })]).length, 0, "18 is still a child");

  assert.match(review([member({ birthDate: null })])[0].reason, /No date of birth/);
  assert.equal(
    buildMedicalInsuranceActions({ asOf: "2026-11-17", employees: [employee()], exceptions: [], members: [member({ birthDate: "1950-01-01" })], policy: POLICY }).actions.length,
    0,
    "without the card's limits no age is checked",
  );
}

/** A bill against what the plan says it should be, for each kind of bill. */
function testEachBillIsComparedWithThePlan() {
  const members: MemberFacts[] = [
    member({ birthDate: "1995-01-01", hrId: "T-1", id: "m-1", name: "Opening Person" }),
    member({ birthDate: "2000-06-01", coverageStart: "2027-02-15", hrId: "T-2", id: "m-2", name: "Joiner" }),
    member({ birthDate: "2000-06-01", coverageEnd: "2027-02-14", hrId: "T-3", id: "m-3", name: "Leaver" }),
  ];
  const plannedAdd = (hrId: string, name: string, effectiveOn: string): MedicalInsuranceAction => ({
    category: null,
    certificateNumber: null,
    decidedCategory: "C",
    dependants: 0,
    effectiveOn,
    hrId,
    jobTitle: null,
    key: `add:${hrId}`,
    kind: "add",
    lineName: null,
    memberId: null,
    memberType: "employee",
    name,
    reason: "Joined after the policy started",
    suggestedCategory: null,
    timing: "soon",
  });
  const year = buildPolicyYearCost({
    actions: [plannedAdd("T-4", "Day One", POLICY.startsOn), plannedAdd("T-5", "March Joiner", "2027-03-01")],
    birthDates: new Map([["T-4", "2000-06-01"], ["T-5", "2000-06-01"]]),
    members,
    policy: POLICY,
    rateCard: CARD,
  });

  const opening = compareInvoiceToPlan({ coversFrom: POLICY.startsOn, coversTo: POLICY.endsOn, kind: "opening", totalDue: year.opening.total + 10 }, year);
  assert.equal(opening.expected, year.opening.total, "an opening bill is held against the opening statement");
  assert.equal(opening.difference, 10);

  const additions = compareInvoiceToPlan({ coversFrom: POLICY.startsOn, coversTo: "2027-03-31", kind: "additions", totalDue: 0 }, year);
  assert.deepEqual(additions.lines.map((line) => [line.name, line.planned]), [["Joiner", false], ["March Joiner", true]], "a day-one joiner belongs on the opening bill, not an endorsement");
  const joinerCharge = additionCharge(CARD, POLICY, CARD.plans.C.rates[2] as number, "2027-02-15").total;
  const marchCharge = additionCharge(CARD, POLICY, CARD.plans.C.rates[2] as number, "2027-03-01").total;
  assert.equal(additions.expected, Math.round((joinerCharge + marchCharge) * 100) / 100);
  assert.equal(additions.difference, -(additions.expected as number));

  const narrow = compareInvoiceToPlan({ coversFrom: "2027-03-01", coversTo: "2027-03-31", kind: "additions", totalDue: marchCharge }, year);
  assert.equal(narrow.lines.length, 1, "only people inside the bill's dates");
  assert.equal(narrow.difference, 0);

  const deletions = compareInvoiceToPlan({ coversFrom: "2027-02-01", coversTo: "2027-02-28", kind: "deletions", totalDue: -7000 }, year);
  assert.deepEqual(deletions.lines.map((line) => line.name), ["Leaver"]);
  assert.ok((deletions.expected as number) < 0, "a credit note is a negative amount");

  const other = compareInvoiceToPlan({ coversFrom: null, coversTo: null, kind: "other", totalDue: 30 }, year);
  assert.equal(other.expected, null, "the plan has nothing to say about another kind of bill");
  assert.equal(other.difference, null);

  // "Still to do": the day-one joiner's share of the opening bill is counted, and the table's total under it
  // is the same figure as the tile above it (they disagreed on production, 17 Nov 2026: +681.73 vs -3,695.63).
  const dayOneStatement = openingStatement(CARD, [{ birthDate: "2000-06-01", category: "C", coverageStart: POLICY.startsOn }]);
  const dayOneShare = Math.round((dayOneStatement.total - dayOneStatement.issueFee) * 100) / 100;
  assert.deepEqual(year.plannedOpening, { people: 1, total: dayOneShare }, "the day-one joiner adds premium, tax and card, not a second issue fee");
  assert.equal(plannedLinesTotal(year), Math.round((dayOneShare + marchCharge) * 100) / 100, "the table total counts the day-one joiner as well as the March charge");
  assert.equal(year.totals.planned, plannedLinesTotal(year), "the Still to do tile and the table total are one figure");
  const costTab = stripComments(readFileSync("src/components/medical-insurance/medical-insurance-cost.tsx", "utf8"));
  assert.match(costTab, /openingAddition=\{view\.year\.plannedOpening\}/, "the Still to do table shows the day-one joiners' row");
  assert.match(costTab, /total=\{plannedLinesTotal\(view\.year\)\}/, "the Still to do table totals with the same function as the tile");
}

/** Libano-Suisse's own sheet: their 39 headings, one text row per person. */
async function testTheMemberFileIsTheInsurersOwnSheet() {
  assert.equal(LIBANO_MEMBER_FILE_HEADERS.length, 39);
  assert.match(LIBANO_MEMBER_FILE_HEADERS[0], /^1- {2}"Plan Code"/);
  assert.match(LIBANO_MEMBER_FILE_HEADERS[6], /"DOB"[\s\S]*ddmmyyyy/);
  assert.match(LIBANO_MEMBER_FILE_HEADERS[21], /"Staff #"/);
  assert.match(LIBANO_MEMBER_FILE_HEADERS[38], /Beneficiary full name/);

  assert.deepEqual(splitLibanoName("Ahmed Mohamed Ali Hassan"), { father: "Mohamed", first: "Ahmed", last: "Ali Hassan" });
  assert.deepEqual(splitLibanoName("Ahmed Ali"), { father: "", first: "Ahmed", last: "Ali" });
  assert.equal(libanoDay("2019-04-08"), "08042019");
  assert.equal(libanoDay(null), "");

  const child = {
    adherentNumber: "900",
    birthDate: "2019-04-08",
    category: "C" as const,
    day: POLICY.startsOn,
    fullName: "Test Child Person",
    gender: "Female",
    memberType: "child" as const,
    nationalId: "",
    phone: "",
    principalNumber: "899",
    staffNumber: "34-1",
  };
  const cells = libanoMemberCells(child);
  assert.equal(cells.length, 39);
  assert.equal(cells[0], "C", "Plan Code");
  assert.equal(cells[1], "Person", "Last name");
  assert.equal(cells[2], "C", "Father Init");
  assert.equal(cells[3], "Test", "First name");
  assert.equal(cells[6], "08042019", "DOB as ddmmyyyy");
  assert.equal(cells[7], "C", "Relation");
  assert.equal(cells[9], "F", "Gender");
  assert.equal(cells[10], "C", "Class");
  assert.equal(cells[21], "34-1", "Staff #");
  assert.equal(cells[22], "900", "Adherent #");
  assert.equal(cells[26], "899", "Principal #");
  assert.equal(libanoMemberCells({ ...child, memberType: "employee" })[7], "P");
  assert.equal(libanoMemberCells({ ...child, memberType: "spouse" })[7], "S");

  const buffer = await buildLibanoMemberFileWorkbook({ kind: "deletions", rows: [{ ...child, day: "2027-02-14" }] });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet("Output draft");
  assert.ok(sheet, "one sheet, named as the insurer's draft");
  assert.equal(sheet.getRow(1).cellCount, 40);
  assert.equal(sheet.getCell(1, 40).value, "Deletion date (ddmmyyyy)");
  assert.equal(sheet.getCell(2, 22).value, "34-1", "a staff number stays text");
  assert.equal(sheet.getCell(2, 7).value, "08042019", "a date stays text");
  assert.equal(sheet.getCell(2, 40).value, "14022027");
}

/**
 * The owner's monthly rule (2026-11-17): the company carries 70% of the employee's own cover and the employee
 * 30%; a spouse or child is the employee's in full; EGP 85 of life insurance for every person covered, on the
 * employee's share. The month is the annual premium plus the 1.55% tax, over twelve.
 */
function testTheCompanyCarries70PercentOfTheEmployeeAndTheFamilyIsTheEmployees() {
  const rateOf = (birthDate: string, category: MedicalInsuranceCategory) => {
    const rate = annualRate(CARD, { birthDate, category, coverageStart: POLICY.startsOn });
    assert.ok(rate.priced, "the fixture's people are priced");
    return rate.annual;
  };
  const monthOf = (annual: number) => Math.round((Math.round(annual * 100) * (10_000 + CARD.taxBasisPoints)) / 10_000 / 12);

  // The split of a month always adds back to the month, and the company's part is its 70%.
  for (const piastres of [0, 1, 99, 100_001, 123_457]) {
    const { company, employee: own } = splitOwnCover(piastres);
    assert.equal(company + own, piastres, "the two shares add back to the month");
    assert.equal(company, Math.round(piastres * 0.7));
  }
  assert.equal(monthlyCoverPiastres(CARD, 12_000), monthOf(12_000), "a month is premium and tax over twelve");

  const members: MemberFacts[] = [
    member({ birthDate: "1990-01-01", category: "B", hrId: "T-1", id: "e-1", name: "Family Employee" }),
    member({ birthDate: "1992-03-01", category: "B", hrId: null, id: "s-1", memberType: "spouse", name: "Their Spouse", principalMemberId: "e-1" }),
    member({ birthDate: "2015-05-01", category: "B", hrId: null, id: "c-1", memberType: "child", name: "Their Child", principalMemberId: "e-1" }),
    member({ birthDate: "1985-01-01", category: "C", hrId: "T-2", id: "e-2", name: "Single Employee" }),
    member({ birthDate: "1980-01-01", category: "C", coverageStart: "2026-12-01", hrId: "T-3", id: "e-3", name: "December Joiner" }),
    member({ birthDate: "1980-01-01", category: "C", coverageEnd: "2026-11-16", hrId: "T-4", id: "e-4", name: "Already Left" }),
    member({ birthDate: "2010-01-01", category: "C", hrId: null, id: "c-9", memberType: "child", name: "Stray Child", principalMemberId: "e-4" }),
    member({ birthDate: null, category: "C", hrId: "T-5", id: "e-5", name: "No Birth Date" }),
  ];
  const split = buildMonthlySplit({ asOf: "2026-11-17", members, rateCard: CARD });
  const row = (name: string) => split.rows.find((entry) => (entry.employee?.name ?? entry.family[0]?.name) === name);

  assert.equal(row("Already Left"), undefined, "cover that has ended is in no month");

  const family = row("Family Employee");
  assert.ok(family);
  const own = monthOf(rateOf("1990-01-01", "B"));
  const relatives = monthOf(rateOf("1992-03-01", "B")) + monthOf(rateOf("2015-05-01", "B"));
  const company = Math.round((own * 7_000) / 10_000);
  assert.equal(family.ownMonthly, own / 100);
  assert.equal(family.companyPays, company / 100, "the company carries 70% of the employee's own cover");
  assert.equal(family.employeeOwnShare, (own - company) / 100, "the employee carries the other 30%");
  assert.equal(family.familyMonthly, relatives / 100, "the family is the employee's in full");
  assert.equal(family.people, 3);
  assert.equal(family.lifeInsurance, 3 * LIFE_INSURANCE_PER_PERSON_MONTHLY, "EGP 85 for every person covered");
  assert.equal(family.employeePays, (own - company + relatives + 3 * 8_500) / 100, "30%, the family and the life insurance");

  const single = row("Single Employee");
  assert.ok(single);
  assert.equal(single.lifeInsurance, LIFE_INSURANCE_PER_PERSON_MONTHLY);
  assert.equal(single.family.length, 0);

  const joiner = row("December Joiner");
  assert.equal(joiner?.employee?.startsOn, "2026-12-01", "cover that starts later is counted and shows its day");

  const stray = row("Stray Child");
  assert.ok(stray, "a family member whose employee is not on the register still stands");
  assert.equal(stray.employee, null);
  assert.equal(stray.companyPays, 0, "the company carries nothing of a family member");
  assert.equal(stray.employeePays, (monthOf(rateOf("2010-01-01", "C")) + 8_500) / 100);

  const unpriced = row("No Birth Date");
  assert.equal(unpriced?.unpriced, 1, "nobody is priced at zero without a birth date");
  assert.equal(unpriced?.employee?.unpricedReason, "No date of birth");
  assert.equal(unpriced?.companyPays, 0);
  assert.equal(split.unpriced, 1);

  assert.equal(split.totals.employees, 4, "four employees whose cover has not ended");
  assert.equal(split.totals.people, 7);
  assert.equal(split.totals.lifeInsurance, 7 * LIFE_INSURANCE_PER_PERSON_MONTHLY);
  const sum = (pick: (entry: (typeof split.rows)[number]) => number) => split.rows.reduce((total, entry) => total + Math.round(pick(entry) * 100), 0) / 100;
  assert.equal(split.totals.companyPays, sum((entry) => entry.companyPays));
  assert.equal(split.totals.employeesPay, sum((entry) => entry.employeePays));
  assert.equal(split.totals.total, Math.round((split.totals.companyPays + split.totals.employeesPay) * 100) / 100);
}

function testASeatNeverHoldsAnAmount() {
  const invoices = "medical_insurance_invoices";
  for (const role of ["HR Operations", "HR Administration"] as const) {
    const grants = hrBundleGrants(role) as Record<string, readonly string[] | undefined>;
    assert.deepEqual(grants.medical_insurance, ["read", "create", "update", "export"], `${role} maintains members`);
    assert.equal(grants[invoices], undefined, `${role} must never hold the invoices`);
    assert.equal((permissionMatrix[role] as Record<string, readonly string[] | undefined>)[invoices], undefined, `${role} in the matrix`);
  }
  assert.ok((permissionMatrix["Super Admin"] as Record<string, readonly string[]>)[invoices].includes("read"));
  assert.equal((permissionMatrix["Super Admin"] as Record<string, readonly string[]>)[invoices].includes("delete"), false, "a bill is a fact about a date");

  const page = readFileSync("app/(admin)/medical-insurance/page.tsx", "utf8");
  assert.match(page, /if \(view && holdsInvoices\) money = await getMedicalInsuranceMoney\(\)/, "money is read only after the check");

  const policyRoute = readFileSync("app/api/medical-insurance/policy/route.ts", "utf8");
  assert.match(policyRoute, /assertPermission\(access, "medical_insurance_invoices", "update"\)/, "a rate decides every amount, so only the money seat changes it");

  const view = readFileSync("src/lib/medical-insurance/view.ts", "utf8");
  const seatShape = view.slice(view.indexOf("export type MedicalInsuranceView"), view.indexOf("export type MedicalInsuranceInvoiceRow"));
  assert.doesNotMatch(seatShape, /total|premium|cost|statement|egp|rate/i, "the seats' shape carries no amount");
  assert.doesNotMatch(seatShape, /split|company|life/i, "the monthly split is never in the seats' shape");
  const moneyShape = view.slice(view.indexOf("export type MedicalInsuranceMoneyView"));
  assert.match(moneyShape.slice(0, moneyShape.indexOf("};")), /monthlySplit: MonthlySplit;/, "the monthly split rides only in the money view");
}

function testNothingHereSendsOrPays() {
  for (const file of ["src/lib/medical-insurance/service.ts", "src/lib/medical-insurance/workbooks.ts", "src/lib/medical-insurance/compare.ts", "src/lib/medical-insurance/cost.ts", "src/lib/medical-insurance/monthly-split.ts"]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /from "@\/lib\/email|sendEmail|resend|from "@\/lib\/payroll/i, `${file} must not send mail or reach payroll`);
  }
}

export async function runMedicalInsuranceTests() {
  testTheSignedOfferIsReproducedToThePound();
  testAJoinerIsChargedByTheDayAndTheLastQuarterAtAQuarter();
  testALeaverIsRefundedByTheDay();
  testEveryoneBelongsFromDayOneAndTheRecordDecidesTheEnd();
  testTheListNamesWhoToAddAndWhoToRemove();
  testAnExceptionBeatsTheRuleEitherWay();
  testFamilyFollowTheirEmployee();
  testSomeoneIsPutUnderAnEmployeeWithTheirFamily();
  testSomeoneWhoDeclinesIsExcluded();
  testALateJoinerIsCoveredFromTheDayTheyJoin();
  testEachEmployeeShowsTheirHrNumberHireDayLineAndArea();
  testTheContractsAgeLimitsAreReviewed();
  testTheCompanyCarries70PercentOfTheEmployeeAndTheFamilyIsTheEmployees();
  testEachBillIsComparedWithThePlan();
  await testTheMemberFileIsTheInsurersOwnSheet();
  testASeatNeverHoldsAnAmount();
  testNothingHereSendsOrPays();
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("tests/medical-insurance.test.ts")) {
  await runMedicalInsuranceTests();
  console.log("medical-insurance: pass");
}
