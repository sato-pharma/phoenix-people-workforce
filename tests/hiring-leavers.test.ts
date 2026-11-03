import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { employeeLeftFlag, employeeLeftLabel, employeeLeftWord } from "../src/lib/employees/left-flag.ts";
import {
  leaverDaysLabel,
  leaverExitPapers,
  leaverHrFormsHref,
  leaverMailboxStanding,
  leaverNamedPapers,
  leaversNewestFirst,
} from "../src/lib/hiring-documents/leavers-logic.ts";
import { hiringDocumentScanQueue } from "../src/lib/hiring-documents/scan-queue.ts";
import type { HiringDocumentDefinition, HiringDocumentEmployeeRow, HiringDocumentEntry } from "../src/lib/hiring-documents/types.ts";
import type { ExitRoute } from "../src/lib/hiring-pack/types.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE LEAVERS TAB AND THE "LEFT" WORD (owner, 2026-11-03: "build 1 &3 & 4"). Who counts as having left,
 * what they owe, and that flagging someone as gone closes nothing and decides nothing for anybody.
 */

function doc(id: string, name: string, isExitDocument: boolean): HiringDocumentDefinition {
  return {
    createdAt: "",
    description: null,
    displayOrder: 0,
    documentGroup: isExitDocument ? "offboarding" : "required",
    id,
    isExitDocument,
    name,
    sheetHeader: null,
  };
}

const DOCUMENTS = [
  doc("cv", "CV", false),
  doc("form6", "Signed social insurance Form 6", true),
  doc("resign", "Signed resignation request", true),
  doc("employee", "Signed Employee Clearance", true),
  doc("company", "Signed Company Clearance", true),
];

function entry(documentId: string, status: HiringDocumentEntry["status"], fileCount = 0): HiringDocumentEntry {
  return { documentId, dueDate: null, fileCount, notes: null, status, updatedAt: null };
}

function person(
  hrId: string,
  status: string,
  documents: Record<string, HiringDocumentEntry>,
  exitRoute: ExitRoute | null = null,
): HiringDocumentEmployeeRow & { exitRoute: ExitRoute | null } {
  return {
    documents,
    employmentStatus: status,
    exitRoute,
    fullName: hrId,
    hireDate: "2026-01-01",
    hrId,
    jobTitle: null,
    lineName: null,
    managerHrId: null,
    managerName: null,
    notes: null,
  };
}

function testTheExitPapersOwed() {
  const leaver = person("L-1", "resigned", {
    cv: entry("cv", "submitted", 1),
    form6: entry("form6", "submitted", 1),
    resign: entry("resign", "submitted"),
    employee: entry("employee", "missing"),
  });

  const exit = leaverExitPapers(DOCUMENTS, leaver);
  assert.deepEqual(
    exit.papers.map(({ document, signal }) => `${document.id}:${signal}`),
    ["form6:complete", "resign:unevidenced", "employee:missing", "company:pending"],
    "the exit papers only, in the checklist's order, a paper with no row reading as not received",
  );
  assert.equal(exit.total, 4, "a joining paper is not an exit paper");
  assert.equal(exit.received, 2, "a tick counts, with or without a scan behind it");
  assert.equal(exit.firstOutstandingId, "employee", "Receive opens on the first one still owed");

  assert.deepEqual(
    leaverNamedPapers(exit, leaver),
    [
      { label: "Form 6", received: true },
      { label: "Employee clearance", received: false },
      { label: "Company clearance", received: false },
    ],
    "the three the line names",
  );
  const renamed = [doc("form6", "Signed form 1", true), doc("employee", "Signed Employee Clearance", true)];
  assert.deepEqual(
    leaverNamedPapers(leaverExitPapers(renamed, leaver), leaver).map((paper) => paper.label),
    ["Employee clearance"],
    "a paper renamed away drops off the line and is never mistaken for another",
  );
  assert.equal(leaverExitPapers(renamed, leaver).total, 2, "and it stays in the count");
}

