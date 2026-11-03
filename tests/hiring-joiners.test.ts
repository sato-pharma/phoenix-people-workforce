import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { joinerAttendanceDayLabel, joinerAttendanceTimeLabel, joinerWhatsAppMessage } from "../src/lib/hiring-documents/joiner-whatsapp.ts";
import {
  HiringJoinerInputError,
  joinerDayOneFacts,
  joinerDayOneItems,
  joinerIsUrgent,
  joinerPapersProgress,
  joinerStanding,
  joinersSummary,
  parseHiringJoinerUpdate,
  upcomingJoinerOffers,
} from "../src/lib/hiring-documents/joiners-logic.ts";
import { hasUnscannedDocuments } from "../src/lib/hiring-documents/filters.ts";
import { employeePapersStanding } from "../src/lib/hiring-documents/readiness-signal.ts";
import { hiringDocumentScanQueue, nextScanQueueItem, scanQueueProgress } from "../src/lib/hiring-documents/scan-queue.ts";
import type { HiringDocumentDefinition, HiringDocumentEmployeeRow } from "../src/lib/hiring-documents/types.ts";
import { summarizeHiringDocumentReadiness } from "../src/lib/recruitment/onboarding-metrics.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE JOINERS PANEL ON HIRING DOCUMENTS (owner, 2026-11-02: "Contact the joiner, confirm papers and
 * attendance time"). Who counts as arriving, what a save may hold, how far the papers have come, and
 * that the read carries no money, because the salary-blind seat reads it.
 */

const OFFER_ID = "11111111-1111-4111-8111-111111111111";
const TODAY = "2026-11-02";

function offer(id: string, startDate: string | null, overrides: Record<string, unknown> = {}) {
  return { employeeHrId: null, id, name: id, startDate, status: "accepted", ...overrides };
}

function testWhoCountsAsArriving() {
  const rows = [
    offer("letter-text-upcoming", "25 November 2026"),
    offer("letter-iso-today", TODAY),
    offer("letter-yesterday", "01 November 2026"),
    // No readable date and no record yet: kept, first, so a real joiner is never hidden.
    offer("no-date", null),
    offer("slash-date", "1/11/2026"),
    // No readable date but a record exists: that person has already joined the system, not listed.
    offer("no-date-with-record", null, { employeeHrId: "B-9003" }),
    offer("not-accepted", "25 November 2026", { status: "sent" }),
    // The record's hire date beats the letter, both ways.
    offer("moved-later", "01 October 2026", { employeeHrId: "B-9001" }),
    offer("moved-earlier", "30 November 2026", { employeeHrId: "B-9002" }),
  ];
  const upcoming = upcomingJoinerOffers(rows, {
    hireDateByHrId: new Map([
      // Keyed by canonicalHrIdKey, as the service builds it.
      ["b-9001", "2026-11-10"],
      ["b-9002", "2026-10-20"],
    ]),
    todayKey: TODAY,
  });
  assert.deepEqual(
    upcoming.map(({ offer: row, startKey }) => [row.id, startKey]),
    [
      ["no-date", ""],
      ["slash-date", ""],
      ["letter-iso-today", TODAY],
      ["moved-later", "2026-11-10"],
      ["letter-text-upcoming", "2026-11-25"],
    ],
    "accepted only, unreadable dates first, then from today on, nearest first, the record's date winning, free-text letter dates read",
  );
}

function refuses(payload: unknown, message: RegExp) {
  assert.throws(
    () => parseHiringJoinerUpdate(payload),
    (error: unknown) => error instanceof HiringJoinerInputError && message.test(error.message),
    `refused with ${message}`,
  );
}

