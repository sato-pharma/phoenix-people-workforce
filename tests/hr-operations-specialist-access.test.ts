import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { isSalaryBlindRole } from "../src/lib/auth/hr-functions.ts";
import { canPrintBusinessCards } from "../src/lib/business-cards/access.ts";
import {
  assertAttendanceMonthlySummaryPermission,
  assertAttendanceSetupPermission,
  canAccess,
  canAccessAttendanceMonthlySummary,
  canAccessAttendanceSetup,
  canAccessFingerprintReport,
  isHiringPaperworkRole,
  isHrAuthorityRole,
  permissionMatrix,
  scopeForRole,
  type AccessContext,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import {
  canViewEmployeeAttendanceReport,
  isSelfOnlyAttendanceViewer,
} from "../src/lib/attendance/employee-attendance.ts";
import {
  isPaperOpenToRole,
  SEAT_PRINTABLE_DOCUMENTS,
  seatPapersFor,
} from "../src/lib/hiring-pack/document-registry.ts";
import { COMPANY_DETAILS_DEFAULT } from "../src/lib/hiring-pack/company-details.ts";
import { buildManualHiringPack } from "../src/lib/hiring-pack/manual-pack.ts";
import {
  assertMayPrintPaper,
  assertMaySaveEmployeeFacts,
  assertMayUseHrForms,
  factsInputForViewer,
  hrFormsAccessFor,
  isSeatPaperViewer,
  packForViewer,
  paperIssuesForViewer,
  profileInputForViewer,
} from "../src/lib/hiring-pack/paper-access.ts";
import { renderContractNonRenewalHtml } from "../src/lib/hiring-pack/render-renewal.ts";
import {
  HIRING_CONTRACT_TERM_FIELDS,
  HIRING_PACK_DOCUMENTS,
  type HiringPackData,
  type HiringPackEmployeeFactsInput,
} from "../src/lib/hiring-pack/types.ts";
import {
  filterHiringDocumentsForAccess,
  mayEditHiringChecklist,
  mayRemoveHiringDocumentFile,
  removeHiringDocumentFile,
} from "../src/lib/hiring-documents/service.ts";
import type { HiringDocumentsDashboardData } from "../src/lib/hiring-documents/types.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE HR OPERATIONS SPECIALIST SEAT (`HR Administration`) — what the owner gave her on 2026-10-20,
 * and what he withheld, held at the gates rather than on her screen.
 *
 *   1. ATTENDANCE. She reviews attendance ONLY through her own Daily & Weekly Reports. She holds
 *      employees:read/update for the Employee Master, and that key used to carry her into the
 *      company Fingerprint Report, the Monthly Summary (both price a day in EGP), Attendance Setup
 *      and the machine sync. Each is now refused to her by name, while every other holder of the
 *      key keeps exactly what it had. Another employee's attendance report is closed to her too.
 *
 *   2. HIRING PAPERS AND HR FORMS (owner, 2026-11-02, reversing the eight-paper limit of 2026-10-20:
 *      "Receive the hiring papers / OPEN HR FORMS FULL MODULE TO AYA"). She holds employee_documents,
 *      works every paper and sees and prints the salary and the contract terms there, but changes
 *      neither ("lock contract terms for aya, she only prints them"), and the checklist itself and
 *      the removal of a scan stay with the seats that held them. She stays salary-blind everywhere
 *      else (tests/salary-blind-seat.test.ts) and stays outside hrAuthorityRoles, so recruitment,
 *      offers, candidates and Business Cards stay shut.
 *
 * The predicates are CALLED for her and for the seats around her, never read; the source pins at
 * the end only prove each route still goes through the helper the calls exercise.
 */

const SEAT = "HR Administration" as PhoenixRole;
const HR_OPERATIONS = "HR Operations" as PhoenixRole;
const SUPER_ADMIN = "Super Admin" as PhoenixRole;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function accessFor(role: PhoenixRole, hrId = "HR-SEAT-TEST"): AccessContext {
  return { role, scope: scopeForRole(role), hrId, source: "session" } as AccessContext;
}

function code(relative: string): string {
  return stripComments(readFileSync(path.join(REPO_ROOT, relative), "utf8"));
}

async function rejectsForbidden(run: () => Promise<unknown>, message: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => error instanceof Error && /^Forbidden:/.test(error.message), message);
}

