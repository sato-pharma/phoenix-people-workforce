import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";
import JSZip from "jszip";

import { hrBundleGrants } from "../src/lib/auth/hr-functions.ts";
import { permissionMatrix } from "../src/lib/auth/permissions.ts";
import { compareInvoiceToPlan } from "../src/lib/medical-insurance/compare.ts";
import {
  MEDICAL_INSURANCE_PRODUCTS,
  memberPeriodCost,
  periodStatement,
  emptyProductAmounts,
  addToProductTotals,
  type MedicalInsuranceProduct,
  type MedicalInsuranceRateCard,
} from "../src/lib/medical-insurance/cost.ts";
import {
  additionCategory,
  buildMedicalInsuranceActions,
  buildMedicalInsurancePlan,
  employeeCoverWindow,
  type EmployeeFacts,
  type MemberFacts,
} from "../src/lib/medical-insurance/eligibility.ts";
import { parseInvoiceAmount, parseMedicalInsuranceInvoice, type ParsedInvoice, type ParsedInvoiceMember } from "../src/lib/medical-insurance/invoice-parser.ts";
import { buildMetLifeEdiWorkbook, METLIFE_EDI_TEMPLATE_PATH } from "../src/lib/medical-insurance/workbooks.ts";

const POLICY = { endsOn: "2027-11-03", startsOn: "2026-11-01" };
const PERIOD = { end: "2027-01-31", start: "2026-11-01" };

const RATE_CARD: MedicalInsuranceRateCard = {
  billingMonths: 3,
  currency: "EGP",
  employeeCoversPerPerson: { AD: 29, GTL: 112, PPDA: 9.5, PTD: 14 },
  issueFee: { fee: 250, nominalStamp: 100, product: "GTL" },
  medicalPerPerson: { A: 5365.25, B: 1936.5, C: 1907 },
  stampBasisPoints: { AD: 50, CMM: 100, GTL: 50, PPDA: 50, PTD: 50 },
  sumInsured: 0,
  supervisoryFeeBasisPoints: 55,
};

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

function actionsFor(employees: EmployeeFacts[], members: MemberFacts[], exceptions: Array<{ id: string; hrId: string; decision: "keep_in" | "keep_out"; reason: string }> = [], asOf = "2026-11-04") {
  return buildMedicalInsuranceActions({ asOf, employees, exceptions, members, policy: POLICY }).actions;
}

/** Pinned to the first real bill's totals: the same people at the same rates print the same statement. */
function testTheFirstBillIsReproducedToThePiastre() {
  const counts: Array<{ category: "A" | "B" | "C"; memberType: "employee" | "spouse" | "child"; people: number }> = [
    { category: "A", memberType: "employee", people: 11 },
    { category: "A", memberType: "spouse", people: 3 },
    { category: "A", memberType: "child", people: 5 },
    { category: "B", memberType: "employee", people: 22 },
    { category: "C", memberType: "employee", people: 73 },
  ];
  const premiums = emptyProductAmounts();
  const people: Record<MedicalInsuranceProduct, number> = { AD: 0, CMM: 0, GTL: 0, PPDA: 0, PTD: 0 };
  for (const { category, memberType, people: howMany } of counts) {
    for (let index = 0; index < howMany; index += 1) {
      const cost = memberPeriodCost(RATE_CARD, { category, coverageEnd: null, coverageStart: POLICY.startsOn, memberType }, PERIOD);
      assert.ok(cost, "a full-period person has a cost");
      addToProductTotals(premiums, people, cost);
    }
  }
  const statement = periodStatement(RATE_CARD, premiums, people, { includeIssueFee: true });
  assert.equal(statement.total, 306122.04);
  assert.equal(statement.premiumTotal, 301190.75);

  const pinned: Record<MedicalInsuranceProduct, { people: number; premium: number; total: number }> = {
    AD: { people: 106, premium: 3074, total: 3106.28 },
    CMM: { people: 114, premium: 283753.75, total: 288151.94 },
    GTL: { people: 106, premium: 11872, total: 12346.66 },
    PPDA: { people: 106, premium: 1007, total: 1017.58 },
    PTD: { people: 106, premium: 1484, total: 1499.58 },
  };
  for (const product of MEDICAL_INSURANCE_PRODUCTS) {
    const line = statement.lines.find((row) => row.product === product);
    assert.ok(line, product);
    assert.equal(line.people, pinned[product].people, `${product} people`);
    assert.equal(line.premium, pinned[product].premium, `${product} premium`);
    assert.equal(line.total, pinned[product].total, `${product} total`);
  }

  const later = periodStatement(RATE_CARD, premiums, people, { includeIssueFee: false });
  assert.equal(later.total, Math.round((306122.04 - 350) * 100) / 100, "the issue fee is charged once");
}

