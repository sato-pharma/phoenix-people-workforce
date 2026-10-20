import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { isSalaryBlindRole } from "../src/lib/auth/hr-functions.ts";
import {
  assertAttendanceMonthlySummaryPermission,
  assertAttendanceSetupPermission,
  canAccess,
  canAccessAttendanceMonthlySummary,
  canAccessAttendanceSetup,
  canAccessFingerprintReport,
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
import { buildFormsDrive, type DriveTemplate } from "../src/lib/hiring-pack/forms-drive.ts";
import {
  assertMayPrintPaper,
  assertMayUseHrForms,
  factsInputForViewer,
  hrFormsAccessFor,
  isSeatPaperViewer,
  packForViewer,
  paperIssuesForViewer,
} from "../src/lib/hiring-pack/paper-access.ts";
import {
  HIRING_PACK_DOCUMENTS,
  type HiringPackData,
  type HiringPackDocument,
  type HiringPackEmployeeFactsInput,
} from "../src/lib/hiring-pack/types.ts";
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
 *   2. HR FORMS. She prints eight papers and no others — the renewal pair and the leaving papers —
 *      never a company template, and she is SALARY-BLIND: the pack her browser receives carries no
 *      salary, gross or insurance wage, and a salary she sends is dropped. The renewal annex prints
 *      the salary from the server's own record, which is the owner's one money exception for her.
 *
 * The predicates are CALLED for her and for the seats around her, never read; the source pins at
 * the end only prove each route still goes through the helper the calls exercise.
 */

const SEAT = "HR Administration" as PhoenixRole;
const HR_OPERATIONS = "HR Operations" as PhoenixRole;
const SUPER_ADMIN = "Super Admin" as PhoenixRole;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/** The eight papers, as the owner listed them (six, then two more the same day). */
const HER_PAPERS: readonly HiringPackDocument[] = [
  "contractRenewal",
  "contractNonRenewal",
  "resignation",
  "clearanceEmployee",
  "clearanceCompany",
  "handoverRecord",
  "deemedResignation",
  "mutualTermination",
];

/** Which business grant each of her papers rides on — the access-control screen can take either away. */
const PAPER_GRANT: Readonly<Record<string, "contracts" | "resignations">> = {
  contractRenewal: "contracts",
  contractNonRenewal: "contracts",
  resignation: "resignations",
  mutualTermination: "resignations",
  deemedResignation: "resignations",
  clearanceEmployee: "resignations",
  clearanceCompany: "resignations",
  handoverRecord: "resignations",
};

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

async function testSheGetsHerEightPapersAndNoOther() {
  assert.deepEqual(
    [...(SEAT_PRINTABLE_DOCUMENTS[SEAT] ?? [])].sort(),
    [...HER_PAPERS].sort(),
    "her list is exactly the eight papers the owner gave her",
  );
  assert.deepEqual([...(seatPapersFor(SEAT) ?? [])].sort(), [...HER_PAPERS].sort());
  for (const role of [HR_OPERATIONS, SUPER_ADMIN, "CEO", null, undefined, ""]) {
    assert.equal(seatPapersFor(role), null, `${String(role)} is not limited by the table`);
  }
  for (const paper of HER_PAPERS) {
    assert.ok((HIRING_PACK_DOCUMENTS as readonly string[]).includes(paper), `${paper} is a built-in paper`);
    assert.ok(PAPER_GRANT[paper], `${paper} rides on a named grant`);
  }

  assert.equal(isSeatPaperViewer(accessFor(SEAT)), true);
  assert.equal(isSeatPaperViewer(accessFor(HR_OPERATIONS)), false);

  let refused = 0;
  for (const paper of HIRING_PACK_DOCUMENTS) {
    const hers = HER_PAPERS.includes(paper);
    assert.equal(isPaperOpenToRole(SEAT, paper), hers, `${paper}: open to her only if it is one of her eight`);
    assert.equal(isPaperOpenToRole(HR_OPERATIONS, paper), true, `${paper}: HR Operations unchanged`);
    if (!hers) refused += 1;
  }
  assert.ok(refused >= 25, `only ${refused} built-in papers were refused to her — the paper list did not load`);
  assert.equal(isPaperOpenToRole(SEAT, "custom:00000000-0000-0000-0000-000000000000"), false, "never a company template");
  assert.equal(isPaperOpenToRole(HR_OPERATIONS, "custom:00000000-0000-0000-0000-000000000000"), true);

  const seat = accessFor(SEAT);
  for (const paper of ["contract", "form1", "form6", "salaryLetterEn", "salaryLetterAr", "nda", "custom:abc"]) {
    await rejectsForbidden(() => assertMayPrintPaper(seat, paper, "read"), `${paper} is refused to her before any grant is read`);
    await rejectsForbidden(() => assertMayPrintPaper(seat, paper, "update"), `${paper} cannot be signed by her either`);
  }
  // Her own papers follow the grant they ride on — whatever the access-control screen says today.
  for (const paper of HER_PAPERS) {
    for (const action of ["read", "update"] as const) {
      const holds = await canAccess(seat, PAPER_GRANT[paper]!, action);
      const outcome = assertMayPrintPaper(seat, paper, action);
      if (holds) await outcome;
      else await rejectsForbidden(() => outcome, `${paper} ${action} follows ${PAPER_GRANT[paper]}:${action}`);
    }
  }

  const opens = (await canAccess(seat, "contracts", "read")) || (await canAccess(seat, "resignations", "read"));
  const forms = await hrFormsAccessFor(seat);
  assert.deepEqual([...(forms.paperScope ?? [])].sort(), [...HER_PAPERS].sort(), "the page shows her only her eight");
  assert.equal(forms.withholdSalary, true, "and no salary box");
  assert.equal(forms.canRead, opens, "she opens HR Forms on her contracts or resignations grant");
  if (opens) await assertMayUseHrForms(seat, "read");
  else await rejectsForbidden(() => assertMayUseHrForms(seat, "read"), "no grant, no HR Forms");

  const operations = await hrFormsAccessFor(accessFor(HR_OPERATIONS));
  assert.equal(operations.paperScope, null, "HR Operations keeps every paper");
  assert.equal(operations.withholdSalary, false, "and the salary boxes");
  const admin = await hrFormsAccessFor(accessFor(SUPER_ADMIN));
  assert.equal(admin.canRead, true, "the Super Admin still opens HR Forms");
  assert.equal(admin.paperScope, null);
  await assertMayPrintPaper(accessFor(SUPER_ADMIN), "contract", "read");
}

function testThePackReachesHerWithoutMoney() {
  const pack = {
    employee: { fullName: "Test Person", baseSalary: 9000, grossSalary: 11610, socialInsuranceWage: 9000 },
    gaps: [
      { field: "nationalId", labelEn: "National ID", labelAr: "", documents: ["contract", "form1"] },
      { field: "lastWorkingDate", labelEn: "Last day", labelAr: "", documents: ["contractRenewal", "contract"] },
      { field: "resignationDate", labelEn: "Resigned", labelAr: "", documents: ["resignation"] },
    ],
  } as unknown as HiringPackData;
  const before = JSON.stringify(pack);

  const hers = packForViewer(accessFor(SEAT), pack);
  assert.equal(hers.employee.baseSalary, null, "no base salary reaches her browser");
  assert.equal(hers.employee.grossSalary, null, "no gross");
  assert.equal(hers.employee.socialInsuranceWage, null, "no insurance wage");
  assert.equal(hers.employee.fullName, "Test Person", "everything else on the record stays");
  assert.deepEqual(
    hers.gaps.map((gap) => [gap.field, gap.documents]),
    [
      ["lastWorkingDate", ["contractRenewal"]],
      ["resignationDate", ["resignation"]],
    ],
    "the gap list keeps only her papers",
  );
  assert.equal(JSON.stringify(pack), before, "the shared pack is never edited in place");
  assert.equal(packForViewer(accessFor(HR_OPERATIONS), pack), pack, "HR Operations gets the pack untouched");

  const sent = { fullName: "Test Person", baseSalary: 5000 } as HiringPackEmployeeFactsInput;
  const kept = factsInputForViewer(accessFor(SEAT), sent);
  assert.equal("baseSalary" in kept, false, "a salary she sends is dropped, so the one on record is kept");
  assert.equal(kept.fullName, "Test Person");
  assert.equal(factsInputForViewer(accessFor(HR_OPERATIONS), sent), sent, "HR Operations still sets the salary");

  const issues = [{ document: "contract" }, { document: "resignation" }, { document: "custom:1" }];
  assert.deepEqual(paperIssuesForViewer(accessFor(SEAT), issues), [{ document: "resignation" }], "the register shows her own papers' rows");
  assert.equal(paperIssuesForViewer(accessFor(HR_OPERATIONS), issues).length, 3);
}

function testTheDriveHoldsHerPapersOnly() {
  const templates: DriveTemplate[] = [
    { id: "t-1", document: "custom:11111111-1111-1111-1111-111111111111", name: "Company paper", group: "other", status: "current" },
  ];
  const everything = buildFormsDrive(templates);
  assert.ok(
    everything.some((folder) => folder.entries.some((entry) => entry.versionId === "t-1")),
    "the control: without a scope the company template is filed",
  );

  const hers = buildFormsDrive(templates, HER_PAPERS);
  const shown = hers.flatMap((folder) => folder.entries.map((entry) => entry.document));
  assert.deepEqual([...shown].sort(), [...HER_PAPERS].sort(), "her drive holds her eight papers, each once");
  assert.ok(hers.every((folder) => folder.entries.length > 0), "no folder is left empty by the filter");
  assert.ok(!hers.some((folder) => folder.id === "company"), "no company-templates folder");
  assert.ok(hers.every((folder) => folder.entries.every((entry) => entry.versionId === null)), "built-in papers only");
}

function testEveryDoorGoesThroughTheHelpers() {
  const render = code("src/lib/hiring-pack/render-paper.ts");
  assert.ok(render.includes("isPaperOpenToRole(access.role, requested)"), "renderHiringPaper refuses her other papers itself");

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
  for (const route of [
    "app/api/hiring-pack/[hrId]/print/route.ts",
    "app/api/hiring-pack/[hrId]/sign/route.ts",
    "app/api/hiring-pack/manual/route.ts",
    "app/api/hiring-pack/paper-register/route.ts",
  ]) {
    assert.ok(code(route).includes("assertMayPrintPaper(access"), `${route} checks the one paper`);
  }
  const facts = code("app/api/hiring-pack/[hrId]/facts/route.ts");
  assert.ok(facts.includes("assertMaySaveEmployeeFacts(access)"), "the facts save needs employees:update for her too");
  assert.ok(facts.includes("factsInputForViewer(access"), "and drops a salary she sends");
  for (const route of [
    "app/api/hiring-pack/[hrId]/route.ts",
    "app/api/hiring-pack/[hrId]/facts/route.ts",
    "app/api/hiring-pack/[hrId]/offboarding/route.ts",
    "app/api/hiring-pack/[hrId]/sign/route.ts",
  ]) {
    assert.ok(code(route).includes("packForViewer(access"), `${route} returns the pack without money`);
  }

  // The doors that stay shut: the layout editor's fields, and the hiring profile (the contract's
  // own terms, which are his to change).
  const fields = code("app/api/hiring-pack/document-fields/route.ts");
  assert.ok(!fields.includes("assertMayUseHrForms"), "document-fields stays employee_documents only");
  const pack = code("app/api/hiring-pack/[hrId]/route.ts");
  const put = pack.slice(pack.indexOf("export async function PUT"));
  assert.ok(
    /assertPermission\(\s*access\s*,\s*"employee_documents"\s*,\s*"update"\s*\)/.test(put),
    "the hiring profile save stays employee_documents:update",
  );

  for (const page of ["app/(admin)/hiring-pack/page.tsx", "app/employee-portals/hiring-pack/page.tsx"]) {
    const source = code(page);
    assert.ok(source.includes("hrFormsAccessFor(access)"), `${page} gates on hrFormsAccessFor`);
    assert.ok(source.includes("packForViewer(access"), `${page} hands the screen the pack without money`);
  }

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
  await testSheGetsHerEightPapersAndNoOther();
  testThePackReachesHerWithoutMoney();
  testTheDriveHoldsHerPapersOnly();
  testEveryDoorGoesThroughTheHelpers();
}