function testWhatASaveMayHold() {
  const whole = { attendanceDate: "2026-11-10", attendanceTime: "09:30", notes: "  Bring originals  ", offerId: OFFER_ID, papersConfirmed: true };
  assert.deepEqual(
    parseHiringJoinerUpdate(whole),
    { attendanceDate: "2026-11-10", attendanceTime: "09:30", notes: "Bring originals", offerId: OFFER_ID, papersConfirmed: true },
    "a whole save passes, trimmed",
  );
  assert.deepEqual(
    parseHiringJoinerUpdate({ attendanceDate: null, attendanceTime: "", notes: null, offerId: OFFER_ID, papersConfirmed: false }),
    { attendanceDate: null, attendanceTime: null, notes: null, offerId: OFFER_ID, papersConfirmed: false },
    "null and empty clear a field",
  );

  refuses({ ...whole, offerId: "not-a-uuid" }, /joiner/);
  refuses({ ...whole, papersConfirmed: "yes" }, /papers/);
  refuses({ ...whole, attendanceDate: "10 November 2026" }, /real date/);
  refuses({ ...whole, attendanceDate: "2026-02-31" }, /real date/);
  refuses({ ...whole, attendanceTime: "25:00" }, /time of day/);
  refuses({ ...whole, attendanceTime: "9:30" }, /time of day/);
  refuses({ ...whole, notes: "x".repeat(1001) }, /note/i);

  // A field left out must never read as "clear it": the save replaces the row.
  for (const missing of ["attendanceDate", "attendanceTime", "notes"]) {
    const { [missing as keyof typeof whole]: _gone, ...rest } = whole;
    refuses(rest, /required/);
  }
}

function testHowFarThePapersHaveCome() {
  const definition = (id: string, isExitDocument = false) =>
    ({ documentGroup: "required", id, isExitDocument, name: id }) as unknown as HiringDocumentDefinition;
  const employee = {
    documents: {
      in: { status: "submitted" },
      missing: { status: "missing" },
    },
    employmentStatus: "active",
  } as unknown as HiringDocumentEmployeeRow;

  assert.deepEqual(
    joinerPapersProgress([definition("in"), definition("missing"), definition("untouched"), definition("exit", true)], employee),
    { firstOutstandingId: "missing", received: 1, total: 3 },
    "an exit document does not count against a joiner, and an untouched paper is outstanding",
  );
  assert.deepEqual(
    joinerPapersProgress([definition("in")], employee),
    { firstOutstandingId: null, received: 1, total: 1 },
    "nothing outstanding, nowhere to open",
  );
}

function testTheReadCarriesNoMoneyAndTheWriteIsGated() {
  const service = stripComments(readFileSync("src/lib/hiring-documents/joiners.ts", "utf8"));
  const selects = [...service.matchAll(/\.select\(([^)]*)\)/g)].map((match) => match[1]);
  assert.ok(selects.length >= 5, `only ${selects.length} reads found: the pattern stopped matching`);
  const columns = /const OFFER_COLUMNS =\s*"([^"]+)"/.exec(service)?.[1] ?? "";
  assert.ok(columns.includes("candidate_name"), "the offer columns were read");
  for (const text of [columns, ...selects]) {
    assert.ok(!text.includes("*"), `no read takes every column: ${text}`);
    for (const money of ["total_monthly", "cost_of_living", "template_snapshot"]) {
      assert.ok(!text.includes(money), `${money} must never reach this panel`);
    }
  }
  assert.ok(service.includes("writeRequiredAuditLog({"), "every save leaves an audit row");
  assert.ok(service.includes('offer.status !== "accepted"'), "a save only lands on an accepted offer");

  const route = stripComments(readFileSync("app/api/hiring-documents/joiners/route.ts", "utf8"));
  const get = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function PATCH"));
  const patch = route.slice(route.indexOf("export async function PATCH"));
  assert.ok(
    get.indexOf('assertPermission(access, "employee_documents", "read")') < get.indexOf("getHiringJoiners()") &&
      get.includes('assertPermission(access, "employee_documents", "read")'),
    "the read is gated before anything is read",
  );
  assert.ok(patch.includes("assertSameOriginMutation(request)"), "the write checks its origin");
  assert.ok(
    patch.includes('assertPermission(access, "employee_documents", "update")') &&
      patch.indexOf('assertPermission(access, "employee_documents", "update")') < patch.indexOf("saveHiringJoinerContact("),
    "the write is gated before anything is written",
  );

  const migration = readFileSync("supabase/migrations/20261102120000_hiring_joiner_contacts.sql", "utf8");
  assert.ok(migration.includes("enable row level security"), "row level security is on");
  assert.ok(migration.includes("from public, anon, authenticated"), "nobody but the service role reads it");
  assert.ok(/attendance_time time without time zone/.test(migration), "an agreed time carries no zone that could move it");

  const panel = stripComments(readFileSync("src/components/hiring-documents/hiring-joiners-panel.tsx", "utf8"));
  assert.ok(panel.includes('className="w-full table-fixed'), "the table fits its width");
  assert.ok(panel.includes("<TableRowDetail"), "the form opens as the row's joined panel, not a tall cell in every row");
  assert.ok(panel.includes("rowDetailToggleProps("), "the button says which panel it controls");
  assert.ok(panel.includes("current[next.offerId] ?? draftOf(next)"), "saving one joiner keeps another joiner's unsaved edits");
  assert.ok(panel.includes("!isDirty(joiner, draft)"), "Save waits for a change");
  const page = stripComments(readFileSync("src/components/hiring-documents/hiring-documents-manager.tsx", "utf8"));
  assert.ok(page.includes("captureSectionRef.current?.scrollIntoView"), "Receive papers follows the form down the page");
  // Measured: a one-line button ran past its column on a 1366px laptop, and 35px past it at 768px.
  assert.ok(panel.includes('className="h-auto min-h-9 w-full whitespace-normal'), "Receive papers wraps inside its column");
  assert.ok(panel.includes("The joiners list could not be read"), "a failed read says so");
  assert.ok(panel.includes("href={`tel:${joiner.mobile}`}"), "contact opens the viewer's own phone");
  const manager = readFileSync("src/components/hiring-documents/hiring-documents-manager.tsx", "utf8");
  assert.ok(manager.includes("<HiringJoinersPanel"), "the panel is on the screen");
}