/** Both labour papers stay open until one is chosen, then the other is greyed, and they share one place in the count. */
function testBothLabourPapersStayOpenUntilOneIsChosen() {
  const documents = [
    doc("form6", "Signed social insurance Form 6", true),
    doc("resign", "Signed resignation request", true),
    doc("mutual", "Signed mutual termination agreement", true),
    doc("employee", "Signed Employee Clearance", true),
  ];
  const standings = (leaver: ReturnType<typeof person>) =>
    leaverExitPapers(documents, leaver).papers.map(({ document, standing }) => `${document.id}:${standing}`);

  const open = ["form6:owed", "resign:either", "mutual:either", "employee:owed"];
  for (const status of ["resigned", "terminated", "not_renewed"]) {
    assert.deepEqual(standings(person("A", status, {})), open, `${status}: how they left chooses nothing`);
    assert.equal(leaverExitPapers(documents, person("A", status, {})).total, 3, "the two share one place in the count");
  }
  assert.equal(leaverExitPapers(documents, person("A", "resigned", {})).received, 0, "an open pair is not received");

  const resignGreyed = ["form6:owed", "resign:greyed", "mutual:owed", "employee:owed"];
  const mutualGreyed = ["form6:owed", "resign:owed", "mutual:greyed", "employee:owed"];
  assert.deepEqual(standings(person("B", "resigned", {}, "mutualTermination")), resignGreyed, "picking the route in HR Forms greys the other");
  assert.deepEqual(standings(person("B", "terminated", {}, "resignation")), mutualGreyed, "whichever way the record says they left");
  assert.deepEqual(standings(person("C", "resigned", { mutual: entry("mutual", "submitted", 1) })), resignGreyed, "receiving one greys the other");
  assert.deepEqual(standings(person("C", "terminated", { resign: entry("resign", "submitted") })), mutualGreyed, "either way round");
  assert.deepEqual(
    standings(person("D", "resigned", { mutual: entry("mutual", "submitted", 1) }, "resignation")),
    mutualGreyed,
    "the route picked in HR Forms beats a paper received against it",
  );

  const chosen = leaverExitPapers(documents, person("E", "resigned", {}, "mutualTermination"));
  assert.deepEqual([chosen.received, chosen.total, chosen.firstOutstandingId], [0, 3, "form6"], "the greyed one is not owed");
  const finished = leaverExitPapers(documents, person("F", "resigned", {
    employee: entry("employee", "submitted"),
    form6: entry("form6", "submitted"),
    resign: entry("resign", "submitted"),
  }));
  assert.deepEqual([finished.received, finished.total, finished.firstOutstandingId], [3, 3, null], "everyone can finish now");
  const both = leaverExitPapers(documents, person("G", "resigned", { mutual: entry("mutual", "submitted"), resign: entry("resign", "submitted") }));
  assert.equal(both.received, 1, "two ticks on the old record still fill one place");
  assert.equal(both.papers.filter(({ standing }) => standing === "greyed").length, 0, "and nobody is told which one to disown");

  const reader = readFileSync("src/lib/hiring-documents/leavers.ts", "utf8");
  assert.ok(reader.includes('.select("hr_id,exit_route")'), "the route read takes the route alone, not the rest of the offboarding profile");
  assert.ok(reader.includes("exitRoute: exitRoutes?.get(keyOf(row.hrId)) ?? null"), "a failed route read leaves both open");
  assert.ok(reader.includes('sideRead("exit route"'), "and costs the list nothing");

  const panel = stripComments(readFileSync("src/components/hiring-documents/hiring-leavers-panel.tsx", "utf8"));
  assert.ok(panel.includes("Not needed, the other paper was chosen"), "the greyed paper says why");
  assert.ok(panel.includes('canManage && standing !== "greyed" && signal !== "complete"'), "a greyed paper has nothing to press");
  assert.ok(panel.includes('standing === "greyed" ? "text-phx-ink-faint" : "text-phx-ink"'), "and it reads grey");
  assert.ok(panel.includes("only one of the two is signed"), "an open pair says so, so nobody scans both");
}