function testPartOfAPeriodIsChargedByTheDay() {
  const half = memberPeriodCost(RATE_CARD, { category: "C", coverageEnd: "2026-11-30", coverageStart: POLICY.startsOn, memberType: "employee" }, PERIOD);
  assert.ok(half);
  assert.equal(half.prorated, true);
  assert.equal(half.days, 30);
  assert.equal(half.periodDays, 92);
  assert.equal(memberPeriodCost(RATE_CARD, { category: "C", coverageEnd: "2026-10-31", coverageStart: "2026-10-01", memberType: "employee" }, PERIOD), null, "cover that misses the period costs nothing");
}

function testEveryoneBelongsFromDayOneAndTheRecordDecidesTheEnd() {
  assert.deepEqual(employeeCoverWindow(employee(), POLICY), { from: POLICY.startsOn, until: null }, "working before the policy: from its start");
  assert.deepEqual(employeeCoverWindow(employee({ hireDate: "2026-11-08" }), POLICY), { from: "2026-11-08", until: null }, "a joiner: from their first day");
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

  const left = actionsFor([employee({ active: false, employmentStatus: "resigned", exitDay: "2026-11-02" })], [member()]);
  assert.equal(left[0].kind, "remove");
  assert.equal(left[0].reason, "Has left");
  assert.equal(left[0].effectiveOn, "2026-11-02");

  const gone = actionsFor([employee({ active: false, employmentStatus: "resigned", exitDay: "2026-10-01" })], [member()]);
  assert.equal(gone[0].kind, "remove", "billed but gone before the policy began");

  const declined = actionsFor([employee({ active: false, employmentStatus: "declined_offer" })], [member()]);
  assert.equal(declined[0].reason, "Declined the offer and never started");

  const notice = actionsFor([employee({ exitDay: "2026-11-20" })], [member()]);
  assert.equal(notice[0].timing, "soon", "someone serving notice is still covered, and shown as coming up");

  const stranger = actionsFor([], [member({ hrId: null })]);
  assert.equal(stranger[0].kind, "review", "no Phoenix record is for a person to check");

  const fine = actionsFor([employee()], [member()]);
  assert.equal(fine.length, 0, "a working employee on the register is nothing to do");

  const [add] = missing;
  assert.equal(add.decidedCategory, null, "nobody has decided a joiner's category until someone does");
  assert.equal(additionCategory({ ...add, suggestedCategory: null }), null, "with nothing decided or suggested, the form waits for a decision");
  assert.equal(additionCategory({ ...add, decidedCategory: "A", suggestedCategory: "C" }), "A", "a decided category beats the suggestion");
  assert.equal(additionCategory({ ...add, category: "B", decidedCategory: "A" }), "B", "the register's category beats a decision made before they were on it");
  assert.equal(additionCategory({ ...add, decidedCategory: "A" }, "C"), "C", "a category picked for this file beats them all");
}

function testAnExceptionBeatsTheRuleEitherWay() {
  const keptOut = actionsFor([employee()], [], [{ decision: "keep_out", hrId: "T-1", id: "e", reason: "Own cover" }]);
  assert.equal(keptOut.length, 0);
  const keptIn = actionsFor([employee({ active: false, employmentStatus: "resigned", exitDay: "2026-11-02" })], [member()], [{ decision: "keep_in", hrId: "T-1", id: "e", reason: "Agreed" }]);
  assert.equal(keptIn.length, 0);
}

function testFamilyFollowTheirEmployee() {
  const spouse = member({ certificateNumber: "1", hrId: "T-1", id: "m-2", memberType: "spouse", name: "Test Spouse", principalMemberId: "m-1" });
  const leaving = actionsFor([employee({ active: false, employmentStatus: "resigned", exitDay: "2026-11-02" })], [member(), spouse]);
  assert.equal(leaving.length, 1, "family leave with their employee, on the employee's line");
  assert.equal(leaving[0].dependants, 1);

  const stranded = actionsFor([employee({ active: false, employmentStatus: "resigned", exitDay: "2026-11-02" })], [member({ coverageEnd: "2026-11-02" }), spouse], [], "2026-11-04");
  const row = stranded.find((action) => action.memberId === "m-2");
  assert.ok(row, "a family row left open under an ended certificate is listed");
  assert.equal(row.kind, "remove");
  assert.equal(row.memberType, "spouse");
}