function testWhereAJoinerStands() {
  const nothing = { attendanceDate: null, attendanceTime: null, papersConfirmed: false };
  const all = { attendanceDate: "2026-11-10", attendanceTime: "09:30", papersConfirmed: true };
  assert.deepEqual(joinerStanding(nothing), { kind: "open", missing: ["papers", "day", "time"] }, "nothing agreed");
  assert.deepEqual(joinerStanding(all), { kind: "confirmed", missing: [] }, "all three agreed");
  assert.deepEqual(
    joinerStanding({ ...nothing, papersConfirmed: true }),
    { kind: "partial", missing: ["day", "time"] },
    "the papers alone are not a confirmation",
  );

  assert.equal(joinerIsUrgent({ ...nothing, startKey: "2026-11-05" }, TODAY), true, "three days out with nothing agreed");
  assert.equal(joinerIsUrgent({ ...nothing, startKey: "2026-11-06" }, TODAY), false, "four days out can wait");
  assert.equal(joinerIsUrgent({ ...all, startKey: "2026-11-03" }, TODAY), false, "tomorrow, and all agreed");
  assert.equal(joinerIsUrgent({ ...nothing, startKey: "" }, TODAY), false, "no readable date has no countdown");

  assert.deepEqual(
    joinersSummary([
      { ...all, mobile: "+201001234567" },
      { ...nothing, mobile: null },
      { ...nothing, mobile: "+201112223334" },
    ]),
    { arriving: 3, noMobile: 1, toConfirm: 2 },
    "the counts above the list",
  );
}