function testTheMailboxLine() {
  assert.equal(leaverMailboxStanding([]), "none", "no task is not a finished task");
  assert.equal(leaverMailboxStanding(["revoked", "pending"]), "pending", "one mailbox still open means they are not done");
  assert.equal(leaverMailboxStanding(["revoked", "in_progress"]), "in_progress");
  assert.equal(leaverMailboxStanding(["not_applicable", "revoked"]), "revoked");
  assert.equal(leaverMailboxStanding(["not_applicable"]), "not_needed");
  assert.equal(leaverMailboxStanding(["something_new"]), "pending", "a status nobody knows must not read as finished");
}

function testNewestFirstAndTheLabels() {
  const named = (hrId: string, lastWorkingDate: string | null) => ({ fullName: hrId, hrId, lastWorkingDate });
  assert.deepEqual(
    leaversNewestFirst([named("old", "2026-01-01"), named("none", null), named("new", "2026-10-01")]).map((row) => row.hrId),
    ["new", "old", "none"],
    "most recently gone first, and someone with no date stays on the list",
  );
  assert.equal(leaverDaysLabel("2026-11-03", "2026-11-03"), "Today");
  assert.equal(leaverDaysLabel("2026-11-03", "2026-11-02"), "Yesterday");
  assert.equal(leaverDaysLabel("2026-11-03", "2026-10-24"), "10 days ago");
  assert.equal(leaverDaysLabel("2026-11-03", "2026-11-13"), "In 10 days", "notice can still be running");

  assert.equal(leaverHrFormsHref("/hiring-documents", "AI-1"), "/hiring-pack?hrId=AI-1");
  assert.equal(leaverHrFormsHref("/employee-portals/hiring-documents", "AI-1"), "/employee-portals/hiring-pack?hrId=AI-1");
  assert.equal(leaverHrFormsHref("/hr/hiring-documents/", "AI-1"), "/hr/hiring-pack?hrId=AI-1");
  assert.equal(leaverHrFormsHref(null, "A B"), "/hiring-pack?hrId=A%20B");
}

function testTheLeftWord() {
  assert.deepEqual(employeeLeftFlag({ employmentStatus: "resigned", lastWorkingDate: "2026-10-12" }), { date: "2026-10-12", kind: "left" });
  assert.deepEqual(employeeLeftFlag({ employmentStatus: " Terminated ", lastWorkingDate: null }), { date: null, kind: "left" }, "spelled as the record spells it");
  assert.deepEqual(employeeLeftFlag({ employmentStatus: "declined_offer", lastWorkingDate: "2026-10-12" }), { date: null, kind: "declined" }, "they never started, so no last day");
  for (const status of ["active", "on_leave", "historical_payroll_record", "system_placeholder", "", null, undefined]) {
    assert.equal(employeeLeftFlag({ employmentStatus: status, lastWorkingDate: "2026-10-12" }), null, `${status} has not left`);
  }
  assert.equal(employeeLeftLabel({ date: "2026-10-12", kind: "left" }), "Left 12 Oct 2026");
  assert.equal(employeeLeftLabel({ date: null, kind: "left" }), "Left");
  assert.equal(employeeLeftLabel({ date: null, kind: "declined" }), "Offer declined");
  assert.equal(employeeLeftWord({ employment_status: "resigned", last_working_date: "2026-10-12" }), "Left 12 Oct 2026");
  assert.equal(employeeLeftWord({ employment_status: "active" }), null);
}

