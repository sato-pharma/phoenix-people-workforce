import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import { hrBundleGrants } from "../src/lib/auth/hr-functions.ts";
import { permissionMatrix } from "../src/lib/auth/permissions.ts";
import { compareInvoiceToPlan, invoiceDatesProblem } from "../src/lib/medical-insurance/compare.ts";
import {
  additionCharge,
  annualRate,
  deletionRefund,
  instalmentNumber,
  lastQuarterStart,
  MEDICAL_INSURANCE_CATEGORIES,
  openingInstalment,
  openingStatement,
  parseRateCard,
  pricingAge,
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
  isActiveEmploymentStatus,
  planFamilyMove,
  plannedLinesTotal,
  type EmployeeFacts,
  type MedicalInsuranceAction,
  type MemberFacts,
} from "../src/lib/medical-insurance/eligibility.ts";
import { LIBANO_TABLE_OF_BENEFITS } from "../src/lib/medical-insurance/benefits.ts";
import { buildMedicalInsuranceMonthlyCostWorkbook } from "../src/lib/medical-insurance/cost-workbook.ts";
import { buildMonthlySplit, EMPLOYEE_MINIMUM_OWN_SHARE_MONTHLY, LIFE_INSURANCE_PER_PERSON_MONTHLY, monthlyCoverPiastres, quoteMonthlyCost, splitOwnCover } from "../src/lib/medical-insurance/monthly-split.ts";
import { employeeRecordWords } from "../src/lib/medical-insurance/view.ts";
import { planLibanoMovementEmail } from "../src/lib/medical-insurance/libano-movement-email.ts";
import type { LibanoMemberLine } from "../src/lib/medical-insurance/workbooks.ts";
import {
  buildLibanoMemberFileWorkbook,
  libanoDay,
  libanoLineGaps,
  libanoMemberCells,
  LIBANO_MEMBER_FILE_HEADERS,
  splitLibanoName,
} from "../src/lib/medical-insurance/workbooks.ts";

import { stripComments } from "./support/comment-strip.ts";

const POLICY = { endsOn: "2027-11-14", startsOn: "2026-11-15" };
const MIGRATION = "supabase/migrations/20261120134229_medical_insurance_rates_before_tax.sql";

/** The rate card exactly as the latest migration sets it, so the test pins what production prices with. */
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

/** The schedule's printed "Premium per age band group" for policy 50048950, bands 0 to 79. It already carries the 1.55% tax. */
const PRINTED_RATES: Record<MedicalInsuranceCategory, number[]> = {
  A: [7569.75, 8419.61, 10018.72, 12328.77, 14994.33, 17589.83, 21726.51, 24234.84, 31342.82, 39339.3, 46980.38, 54088.44, 62084.83],
  B: [3494.61, 4052.66, 4776.65, 5822.34, 7028.99, 8203.97, 10076.66, 11212.13, 14429.8, 18049.73, 21508.79, 24726.62, 28346.52],
  C: [3161.55, 3695.59, 4347.59, 5289.29, 6375.95, 7434.08, 9120.54, 10143.1, 13040.79, 16300.75, 19415.82, 22313.66, 25573.58],
};

/**
 * The issued policy 50048950 against Libano-Suisse's own first invoice (INV6021-2026-1) and Initial Breakdown,
 * 20 November 2026. The card holds each printed rate BEFORE tax, so adding the 1.55% gives back every printed
 * figure (the breakdown bills each person the printed rate, and its 139 add up to the schedule's net plus tax).
 * The breakdown's 139, plan by priced age, reproduce the schedule (net 927,635.54, tax 14,378.35) and the
 * invoice's first quarter (235,503.75 + 4,260 = 239,763.75) within a pound. A band's premium is the rate times
 * its people, to the piastre.
 */