function testHrFormsSaysWhyABoxIsLocked() {
  const forms = stripComments(readFileSync("src/components/hiring-pack/hiring-pack-manager.tsx", "utf8"));
  assert.ok(/salaryReadOnly \? \(\s*<p[^>]*>\s*You print this figure\./.test(forms), "the salary box says why it is locked");
  assert.ok(forms.includes('contractTermsReadOnly ? "You print these terms.'), "the contract terms say why they are locked");
}

function testOneLineForEachEmployee() {
  const definition = (id: string, isExitDocument = false) =>
    ({ documentGroup: "required", id, isExitDocument, name: id }) as unknown as HiringDocumentDefinition;
  const employee = {
    documents: {
      filed: { dueDate: null, fileCount: 1, status: "submitted" },
      late: { dueDate: "2026-10-20", fileCount: 0, status: "missing" },
      marked: { dueDate: "2026-11-20", fileCount: 0, status: "missing" },
      ticked: { dueDate: null, fileCount: 0, status: "submitted" },
    },
    employmentStatus: "active",
  } as unknown as HiringDocumentEmployeeRow;
  assert.deepEqual(
    employeePapersStanding(
      ["filed", "ticked", "marked", "late", "untouched"].map((id) => definition(id)).concat(definition("exit", true)),
      employee,
      new Date("2026-11-03T00:00:00"),
    ),
    { missing: 1, noScan: 1, overdue: 1, received: 2, total: 5 },
    "a tick with no scan is received and still needs filing, a passed deadline is overdue and not also missing, an exit paper does not count",
  );

  const page = stripComments(readFileSync("src/components/hiring-documents/hiring-documents-manager.tsx", "utf8"));
  // Measured: as the else of the Documents tab, this drew six Delete buttons and an Add for a seat the
  // server refuses, under Scan & Upload.
  assert.ok(page.includes('activeTab === "control" && canEditChecklist'), "the checklist editor shows on its own tab, to the seat that may edit it");
  assert.ok(page.includes('React.useState<ActiveTab>("joiners")'), "the screen opens on the people arriving");
  assert.ok(page.includes('activeTab === "joiners" ? undefined : "hidden"'), "the joiners panel stays mounted, so a typed note survives a trip to another tab");
  assert.ok(page.includes("openHrId === employee.hrId") && page.includes("<TableRowDetail"), "one person's papers open beneath their row, one at a time");
  assert.ok(/\{data \? \(\s*<dl/.test(page), "a failed read shows no row of zeros");
}

function testHrFormsReadsAsALedger() {
  const forms = stripComments(readFileSync("src/components/hiring-pack/hiring-pack-manager.tsx", "utf8"));
  // Measured at 375: 413px wide in a 309px column, with no border at all.
  assert.ok(/<select\s+className=\{phxSelectClassName\}/.test(forms), "the fixed-term reason wears the form skin and fits its column");
  assert.ok(forms.includes("canSign && signOpen"), "the signature line stays folded until it is wanted");
  assert.ok(forms.includes("[&:not(:has(h3))]:hidden"), "a heading with no paper under it for this seat does not show");
  assert.equal(forms.split("<PaperGroup ").length - 1, 9, "every paper sits under a heading");
  assert.ok(!forms.includes("grid gap-2 empty:hidden"), "no group of papers was left without one");
}

function testTheMessageToAJoiner() {
  const paper = (id: string, documentGroup: string, name: string, isExitDocument = false) =>
    ({ documentGroup, id, isExitDocument, name }) as unknown as HiringDocumentDefinition;
  const documents = [
    paper("photos", "required", "(6) personal photos"),
    paper("birth", "required", "Birth certificate"),
    paper("s6", "required", "Clearance form or S6  From the last employer"),
    paper("contract", "onboarding", "Signed contract"),
    paper("exit", "required", "Mutual termination", true),
  ];
  const base = { attendanceDate: null, attendanceTime: null, companyName: "Sato Pharma", documents, employeeDocuments: null, name: " Sara Ali " };

  const noRecord = joinerWhatsAppMessage(base);
  assert.ok(noRecord.startsWith("Hello Sara Ali,\n"), "it greets them by name");
  assert.ok(noRecord.includes("the HR team at Sato Pharma"), "it says who is writing");
  assert.ok(noRecord.includes("1. (6) personal photos\n2. Birth certificate\n3. Clearance form or S6 From the last employer"), "no record yet: every paper they carry in, in order, tidied");
  assert.ok(!noRecord.includes("Signed contract"), "a paper signed at HR on the day is not one they bring");
  assert.ok(!noRecord.includes("Mutual termination"), "an exit paper is not one a joiner brings");
  assert.ok(noRecord.includes("We will confirm your first day and time with you."), "no day agreed yet: it says so");
  assert.ok(!/\.\.\.|…/.test(noRecord), "no ellipsis");

  const withRecord = joinerWhatsAppMessage({
    ...base,
    employeeDocuments: { birth: { status: "missing" }, photos: { status: "submitted" } },
  });
  assert.ok(!withRecord.includes("personal photos"), "a paper already in is not asked for again");
  assert.ok(withRecord.includes("1. Birth certificate\n2. Clearance form"), "the rest still is, a paper marked missing included");

  const allIn = joinerWhatsAppMessage({
    ...base,
    employeeDocuments: { birth: { status: "submitted" }, photos: { status: "submitted" }, s6: { status: "submitted" } },
  });
  assert.ok(allIn.includes("We have received all the papers") && !allIn.includes("Please bring"), "nothing left to ask for");

  assert.ok(
    joinerWhatsAppMessage({ ...base, attendanceDate: "2026-11-10", attendanceTime: "09:30" }).includes("Please attend on Tuesday 10 November 2026 at 9:30 AM."),
    "the day and time, in words",
  );
  assert.ok(
    joinerWhatsAppMessage({ ...base, attendanceDate: "2026-11-10" }).includes("Please attend on Tuesday 10 November 2026. We will confirm the time with you."),
    "a day with no time yet",
  );
  assert.equal(joinerAttendanceDayLabel("2026-02-31"), null, "not a real day");
  assert.equal(joinerAttendanceTimeLabel("00:15"), "12:15 AM", "just after midnight");
  assert.equal(joinerAttendanceTimeLabel("12:00"), "12:00 PM", "noon");
  assert.equal(joinerAttendanceTimeLabel("13:05"), "1:05 PM", "the afternoon");

  const pure = stripComments(readFileSync("src/lib/hiring-documents/joiner-whatsapp.ts", "utf8"));
  assert.ok(!pure.includes("fetch(") && !pure.includes("graph.facebook"), "it prepares a message and never sends one");
  const panel = stripComments(readFileSync("src/components/hiring-documents/hiring-joiners-panel.tsx", "utf8"));
  assert.ok(panel.includes("if (!canManage || !documents.some("), "a seat that cannot act gets no link, and an unread checklist never says everything is in");
  assert.ok(panel.includes("toWhatsAppDialNumber(joiner.mobile)") && panel.includes("if (!number) return null;"), "a number WhatsApp cannot open gets no link");
  assert.ok(panel.includes("attendanceDate: draft.attendanceDate || null"), "the message says the day on screen");
  assert.ok(panel.includes('rel="noopener noreferrer"') && panel.includes('target="_blank"'), "it opens in its own tab");
}

function testTheScanQueue() {
  const definition = (id: string, isExitDocument = false) =>
    ({ documentGroup: "required", id, isExitDocument, name: id }) as unknown as HiringDocumentDefinition;
  const documents = [definition("one"), definition("two"), definition("three"), definition("exit", true)];
  const ticked = { dueDate: null, fileCount: 0, status: "submitted" };
  const filed = { dueDate: null, fileCount: 2, status: "submitted" };
  const person = (hrId: string, hireDate: string | null, papers: Record<string, unknown>, employmentStatus = "active") =>
    ({ documents: papers, employmentStatus, fullName: hrId, hireDate, hrId }) as unknown as HiringDocumentEmployeeRow;
  const employees = [
    person("old", "2020-01-01", { two: ticked, one: ticked }),
    person("none", null, { one: ticked }),
    person("new", "2026-10-01", { one: filed, two: { dueDate: null, fileCount: 0, status: "missing" }, three: ticked, exit: ticked }),
    person("left", "2019-01-01", { exit: ticked }, "resigned"),
    person("clean", "2026-11-01", { one: filed }),
  ];

  const queue = hiringDocumentScanQueue(documents, employees);
  assert.deepEqual(
    queue.map((item) => item.key),
    ["new|three", "old|one", "old|two", "left|exit", "none|one"],
    "newest hire first, one person's papers together in checklist order, an exit paper only for a leaver, no date last",
  );

  const summary = summarizeHiringDocumentReadiness(employees, documents);
  assert.equal(queue.length, summary.submittedDocuments - summary.scannedDocuments, "its length is the figure above the screen");
  assert.deepEqual(
    [...new Set(queue.map((item) => item.employeeHrId))].sort(),
    employees.filter((employee) => hasUnscannedDocuments(employee, documents)).map((employee) => employee.hrId).sort(),
    "the same people as Show who",
  );

  assert.equal(nextScanQueueItem(queue, new Set())?.key, "new|three", "it starts at the top");
  const passed = new Set(["new|three", "old|one"]);
  assert.equal(nextScanQueueItem(queue, passed)?.key, "old|two", "what was filed or skipped does not come back");
  assert.deepEqual(scanQueueProgress(queue, new Set()), { position: 1, skipped: 0, total: 5 }, "Paper 1 of 5");

  // new|three was filed, so the re-read drops it, and old|one was skipped, so it stays.
  const reread = queue.filter((item) => item.key !== "new|three");
  assert.deepEqual(scanQueueProgress(reread, passed), { position: 3, skipped: 1, total: 5 }, "the total holds as the list shrinks, and only a skipped paper counts as skipped");

  const capture = stripComments(readFileSync("src/components/hiring-documents/hiring-document-capture.tsx", "utf8"));
  assert.ok(capture.includes("canManage ? hiringDocumentScanQueue(documents, employees) : []"), "a read-only seat has no queue");
  // Measured at every width: the admin shell lifts a bordered white box unless it says otherwise.
  assert.equal(capture.split("gap-3 border border-phx-line bg-white p-4 shadow-none").length - 1, 2, "the queue's banners stay flat");
  assert.ok(!capture.includes('gap-3 border border-phx-line bg-white p-4"'), "no banner was left lifted");
  const afterSave = capture.slice(capture.indexOf("await onChanged();"));
  assert.ok(capture.indexOf("await reloadFiles();") < capture.indexOf("passQueuePaper();"), "it moves after the re-read, so one paper's files never list under the next");
  assert.ok(afterSave.includes('queueRunningRef.current && (mode === "scan" || stagedPages.length === 0)'), "it never moves with pages staged, which would then save under the wrong paper");
  assert.ok(capture.includes("disabled={busy !== null || stagedPages.length > 0} onClick={passQueuePaper}"), "Skip waits for staged pages and for a save in flight");
  assert.ok(!capture.includes("onChange={(event) => setEmployeeHrId(") && !capture.includes("onChange={(event) => setDocumentId(") && !capture.includes("onClick={() => setDocumentId("), "choosing by hand leaves the queue");
}

function testWhatStandsReadyForDayOne() {
  const reads = {
    details: new Map([
      ["b-1", { bankAccount: true, insuranceNumber: true, nationalId: true }],
      ["b-2", { bankAccount: false, insuranceNumber: false, nationalId: true }],
      ["b-3", { bankAccount: true, insuranceNumber: true, nationalId: false }],
    ]),
    deviceCounts: new Map([["b-1", 2]]),
    logins: new Set(["b-1"]),
    mailboxes: new Map<string, string | null>([["b-1", "connected"], ["b-2", "pending"], ["b-3", "not_needed"]]),
  };
  const allThere = { bankAccount: true, insuranceNumber: true, nationalId: true };
  assert.deepEqual(joinerDayOneFacts("b-1", reads), { details: allThere, devicesOutstanding: 2, hasActiveLogin: true, mailbox: "connected" }, "every read answered");
  assert.deepEqual(joinerDayOneFacts("b-9", reads), { details: null, devicesOutstanding: 0, hasActiveLogin: false, mailbox: "none" }, "read, and nothing there");
  assert.deepEqual(
    joinerDayOneFacts("b-1", { details: null, deviceCounts: null, logins: null, mailboxes: null }),
    { details: null, devicesOutstanding: null, hasActiveLogin: null, mailbox: null },
    "a failed read stays a failed read",
  );

  const values = (joiner: Parameters<typeof joinerDayOneItems>[0]) =>
    joinerDayOneItems(joiner, TODAY).map((item) => `${item.key}:${item.value}:${item.state}`);
  const dayOne = (key: string) => joinerDayOneFacts(key, reads);

  assert.deepEqual(
    values({ dayOne: dayOne("b-1"), employeeHrId: "B-1", startKey: "2026-11-04" }),
    ["record:Created:done", "account:Active:done", "mailbox:Connected:done", "device:2 issued:done", "details:Complete:done"],
    "everything in place",
  );
  assert.deepEqual(
    values({ dayOne: dayOne("b-2"), employeeHrId: "B-2", startKey: "2026-11-20" }),
    ["record:Created:done", "account:Not active yet:open", "mailbox:Pending:open", "device:None issued:neutral", "details:No insurance number, bank account:open"],
    "weeks away: undone but not alarming, and no device is not a gap",
  );
  assert.deepEqual(
    values({ dayOne: dayOne("b-2"), employeeHrId: "B-2", startKey: "2026-11-05" }),
    ["record:Created:done", "account:Not active yet:late", "mailbox:Pending:late", "device:None issued:neutral", "details:No insurance number, bank account:open"],
    "inside three days the undone turn late, but an insurance number or bank account never turns red",
  );
  assert.deepEqual(
    values({ dayOne: dayOne("b-2"), employeeHrId: "B-2", startKey: "" }),
    ["record:Created:done", "account:Not active yet:open", "mailbox:Pending:open", "device:None issued:neutral", "details:No insurance number, bank account:open"],
    "no readable date has no countdown",
  );
  const lastItem = (startKey: string) => values({ dayOne: dayOne("b-3"), employeeHrId: "B-3", startKey }).at(-1);
  assert.equal(lastItem("2026-11-05"), "details:No national ID:late", "a missing national ID turns red inside three days");
  assert.equal(lastItem("2026-11-20"), "details:No national ID:open", "and not weeks away");
  assert.deepEqual(
    values({ dayOne: { details: null, devicesOutstanding: null, hasActiveLogin: null, mailbox: null }, employeeHrId: "B-2", startKey: "2026-11-04" }),
    ["record:Created:done", "account:Not read:unread", "mailbox:Not read:unread", "device:Not read:unread", "details:Not read:unread"],
    "a failed read says so and never reads as a no, however close the day",
  );
  assert.deepEqual(
    values({ dayOne: dayOne(""), employeeHrId: null, startKey: "2026-11-04" }),
    ["record:Not created yet:late", "account:After the record:neutral", "mailbox:After the record:neutral", "device:After the record:neutral", "details:After the record:neutral"],
    "no record: the rest waits for it",
  );

  const service = stripComments(readFileSync("src/lib/hiring-documents/joiners.ts", "utf8"));
  const selects = [...service.matchAll(/\.select\(([^)]*)\)/g)].map((match) => match[1]).join(" ");
  for (const secret of ["sealed_initial_password", "email_address", "login_id", "role", "value", "price", "cost"]) {
    assert.ok(!selects.includes(secret), `${secret} must never reach this panel`);
  }
  assert.equal((service.match(/await dayOneRead\(|dayOneRead\("/g) ?? []).length, 4, "the four reads each go through the wrapper");
  assert.ok(/async function dayOneRead[\s\S]*?catch \(error\)[\s\S]*?return null;/.test(service), "one failing read costs only its own lines");
  assert.ok(service.includes('.eq("status", "outstanding")') && service.includes('.eq("is_placeholder", false)'), "only a device actually out to this person counts");

  // A national ID and a bank account are read to answer yes or no, and only that leaves the server.
  assert.ok(selects.includes('"hr_id,national_id,social_insurance_number,bank_account"'), "the details read is exactly these columns");
  assert.ok(/bankAccount: Boolean\(row\.bank_account\?\.trim\(\)\)/.test(service), "a bank account leaves as yes or no, and spaces are no");
  assert.ok(/insuranceNumber: Boolean\(row\.social_insurance_number\?\.trim\(\)\)/.test(service), "an insurance number leaves as yes or no");
  assert.ok(/nationalId: Boolean\(row\.national_id\?\.trim\(\)\)/.test(service), "a national ID leaves as yes or no");
  const facts = joinerDayOneFacts("b-1", reads);
  assert.ok(Object.values(facts.details ?? {}).every((value) => typeof value === "boolean"), "the payload holds booleans, never a number");

  const panel = stripComments(readFileSync("src/components/hiring-documents/hiring-joiners-panel.tsx", "utf8"));
  assert.equal(panel.split("renderDayOne(joiner)").length - 1, 2, "on the table and on the phone card");
  assert.ok(!panel.includes("Starts</th>"), "the date moved under the name, so five columns fit without shrinking type");
}

export function runHiringJoinersTests() {
  testWhoCountsAsArriving();
  testWhatASaveMayHold();
  testHowFarThePapersHaveCome();
  testTheReadCarriesNoMoneyAndTheWriteIsGated();
  testWhereAJoinerStands();
  testHrFormsSaysWhyABoxIsLocked();
  testOneLineForEachEmployee();
  testHrFormsReadsAsALedger();
  testTheMessageToAJoiner();
  testTheScanQueue();
  testWhatStandsReadyForDayOne();
}