function testTheyStayOutOfTheCurrentStaffFigures() {
  const leaver = person("L-1", "resigned", { form6: entry("form6", "submitted") });
  const staff = person("S-1", "active", { cv: entry("cv", "submitted") });
  assert.deepEqual(
    hiringDocumentScanQueue(DOCUMENTS, [staff]).map((item) => item.employeeHrId),
    ["S-1"],
    "the queue is built from the staff list",
  );
  assert.ok(hiringDocumentScanQueue(DOCUMENTS, [leaver]).length === 1, "which is why a leaver must never be handed to it");

  const capture = stripComments(readFileSync("src/components/hiring-documents/hiring-document-capture.tsx", "utf8"));
  assert.ok(capture.includes("hiringDocumentScanQueue(documents, employees)"), "the queue reads staff alone, so it stays the figure above the screen");
  assert.ok(capture.includes("[...employees, ...leavers].find("), "a leaver can be chosen and filed against");
  assert.ok(/leavers\.map\(\(leaver\)[\s\S]*?\(left\)/.test(capture), "and says they have left in the list");

  const service = stripComments(readFileSync("src/lib/hiring-documents/service.ts", "utf8"));
  assert.ok(service.includes('.in("employment_status", [...DEPARTED_EMPLOYMENT_STATUSES])'), "one vocabulary for who has left");
  assert.ok(service.includes(".filter(isVisibleEmployee)"), "the checklist itself stays current staff");
  const departed = service.slice(service.indexOf("export async function getDepartedEmployeesWithPapers"), service.indexOf("async function employeesWithPapers"));
  assert.ok(departed.includes("employeesWithPapers(employeeRows, documents)"), "their papers come through the checklist's own read");
  assert.ok(!departed.includes("hiringDocumentsDashboardCache"), "not cached, or a filed scan would not show");
  const dashboard = service.slice(service.indexOf("export async function getHiringDocumentsDashboard"), service.indexOf("export async function getDepartedEmployeesWithPapers"));
  assert.ok(dashboard.includes("hiringDocumentsDashboardCache = { data: result"), "the dashboard still caches its answer");
}

function testTheReadAndThePanel() {
  const route = stripComments(readFileSync("app/api/hiring-documents/leavers/route.ts", "utf8"));
  assert.ok(
    route.includes('assertPermission(access, "employee_documents", "read")') &&
      route.indexOf('assertPermission(access, "employee_documents", "read")') < route.indexOf("getHiringLeavers(access)"),
    "the read is gated before anything is read",
  );
  assert.ok(!route.includes("export async function PATCH") && !route.includes("export async function POST"), "this route writes nothing");

  const service = stripComments(readFileSync("src/lib/hiring-documents/leavers.ts", "utf8"));
  assert.ok(service.includes("rows.filter((row) => canSeeHiringDocumentRow(access, row))"), "a seat scoped to its own people sees only those leavers");
  const documentsService = stripComments(readFileSync("src/lib/hiring-documents/service.ts", "utf8"));
  assert.ok(
    documentsService.includes("dashboard.employees.filter((employee) => canSeeHiringDocumentRow(access, employee))"),
    "the same question the dashboard asks",
  );
  const selects = [...service.matchAll(/\.select\(([^)]*)\)/g)].map((match) => match[1]);
  assert.equal(selects.length, 3, "three side reads");
  for (const select of selects) {
    assert.ok(/^"(employee_hr_id(,status)?|hr_id,exit_route)"$/.test(select), `status, count and route only: ${select}`);
  }
  assert.equal((service.match(/sideRead\("/g) ?? []).length, 3, "each side read goes through the wrapper");
  assert.ok(/async function sideRead[\s\S]*?catch \(error\)[\s\S]*?return null;/.test(service), "one failing side read costs only its own line");
  assert.ok(service.includes("devices ? (devices.get(") && service.includes("mailboxes ? leaverMailboxStanding("), "a failed read stays null, never zero");
  assert.ok(service.includes('.eq("status", "outstanding")') && service.includes('.eq("is_placeholder", false)'), "only a device actually out counts");
  for (const write of [".insert(", ".update(", ".upsert(", ".delete("]) {
    assert.ok(!service.includes(write), `the leavers read never writes: ${write}`);
  }

  const panel = stripComments(readFileSync("src/components/hiring-documents/hiring-leavers-panel.tsx", "utf8"));
  assert.ok(panel.includes('className="w-full table-fixed'), "the table fits its width");
  assert.ok(panel.includes("<TableRowDetail"), "the papers open as the row's joined panel");
  assert.ok(panel.includes("rowDetailToggleProps("), "the button says which panel it controls");
  assert.ok(panel.includes("The leavers list could not be read"), "a failed read says so");
  assert.ok(panel.includes('word: "Not read"') && panel.includes(">Not read<"), "a failed side read says so on its own line");
  assert.ok(panel.includes("canManage && standing !== \"greyed\" && signal !== \"complete\""), "a seat that only reads has nothing to press");
  assert.equal(panel.split("renderPapers(leaver, exit)").length - 1, 2, "on the table and on the phone card");
  assert.equal(panel.split("renderOpen(leaver)").length - 1, 2, "on the table and on the phone card");
  assert.ok(panel.includes("border border-phx-line bg-white p-4 shadow-none"), "a bordered box stays flat under the admin shell");

  const manager = stripComments(readFileSync("src/components/hiring-documents/hiring-documents-manager.tsx", "utf8"));
  assert.ok(manager.includes('activeTab === "leavers" ? undefined : "hidden"'), "stays mounted, so the open papers survive a trip to Scan & Upload");
  const refresh = manager.slice(manager.indexOf("async function refreshDashboard"), manager.indexOf("async function refreshDashboard") + 400);
  assert.ok(refresh.includes("void leavers.reload()"), "a scan filed against a leaver shows on the next read");
  assert.ok(manager.includes("onRetry={() => void leavers.reload()}"), "Try again reads the list again");
  assert.ok(manager.includes("leavers={leavers.data?.leavers ?? []}"), "Scan & Upload can reach them");
}

/** The flag only says so. The decision path and every status write stay exactly as they were. */
function testTheWordClosesNothing() {
  const cases = stripComments(readFileSync("src/lib/probation/intelligence/cases.ts", "utf8"));
  const read = cases.slice(cases.indexOf("export async function readProbationEmployeeLeft"), cases.indexOf("export async function assertCaseAcceptsSubmissions"));
  assert.ok(read.includes('.select("employment_status, last_working_date")'), "two columns");
  assert.ok(!/\.(insert|update|upsert|delete)\(/.test(read), "it writes nothing");
  assert.ok(read.includes("employeeHrId.toLowerCase()") && read.includes("employeeHrId.toUpperCase()"), "probation_cases and employees spell the id differently");

  const decision = readFileSync("src/lib/probation/intelligence/decision.ts", "utf8");
  assert.ok(!decision.includes("readProbationEmployeeLeft") && !decision.includes("left-flag"), "a decision never asks whether they left");

  const page = stripComments(readFileSync("app/(admin)/probation/cases/[caseId]/page.tsx", "utf8"));
  assert.ok(page.includes('report.case.status === "active" ? await readProbationEmployeeLeft('), "only an open case says this");
  assert.ok(page.includes("This case is still open:"), "the page says what it means");
  assert.ok(page.includes("<ProbationDecisionPanel"), "the decision stays with whoever holds it");

  const tracker = stripComments(readFileSync("src/components/probation/probation-tracker.tsx", "utf8"));
  assert.equal(tracker.split('value: employeeLeftWord(row) as string').length - 1, 2, "both phone cards");
  assert.equal(tracker.split("{employeeLeftWord(row)}</span>").length - 1, 2, "both desktop tables");
  const portal = stripComments(readFileSync("src/components/employee-portal/employee-probation-dashboard.tsx", "utf8"));
  assert.equal(portal.split("{employeeLeftWord(row)}</p>").length - 1, 2, "the portal's table and card");
  const probationService = stripComments(readFileSync("src/lib/probation/service.ts", "utf8"));
  assert.ok(probationService.includes("last_working_date: employee.lastWorkingDate ?? null"), "the row carries the day");

  const mailbox = stripComments(readFileSync("src/lib/new-hire-mailbox/service.ts", "utf8"));
  assert.ok(mailbox.includes("employeeLeft: employee") && mailbox.includes("getEmployeeDirectoryRows({ includeInactive: true })"), "the queue's directory read includes them");
  assert.ok(mailbox.includes('pending: tasks.filter((task) => task.status === "pending")'), "a person who left stays in the queue until HR closes the task");
  const mailboxPanel = stripComments(readFileSync("src/components/new-hire-mailbox/new-hire-mailbox-panel.tsx", "utf8"));
  assert.ok(mailboxPanel.includes("{employeeLeftLabel(task.employeeLeft)}"), "the card says so");
}

export function runHiringLeaversTests() {
  testTheExitPapersOwed();
  testBothLabourPapersStayOpenUntilOneIsChosen();
  testTheMailboxLine();
  testNewestFirstAndTheLabels();
  testTheLeftWord();
  testTheyStayOutOfTheCurrentStaffFigures();
  testTheReadAndThePanel();
  testTheWordClosesNothing();
}
