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
import { COMPANY_DETAILS_DEFAULT } from "../src/lib/hiring-pack/company-details.ts";
import type { DocumentFieldRow } from "../src/lib/hiring-pack/field-layout.ts";
import { buildFormsDrive, type DriveTemplate } from "../src/lib/hiring-pack/forms-drive.ts";
import { HR_PAPER_DEEMED_RESIGNATION_V2 } from "../src/lib/hiring-pack/hr-paper-text.ts";
import { buildManualHiringPack } from "../src/lib/hiring-pack/manual-pack.ts";
import {
  assertMayPrintPaper,
  assertMayUseHrForms,
  factsInputForViewer,
  hrFormsAccessFor,
  isSeatPaperViewer,
  packForPaper,
  packForViewer,
  paperIssuesForViewer,
  SALARY_BLIND_MONEY_PAPER,
} from "../src/lib/hiring-pack/paper-access.ts";
import { buildHrPaperValues, renderHrPaperHtml } from "../src/lib/hiring-pack/render-hr-paper.ts";
import {
  renderContractNonRenewalHtml,
  renderContractRenewalHtml,
} from "../src/lib/hiring-pack/render-renewal.ts";
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

/** A field the Super Admin placed in the layout editor, printing one value of the paper's map. */
function placedField(document: HiringPackDocument, key: string): DocumentFieldRow {
  return {
    align: "right",
    anchor: { dx: 12, dy: 12, selector: ".copy" },
    defaultKey: null,
    document,
    h: 14,
    hidden: false,
    id: `placed-${key}`,
    page: null,
    size: 11,
    source: { key, kind: "value" },
    templateVersionId: "test-version",
    updatedAt: "2026-10-20T08:00:00Z",
    updatedByHrId: "B-10",
    w: 160,
    x: 0,
    y: 0,
  };
}

/**
 * THE PAPER ITSELF, NOT ONLY THE JSON. Her seven non-annex papers print no salary in their own text,
 * but each renderer still puts the figure in its values map — BASE_SALARY on a house paper,
 * SALARY_FIGURES / SALARY_WORDS / INSURANCE_WAGE on the non-renewal notice — and a field placed in
 * the layout editor prints whatever that map holds. renderHiringPaper draws every paper from
 * `packForPaper`, so this renders through the same function with such a field placed.
 */