async function testAttendanceIsClosedToHer() {
  assert.equal(isSalaryBlindRole(SEAT), true, "the HR Operations Specialist is the salary-blind seat");
  assert.equal(isSalaryBlindRole(HR_OPERATIONS), false, "HR Operations is not salary-blind");

  // Load-bearing, not decoration: she HOLDS the key every one of these pages used to open on, so the
  // by-name refusal is the only thing between her and an EGP figure.
  const held = (permissionMatrix as unknown as Record<string, Record<string, readonly string[] | undefined>>)[SEAT];
  assert.ok(held?.employees?.includes("read"), "the seat holds employees:read (the Employee Master)");

  const seat = accessFor(SEAT);
  assert.equal(await canAccessFingerprintReport(seat), false, "the company Fingerprint Report prices every late minute in EGP");
  assert.equal(await canAccessAttendanceSetup(seat, "read"), false, "Attendance Setup holds the deduction policies");
  assert.equal(await canAccessAttendanceSetup(seat, "update"), false, "nor may she change the setup or start a machine sync");
  assert.equal(await canAccessAttendanceMonthlySummary(seat), false, "the Monthly Summary carries every employee's deduction value");
  await rejectsForbidden(() => assertAttendanceMonthlySummaryPermission(seat), "the Monthly Summary export refuses her");
  await rejectsForbidden(() => assertAttendanceSetupPermission(seat, "update"), "sync-now and the agent start refuse her");

  // Everyone else is untouched: each predicate still answers exactly what the key answers.
  for (const role of [HR_OPERATIONS, SUPER_ADMIN]) {
    const access = accessFor(role);
    const read = await canAccess(access, "employees", "read");
    const update = await canAccess(access, "employees", "update");
    assert.equal(await canAccessFingerprintReport(access), read, `${role}: Fingerprint Report unchanged`);
    assert.equal(await canAccessAttendanceSetup(access, "read"), read, `${role}: Attendance Setup read unchanged`);
    assert.equal(await canAccessAttendanceSetup(access, "update"), update, `${role}: Attendance Setup update unchanged`);
    assert.equal(await canAccessAttendanceMonthlySummary(access), read, `${role}: Monthly Summary unchanged`);
  }
  // The control: a refusal for everyone would satisfy every line above.
  assert.equal(await canAccessAttendanceMonthlySummary(accessFor(SUPER_ADMIN)), true, "the Super Admin still opens the Monthly Summary");
  assert.equal(await canAccessFingerprintReport(accessFor("CEO" as PhoenixRole)), true, "the CEO's route-scoped exception still holds");
}

function testHerAttendanceReportIsHerOwn() {
  const me = "B-9001";
  const seat = accessFor(SEAT, me);
  assert.equal(isSelfOnlyAttendanceViewer(seat), true, "she is a self-only attendance viewer");
  assert.equal(canViewEmployeeAttendanceReport(seat, { hrId: me, managerHrId: null }), true, "her own report stays hers");
  assert.equal(
    canViewEmployeeAttendanceReport(seat, { hrId: "B-9002", managerHrId: me }),
    false,
    "not even somebody placed under her — the manager fallback would have opened it",
  );
  assert.equal(canViewEmployeeAttendanceReport(seat, { hrId: "B-9003", managerHrId: "B-1" }), false, "nor anybody else's");

  const operations = accessFor(HR_OPERATIONS, "B-9004");
  assert.equal(isSelfOnlyAttendanceViewer(operations), false, "HR Operations is not self-only");
  assert.equal(
    canViewEmployeeAttendanceReport(operations, { hrId: "B-9003", managerHrId: "B-1" }),
    true,
    "HR Operations keeps the one-person view she approves leave with",
  );
}