function testTheIssuedPolicyIsReproducedFromTheInsurersOwnBill() {
  for (const category of ["A", "B", "C"] as const) {
    PRINTED_RATES[category].forEach((printed, index) => {
      const rate = CARD.plans[category].rates[index] as number;
      const withTax = Math.round((Math.round(rate * 100) * (10_000 + CARD.taxBasisPoints)) / 10_000);
      assert.equal(withTax, Math.round(printed * 100), `plan ${category}, band ${index}: the stored rate plus 1.55% is the printed ${printed}`);
    });
    assert.equal(CARD.plans[category].rates.at(-1), null, `plan ${category}: 80 and over is unquoted`);
  }
  assert.equal(CARD.plans.A.rates[8], 30_864.42, "A 55 to 59 is 30,864.42 before tax, printed 31,342.82");
  assert.equal(CARD.premiumInstalments, 4, "the policy is paid quarterly");

  // The Initial Breakdown's 139 people as [plan, priced age, how many]; the priced age is 2026 less the year of birth.
  const breakdown: Array<[MedicalInsuranceCategory, number, number]> = [
    ["A", 0, 2], ["A", 25, 1], ["A", 30, 1], ["A", 35, 1], ["A", 40, 1], ["A", 45, 2], ["A", 50, 2], ["A", 55, 4], ["A", 60, 1],
    ["B", 0, 1], ["B", 30, 11], ["B", 35, 7], ["B", 40, 5], ["B", 50, 2], ["B", 55, 1],
    ["C", 0, 3], ["C", 18, 35], ["C", 25, 43], ["C", 30, 10], ["C", 35, 5], ["C", 50, 1],
  ];
  const issued = { endsOn: "2027-11-26", startsOn: "2026-11-22" };
  const people: PersonToPrice[] = [];
  for (const [category, age, count] of breakdown) {
    for (let person = 0; person < count; person += 1) people.push({ birthDate: `${2026 - age}-06-01`, category, coverageStart: issued.startsOn });
  }

  const statement = openingStatement(CARD, people);
  assert.equal(statement.people, 139);
  assert.equal(statement.unpriced, 0);
  assert.deepEqual(statement.plans.map((plan) => [plan.category, plan.people]), [["A", 15], ["B", 27], ["C", 97]]);
  assert.equal(statement.plans[0].bands[0].premium, 14_908.42, "two at 7,454.21 is 14,908.42, never rounded to the pound");
  assert.equal(statement.premium, 927_635.51);
  assert.ok(Math.abs(statement.premium - 927_635.54) < 1, "within a pound of the schedule's net premium");
  assert.equal(statement.tax, 14_378.35, "the schedule's tax, to the piastre");
  assert.equal(statement.cards, 4_170, "EGP 30 a member for 139 people");
  assert.equal(statement.issueFee, 90, "the issue fee, once");

  const first = openingInstalment(statement, 4, 1);
  assert.equal(first, 239_763.47, "a quarter of premium and tax, then every card and the issue fee");
  assert.ok(Math.abs(first - 239_763.75) < 1, "within a pound of invoice INV6021-2026-1");
  assert.equal(openingInstalment(statement, 4, 2), 235_503.47, "a later quarter carries no card and no issue fee");
  assert.equal(openingInstalment(statement, 1, 1), statement.total, "one instalment is the whole opening bill");
  assert.equal(instalmentNumber(issued, 4, "2026-11-22"), 1);
  assert.equal(instalmentNumber(issued, 4, "2027-02-21"), 1, "the first quarter runs to 21 February");
  assert.equal(instalmentNumber(issued, 4, "2027-02-22"), 2);
  assert.equal(instalmentNumber(issued, 4, "2027-08-22"), 4);
  assert.equal(instalmentNumber(issued, 4, null), 1, "a bill with no first day is the first");
  assert.equal(instalmentNumber(issued, 1, "2027-08-22"), 1, "one bill a year is always the first");

  // The insurer's age: the year cover starts less the year of birth, never the age on the day.
  assert.equal(pricingAge("1996-12-03", issued.startsOn), 30, "29 on the day, priced at 30 as the breakdown did");
  const turning = annualRate(CARD, { birthDate: "1996-12-03", category: "A", coverageStart: issued.startsOn });
  assert.equal(turning.priced && turning.annual, CARD.plans.A.rates[3], "priced in A 30 to 34");
  assert.equal(pricingAge("2001-12-26", issued.startsOn), 25, "24 on the day, priced at 25");
  assert.equal(pricingAge("2027-01-01", issued.startsOn), null, "born after the year cover starts");

  const old = annualRate(CARD, { birthDate: "1940-01-01", category: "C", coverageStart: POLICY.startsOn });
  assert.equal(old.priced, false, "a band the policy does not quote (80 and over) is never priced at zero");
  assert.equal(annualRate(CARD, { birthDate: null, category: "A", coverageStart: POLICY.startsOn }).priced, false, "no birth date, no price");
  assert.throws(() => parseRateCard({ ...CARD, taxBasisPoints: undefined }), /missing a figure/);
  assert.throws(() => parseRateCard({ ...CARD, premiumInstalments: 0 }), /missing a figure/, "instalments are a whole number from 1 to 12");
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
  // The other two ways an exit is recorded: a contract not renewed, and the resignation workflow's own `inactive`.
  // Each leaves a day on record and is covered to it — never read as "not an employee" and refunded from day one.
  for (const status of ["not_renewed", "inactive"]) {
    assert.deepEqual(
      employeeCoverWindow(employee({ active: false, employmentStatus: status, exitDay: "2026-11-20" }), POLICY),
      { from: POLICY.startsOn, until: "2026-11-20" },
      `${status} with a last working day: covered until it`,
    );
    assert.equal(employeeCoverWindow(employee({ active: false, employmentStatus: status }), POLICY), null, `${status} with no day on record cannot be placed`);
  }
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

/**
 * The three service fixes that rode on a review, each pinned so reverting it turns something red:
 *   1. an employee on leave is still an employee (the lifecycle set, not the literal "active");
 *   2. Exclude/keep-out is refused for someone with an open row, and a reinstate is refused when another open row exists;
 *   3. Put back and Add someone both revoke a live keep_out, each with its own audit row, and Put back revokes FIRST.
 * (1) is behaviour; the rest is database work no unit can run, so the service's own text is held to its order.
 */
function testTheServiceFixesCannotBeRevertedQuietly() {
  for (const status of ["active", "on_leave", " Active ", "", null, undefined]) {
    assert.equal(isActiveEmploymentStatus(status), true, `${JSON.stringify(status)} is someone who works here`);
  }
  for (const status of ["resigned", "terminated", "not_renewed", "inactive", "declined_offer", "placeholder"]) {
    assert.equal(isActiveEmploymentStatus(status), false, `${status} is not`);
  }
  const service = stripComments(readFileSync("src/lib/medical-insurance/service.ts", "utf8"));
  assert.match(service, /active: isActiveEmploymentStatus\(row\.employmentStatus\),/, "the register reads an employee on leave as active");

  const guardStart = service.indexOf("export async function addMedicalInsuranceException(");
  const guard = service.slice(guardStart, service.indexOf("export async function revokeMedicalInsuranceException("));
  assert.match(guard, /if \(input\.decision === "keep_out"\) \{[\s\S]*?\.is\("coverage_ends_on", null\)[\s\S]*?already on the register/, "a bare keep_out is refused for someone with an open row");

  const reinstate = service.slice(service.indexOf('input.action === "reinstate"'), service.indexOf('const coverageStart = cleanDay(input.coverageStart, "The start of cover") ?? member.coverage_starts_on;'));
  const precheck = reinstate.indexOf('.neq("id", memberId)');
  const keepOut = reinstate.indexOf("revokeLiveKeepOuts(access, policy.id, member.hr_id");
  const familyBack = reinstate.indexOf('.eq("principal_member_id", memberId)');
  const reopen = reinstate.indexOf('.eq("id", memberId)');
  assert.ok(precheck > -1 && keepOut > -1 && familyBack > -1 && reopen > -1, "the reinstate keeps its open-row check, its keep_out revoke, its family and its own reopen");
  assert.ok(precheck < keepOut && keepOut < familyBack && familyBack < reopen, "an open-row refusal, then the keep_out, then the family, then the row — a failure never leaves an open row beside a live keep_out");

  const helper = service.slice(service.indexOf("async function revokeLiveKeepOuts("), service.indexOf("export async function addMedicalInsuranceException("));
  assert.match(helper, /\.eq\("decision", "keep_out"\)[\s\S]*?\.is\("revoked_at", null\)/, "only a live keep_out is revoked, and it stays on the table");
  assert.match(helper, /for \(const row of revoked\) \{\s*await writeRequiredAuditLog\(/, "each revoked exception leaves its own audit row, as the Exceptions tab's Remove does");
  const add = service.slice(service.indexOf("export async function addMedicalInsuranceMember("), service.indexOf("export type UpdateMemberInput"));
  assert.ok(add.indexOf('.from("medical_insurance_members")\n    .insert(') < add.indexOf("revokeLiveKeepOuts(access, policy.id, hrId"), "Add someone revokes the keep_out only AFTER the row is in, so a refused add keeps the exclusion");

  // Put back on a spouse or child is refused while their employee is still ended, before anything is written.
  const principalRead = reinstate.indexOf('.eq("id", member.principal_member_id)');
  const firstReinstateWrite = reinstate.indexOf(".update(");
  assert.ok(principalRead > -1 && principalRead < firstReinstateWrite, "Put back on a spouse or child reads their employee before the first write");
  assert.match(reinstate, /member\.member_type !== "employee"[\s\S]*?coverage_ends_on[\s\S]*?cannot be put back under it/, "a family member is never put back under an ended employee");

  // Editing a family member's start is held to their employee's start, as adding one is.
  const edit = service.slice(
    service.indexOf('const coverageStart = cleanDay(input.coverageStart, "The start of cover") ?? member.coverage_starts_on;'),
    service.indexOf("const patch = {"),
  );
  assert.match(edit, /member\.principal_member_id[\s\S]*?Cover cannot start before the employee's own cover/, "a family member's start cannot move before their employee's");
  assert.ok(edit.includes("coverageStart !== member.coverage_starts_on"), "asked only when the start changes, so an already-early row can still have its notes corrected");

  // Exclude asks for a live exception BEFORE it ends anyone, so a refusal writes nothing.
  const end = service.slice(service.indexOf('input.action === "end"'), service.indexOf('input.action === "move_under"'));
  const liveRead = end.indexOf('.from("medical_insurance_exceptions")');
  const firstEndWrite = end.indexOf("coverage_ends_on: endsOn, end_reason: reason");
  assert.ok(liveRead > -1 && liveRead < firstEndWrite, "Exclude reads the live exception before the first write");
  assert.match(end, /liveDecision === "keep_in"[\s\S]*?Remove it on the Exceptions tab first/, "a live keep-on is refused with nothing written");
  assert.ok(end.includes("!alreadyKeptOut &&"), "a live keep-off is not inserted twice");

  // The additions file names everyone the insurer's sheet would take blank, instead of writing blank mandatory cells.
  assert.match(
    service.slice(service.indexOf("export async function prepareLibanoMemberFile(")),
    /libanoLineGaps\([\s\S]*?needs a date of birth and sex for everyone/,
    "the additions file refuses a line with no date of birth or sex",
  );
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

  // The policy is paid quarterly, so an opening bill is held against its quarter of the opening statement.
  assert.equal(year.premiumInstalments, 4);
  const firstQuarter = openingInstalment(year.opening, 4, 1);
  const opening = compareInvoiceToPlan({ coversFrom: POLICY.startsOn, coversTo: "2027-02-14", kind: "opening", totalDue: firstQuarter + 10 }, year);
  assert.equal(opening.expected, firstQuarter, "the first quarterly bill is a quarter of premium and tax, with every card and the issue fee");
  assert.ok(firstQuarter < year.opening.total, "never the whole year");
  assert.deepEqual(opening.instalment, { number: 1, of: 4 });
  assert.equal(opening.difference, 10);
  const secondQuarter = compareInvoiceToPlan({ coversFrom: "2027-02-15", coversTo: "2027-05-14", kind: "opening", totalDue: 0 }, year);
  assert.deepEqual(secondQuarter.instalment, { number: 2, of: 4 });
  assert.equal(secondQuarter.expected, openingInstalment(year.opening, 4, 2), "a later quarter carries no card and no issue fee");
  const yearly = buildPolicyYearCost({ actions: [], birthDates: new Map(), members, policy: POLICY, rateCard: { ...CARD, premiumInstalments: undefined } });
  const oneBill = compareInvoiceToPlan({ coversFrom: POLICY.startsOn, coversTo: POLICY.endsOn, kind: "opening", totalDue: yearly.opening.total }, yearly);
  assert.equal(oneBill.expected, yearly.opening.total, "a policy paid once a year is held against the whole opening statement");
  assert.equal(oneBill.instalment, null);
  // An opening bill must say which day it covers from: without it instalments 2 to 4 were held against the first,
  // cards and issue fee included, because the form never asked (found on 20 Nov 2026 recording INV6021-2026-1).
  assert.match(invoiceDatesProblem("opening", null, null) ?? "", /first day the bill covers/, "an opening bill with no first day is refused");
  assert.equal(invoiceDatesProblem("opening", "2027-02-22", "2027-05-21"), null, "a later quarter with its dates is accepted");
  assert.match(invoiceDatesProblem("additions", "2027-03-01", "2027-02-01") ?? "", /before its first/, "a last day before the first is refused");
  assert.equal(invoiceDatesProblem("additions", null, null), null, "an endorsement may leave its dates open");
  assert.equal(invoiceDatesProblem("other", null, null), null);
  const recordForm = stripComments(readFileSync("src/components/medical-insurance/medical-insurance-cost.tsx", "utf8"));
  assert.match(recordForm, /fields\.kind !== "other" \? \(/, "the record form asks the cover dates on an opening bill too, not only on additions and deletions");
  assert.match(recordForm, /datesProblem !== null/, "the record button waits for the dates the bill needs");
  const recordService = stripComments(readFileSync("src/lib/medical-insurance/service.ts", "utf8"));
  assert.match(recordService, /invoiceDatesProblem\(kind, coversFrom, coversTo\)/, "the server refuses a bill whose dates the form would refuse");

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
  // The two cells the insurer's sheet marks mandatory and that a record can leave blank: named, never written blank.
  assert.deepEqual(libanoLineGaps(child), [], "a complete line has no gaps");
  assert.deepEqual(libanoLineGaps({ ...child, birthDate: null, gender: null }), ["date of birth", "sex"]);
  assert.deepEqual(libanoLineGaps({ ...child, gender: "x" }), ["sex"], "anything but M or F is blank in the file");
  assert.deepEqual(libanoLineGaps({ ...child, birthDate: "" }), ["date of birth"]);
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

  // The split of a month always adds back to the month: the employee 30%, never under EGP 120 (nor above the month).
  assert.equal(EMPLOYEE_MINIMUM_OWN_SHARE_MONTHLY, 120);
  for (const piastres of [0, 1, 99, 11_999, 30_000, 39_999, 40_000, 100_001, 123_457]) {
    const { company, employee: own, raisedToMinimum } = splitOwnCover(piastres);
    assert.equal(company + own, piastres, "the two shares add back to the month");
    const thirty = piastres - Math.round(piastres * 0.7);
    assert.equal(own, piastres === 0 ? 0 : Math.max(thirty, Math.min(piastres, 12_000)), `the employee's share of ${piastres} piastres`);
    assert.equal(raisedToMinimum, own > thirty);
  }
  assert.deepEqual(splitOwnCover(30_000), { company: 18_000, employee: 12_000, raisedToMinimum: true }, "30% of EGP 300 is EGP 90, raised to EGP 120");
  assert.deepEqual(splitOwnCover(100_000), { company: 70_000, employee: 30_000, raisedToMinimum: false }, "30% of EGP 1,000 is over the minimum");
  assert.equal(monthlyCoverPiastres(CARD, 12_000), monthOf(12_000), "a month is premium and tax over twelve");

  const members: MemberFacts[] = [
    member({ birthDate: "1990-01-01", category: "C", hrId: "T-1", id: "e-1", name: "Family Employee" }),
    member({ birthDate: "1992-03-01", category: "C", hrId: null, id: "s-1", memberType: "spouse", name: "Their Spouse", principalMemberId: "e-1" }),
    member({ birthDate: "2015-05-01", category: "C", hrId: null, id: "c-1", memberType: "child", name: "Their Child", principalMemberId: "e-1" }),
    member({ birthDate: "1996-01-01", category: "C", hrId: "T-2", id: "e-2", name: "Single Employee" }),
    member({ birthDate: "1998-01-01", category: "C", coverageStart: "2026-12-01", hrId: "T-3", id: "e-3", name: "December Joiner" }),
    member({ birthDate: "1980-01-01", category: "C", coverageEnd: "2026-11-16", hrId: "T-4", id: "e-4", name: "Already Left" }),
    member({ birthDate: "2010-01-01", category: "C", hrId: null, id: "c-9", memberType: "child", name: "Stray Child", principalMemberId: "e-4" }),
    member({ birthDate: null, category: "C", hrId: "T-5", id: "e-5", name: "No Birth Date" }),
  ];
  const split = buildMonthlySplit({ asOf: "2026-11-17", members, rateCard: CARD });
  const row = (name: string) => split.rows.find((entry) => (entry.employee?.name ?? entry.family[0]?.name) === name);

  assert.equal(row("Already Left"), undefined, "cover that has ended is in no month");

  const family = row("Family Employee");
  assert.ok(family);
  const own = monthOf(rateOf("1990-01-01", "C"));
  const relatives = monthOf(rateOf("1992-03-01", "C")) + monthOf(rateOf("2015-05-01", "C"));
  const company = Math.round((own * 7_000) / 10_000);
  assert.ok(own - company > 12_000, "the fixture's 30% is over the minimum");
  assert.equal(family.ownMonthly, own / 100);
  assert.equal(family.companyPays, company / 100, "the company carries 70% of the employee's own cover");
  assert.equal(family.employeeOwnShare, (own - company) / 100, "the employee carries the other 30%");
  assert.equal(family.raisedToMinimum, false);
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
  // Plan C at 28: 30% of the month is under EGP 120, so the employee carries EGP 120 and the company the rest.
  const joinerMonth = monthOf(rateOf("1998-01-01", "C"));
  assert.ok(joinerMonth - Math.round((joinerMonth * 7_000) / 10_000) < 12_000, "the fixture's 30% is under the minimum");
  assert.equal(joiner?.employeeOwnShare, EMPLOYEE_MINIMUM_OWN_SHARE_MONTHLY, "an employee's share is never under EGP 120");
  assert.equal(joiner?.companyPays, (joinerMonth - 12_000) / 100, "the company carries the rest");
  assert.equal(joiner?.raisedToMinimum, true);
  assert.equal(joiner?.employeePays, (12_000 + 8_500) / 100);

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

/**
 * The cost calculator (owner, 2026-11-27: "a cost calculator in the module … employee or family of employee … the
 * birth year and the grade, and it calculates the cost") prices a person exactly as the monthly split does.
 */
function testTheCalculatorPricesAsTheSplitDoes() {
  const start = POLICY.startsOn;
  const split = buildMonthlySplit({
    asOf: start,
    members: [
      member({ birthDate: "1990-01-01", category: "C", coverageStart: start, hrId: "T-1", id: "e-1", name: "Quoted Employee" }),
      member({ birthDate: "1992-01-01", category: "C", coverageStart: start, hrId: null, id: "s-1", memberType: "spouse", name: "Quoted Spouse", principalMemberId: "e-1" }),
      member({ birthDate: "1998-01-01", category: "C", coverageStart: start, hrId: "T-2", id: "e-2", name: "Minimum Employee" }),
    ],
    rateCard: CARD,
  });
  const employeeRow = split.rows.find((row) => row.hrId === "T-1")!;
  const minimumRow = split.rows.find((row) => row.hrId === "T-2")!;

  const employee = quoteMonthlyCost({ birthYear: 1990, category: "C", coverageStart: start, memberType: "employee", rateCard: CARD });
  assert.ok(employee.priced);
  assert.equal(employee.monthly, employeeRow.ownMonthly, "the month of cover is the split's");
  assert.equal(employee.companyPays, employeeRow.companyPays, "the company's 70% is the split's");
  assert.equal(employee.employeeCover, employeeRow.employeeOwnShare, "the employee's 30% is the split's");
  assert.equal(employee.employeePays, Math.round((employeeRow.employeeOwnShare + LIFE_INSURANCE_PER_PERSON_MONTHLY) * 100) / 100, "their 30% and EGP 85 life insurance");

  const spouse = quoteMonthlyCost({ birthYear: 1992, category: "C", coverageStart: start, memberType: "spouse", rateCard: CARD });
  assert.ok(spouse.priced);
  assert.equal(spouse.companyPays, 0, "the company carries nothing of a spouse or child");
  assert.equal(spouse.employeeCover, employeeRow.familyMonthly, "a spouse is the employee's in full, as on the split");
  assert.equal(spouse.employeePays, Math.round((employeeRow.familyMonthly + LIFE_INSURANCE_PER_PERSON_MONTHLY) * 100) / 100);
  assert.equal(employee.employeePays + spouse.employeePays, employeeRow.employeePays, "the two quotes add up to the employee's row");

  const minimum = quoteMonthlyCost({ birthYear: 1998, category: "C", coverageStart: start, memberType: "employee", rateCard: CARD });
  assert.ok(minimum.priced && minimum.raisedToMinimum, "a 30% under EGP 120 is raised to it");
  assert.equal(minimum.employeeCover, EMPLOYEE_MINIMUM_OWN_SHARE_MONTHLY);
  assert.equal(minimum.companyPays, minimumRow.companyPays);

  const plans = MEDICAL_INSURANCE_CATEGORIES.map((category) => quoteMonthlyCost({ birthYear: 1985, category, coverageStart: start, memberType: "employee", rateCard: CARD }));
  for (const [index, quote] of plans.entries()) {
    assert.ok(quote.priced, `plan ${MEDICAL_INSURANCE_CATEGORIES[index]} is priced`);
    assert.equal(quote.annual, CARD.plans[MEDICAL_INSURANCE_CATEGORIES[index]!].rates[CARD.ageBands.findIndex((band) => 41 >= band.from && (band.to === null || 41 <= band.to))], "each plan reads its own rate");
  }

  const unknown = quoteMonthlyCost({ birthYear: 3000, category: "A", coverageStart: start, memberType: "employee", rateCard: CARD });
  assert.equal(unknown.priced, false, "a year after cover starts is refused in words, never priced at zero");
  const oldChild = quoteMonthlyCost({ birthYear: 1990, category: "A", coverageStart: start, memberType: "child", rateCard: CARD });
  if (oldChild.priced) assert.match(oldChild.ageNote ?? "", /children up to/, "a child past the contract's limit is flagged for review");
}

/**
 * The monthly cost workbook (owner, 2026-11-27: "export XLX sheet with the employee and the monthly cost on him
 * … cost for the company and for him, and the details") is the Cost tab's split, cell for cell.
 */
async function testTheMonthlyCostWorkbookIsTheCostTabsSplit() {
  const members: MemberFacts[] = [
    member({ birthDate: "1990-01-01", category: "C", hrId: "T-1", id: "e-1", name: "Family Employee" }),
    member({ birthDate: "1992-03-01", category: "C", hrId: null, id: "s-1", memberType: "spouse", name: "Their Spouse", principalMemberId: "e-1" }),
    member({ birthDate: "2015-05-01", category: "C", hrId: null, id: "c-1", memberType: "child", name: "Their Child", principalMemberId: "e-1" }),
    member({ birthDate: "1998-01-01", category: "C", hrId: "T-3", id: "e-3", name: "Minimum Employee" }),
    member({ birthDate: "2010-01-01", category: "C", hrId: null, id: "c-9", memberType: "child", name: "Stray Child", principalMemberId: "gone" }),
  ];
  const split = buildMonthlySplit({ asOf: "2026-11-27", members, rateCard: CARD });
  const buffer = await buildMedicalInsuranceMonthlyCostWorkbook({
    asOf: "2026-11-27",
    exportedByName: "Test Exporter",
    generatedAtIso: "2026-11-27T10:00:00.000Z",
    numbers: new Map([
      ["e-1", { principalNumber: "51905339", staffNumber: "30" }],
      ["s-1", { principalNumber: "51905339", staffNumber: "30-1" }],
      ["c-1", { principalNumber: "51905339", staffNumber: "30-2" }],
      ["e-3", { principalNumber: "52739707", staffNumber: "1028" }],
      ["c-9", { principalNumber: null, staffNumber: "77-1" }],
    ]),
    policy: { endsOn: POLICY.endsOn, insurer: "Libano-Suisse Takaful Egypt", policyNumber: "50048950", startsOn: POLICY.startsOn },
    split,
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["Cover", "Monthly cost", "Details"]);

  const sheet = workbook.getWorksheet("Monthly cost")!;
  const headers = (sheet.getRow(2).values as unknown[]).slice(1).map(String);
  const column = (label: string) => {
    const index = headers.findIndex((header) => header.startsWith(label));
    assert.ok(index >= 0, `the sheet has a "${label}" column`);
    return index + 1;
  };
  const rowOf = (name: string): number => {
    for (let r = 3; r <= sheet.rowCount; r += 1) if (sheet.getCell(r, column("Employee")).value === name) return r;
    assert.fail(`${name} is on the sheet`);
  };
  const value = (r: number, label: string) => sheet.getCell(r, column(label)).value;

  for (const row of split.rows) {
    const name = row.employee?.name ?? row.family[0]!.name;
    const r = rowOf(name);
    assert.equal(value(r, "HR ID"), row.hrId ?? "", `${name}: their HR id`);
    assert.equal(value(r, "Company pays"), row.employee ? row.companyPays : "", `${name}: what the company pays is the tab's (blank with no employee)`);
    assert.equal(value(r, "Employee pays a month"), row.employeePays, `${name}: what the employee pays is the tab's`);
    assert.equal(value(r, "Company and employee a month"), Math.round((row.companyPays + row.employeePays) * 100) / 100, `${name}: the two together`);
    assert.equal(value(r, "Life insurance"), row.lifeInsurance);
    assert.equal(value(r, "People covered"), row.people);
  }
  const family = split.rows.find((row) => row.hrId === "T-1")!;
  assert.equal(value(rowOf("Family Employee"), "Family a month"), family.familyMonthly, "the details of the employee's figure: the family in full");
  assert.equal(value(rowOf("Family Employee"), "Employee's own share"), family.employeeOwnShare, "and their 30%");
  assert.match(String(value(rowOf("Minimum Employee"), "Notes")), /raised to EGP 120/, "a share raised to the minimum says so");
  assert.match(String(value(rowOf("Stray Child"), "Notes")), /not on the register/);
  // The insurer's numbers beside Phoenix's (owner, 2026-11-27): the Principal ID is the employee's card number,
  // the staff number is Libano's own with its dash for family, and the HR ID is Phoenix's.
  assert.deepEqual(headers.slice(0, 4), ["Principal ID", "HR ID in Phoenix", "Libano staff number", "Employee"], "the three ids open the sheet");
  assert.equal(value(rowOf("Family Employee"), "Principal ID"), "51905339");
  assert.equal(value(rowOf("Family Employee"), "HR ID in Phoenix"), "T-1");
  assert.equal(value(rowOf("Family Employee"), "Libano staff number"), "30", "a staff number stays text, never the number 30");
  assert.equal(value(rowOf("Stray Child"), "Libano staff number"), "77-1", "a row with no employee speaks for the relative it holds");

  const totalRow = rowOf("Total a month");
  assert.equal(value(totalRow, "Company pays"), split.totals.companyPays, "the company's total is the tab's tile");
  assert.equal(value(totalRow, "Employee pays a month"), split.totals.employeesPay, "the employees' total is the tab's tile");
  assert.equal(value(totalRow, "Company and employee a month"), split.totals.total);

  const details = workbook.getWorksheet("Details")!;
  const people: string[] = [];
  const detailHeaders = (details.getRow(2).values as unknown[]).slice(1).map(String);
  const detailColumn = (label: string) => detailHeaders.indexOf(label) + 1;
  const ids = new Map<string, [unknown, unknown, unknown]>();
  for (let r = 3; r <= details.rowCount; r += 1) {
    const name = String(details.getCell(r, detailColumn("Person covered")).value ?? "");
    people.push(name);
    ids.set(name, [details.getCell(r, detailColumn("Principal ID")).value, details.getCell(r, detailColumn("HR ID in Phoenix")).value, details.getCell(r, detailColumn("Libano staff number")).value]);
  }
  assert.deepEqual(people.filter(Boolean).sort(), ["Family Employee", "Minimum Employee", "Stray Child", "Their Child", "Their Spouse"], "every person covered has a line of their own");
  assert.deepEqual(ids.get("Their Spouse"), ["51905339", "T-1", "30-1"], "a spouse carries their employee's Principal ID and HR ID, and their own staff number");
  assert.deepEqual(ids.get("Family Employee"), ["51905339", "T-1", "30"]);

  const route = readFileSync("app/api/medical-insurance/cost/export/route.ts", "utf8");
  const assertAt = route.indexOf(`assertPermission(access, "medical_insurance_invoices", "read")`);
  assert.ok(assertAt > 0 && assertAt < route.indexOf("getMedicalInsuranceMonthlyCost("), "the sheet carries amounts, so the money seat is asserted before anything is read");
  assert.doesNotMatch(route, /"medical_insurance", "export"/, "never the register's seat");
}

/** The table of benefits is the signed one (Rev 1.3, pages 7 to 9): each plan's limit, network, room and shares. */
function testTheTableOfBenefitsIsTheSignedOne() {
  const find = (category: "A" | "B" | "C", section: string, benefit: string, part?: string) => {
    const line = LIBANO_TABLE_OF_BENEFITS[category].sections.find((entry) => entry.key === section)?.lines.find((entry) => entry.benefit.en === benefit && entry.part?.en === part);
    assert.ok(line, `plan ${category} has ${benefit}${part ? ` (${part})` : ""}`);
    return line;
  };
  for (const category of ["A", "B", "C"] as const) {
    const plan = LIBANO_TABLE_OF_BENEFITS[category];
    assert.equal(plan.category, category);
    assert.equal(plan.annualLimit, CARD.plans[category].annualLimit, `plan ${category}'s limit matches the rate card`);
    const facts = Object.fromEntries(plan.facts.map((fact) => [fact.label.en, fact.value.en]));
    assert.equal(facts["Medical network"], CARD.plans[category].network, `plan ${category}'s network matches the rate card`);
    assert.equal(facts["Hospital room"], CARD.plans[category].room, `plan ${category}'s room matches the rate card`);
    assert.deepEqual(plan.sections.map((section) => section.key), ["in-patient", "out-patient", "additional", "reimbursement"]);
    for (const section of plan.sections) {
      for (const line of section.lines) {
        for (const text of [line.benefit, line.coverage, ...(line.part ? [line.part] : [])]) {
          assert.ok(text.en.trim() && text.ar.trim(), "every line carries its English and the signed Arabic");
        }
      }
    }
    assert.equal(find(category, "additional", "Dental").memberShare, "20%");
    assert.equal(find(category, "additional", "Optical").coverage.en, "Not covered");
    assert.equal(find(category, "additional", "Pregnancy and childbirth", "Natural delivery").coverage.en, "Not covered");
  }
  assert.deepEqual([find("A", "out-patient", "Doctor visits").memberShare, find("B", "out-patient", "Doctor visits").memberShare, find("C", "out-patient", "Doctor visits").memberShare], ["10%", "25%", "25%"]);
  assert.equal(find("B", "out-patient", "Prescribed medicines", "Chronic medicines").coverage.en, "Covered up to EGP 50,000");
  assert.equal(find("C", "out-patient", "Prescribed medicines", "Chronic medicines").coverage.en, "Covered up to EGP 25,000");
  assert.equal(find("A", "additional", "Organ transplant (the surgery only)").coverage.en, "Fully covered", "plan A covers a transplant");
  assert.equal(find("B", "additional", "Organ transplant (the surgery only)").coverage.en, "Not covered");
  assert.equal(find("C", "additional", "Congenital defects").coverage.en, "Not covered");

  const page = readFileSync("src/components/medical-insurance/medical-insurance-page.tsx", "utf8");
  assert.match(page, /\{tab === "benefits" \? <MedicalInsuranceBenefitsTab view=\{view\} \/> : null\}/, "the Benefits tab needs no money: every seat that opens the page sees it");
  const benefits = readFileSync("src/lib/medical-insurance/benefits.ts", "utf8");
  assert.doesNotMatch(benefits, /rateCard|premium|annualRate/, "the table of benefits carries no cost");
  // The Cost calculator is a tab of its own (owner, 2026-11-27: "Make it in a separate tab"), held to the money
  // seat like Cost and invoices, and no longer buried at the foot of the Cost tab.
  assert.ok(page.includes(`...(money ? [{ id: "calculator" as const, label: "Cost calculator"`), "the calculator has its own tab, shown only with the money seat");
  assert.ok(page.includes(`{tab === "calculator" && money ? <MedicalInsuranceCalculatorTab `), "the calculator tab renders the calculator");
  const costTab = readFileSync("src/components/medical-insurance/medical-insurance-cost.tsx", "utf8");
  const costTabBody = costTab.slice(costTab.indexOf("export function MedicalInsuranceCostTab("), costTab.indexOf("function Tiles("));
  assert.doesNotMatch(costTabBody, /CostCalculatorPanel/, "Cost and invoices no longer carries the calculator at its foot");
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

// The Send and Send test buttons (owner, 27 Nov 2026). Built with a fake workbook: nothing is ever sent here.
function testTheLibanoEmailGoesToTheInsurerAndTheTestToTheOwnerAlone() {
  const line = (fullName: string, memberType: LibanoMemberLine["memberType"]): LibanoMemberLine => ({
    adherentNumber: null,
    birthDate: "1990-01-01",
    category: "A",
    day: "2026-11-30",
    fullName,
    gender: "M",
    memberType,
    nationalId: null,
    phone: null,
    principalNumber: null,
    staffNumber: "A-2",
  });
  const rows = [line("Ahmed <Ali>", "employee"), line("Mona Ali", "spouse")];
  const workbook = new Uint8Array([80, 75, 3, 4]);
  // 01:30 in Cairo on the 27th is still the 26th in UTC: the subject carries Cairo's day.
  const base = { atIso: "2026-11-26T23:30:00.000Z", fileName: "Libano-Suisse-members-deletions-2026-11-27.xlsx", kind: "deletions" as const, policyNumber: "P-1", rows, systemFromAddress: "phoenix@send.satopharma.com", workbook };

  const real = planLibanoMovementEmail(base);
  assert.deepEqual(real.input.to, ["Policy.Admin@Libano-suisse-takaful.com"]);
  assert.deepEqual(real.input.cc, ["ahmed.elshazly@libano-suisse-takaful.com", "omar.anwar@satopharma.com"]);
  assert.equal(real.input.subject, "Deletion 27/11/2026");
  assert.equal(real.input.from, "Omar Gawish via Phoenix Workforce <phoenix@send.satopharma.com>");
  assert.equal(real.input.replyTo, "omar.anwar@satopharma.com");
  assert.ok(real.input.externalRecipients.includes("Policy.Admin@Libano-suisse-takaful.com"), "the insurer is declared to the recipient guard");
  assert.match(real.input.html, /automated email from Phoenix Workforce/);
  assert.match(real.input.html, /Ahmed &lt;Ali&gt;/, "a name is escaped, never written into the email as markup");
  assert.equal(real.input.attachments.length, 1);
  assert.equal(real.input.attachments[0]!.filename, base.fileName);
  assert.deepEqual([...Buffer.from(real.input.attachments[0]!.content, "base64")], [...workbook], "the attachment is the very workbook Export builds");
  const fromArrayBuffer = planLibanoMovementEmail({ ...base, workbook: workbook.slice().buffer });
  assert.deepEqual([...Buffer.from(fromArrayBuffer.input.attachments[0]!.content, "base64")], [...workbook], "the workbook builder answers an ArrayBuffer, and it is attached byte for byte");
  assert.equal(planLibanoMovementEmail({ ...base, atIso: "2026-11-27T15:00:00.000Z" }).dedupeKey, real.dedupeKey, "a second press the same day never reaches the insurer twice");

  const test = planLibanoMovementEmail({ ...base, test: true });
  assert.deepEqual(test.input.to, ["omar.anwar@satopharma.com"], "a test goes to the owner alone");
  assert.deepEqual(test.input.cc, [], "a test copies nobody");
  assert.ok(![...test.input.to, ...test.input.cc, ...test.input.externalRecipients].some((address) => /libano/i.test(address)), "a test never names the insurer");
  assert.equal(test.input.subject, "TEST - Deletion 27/11/2026");
  assert.match(test.input.html, /TEST SEND/);
  assert.deepEqual([...Buffer.from(test.input.attachments[0]!.content, "base64")], [...workbook], "a test carries the same file");
  assert.notEqual(test.dedupeKey, real.dedupeKey, "a test never stands in for the real send");
  assert.notEqual(planLibanoMovementEmail({ ...base, atIso: "2026-11-26T23:31:00.000Z", test: true }).dedupeKey, test.dedupeKey, "a test can be sent again a minute later");

  assert.throws(() => planLibanoMovementEmail({ ...base, rows: [] }), /Nobody is on the file/, "an empty file is never sent");

  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.ok(registry.includes(`pattern: "/api/medical-insurance/movement-file/send", permission: { resource: "medical_insurance", action: "export" }`));
  const route = readFileSync("app/api/medical-insurance/movement-file/send/route.ts", "utf8");
  assert.ok(route.includes("assertSameOriginMutation(request)") && route.includes(`assertPermission(access, "medical_insurance", "export")`));
  const service = readFileSync("src/lib/medical-insurance/service.ts", "utf8");
  assert.ok(service.includes("sendDurableEmail(") && service.includes(`sender: "phoenix"`), "the button email goes through the durable outbox");
  const page = readFileSync("src/components/medical-insurance/medical-insurance-actions.tsx", "utf8");
  assert.ok(page.includes("Send test to me") && page.includes("Send to Libano-Suisse") && page.includes("<SendConfirm"));
}

function testNothingHereSendsOrPays() {
  for (const file of ["src/lib/medical-insurance/service.ts", "src/lib/medical-insurance/workbooks.ts", "src/lib/medical-insurance/compare.ts", "src/lib/medical-insurance/cost.ts", "src/lib/medical-insurance/monthly-split.ts", "src/lib/medical-insurance/cost-workbook.ts"]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /from "@\/lib\/email|sendEmail|resend|from "@\/lib\/payroll/i, `${file} must not send mail or reach payroll`);
  }
}

export async function runMedicalInsuranceTests() {
  testTheIssuedPolicyIsReproducedFromTheInsurersOwnBill();
  testAJoinerIsChargedByTheDayAndTheLastQuarterAtAQuarter();
  testALeaverIsRefundedByTheDay();
  testEveryoneBelongsFromDayOneAndTheRecordDecidesTheEnd();
  testTheListNamesWhoToAddAndWhoToRemove();
  testAnExceptionBeatsTheRuleEitherWay();
  testFamilyFollowTheirEmployee();
  testSomeoneIsPutUnderAnEmployeeWithTheirFamily();
  testSomeoneWhoDeclinesIsExcluded();
  testTheServiceFixesCannotBeRevertedQuietly();
  testALateJoinerIsCoveredFromTheDayTheyJoin();
  testEachEmployeeShowsTheirHrNumberHireDayLineAndArea();
  testTheContractsAgeLimitsAreReviewed();
  testTheCompanyCarries70PercentOfTheEmployeeAndTheFamilyIsTheEmployees();
  testTheCalculatorPricesAsTheSplitDoes();
  await testTheMonthlyCostWorkbookIsTheCostTabsSplit();
  testTheTableOfBenefitsIsTheSignedOne();
  testEachBillIsComparedWithThePlan();
  await testTheMemberFileIsTheInsurersOwnSheet();
  testASeatNeverHoldsAnAmount();
  testTheLibanoEmailGoesToTheInsurerAndTheTestToTheOwnerAlone();
  testNothingHereSendsOrPays();
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("tests/medical-insurance.test.ts")) {
  await runMedicalInsuranceTests();
  console.log("medical-insurance: pass");
}