function plan(employees: EmployeeFacts[], members: MemberFacts[]) {
  return buildMedicalInsurancePlan({ employees, exceptions: [], members, period: PERIOD, policy: POLICY, rateCard: RATE_CARD });
}

function billedRow(certificate: string, name: string, totals: Record<MedicalInsuranceProduct, number>): ParsedInvoiceMember {
  return {
    birthDate: null,
    certificate,
    lines: MEDICAL_INSURANCE_PRODUCTS.map((product) => ({
      adjustment: 0,
      coverType: "MEM" as const,
      dependantCount: null,
      plan: "003",
      premium: totals[product],
      product,
      volume: 0,
    })),
    name,
    statedTotal: null,
  };
}

function parsedInvoice(members: ParsedInvoiceMember[]): ParsedInvoice {
  return {
    billNumber: "TEST-1",
    feesTotal: 0,
    issuedOn: "2026-11-03",
    members,
    periodEnd: PERIOD.end,
    periodStart: PERIOD.start,
    policyNumber: null,
    premiumTotal: 0,
    problems: [],
    products: [],
    subOffice: null,
    totalDue: 0,
  };
}

function testEveryComparisonStandingIsReached() {
  const fullPrice = { AD: 29, CMM: 1907, GTL: 112, PPDA: 9.5, PTD: 14 };
  const employees = [
    employee(),
    employee({ hrId: "T-2", name: "Differs Person" }),
    employee({ active: false, employmentStatus: "resigned", exitDay: "2026-10-01", hrId: "T-3", name: "Gone Person" }),
    employee({ hrId: "T-4", name: "Unbilled Person" }),
  ];
  const members = [
    member(),
    member({ certificateNumber: "2", hrId: "T-2", id: "m-2", name: "Differs Person" }),
    member({ certificateNumber: "3", hrId: "T-3", id: "m-3", name: "Gone Person" }),
    member({ certificateNumber: "4", hrId: "T-4", id: "m-4", name: "Unbilled Person" }),
  ];
  const comparison = compareInvoiceToPlan(
    parsedInvoice([
      billedRow("1", "Test Person", fullPrice),
      billedRow("2", "Differs Person", { ...fullPrice, CMM: 5365.25 }),
      billedRow("3", "Gone Person", fullPrice),
      billedRow("9", "Stranger", fullPrice),
    ]),
    plan(employees, members),
  );
  const byName = new Map(comparison.rows.map((row) => [row.name, row]));
  assert.equal(byName.get("Test Person")?.status, "match");
  assert.equal(byName.get("Differs Person")?.status, "differs");
  assert.equal(byName.get("Differs Person")?.difference, 3458.25);
  assert.equal(byName.get("Gone Person")?.status, "billed_not_planned", "left before the period, and billed for it");
  assert.equal(byName.get("Stranger")?.status, "billed_not_planned");
  assert.equal(byName.get("Unbilled Person")?.status, "planned_not_billed");
  assert.ok(comparison.overBilled >= 3458.25, "over-billing is summed");
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
  assert.equal((permissionMatrix["Super Admin"] as Record<string, readonly string[]>)[invoices].includes("delete"), false, "an invoice is a fact about a date");

  const page = readFileSync("app/(admin)/medical-insurance/page.tsx", "utf8");
  assert.match(page, /if \(view && holdsInvoices\) money = await getMedicalInsuranceMoney\(\)/, "money is read only after the check");

  const view = readFileSync("src/lib/medical-insurance/view.ts", "utf8");
  const seatShape = view.slice(view.indexOf("export type MedicalInsuranceView"), view.indexOf("export type MedicalInsuranceInvoiceRow"));
  assert.doesNotMatch(seatShape, /total|premium|cost|statement|egp/i, "the seats' shape carries no amount");
}