async function testSheHoldsTheHiringPapersGrantAndNothingBesideIt() {
  const seat = accessFor(SEAT);
  for (const action of ["read", "create", "update", "export"] as const) {
    assert.equal(await canAccess(seat, "employee_documents", action), true, `she holds employee_documents:${action}`);
  }
  for (const action of ["delete", "approve", "import"] as const) {
    assert.equal(await canAccess(seat, "employee_documents", action), false, `she does not hold employee_documents:${action}`);
  }

  assert.equal(isHiringPaperworkRole(SEAT), true, "the pages admit her");
  assert.equal(isHrAuthorityRole(SEAT), false, "and she stays outside hrAuthorityRoles");
  for (const resource of ["recruitment", "candidates", "offers", "cv_lookup", "account_activation"] as const) {
    assert.equal(await canAccess(seat, resource, "read"), false, `${resource} stays shut: he did not name it`);
  }
  assert.equal(await canPrintBusinessCards(seat), false, "Business Cards stays shut: he did not name it");

  // The control: a seat outside both lists is still refused, and HR Operations keeps what she had.
  assert.equal(isHiringPaperworkRole("Employee" as PhoenixRole), false, "an employee is not admitted");
  assert.equal(await canAccess(accessFor("Employee" as PhoenixRole), "employee_documents", "read"), false);
  assert.equal(isHiringPaperworkRole(HR_OPERATIONS), true);
  assert.equal(await canPrintBusinessCards(accessFor(HR_OPERATIONS)), true, "HR Operations still prints cards");

  // The whole board, not the self-only default.
  const board = {
    documents: [],
    employees: [
      { documents: {}, employmentStatus: "active", fullName: "One", hireDate: null, hrId: "B-9101", jobTitle: null, lineName: null, managerHrId: "B-1", managerName: null, notes: null },
      { documents: {}, employmentStatus: "active", fullName: "Two", hireDate: null, hrId: "B-9102", jobTitle: null, lineName: null, managerHrId: "B-2", managerName: null, notes: null },
    ],
    summary: { completeDocuments: 0, dueDocuments: 0, employees: 2, missingDocuments: 0, pendingDocuments: 0, scannedDocuments: 0, submittedDocuments: 0, totalDocumentSlots: 0 },
  } as unknown as HiringDocumentsDashboardData;
  assert.equal(filterHiringDocumentsForAccess(board, accessFor(SEAT, "B-9000")).employees.length, 2, "she receives every joiner's papers");
  assert.equal(
    filterHiringDocumentsForAccess(board, accessFor("HR Resourcing" as PhoenixRole, "B-9000")).employees.length,
    0,
    "the control: another seat outside the bypass still gets its own row only",
  );

  // She receives papers; what the checklist asks of everybody stays with the seats that held it.
  assert.equal(mayEditHiringChecklist(seat), false, "she does not change the checklist");
  assert.equal(mayEditHiringChecklist(accessFor(HR_OPERATIONS)), true, "HR Operations still does");
  // Removing a scan is permanent and its route asks only :update, so the service refuses her itself.
  // The call never reaches the database: the refusal is its first line.
  assert.equal(mayRemoveHiringDocumentFile(seat), false, "she does not remove a file on record");
  assert.equal(mayRemoveHiringDocumentFile(accessFor(HR_OPERATIONS)), true, "HR Operations still does");
  await rejectsForbidden(() => removeHiringDocumentFile(seat, "any-file"), "the service refuses her before it reads anything");
  for (const page of ["app/(admin)/hiring-documents/page.tsx", "app/employee-portals/hiring-documents/page.tsx"]) {
    assert.ok(code(page).includes("canManage && mayRemoveHiringDocumentFile(access)"), `${page} hides the remove button from her`);
  }
  const service = code("src/lib/hiring-documents/service.ts");
  for (const fn of ["createHiringDocumentDefinition", "deleteHiringDocumentDefinition"]) {
    const body = service.slice(service.indexOf(`export async function ${fn}(`));
    assert.ok(
      body.slice(0, body.indexOf("\n}\n")).includes("assertMayEditHiringChecklist(access)"),
      `${fn} refuses her itself`,
    );
  }
  for (const page of ["app/(admin)/hiring-documents/page.tsx", "app/employee-portals/hiring-documents/page.tsx"]) {
    const source = code(page);
    assert.ok(source.includes("isHiringPaperworkRole(access.role)"), `${page} admits her`);
    assert.ok(source.includes("canManage && mayEditHiringChecklist(access)"), `${page} hides the checklist control from her`);
  }
  assert.ok(code("app/api/hiring-documents/export/route.ts").includes("isHiringPaperworkRole(access.role)"), "the export matches the page");
}