function testHerPapersAreDrawnWithoutMoney() {
  const pack = buildManualHiringPack(
    {
      "employee.baseSalary": "18000",
      "employee.hireDate": "2023-03-01",
      "employee.hrId": "T-1",
      "employee.nameAr": "شخص عيّنة",
      "employee.nationalId": "29001011234567",
    },
    COMPANY_DETAILS_DEFAULT,
  );
  assert.equal(pack.employee.baseSalary, 18000, "the fixture carries a salary, or nothing below is tested");
  const figure = "18,000";
  const words = buildHrPaperValues(pack).BASE_SALARY_WORDS ?? "";
  assert.ok(words.length > 0, "the salary in words is on the full record");

  const seat = accessFor(SEAT);
  const operations = accessFor(HR_OPERATIONS);
  assert.equal(SALARY_BLIND_MONEY_PAPER, "contractRenewal", "the annex is the one money paper — not the non-renewal notice");

  // The data selection, for every paper.
  for (const paper of HIRING_PACK_DOCUMENTS) {
    const drawn = packForPaper(seat, paper, pack);
    if (paper === "contractRenewal") {
      assert.equal(drawn, pack, "the renewal annex is drawn from the full record");
      continue;
    }
    assert.equal(drawn.employee.baseSalary, null, `${paper}: no base salary for her`);
    assert.equal(drawn.employee.grossSalary, null, `${paper}: no gross`);
    assert.equal(drawn.employee.socialInsuranceWage, null, `${paper}: no insurance wage`);
    assert.equal(drawn.employee.nameAr, pack.employee.nameAr, `${paper}: everything else stays`);
  }
  for (const role of [HR_OPERATIONS, SUPER_ADMIN]) {
    for (const paper of HIRING_PACK_DOCUMENTS) {
      assert.equal(packForPaper(accessFor(role), paper, pack), pack, `${role} ${paper}: the pack untouched`);
    }
  }

  // A house paper: the deemed-resignation notice with BASE_SALARY and its words placed on it.
  const houseFields = [placedField("deemedResignation", "BASE_SALARY"), placedField("deemedResignation", "BASE_SALARY_WORDS")];
  const renderDeemed = (role: PhoenixRole) =>
    renderHrPaperHtml(packForPaper(accessFor(role), "deemedResignation", pack), 1, HR_PAPER_DEEMED_RESIGNATION_V2, null, houseFields);
  const deemedControl = renderDeemed(HR_OPERATIONS);
  assert.ok(deemedControl.includes('data-hp-field="placed-BASE_SALARY"'), "the control: the placed field prints for HR Operations");
  assert.ok(deemedControl.includes(figure) && deemedControl.includes(words), "the control: it prints the figure and its words");
  const deemedHers = renderDeemed(SEAT);
  assert.ok(!deemedHers.includes('data-hp-field="placed-BASE_SALARY"'), "the placed salary field prints nothing for her");
  assert.ok(!deemedHers.includes('data-hp-field="placed-BASE_SALARY_WORDS"'), "nor the salary in words");
  assert.ok(!deemedHers.includes(figure), "the figure is nowhere on her deemed-resignation notice");
  assert.ok(!deemedHers.includes(words), "nor its words");

  // The non-renewal notice shares the annex's values map — it must be blanked too.
  const renewalKeys = ["SALARY_FIGURES", "SALARY_WORDS", "INSURANCE_WAGE"];
  const noticeFields = renewalKeys.map((key) => placedField("contractNonRenewal", key));
  const noticeControl = renderContractNonRenewalHtml(packForPaper(operations, "contractNonRenewal", pack), 1, null, noticeFields);
  assert.ok(noticeControl.includes('data-hp-field="placed-SALARY_FIGURES"'), "the control: the notice's placed field prints");
  assert.ok(noticeControl.includes(figure), "the control: with the figure");
  const noticeHers = renderContractNonRenewalHtml(packForPaper(seat, "contractNonRenewal", pack), 1, null, noticeFields);
  for (const key of renewalKeys) {
    assert.ok(!noticeHers.includes(`data-hp-field="placed-${key}"`), `${key} placed on the non-renewal notice prints nothing for her`);
  }
  assert.ok(!noticeHers.includes(figure), "the figure is nowhere on her non-renewal notice");
  assert.ok(!noticeHers.includes(words), "nor its words");

  // The annex is the owner's exception: she prints it with the salary, placed field and all.
  const annexHers = renderContractRenewalHtml(
    packForPaper(seat, "contractRenewal", pack),
    1,
    null,
    [placedField("contractRenewal", "SALARY_FIGURES")],
  );
  assert.ok(annexHers.includes(figure), "the renewal annex still prints the salary for her");
  assert.ok(annexHers.includes('data-hp-field="placed-SALARY_FIGURES"'), "and a field placed on it");
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
  // THE CHOKE POINT DRAWS FROM THE BLANKED PACK: the one `data` every renderer, the inventory and
  // the filing read is the value packForPaper returns, and no renderer is handed anything else.
  assert.match(
    render,
    /const data = packForPaper\(\s*access,\s*requested,\s*withPrintAddress\(/,
    "renderHiringPaper draws the paper from packForPaper",
  );
  assert.equal((render.match(/getHiringPack\(/g) ?? []).length, 1, "the full pack is read once, inside packForPaper's argument");
  assert.ok(
    /\.render\(\s*data,/.test(render) && render.includes("renderCustomTemplateHtml(template, data,"),
    "every renderer is handed that drawn data",
  );
  assert.ok(render.includes("return { copies, data, fields, html, ok: true, template, versionId };"), "and so is every caller");
  // Every route that renders a paper goes through renderHiringPaper (the filing store for signing).
  for (const caller of [
    "app/api/hiring-pack/[hrId]/print/route.ts",
    "app/api/hiring-pack/manual/route.ts",
    "src/lib/hiring-pack/paper-filing-store.ts",
  ]) {
    assert.ok(code(caller).includes("renderHiringPaper({"), `${caller} renders through renderHiringPaper`);
  }
  const print = code("app/api/hiring-pack/[hrId]/print/route.ts");
  assert.ok(
    print.includes("documentFieldInventory(requested, paper.data, paper.html)"),
    "inventory=1 lists the drawn data, not a pack of its own",
  );
  assert.ok(code("app/api/hiring-pack/[hrId]/sign/route.ts").includes("fileSignedPaper({"), "signing files through the same render");

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
  testHerPapersAreDrawnWithoutMoney();
  testTheDriveHoldsHerPapersOnly();
  testEveryDoorGoesThroughTheHelpers();
}