const BILL_TEXT = [
  "BILL NO : TEST1-C611-01-00-001",
  "ISSUE DATE : 03/11/2026",
  "PREMIUM STATEMENT",
  "CMM - MEDICAL 01/11/2026 TO 31/01/2027",
  "003 MEM 2 1,907.00 3,814.00",
  "PREMIUM : 3,814.00",
  "SUPERVISORY & SERVICE FEES : 20.98",
  "PROPORTIONAL STAMP DUTY : 38.14",
  "PRODUCT TOTAL EGP 3,873.12",
  "TOTAL DUE FOR PRODUCT EGP 3,873.12",
  "PREMIUM DETAIL REPORT",
  "First Person 01/01/2024 M 11 01/01/1990 CMAJO 003 MEM 100,000 0.00 1,907.00",
  "MEMBER TOTAL : 0.00 1,907.00",
  "Second Person 01/01/2024 F 22 01/01/1991 CMAJO 003 MEM 100,000 0.00 1,000.00",
  // The same certificate's heading, reprinted where its lines cross a page.
  "Second Person 01/01/2024 F 22 01/01/1991 CMAJO 003 SPO 100,000 0.00 907.00",
  "MEMBER TOTAL : 0.00 1,907.00",
  "TOTAL DUE : 0.00 3,814.00",
].join("\n");

function testThePdfTextReadsOrSaysWhatItCouldNotRead() {
  const clean = parseMedicalInsuranceInvoice(BILL_TEXT);
  assert.equal(clean.billNumber, "TEST1-C611-01-00-001");
  assert.equal(clean.periodStart, "2026-11-01");
  assert.equal(clean.periodEnd, "2027-01-31");
  assert.deepEqual(clean.members.map((row) => row.certificate), ["11", "22"], "a reprinted heading is one person, not two");
  assert.equal(clean.members[1].lines.length, 2);
  assert.deepEqual(clean.problems, []);

  assert.equal(parseInvoiceAmount("1,234.50-"), -1234.5, "the billing system prints a credit with a trailing minus");
  assert.equal(parseInvoiceAmount("1,234.50"), 1234.5);
  assert.equal(parseInvoiceAmount("not money"), null);

  const unread = parseMedicalInsuranceInvoice(BILL_TEXT.replace("MEMBER TOTAL : 0.00 1,907.00", "Garbled CMAJO 003 MEM smudged line\nMEMBER TOTAL : 0.00 1,907.00"));
  assert.ok(unread.problems.some((problem) => problem.startsWith("A premium line could not be read")), "a line it cannot read is said out loud, never dropped");

  const wrong = parseMedicalInsuranceInvoice(BILL_TEXT.replace("MEMBER TOTAL : 0.00 1,907.00", "MEMBER TOTAL : 0.00 1,900.00"));
  assert.ok(wrong.problems.some((problem) => problem.includes("Certificate 11")), "lines that disagree with the printed total are named");

  assert.throws(() => parseMedicalInsuranceInvoice("A letter about something else"), /Nothing was saved/);
}