async function testHrFormsIsTheFullModuleForHer() {
  const seat = accessFor(SEAT);
  assert.deepEqual(SEAT_PRINTABLE_DOCUMENTS, {}, "no seat is limited to a list of papers today");
  assert.equal(seatPapersFor(SEAT), null, "she is not limited by the table");
  assert.equal(isSeatPaperViewer(seat), false, "employee_documents decides for her");

  assert.ok(HIRING_PACK_DOCUMENTS.length >= 30, `only ${HIRING_PACK_DOCUMENTS.length} papers: the list did not load`);
  for (const paper of HIRING_PACK_DOCUMENTS) {
    assert.equal(isPaperOpenToRole(SEAT, paper), true, `${paper} is open to her`);
    await assertMayPrintPaper(seat, paper, "read");
    await assertMayPrintPaper(seat, paper, "update");
  }
  assert.equal(isPaperOpenToRole(SEAT, "custom:00000000-0000-0000-0000-000000000000"), true, "and the company templates");
  await assertMayPrintPaper(seat, "custom:00000000-0000-0000-0000-000000000000", "read");

  const forms = await hrFormsAccessFor(seat);
  assert.deepEqual(
    forms,
    { canManage: true, canRead: true, contractTermsReadOnly: true, paperScope: null, salaryReadOnly: true },
    "the whole screen, with the salary and the contract terms locked",
  );
  await assertMayUseHrForms(seat, "read");
  await assertMayUseHrForms(seat, "update");
  await assertMaySaveEmployeeFacts(seat);

  const operations = await hrFormsAccessFor(accessFor(HR_OPERATIONS));
  assert.deepEqual(
    operations,
    { canManage: true, canRead: true, contractTermsReadOnly: false, paperScope: null, salaryReadOnly: false },
    "HR Operations is unchanged",
  );

  // The control: a seat that holds no employee_documents is refused the same doors.
  const outsider = accessFor("Employee" as PhoenixRole);
  assert.equal((await hrFormsAccessFor(outsider)).canRead, false, "an employee does not open HR Forms");
  await rejectsForbidden(() => assertMayUseHrForms(outsider, "read"), "and is refused by the routes");
  await rejectsForbidden(() => assertMayPrintPaper(outsider, "contract", "read"), "and refused a paper");
}

function testSheSeesTheSalaryOnHrFormsAndCannotChangeIt() {
  const pack = {
    employee: { fullName: "Test Person", baseSalary: 9000, grossSalary: 11610, socialInsuranceWage: 9000 },
    gaps: [{ field: "nationalId", labelEn: "National ID", labelAr: "", documents: ["contract", "form1"] }],
  } as unknown as HiringPackData;
  assert.equal(packForViewer(accessFor(SEAT), pack), pack, "the pack reaches her whole: the same object, figures included");

  const sent = { fullName: "Test Person", baseSalary: 5000 } as HiringPackEmployeeFactsInput;
  const kept = factsInputForViewer(accessFor(SEAT), sent);
  assert.equal("baseSalary" in kept, false, "a salary she sends is dropped, so the one on record is kept");
  assert.equal(kept.fullName, "Test Person", "everything else she sends is saved");
  assert.equal(factsInputForViewer(accessFor(HR_OPERATIONS), sent), sent, "HR Operations still sets the salary");

  const issues = [{ document: "contract" }, { document: "resignation" }, { document: "custom:1" }];
  assert.equal(paperIssuesForViewer(accessFor(SEAT), issues).length, 3, "the register shows her every paper's rows");

  // A paper she prints carries the figure, drawn from the same pack as for HR Operations.
  const manual = buildManualHiringPack(
    {
      "employee.baseSalary": "18000",
      "employee.hireDate": "2023-03-01",
      "employee.hrId": "T-1",
      "employee.nameAr": "شخص عيّنة",
      "employee.nationalId": "29001011234567",
    },
    COMPANY_DETAILS_DEFAULT,
  );
  const html = renderContractNonRenewalHtml(packForViewer(accessFor(SEAT), manual), 1, null, [
    {
      align: "right",
      anchor: { dx: 12, dy: 12, selector: ".copy" },
      defaultKey: null,
      document: "contractNonRenewal",
      h: 14,
      hidden: false,
      id: "placed-SALARY_FIGURES",
      page: null,
      size: 11,
      source: { key: "SALARY_FIGURES", kind: "value" },
      templateVersionId: "test-version",
      updatedAt: "2026-11-02T08:00:00Z",
      updatedByHrId: "B-10",
      w: 160,
      x: 0,
      y: 0,
    },
  ]);
  assert.ok(html.includes("18,000"), "a salary field placed on a paper prints the figure for her");

  // Contract terms: she prints them and does not change them (owner, 2026-11-02). The save writes
  // every column, so every term goes back to what is on record and nothing else she sent is lost.
  const onRecord = {
    contractDurationMonths: 12,
    contractEndDate: "2027-01-01",
    contractObjectiveReasonCode: "project",
    contractSignatoryNameAr: "اسم",
    contractSignatoryTitleAr: "صفة",
    contractStartDate: "2026-01-01",
    nationality: "old",
    trainingBondMonths: 6,
    underperformanceMonths: 3,
    underperformanceThresholdPct: 70,
  };
  const profileSent = {
    contractDurationMonths: 99,
    contractEndDate: "2099-01-01",
    contractObjectiveReasonCode: "other",
    contractSignatoryNameAr: "x",
    contractSignatoryTitleAr: "x",
    contractStartDate: "2099-01-01",
    nationality: "new",
    trainingBondMonths: 99,
    underperformanceMonths: 99,
    underperformanceThresholdPct: 1,
  };
  assert.deepEqual(
    profileInputForViewer(accessFor(SEAT), profileSent, onRecord),
    { ...onRecord, nationality: "new" },
    "every term stays as on record, and the rest of the profile saves",
  );
  assert.deepEqual(
    profileInputForViewer(accessFor(SEAT), { nationality: "new" }, {}),
    { ...Object.fromEntries(HIRING_CONTRACT_TERM_FIELDS.map((field) => [field, null])), nationality: "new" },
    "a term never on record stays empty",
  );
  assert.equal(profileInputForViewer(accessFor(HR_OPERATIONS), profileSent, onRecord), profileSent, "HR Operations still changes them");

  // She stays salary-blind outside this module: the seat rule itself is untouched.
  assert.equal(isSalaryBlindRole(SEAT), true, "still the salary-blind seat everywhere else");
}