/** The EDI file is the insurer's own workbook with the ticked people on it, and the blank copy carries nobody. */
async function testTheEdiFileIsTheInsurersOwnWorkbook() {
  const template = readFileSync(METLIFE_EDI_TEMPLATE_PATH);
  const templateText = Buffer.from(template).toString("latin1");
  assert.ok(templateText.startsWith("PK"), "the template is an xlsx");
  const blank = new ExcelJS.Workbook();
  await blank.xlsx.load(template as unknown as ArrayBuffer);
  const sheetNames = blank.worksheets.map((sheet) => sheet.name);
  assert.deepEqual(sheetNames, ["Additions", "Bank account details ", "Deletions", "Salary Changes", "Subgroup-Suboff-Class Changes"], "the insurer's five sheets, in their order");
  for (const sheet of blank.worksheets) {
    sheet.eachRow((row) => row.eachCell((cell) => {
      const value = String(cell.value ?? "");
      assert.doesNotMatch(value, /\b[23]\d{13}\b|@[\w-]+\./, `the blank template carries no ID or email (${sheet.name}!${cell.address})`);
    }));
  }
  assert.equal(blank.getWorksheet("Additions")?.getCell("A11").value ?? null, null, "no person is left on the template's Additions sheet");

  const additionsFile = await buildMetLifeEdiWorkbook({
    kind: "additions",
    rows: [
      {
        birthDate: "1990-01-02",
        category: "B",
        coverageStartsOn: "2026-11-08",
        email: "test.person@example.com",
        fullName: "Test Middle Person Last",
        gender: "male",
        hireDate: "2026-11-08",
        hrId: "T-1",
        mobileNumber: "01000000000",
        nationalId: "29001020100013",
      },
    ],
  });
  const additions = new ExcelJS.Workbook();
  await additions.xlsx.load(additionsFile);
  const styles = (await (await JSZip.loadAsync(additionsFile)).file("xl/styles.xml")?.async("string")) ?? "";
  const fonts = [...(/<fonts[^>]*>([\s\S]*?)<\/fonts>/.exec(styles)?.[1] ?? "").matchAll(/<font\b[^>]*?(?:\/>|>([\s\S]*?)<\/font>)/g)].map((match) => match[1] ?? "");
  const normalFont = Number(/<cellXfs[^>]*>\s*<xf [^>]*?fontId="(\d+)"/.exec(styles)?.[1]);
  assert.equal(normalFont, 0, "a blank cell reads the first font slot, as the insurer's file has it");
  assert.match(fonts[normalFont] ?? "", /<sz val="10"\/><name val="Arial"\/>/, "a blank cell keeps the insurer's Arial 10, not the library's Calibri");
  assert.deepEqual(additions.worksheets.map((sheet) => sheet.name), sheetNames, "every sheet of theirs travels with the file");
  const sheet = additions.getWorksheet("Additions");
  assert.ok(sheet);
  assert.equal(sheet.getCell("A8").value, "Dep. Type (M/S/C)", "their heading stays where it was");
  const cell = (address: string) => {
    const value = sheet.getCell(address).value;
    return value && typeof value === "object" && "result" in value ? value.result : value;
  };
  assert.deepEqual(["A11", "B11", "C11", "D11", "E11", "F11", "G11", "I11"].map(cell), ["M", "T-1", "Test", "Middle", "Person Last", "29001020100013", "2026-11-08", "B"]);
  assert.deepEqual(["J11", "K11", "L11", "M11"].map(cell), [2, 1, 1990, "M"], "birth day, month, year and sex as their formulas read the ID");
  assert.match(String((sheet.getCell("J11").value as { formula?: string }).formula), /MID\(F11,6,2\)/, "the day stays their formula on column F");
  assert.deepEqual(["Q11", "R11", "S11", "T11", "U11", "V11", "W11"].map(cell), [8, 11, 2026, "E-card", "Egyptian", "01000000000", "test.person@example.com"]);
  assert.equal(cell("A12"), null, "one ticked person, one line");

  const lines = Array.from({ length: 12 }, (_, index) => ({ certificateNumber: String(index + 1), coverageEndsOn: "2026-11-02", memberType: "employee" as const, name: `Leaver ${index + 1}` }));
  const deletions = new ExcelJS.Workbook();
  await deletions.xlsx.load(await buildMetLifeEdiWorkbook({ kind: "deletions", rows: lines }));
  const gone = deletions.getWorksheet("Deletions");
  assert.ok(gone);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((column) => gone.getCell(8, column).value), ["M", 1, "Leaver 1", 2, 11, 2026], "a certificate is a number, and the day is split as their columns are");
  assert.equal(gone.getCell(19, 3).value, "Leaver 12", "twelve lines run past the template's ten");
  assert.equal(gone.getCell(20, 3).value, "M- Member, S- Spouse, C- Child", "and push the form's own notes down rather than over them");
  assert.equal(deletions.getWorksheet("Additions")?.getCell("A11").value ?? null, null, "a deletions file adds nobody");
}

function testNothingHereSendsOrPays() {
  for (const file of ["src/lib/medical-insurance/service.ts", "src/lib/medical-insurance/workbooks.ts", "src/lib/medical-insurance/compare.ts"]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /from "@\/lib\/email|sendEmail|resend|from "@\/lib\/payroll/i, `${file} must not send mail or reach payroll`);
  }
}

export async function runMedicalInsuranceTests() {
  testTheFirstBillIsReproducedToThePiastre();
  testPartOfAPeriodIsChargedByTheDay();
  testEveryoneBelongsFromDayOneAndTheRecordDecidesTheEnd();
  testTheListNamesWhoToAddAndWhoToRemove();
  testAnExceptionBeatsTheRuleEitherWay();
  testFamilyFollowTheirEmployee();
  testEveryComparisonStandingIsReached();
  testThePdfTextReadsOrSaysWhatItCouldNotRead();
  await testTheEdiFileIsTheInsurersOwnWorkbook();
  testASeatNeverHoldsAnAmount();
  testNothingHereSendsOrPays();
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("tests/medical-insurance.test.ts")) {
  await runMedicalInsuranceTests();
  console.log("medical-insurance: pass");
}