function testEveryDoorGoesThroughTheHelpers() {
  const render = code("src/lib/hiring-pack/render-paper.ts");
  assert.ok(render.includes("isPaperOpenToRole(access.role, requested)"), "renderHiringPaper still refuses a paper a listed seat does not print");
  assert.ok(!render.includes("packForPaper"), "no paper is drawn from a blanked pack any more");

  for (const route of [
    "app/api/hiring-pack/[hrId]/route.ts",
    "app/api/hiring-pack/[hrId]/print/route.ts",
    "app/api/hiring-pack/[hrId]/offboarding/route.ts",
    "app/api/hiring-pack/[hrId]/sign/route.ts",
    "app/api/hiring-pack/manual/route.ts",
    "app/api/hiring-pack/paper-register/route.ts",
  ]) {
    assert.ok(code(route).includes("assertMayUseHrForms(access"), `${route} admits through assertMayUseHrForms`);
  }
  const profileRoute = code("app/api/hiring-pack/[hrId]/route.ts");
  assert.ok(
    /const input = areContractTermsReadOnly\(access\)\s*\? profileInputForViewer\(access, payload,[\s\S]{0,120}saveHiringPackProfile\(hrId, input,/.test(profileRoute),
    "the profile save goes through the contract-term lock",
  );
  const termKeys = [...code("src/components/hiring-pack/hiring-pack-manager.tsx")
    .slice(0, code("src/components/hiring-pack/hiring-pack-manager.tsx").indexOf("const NUMBER_KEYS"))
    .split("const TERM_FIELDS")[1]
    .matchAll(/key: "(\w+)"/g)].map((match) => match[1]);
  assert.deepEqual(
    [...termKeys].sort(),
    [...HIRING_CONTRACT_TERM_FIELDS].sort(),
    "a new box under Contract terms must join the locked list",
  );
  assert.ok(
    code("src/components/hiring-pack/hiring-pack-manager.tsx").includes("disabled={!canManage || contractTermsReadOnly}"),
    "the contract term boxes are read only for her",
  );
  const editor = code("src/components/hiring-pack/paper-editor.tsx");
  assert.ok(
    editor.includes('(contractTermsReadOnly && binding.store === "profile" && isContractTermField(binding.field))'),
    "a contract term on a paper shows locked",
  );
  assert.ok(editor.includes('element.setAttribute("contenteditable", "false")'), "and holds under Type anywhere");
  for (const page of ["app/(admin)/hiring-pack/page.tsx", "app/employee-portals/hiring-pack/page.tsx"]) {
    assert.ok(code(page).includes("contractTermsReadOnly={forms.contractTermsReadOnly}"), `${page} locks the terms on her screen`);
  }

  const facts = code("app/api/hiring-pack/[hrId]/facts/route.ts");
  assert.ok(facts.includes("assertMaySaveEmployeeFacts(access)"), "the facts save still needs employees:update for her");
  assert.ok(facts.includes("factsInputForViewer(access"), "and drops a salary she sends");

  for (const page of ["app/(admin)/hiring-pack/page.tsx", "app/employee-portals/hiring-pack/page.tsx"]) {
    const source = code(page);
    assert.ok(source.includes("hrFormsAccessFor(access)"), `${page} gates on hrFormsAccessFor`);
    assert.ok(source.includes("salaryReadOnly={forms.salaryReadOnly}"), `${page} tells the screen to lock her salary box`);
  }
  const manager = code("src/components/hiring-pack/hiring-pack-manager.tsx");
  assert.ok(
    /disabled=\{!canManage \|\| employee\.departed \|\| salaryReadOnly\}\s*id="hiring-pack-fact-baseSalary"/.test(manager),
    "the base salary box is read only for her",
  );
  assert.ok(
    code("src/components/hiring-pack/paper-editor.tsx").includes(
      '(salaryReadOnly && binding.store === "employee" && binding.field === "baseSalary")',
    ),
    "and the salary on a paper shows locked",
  );

  const summaryPage = code("app/(admin)/attendance/monthly-summary/page.tsx");
  assert.ok(summaryPage.includes("canAccessAttendanceMonthlySummary(access)"), "the Monthly Summary page refuses her");
  const summaryExport = code("app/api/attendance/monthly-summary/export/route.ts");
  assert.ok(summaryExport.includes("assertAttendanceMonthlySummaryPermission(access)"), "and its export");
  for (const route of ["app/api/attendance/sync-now/route.ts", "app/api/attendance/agent/start/route.ts"]) {
    assert.ok(
      code(route).includes('assertAttendanceSetupPermission(access, "update")'),
      `${route} is Attendance Setup and refuses her`,
    );
  }
}

export async function runHrOperationsSpecialistAccessTests() {
  await testAttendanceIsClosedToHer();
  testHerAttendanceReportIsHerOwn();
  await testSheHoldsTheHiringPapersGrantAndNothingBesideIt();
  await testHrFormsIsTheFullModuleForHer();
  testSheSeesTheSalaryOnHrFormsAndCannotChangeIt();
  testEveryDoorGoesThroughTheHelpers();
}
