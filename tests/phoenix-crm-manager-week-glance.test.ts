import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import { MANAGER_SLOT_KINDS, type ManagerHalf, type ManagerSlotKind } from "../src/lib/phoenix-crm/manager-plan-rules.ts";
import {
  districtManagerDayCustomerTail,
  districtManagerDayPill,
  isManagerFieldDay,
  managerAreasTickedLine,
  managerDayIsPlanned,
  managerDayNote,
  managerGlanceAShare,
  managerGlanceCustomerKey,
  managerGlanceCustomerLine,
  managerGlanceCustomers,
  managerGlanceDayState,
  managerGlanceDays,
  managerGlanceDistrictLine,
  managerGlanceDistrictWho,
  managerGlanceGrade,
  managerGlanceGradeLine,
  managerGlanceGridRow,
  managerGlanceHalfName,
  managerGlanceKindBar,
  managerGlanceKindLabel,
  managerGlanceKindsLine,
  managerGlanceMissingHalfWords,
  managerGlanceNoFieldWords,
  managerGlanceOpenHalvesLine,
  managerGlanceOpenLine,
  managerGlancePeopleLine,
  managerGlancePlannedLine,
  managerGlanceRepeatedLine,
  managerGlanceScopeKind,
  managerGlanceScopeWords,
  managerGlanceShares,
  managerGlanceShortDay,
  managerHubWeekExportHref,
  managerSendTally,
  managerWeekGlance,
  MANAGER_GLANCE_KIND_EDGE,
  MANAGER_GLANCE_KIND_SWATCH,
  MANAGER_GLANCE_KINDS,
  MANAGER_GLANCE_OPEN_WORDS,
  MANAGER_GLANCE_PASSED_WORDS,
  MANAGER_HUB_EMPTY_HALF_WORDS,
} from "../src/lib/phoenix-crm/manager-week-glance.ts";
import { buildManagerWeekWorkbook, MANAGER_WEEK_WORKBOOK_SHEETS, managerWeekWorkbookFileName } from "../src/lib/phoenix-crm/server/manager-week-workbook.ts";
import type { ManagerBoardDay, ManagerBoardScope, ManagerBoardSlot, ManagerBoardSlotCustomer, ManagerPlanBoardView } from "../src/lib/phoenix-crm/view-types.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Plan your week in Phoenix CRM, the premium pass (owner, 2026-11-09: "eyeball every report in My Team's Reports,
 * premium polish big work, every single component"). The sixth item of the Regional Sales Manager's menu is his own
 * plan board; the pass put the week at a glance above its steps, an Excel file of the week, and fixed three defects:
 *
 *   1. the district manager's day pill said the same thing twice ("Draft · not sent yet", "Not started · not sent yet");
 *   2. a district manager's week returned for changes wore a sent week's colour (`sent` was "anything but a draft");
 *   3. the panel decided "No customers chosen" by the on-screen word "Admin", not by the half's kind.
 *
 * What would go wrong without these blocks:
 *   - a half typed but not saved counted as planned, or a passed empty half counted as still to plan;
 *   - a holiday counted as an open day;
 *   - one customer on two half-days counted as two customers, or a grade counted per tick;
 *   - a bar ending short of 100%;
 *   - the file disagreeing with the screen, or reachable without the board's own door.
 *
 * The week, worked out by hand — Hany Saad, a Regional Sales Manager, Saturday 7 to Thursday 12 November 2026, viewed
 * on Monday 9 (Saturday and Sunday have passed). Three district managers are offered: Delta (1) — Nermeen Adel,
 * Cairo (1) — Mohamed Eleiwa, and Alexandria with nobody on the seat.
 *   - Sat 7 (passed): AM with Nermeen Adel (Dr. Mona Saleh A, Dr. Adel Fawzy B); PM nothing — passed, never open.
 *   - Sun 8: a public holiday — not a field day.
 *   - Mon 9: AM with Ahmed Ali, Delta (Dr. Mona Saleh again, and an own-list customer no longer on the rep's day,
 *     no grade); PM Admin · Office. The only day planned in full.
 *   - Tue 10: AM with Sara Kamal, Cairo (1); PM open.
 *   - Wed 11: AM single visit, Heliopolis, Cairo (1) (Dr. Hany Fathy C); PM open.
 *   - Thu 12: a morning only, open.
 * So: 5 field days, 9 halves, 5 planned, 3 still to plan, 1 passed empty, 1 day planned; 5 ticks, 4 customers.
 */

const WEEK = "2026-11-07";

const customer = (name: string, over: Partial<ManagerBoardSlotCustomer> = {}): ManagerBoardSlotCustomer => ({
  areaSeatId: null,
  customerId: `id-${name}`,
  flag: null,
  flagLabel: null,
  grade: null,
  managerCustomerId: null,
  name,
  own: false,
  speciality: null,
  ...over,
});

const MONA = customer("Dr. Mona Saleh", { grade: "a", speciality: "Paediatrics" });
const ADEL = customer("Dr. Adel Fawzy", { grade: " B ", speciality: "Paediatrics" });
const GONE = customer("Dr. Samia Lotfy", { customerId: null, flag: "dropped", flagLabel: "No longer on the rep's day", managerCustomerId: "own-1", own: true });
const HANY = customer("Dr. Hany Fathy", { grade: "C", speciality: "General Practice" });

function slot(half: ManagerHalf, kind: ManagerSlotKind, over: Partial<ManagerBoardSlot> = {}): ManagerBoardSlot {
  return {
    activityLabel: null,
    activityType: null,
    areaName: null,
    areaSeatId: null,
    areaSeatIds: [],
    customers: [],
    dmName: null,
    half,
    kind,
    kindLabel: MANAGER_SLOT_KINDS.find((entry) => entry.key === kind)?.label ?? kind,
    note: null,
    repName: null,
    repSeatId: null,
    scopeKey: null,
    scopeName: null,
    seniorHrId: null,
    seniorName: null,
    seniorTitle: null,
    summary: null,
    tickedAreas: [],
    ...over,
  };
}

function day(date: string, dateText: string, over: Partial<ManagerBoardDay> = {}): ManagerBoardDay {
  return { date, dateText, districtManagerDays: [], editable: true, halves: ["AM", "PM"], holiday: null, passed: false, repHalves: [], slots: [], ...over };
}

const SCOPES: ManagerBoardScope[] = [
  { dmName: "Nermeen Adel", dmSeatId: "D1", group: null, key: "dm:D1", lineCode: "PED", lineName: "Pedia", name: "Delta (1) — Nermeen Adel", place: "Delta (1)", regionCode: null },
  { dmName: "Mohamed Eleiwa", dmSeatId: "C1", group: null, key: "dm:C1", lineCode: "PED", lineName: "Pedia", name: "Cairo (1) — Mohamed Eleiwa", place: "Cairo (1)", regionCode: null },
  { dmName: null, dmSeatId: "A1", group: null, key: "dm:A1", lineCode: "PED", lineName: "Pedia", name: "Alexandria — no district manager", place: "Alexandria", regionCode: null },
];

const SLOT_KINDS: ManagerPlanBoardView["slotKinds"] = [
  { key: "with_rep", label: "With a rep" },
  { key: "with_dm", label: "With a district manager" },
  { key: "with_senior", label: "With a peer" },
  { key: "admin", label: "Admin" },
  { key: "single_visit", label: "Single visit" },
];

function sampleView(over: Partial<ManagerPlanBoardView> = {}): ManagerPlanBoardView {
  const days: ManagerBoardDay[] = [
    day("2026-11-07", "Saturday 7 November", {
      editable: false,
      passed: true,
      slots: [slot("AM", "with_dm", { customers: [MONA, ADEL], dmName: "Nermeen Adel", scopeKey: "dm:D1", scopeName: "Delta (1) — Nermeen Adel", summary: "With Nermeen Adel · 2 areas" })],
    }),
    day("2026-11-08", "Sunday 8 November", { editable: false, halves: [], holiday: "Public holiday", passed: true }),
    day("2026-11-09", "Monday 9 November", {
      slots: [
        slot("AM", "with_rep", { customers: [MONA, GONE], repName: "Ahmed Ali", repSeatId: "R1", scopeKey: "dm:D1", scopeName: "Delta (1) — Nermeen Adel", summary: "With Ahmed Ali · 2 customers" }),
        slot("PM", "admin", { activityLabel: "Office", activityType: "office", summary: "Office" }),
      ],
    }),
    day("2026-11-10", "Tuesday 10 November", {
      slots: [slot("AM", "with_rep", { repName: "Sara Kamal", repSeatId: "R5", scopeKey: "dm:C1", scopeName: "Cairo (1) — Mohamed Eleiwa", summary: "With Sara Kamal · 0 customers" })],
    }),
    day("2026-11-11", "Wednesday 11 November", {
      slots: [
        slot("AM", "single_visit", { areaName: "Heliopolis", customers: [HANY], scopeKey: "dm:C1", scopeName: "Cairo (1) — Mohamed Eleiwa", summary: "Single visit · Heliopolis · 1 customer" }),
        // A slot row with no kind is an emptied half — never a planned one.
        slot("PM", "admin", { kind: null, kindLabel: null, summary: null }),
      ],
    }),
    day("2026-11-12", "Thursday 12 November", { halves: ["AM"] }),
  ];
  return {
    activities: [],
    adminDeletes: false,
    areas: [],
    canWrite: true,
    customersOptional: false,
    days,
    districtManagerPlanUnread: false,
    isTest: false,
    manager: { hrId: "B-55", name: "Hany Saad", place: "Regional Sales Manager · Pedia" },
    managers: null,
    mode: "own",
    plan: {
      conversation: null,
      decisionNote: null,
      dueText: "Thursday 5 November, 23:55",
      editAsk: null,
      firstApproverName: "Ali Mohamed Ali",
      hrAcknowledged: false,
      overdue: true,
      planId: "PLAN-H",
      returnedDay: null,
      secondApproverName: null,
      sentText: null,
      state: "plan",
      status: "draft",
      statusLabel: "Draft",
      statusLine: "Draft — not sent yet",
      submittedLate: null,
      version: 3,
    },
    reps: [],
    scope: null,
    scopes: SCOPES,
    seniors: [],
    singleVisitDaysApproved: null,
    singleVisitHalvesUsed: null,
    slotKinds: SLOT_KINDS,
    weekStart: WEEK,
    weeks: [{ coming: false, name: "This week", statusLabel: "Draft", weekStart: WEEK }],
    writer: { kind: "rsm", title: "Regional Sales Manager" },
    ...over,
  };
}

function daysAndWords() {
  assert.equal(managerGlanceShortDay("2026-11-07"), "Sat 7");
  assert.equal(managerGlanceShortDay("2026-11-12"), "Thu 12");
  assert.equal(managerGlanceShortDay("2026-11-13"), "Fri 13");
  assert.equal(managerGlanceHalfName("2026-11-10", "PM"), "Tue 10 PM");
  const view = sampleView();
  const [sat, sun, mon, tue, wed, thu] = view.days;
  assert.equal(isManagerFieldDay(sat), true);
  assert.equal(isManagerFieldDay(sun), false, "a holiday is not a field day");
  assert.equal(isManagerFieldDay(day("2026-11-13", "Friday 13 November", { halves: [] })), false, "a day with no half is not one either");
  // The day list's finished mark, now in the lib: every half, or any one where AM and PM are each optional.
  assert.equal(managerDayIsPlanned(mon, false), true);
  assert.equal(managerDayIsPlanned(tue, false), false);
  assert.equal(managerDayIsPlanned(tue, true), true, "one half is enough for a planner whose halves are optional");
  assert.equal(managerDayIsPlanned(wed, false), false, "an emptied half (no kind) is not planned");
  assert.equal(managerDayIsPlanned(thu, true), false);
  assert.equal(managerDayIsPlanned(sun, true), false, "a holiday is never planned");
  // The day note: the saved summary, unless a half is typed and not saved — then why, when it cannot save.
  assert.equal(managerDayNote(sun, () => null), "Public holiday · no plan");
  assert.equal(managerDayNote(day("2026-11-13", "Friday", { halves: [] }), () => null), "No field day");
  assert.equal(managerDayNote(mon, () => null), "AM: With Ahmed Ali · 2 customers · PM: Office");
  assert.equal(managerDayNote(tue, (half) => (half === "PM" ? { problem: "Choose an activity" } : null)), "AM: With Sara Kamal · 0 customers · PM: Not saved: Choose an activity");
  assert.equal(managerDayNote(tue, (half) => (half === "PM" ? { problem: null } : null)), "AM: With Sara Kamal · 0 customers · PM: Not saved yet");
  assert.equal(managerDayNote(thu, () => null), "AM: Nothing planned");
  assert.equal(managerAreasTickedLine(2, 5), "2 of 5 areas ticked");
  assert.equal(managerAreasTickedLine(0, 1), "0 of 1 area ticked");
  // The kinds' words come from this planner's board, then the form's.
  assert.equal(managerGlanceKindLabel(view, "with_senior"), "With a peer");
  assert.equal(managerGlanceKindLabel(view, "with_area"), "An area", "a kind the board does not offer still has its form words");
}

function theWeek() {
  const view = sampleView();
  const glance = managerWeekGlance(view);
  assert.equal(glance.fieldDays, 5, "Sunday's holiday is left out");
  assert.equal(glance.halves, 9, "Thursday is a morning only");
  assert.equal(glance.planned, 5);
  assert.equal(glance.open, 3, "Tuesday PM, Wednesday PM and Thursday AM");
  assert.equal(glance.passedOpen, 1, "Saturday PM has passed: never still to plan");
  assert.equal(glance.planned + glance.open + glance.passedOpen, glance.halves, "every half is counted once");
  assert.equal(glance.daysPlanned, 1, "only Monday is planned in full");
  assert.deepEqual(
    glance.openHalves.map((entry) => entry.name),
    ["Tue 10 PM", "Wed 11 PM", "Thu 12 AM"],
  );
  assert.deepEqual(glance.byKind, { admin: 1, single_visit: 1, with_area: 0, with_dm: 1, with_rep: 2, with_senior: 0 });
  assert.deepEqual(glance.kinds, ["with_rep", "with_dm", "with_senior", "admin", "single_visit"], "the offered kinds, in the form's order");
  // Districts: by half-days, then name; the one with nobody on the seat is not in the week.
  assert.deepEqual(
    glance.districts.map((district) => [district.name, district.halves, district.days, district.withDm]),
    [
      ["Cairo (1) — Mohamed Eleiwa", 2, 2, 0],
      ["Delta (1) — Nermeen Adel", 2, 2, 1],
    ],
  );
  assert.deepEqual(glance.districtsNotIn, ["Alexandria — no district manager"]);
  assert.equal(managerGlanceDistrictLine(glance.districts[1]), "2 half-days on 2 days · 1 with the district manager");
  assert.equal(managerGlanceDistrictLine({ days: 1, halves: 1, withDm: 0 }), "1 half-day on 1 day");
  // People: the reps and the managers the week goes with.
  assert.deepEqual(glance.reps.map((person) => [person.name, person.halves, person.halfNames]), [
    ["Ahmed Ali", 1, ["Mon 9 AM"]],
    ["Sara Kamal", 1, ["Tue 10 AM"]],
  ]);
  assert.deepEqual(glance.managers.map((person) => person.name), ["Nermeen Adel"]);
  assert.equal(managerGlancePeopleLine(glance.reps), "Ahmed Ali 1 · Sara Kamal 1");
  assert.equal(managerGlancePeopleLine([]), null);
  // The words.
  assert.equal(managerGlancePlannedLine(glance), "5 of 9 half-days planned");
  assert.equal(managerGlanceOpenLine(glance), "3 still to plan · 1 passed with nothing planned");
  assert.equal(managerGlanceOpenHalvesLine(glance), "Still open: Tue 10 PM · Wed 11 PM · Thu 12 AM");
  assert.equal(managerGlanceKindsLine(view, glance), "With a rep 2 · With a district manager 1 · Admin 1 · Single visit 1");
  assert.equal(managerGlancePlannedLine({ halves: 0, planned: 0 }), "No field half-day this week");
  assert.equal(managerGlanceOpenLine({ halves: 4, open: 0, passedOpen: 0 }), "Every half-day is planned");
  assert.equal(managerGlanceOpenLine({ halves: 0, open: 0, passedOpen: 0 }), "Nothing to plan");
  assert.equal(managerGlanceOpenHalvesLine({ openHalves: [] }), null);
  // A district manager's own board offers no district: the week goes to none, and none is "not in".
  const own = managerWeekGlance({ ...view, scopes: [] });
  assert.deepEqual(own.districtsNotIn, []);
  assert.equal(own.districts.length, 2, "a saved half still names its district");
}

function theGrid() {
  const rows = managerGlanceDays(sampleView());
  assert.deepEqual(rows.map((row) => row.shortDay), ["Sat 7", "Sun 8", "Mon 9", "Tue 10", "Wed 11", "Thu 12"], "every day the board holds, Saturday first");
  const [sat, sun, mon, , wed, thu] = rows;
  assert.deepEqual(sat.cells.map((cell) => [cell.half, cell.state, cell.kind]), [
    ["AM", "planned", "with_dm"],
    ["PM", "passed_open", null],
  ]);
  assert.equal(sat.cells[1].text, MANAGER_GLANCE_PASSED_WORDS);
  assert.equal(sat.passed, true);
  assert.equal(sun.fieldDay, false);
  assert.deepEqual(sun.cells, [], "a holiday has no half to show");
  assert.equal(sun.holiday, "Public holiday");
  assert.equal(mon.planned, true);
  assert.equal(mon.cells[0].customers, 2);
  assert.equal(mon.cells[1].text, "Office");
  assert.equal(wed.cells[1].state, "open", "an emptied half is open");
  assert.equal(wed.cells[1].text, MANAGER_GLANCE_OPEN_WORDS);
  assert.deepEqual(thu.cells.map((cell) => cell.half), ["AM"], "Thursday has no afternoon");
}

function theCustomers() {
  const view = sampleView();
  const customers = managerGlanceCustomers(view.days);
  assert.equal(customers.ticked, 5);
  assert.equal(customers.distinct, 4, "Dr. Mona Saleh on two half-days is one customer");
  assert.deepEqual(customers.byGrade, { A: 1, B: 1, C: 1, none: 1 }, "grades count customers, read whatever their case or spaces");
  assert.equal(customers.own, 1);
  assert.deepEqual(customers.marked, [{ flagLabel: "No longer on the rep's day", name: "Dr. Samia Lotfy" }]);
  assert.deepEqual(customers.repeated, [{ name: "Dr. Mona Saleh", times: 2 }]);
  assert.equal(managerGlanceCustomerLine(customers), "5 ticks · 4 different customers");
  assert.equal(managerGlanceGradeLine(customers), "1 A · 1 B · 1 C · 1 with no grade");
  assert.equal(managerGlanceAShare(customers), 33, "1 A of the 3 graded");
  assert.equal(managerGlanceRepeatedLine(customers), "Ticked more than once: Dr. Mona Saleh ×2");
  // Nobody ticked: words, never a zero share.
  const none = managerGlanceCustomers([]);
  assert.equal(managerGlanceCustomerLine(none), "No customer ticked");
  assert.equal(managerGlanceGradeLine(none), null);
  assert.equal(managerGlanceAShare(none), null);
  assert.equal(managerGlanceRepeatedLine(none), null);
  // A holiday's slots (a loader fault) never count.
  const leaked = managerGlanceCustomers([day("2026-11-08", "Sunday", { halves: [], holiday: "Public holiday", slots: [slot("AM", "with_rep", { customers: [MONA] })] })]);
  assert.equal(leaked.ticked, 0);
  // The key: the list's id, then Manager's own list's, then the name folded.
  assert.equal(managerGlanceCustomerKey(MONA), "c:id-Dr. Mona Saleh");
  assert.equal(managerGlanceCustomerKey(GONE), "m:own-1");
  assert.equal(managerGlanceCustomerKey({ customerId: null, managerCustomerId: null, name: " Dr. X " }), "n:dr. x");
  assert.equal(managerGlanceGrade("b"), "B");
  assert.equal(managerGlanceGrade("D"), "none");
  assert.equal(managerGlanceGrade(null), "none");
  // A flag on the later half is still the customer's flag.
  const later = managerGlanceCustomers([
    day("2026-11-09", "Mon", { slots: [slot("AM", "with_rep", { customers: [MONA] }), slot("PM", "with_rep", { customers: [{ ...MONA, flag: "dropped", flagLabel: "No longer on the rep's day" }] })] }),
  ]);
  assert.deepEqual(later.marked.map((entry) => entry.name), ["Dr. Mona Saleh"]);
}

function theBar() {
  assert.deepEqual(managerGlanceShares([1, 1, 1]), [34, 33, 33], "the point left goes to the first of the tied remainders");
  assert.deepEqual(managerGlanceShares([2, 1]), [67, 33]);
  assert.deepEqual(managerGlanceShares([0, 0]), [0, 0], "nothing to share is all zeros");
  assert.deepEqual(managerGlanceShares([5, 0, 2]), [71, 0, 29], "a zero never takes a point");
  for (const counts of [[1, 1, 1], [3, 3, 1], [1, 2, 3, 4, 5, 6], [7], [1, 1, 1, 1, 1, 1, 1]]) {
    assert.equal(managerGlanceShares(counts).reduce((sum, share) => sum + share, 0), 100, `${counts.join(",")} adds up to 100`);
  }
  const view = sampleView();
  const bar = managerGlanceKindBar(view, managerWeekGlance(view));
  assert.deepEqual(bar.map((part) => [part.kind, part.count, part.share]), [
    ["with_rep", 2, 40],
    ["with_dm", 1, 20],
    ["admin", 1, 20],
    ["single_visit", 1, 20],
  ]);
  assert.equal(bar.reduce((sum, part) => sum + part.share, 0), 100);
  assert.equal(bar.reduce((sum, part) => sum + part.count, 0), managerWeekGlance(view).planned, "the bar is the planned half-days");
  // Flat colour, and no kind wears a warning colour.
  for (const kind of MANAGER_GLANCE_KINDS) {
    assert.ok(!/rose|red|amber|orange/.test(MANAGER_GLANCE_KIND_SWATCH[kind] + MANAGER_GLANCE_KIND_EDGE[kind]), `${kind} is never a warning colour`);
  }
}

function theDistrictManagerDay() {
  assert.deepEqual(districtManagerDayPill({ standing: "approved", statusLabel: "Approved" }), { text: "Approved", tone: "good" });
  assert.deepEqual(districtManagerDayPill({ standing: "waiting", statusLabel: "Waiting for approval" }), { text: "Waiting for approval", tone: "info" });
  assert.deepEqual(districtManagerDayPill({ standing: "waiting", statusLabel: "Ended before it was approved" }), { text: "Ended before it was approved", tone: "info" }, "an ended week was sent: it reads its own words");
  assert.deepEqual(districtManagerDayPill({ standing: "returned", statusLabel: "Returned for changes" }), { text: "Returned for changes · may still change", tone: "warn" }, "a returned week never wears a sent week's colour");
  assert.deepEqual(districtManagerDayPill({ standing: "draft", statusLabel: "Draft" }), { text: "Draft · may still change", tone: "warn" });
  assert.deepEqual(districtManagerDayPill({ standing: "not_started", statusLabel: "Not started" }), { text: "Not started", tone: "neutral" });
  for (const standing of ["approved", "waiting", "returned", "draft", "not_started"] as const) {
    assert.ok(!districtManagerDayPill({ standing, statusLabel: "Draft" }).text.includes("not sent yet"), "never the words said twice");
  }
  // The tone follows the standing, never the words: an approved standing under other words is still good.
  assert.equal(districtManagerDayPill({ standing: "approved", statusLabel: "Something else" }).tone, "good");
}

async function theWorkbook() {
  const view = sampleView();
  const buffer = await buildManagerWeekWorkbook(view, "2026-11-09T08:30:00Z");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [...MANAGER_WEEK_WORKBOOK_SHEETS]);
  assert.deepEqual([...MANAGER_WEEK_WORKBOOK_SHEETS], ["Cover", "Week", "Half-days", "Customers", "People"], "the Week sheet follows the cover");
  assert.equal(managerWeekWorkbookFileName(view), "week-plan-hany-saad-2026-11-07.xlsx");
  assert.equal(managerWeekWorkbookFileName({ manager: { hrId: "x", name: "Dr. Ola  O'Reilly", place: "" }, weekStart: WEEK }), "week-plan-dr-ola-oreilly-2026-11-07.xlsx");
  assert.equal(managerWeekWorkbookFileName({ manager: null, weekStart: WEEK }), "week-plan-manager-2026-11-07.xlsx");
  const text = (name: string) => {
    const values: string[] = [];
    workbook.getWorksheet(name)!.eachRow((row) => row.eachCell((cell) => values.push(String(cell.value ?? ""))));
    return values;
  };
  const cover = text("Cover");
  for (const expected of ["Hany Saad · Regional Sales Manager · Pedia", "Draft", "5 of 9 half-days planned", "1 of 5 field days", "Ahmed Ali 1 · Sara Kamal 1", "5 ticks · 4 different customers", "Alexandria — no district manager"]) {
    assert.ok(cover.some((value) => value.includes(expected)), `cover: ${expected}`);
  }
  // Half-days: every half of every field day once, the holiday as one line.
  let halves = 0;
  workbook.getWorksheet("Half-days")!.eachRow((row) => {
    const value = String(row.getCell(2).value ?? "");
    if (value === "AM" || value === "PM") halves += 1;
  });
  assert.equal(halves, managerWeekGlance(view).halves, "the file holds every half once");
  const halfText = text("Half-days");
  assert.ok(halfText.includes("Public holiday · no plan"));
  assert.ok(halfText.includes(MANAGER_GLANCE_PASSED_WORDS) && halfText.includes(MANAGER_GLANCE_OPEN_WORDS));
  assert.ok(halfText.includes("Office"), "an Admin half names its activity");
  // Customers: one row per tick.
  let ticks = 0;
  workbook.getWorksheet("Customers")!.eachRow((row) => {
    const value = String(row.getCell(2).value ?? "");
    if (value === "AM" || value === "PM") ticks += 1;
  });
  assert.equal(ticks, 5);
  const customers = text("Customers");
  assert.ok(customers.includes("Manager's own list") && customers.includes("No longer on the rep's day") && customers.includes("No grade"));
  const people = text("People");
  assert.ok(people.includes("Not in the week") && people.includes("Nermeen Adel") && people.includes("Seat is vacant") === false);
  assert.ok(people.includes("Rep") && people.includes("Manager"));
  const source = stripComments(readFileSync("src/lib/phoenix-crm/server/manager-week-workbook.ts", "utf8"));
  assert.ok(source.includes("buildHouseCoverSheet") && source.includes("writeHouseMasthead"), "the file wears the house identity");
  assert.ok(source.includes("managerWeekGlance(view)"), "the file reads the screen's arithmetic");
  assert.ok(!/\bhis\b|\bhim\b|\bhe\b/i.test(source), "neutral wording in the file");
}

function theExportDoor() {
  const route = stripComments(readFileSync("app/api/phoenix-crm/manager-plans/export/route.ts", "utf8"));
  const gate = route.indexOf('assertPermission(access, "phoenix_crm", "read")');
  const read = route.indexOf("loadManagerPlanBoard(viewer");
  assert.ok(gate > 0 && read > gate, "the module's gate is asked before the board is read");
  assert.ok(route.includes("assertExportRateLimit("), "rate-limited");
  assert.ok(route.includes('entityType: "crm_manager_week_export"'), "every download is audited");
  assert.ok(route.indexOf("writeAuditLog(") > read, "audited after the read, naming whose week");
  assert.ok(!/saveManagerPlanSlot|crmPost|\.insert\(|\.upsert\(|\.update\(/.test(route), "the export never writes the plan");
  assert.ok(route.includes("scope: null"), "the file holds the whole week, never one district's reps");
  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.ok(
    registry.includes('sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/phoenix-crm/manager-plans/export", permission: { resource: "phoenix_crm", action: "read" }'),
    "registered as an audited export",
  );
  assert.ok(readFileSync("src/lib/admin/audit-entity-types.ts", "utf8").includes("crm_manager_week_export: true,"));
  assert.ok(readFileSync("src/lib/admin/audit.ts", "utf8").includes('| "crm_manager_week_export"'));
}

function theBoard() {
  const board = stripComments(readFileSync("src/components/phoenix-crm/manager-plan-board.tsx", "utf8"));
  assert.ok(board.includes('import { ManagerWeekGlancePanel } from "@/components/phoenix-crm/manager-week-glance";'));
  assert.match(board, /\{step !== 3 \? \(\s*<ManagerWeekGlancePanel/, "the glance is never over a half-day being edited");
  assert.ok(board.includes("crmUrl(`${BOARD}/export`"), "the download is the board's own door");
  assert.ok(!board.includes("not sent yet"), "the district manager's pill never says the same thing twice");
  assert.ok(board.includes("districtManagerDayPill(dmDay).tone"), "its colour comes from where the week stands");
  assert.ok(!board.includes('kindLabel !== "Admin"'), "the panel asks the half's kind, never its words");
  assert.ok(board.includes("!entry.admin ?"));
  assert.ok(!/function dayIsPlanned\(/.test(board), "the day list's finished mark lives in the lib");
  assert.ok(board.includes("managerDayNote(day, (half) =>"));
  assert.ok(!board.includes(" areas\")} ticked`"), "the areas line is the lib's");
  const loader = stripComments(readFileSync("src/lib/phoenix-crm/server/manager-dm-day.ts", "utf8"));
  assert.ok(loader.includes("sent: isManagerPlanSent(week.status),"), "a returned week is not sent");
  assert.ok(loader.includes("standing: districtManagerWeekStanding(week.status),"));
  assert.ok(!loader.includes('week.status !== "draft"'), "never 'anything but a draft'");
}

function theFlatKit() {
  const panel = stripComments(readFileSync("src/components/phoenix-crm/manager-week-glance.tsx", "utf8"));
  assert.ok(!/\brounded(?!-none)/.test(panel), "square corners");
  assert.ok(!/shadow-|gradient|blur|glow/.test(panel), "flat colour: no shadow, gradient or glow");
  assert.ok(!/\btruncate\b|line-clamp|text-ellipsis|…/.test(panel), "no ellipsis");
  assert.ok(!/overflow-x-auto|min-w-\[/.test(panel), "never a sideways scroll");
  assert.ok(panel.includes("<CrmTable ") && !panel.includes("<table") && panel.includes("lg:hidden"), "a fixed table on a desktop, through the module's CrmTable (w-full table-fixed and its colgroup), and cards on a phone");
  const widths = [...(panel.match(/const WEEK_GRID_COLUMNS = \[([^\]]*)\]/)?.[1] ?? "").matchAll(/"(\d+)%"/g)].map((match) => Number(match[1]));
  assert.equal(widths.length, 3, "the day, the morning and the afternoon");
  assert.equal(widths.reduce((sum, width) => sum + width, 0), 100, "the columns add up to 100%");
  assert.ok(panel.includes("managerWeekGlance(view)"), "every figure comes from the lib");
  const strings = [...panel.matchAll(/>([^<>{}]+)</g)].map((match) => match[1]).join(" ");
  assert.ok(!/\bhis\b|\bhim\b|\bhe\b/i.test(strings), "neutral words on the screen");
  const lib = stripComments(readFileSync("src/lib/phoenix-crm/manager-week-glance.ts", "utf8"));
  assert.ok(!/from "@\/lib\/phoenix-crm\/server\/(?!.*import type)/.test(lib.split("\n").filter((line) => line.startsWith("import ") && !line.startsWith("import type")).join("\n")), "the lib imports no server code");
  assert.ok(!/statusLabel === /.test(lib), "the pill never reads its own words");
}

function theSendStep() {
  // The Send step counts the days still to come, and counts a half typed here once it can save.
  const view = sampleView();
  const none = () => null;
  const tally = managerSendTally(view.days, none);
  assert.equal(tally.fieldHalves, 7, "Monday to Thursday: Saturday has passed, Sunday has no half");
  assert.equal(tally.planned, 4, "Monday AM and PM, Tuesday AM, Wednesday AM — Saturday's half is history");
  assert.deepEqual(tally.emptyHalves, ["Tuesday 10 November PM", "Wednesday 11 November PM", "Thursday 12 November AM"]);
  assert.equal(tally.offRepDay, 1, "the one flagged tick");
  // A half typed and able to save counts; one missing something does not; an emptied kind does not.
  const typed = managerSendTally(view.days, (date, half) => {
    if (date === "2026-11-10" && half === "PM") return { kind: "admin", problem: null };
    if (date === "2026-11-11" && half === "PM") return { kind: "with_rep", problem: "Choose a rep" };
    if (date === "2026-11-12" && half === "AM") return { kind: null, problem: null };
    return null;
  });
  assert.equal(typed.planned, 5);
  assert.deepEqual(typed.emptyHalves, ["Wednesday 11 November PM", "Thursday 12 November AM"]);
  // A typed half over a saved one is what counts: clearing a saved half's problem-free kind still counts it.
  const cleared = managerSendTally(view.days, (date, half) => (date === "2026-11-09" && half === "PM" ? { kind: "admin", problem: "Choose an activity" } : null));
  assert.equal(cleared.planned, 3, "a saved half typed over and not able to save is not counted");
  // A day that can no longer be edited is never named as going empty.
  const locked = managerSendTally(view.days.map((day) => ({ ...day, editable: false })), none);
  assert.deepEqual(locked.emptyHalves, []);
  assert.equal(locked.planned, 4, "locking a day never changes what was planned");
  // The board reads this one function.
  const board = stripComments(readFileSync("src/components/phoenix-crm/manager-plan-board.tsx", "utf8"));
  assert.ok(board.includes("managerSendTally(days, (date, half) =>"), "the Send step counts through the lib");
  assert.ok(!/const comingDays = days\.filter/.test(board), "never a second count on the board");
}

function theApproversView() {
  // The Approvals Hub's page of a manager's week shows the same glance, text only, with the hub's own download.
  const hub = stripComments(readFileSync("src/components/approvals-hub/manager-plan-request-detail.tsx", "utf8"));
  assert.ok(hub.includes('import { ManagerWeekGlancePanel } from "@/components/phoenix-crm/manager-week-glance";'));
  assert.ok(
    hub.includes("<ManagerWeekGlancePanel canOpen={false} exportHref={managerHubWeekExportHref(detail.planId)} view={detail.board} />"),
    "the approver reads the planner's own figures, never opening a half",
  );
  assert.ok(!/<ManagerWeekGlancePanel[^>]*onOpenHalf/.test(hub), "a server page hands the client panel no function");
  assert.ok(hub.indexOf("<ManagerWeekGlancePanel") < hub.indexOf("<WeekDays detail={detail} />"), "the glance comes before the half-by-half read");
  assert.ok(!hub.includes('"use client"'), "the hub page stays a server component");
  assert.match(hub, /import \{[^}]*managerHubWeekExportHref,[^}]*\} from "@\/lib\/phoenix-crm\/manager-week-glance";/, "the hub's link is the lib's");
  // Its half-by-half read holds every half the day holds, an empty one by its words — never only the saved ones.
  assert.ok(hub.includes("{day.halves.map((half) => {") && hub.includes("const slot = managerSavedSlot(day, half);"), "every half, from the day's own halves");
  assert.ok(!hub.includes("{day.slots.map((slot) => ("), "never the saved slots alone, which hid an empty half");
  assert.match(
    hub,
    /if \(!slot\) \{\s*return \(\s*<div key=\{half\}[\s\S]{0,400}?\{MANAGER_HUB_EMPTY_HALF_WORDS\}/,
    "an empty half renders its own row with its words, never nothing",
  );
  assert.equal(MANAGER_HUB_EMPTY_HALF_WORDS, "Nothing planned for this half");
  assert.ok(hub.includes("MANAGER_GLANCE_KIND_EDGE[slot.kind]"), "a planned half wears its kind's edge, as on the glance");
  assert.ok(hub.includes('managerGlanceGrade(customer.grade) !== "none"') && !hub.includes("· {customer.grade}</span>"), "a grade read whatever its case");
  // The panel takes no handler and no link when it has none to give.
  const panel = stripComments(readFileSync("src/components/phoenix-crm/manager-week-glance.tsx", "utf8"));
  assert.ok(panel.includes("onOpenHalf?: (date: string, half: ManagerHalf) => void;"));
  assert.ok(panel.includes("exportHref: string | null;"));
  assert.ok(panel.includes("const opens = canOpen && onOpenHalf !== undefined;"), "no handler, nothing opens");
  assert.ok(panel.includes("{exportHref ? ("), "no door, no link");
  assert.match(panel, /<WeekGrid canOpen=\{opens\}/);
  assert.match(panel, /<OpenHalves canOpen=\{opens\}/);
}

function theHubDoor() {
  assert.equal(managerHubWeekExportHref("1f0e1c1a-0000-4000-8000-000000000001"), "/api/phoenix-crm/manager-plans/export?plan=1f0e1c1a-0000-4000-8000-000000000001");
  assert.equal(managerHubWeekExportHref("a b"), "/api/phoenix-crm/manager-plans/export?plan=a%20b", "the id is always encoded");
  const route = stripComments(readFileSync("app/api/phoenix-crm/manager-plans/export/route.ts", "utf8"));
  const gate = route.indexOf('assertPermission(access, "phoenix_crm", "read")');
  const hubRead = route.indexOf("loadManagerPlanHubDetail(access, planId)");
  const boardRead = route.indexOf("loadManagerPlanBoard(viewer");
  assert.ok(gate > 0 && hubRead > gate && boardRead > gate, "both doors sit behind the module's gate");
  assert.ok(route.indexOf("assertExportRateLimit(") < hubRead, "both doors are rate-limited");
  assert.match(route, /if \(detail\.kind !== "plan"\) \{\s*return NextResponse\.json\(\{ error: "not_found"[^}]*\}, \{ status: 404 \}\);/, "anything but a week the viewer may open is not found");
  assert.ok(!/detail\.kind !== "plan"[\s\S]{0,200}loadManagerPlanBoard/.test(route), "a refused hub id never falls through to the board's door");
  assert.ok(route.includes('${planId ? ", from the Approvals Hub" : ""}'), "the audit says which door");
  const hubLoader = stripComments(readFileSync("src/lib/phoenix-crm/server/manager-plan-hub.ts", "utf8"));
  assert.ok(hubLoader.includes("if (!mayOpenManagerRecord(viewer, plan.managerHrId,"), "the hub's proof is the one the page uses");
}

/**
 * The Training Manager's week (owner, 2026-10-24: she holds no seat and plans by region) — worked out by hand: two
 * regions offered, Cairo and Delta. Mon 9 AM with Sara Kamal in Cairo, Mon 9 PM An area · Heliopolis in Cairo, Tue 10 AM
 * the Office; the rest open. Cairo holds two half-days on one day; Delta is not in the week.
 */
function trainingManagerView(): ManagerPlanBoardView {
  const regions: ManagerBoardScope[] = [
    { dmName: null, dmSeatId: null, group: null, key: "region:CAI", lineCode: "PED", lineName: "Pedia", name: "Cairo region", place: null, regionCode: "CAI" },
    { dmName: null, dmSeatId: null, group: null, key: "region:DEL", lineCode: "PED", lineName: "Pedia", name: "Delta region", place: null, regionCode: "DEL" },
  ];
  const base = sampleView();
  return {
    ...base,
    days: [
      day("2026-11-09", "Monday 9 November", {
        slots: [
          slot("AM", "with_rep", { repName: "Sara Kamal", repSeatId: "R5", scopeKey: "region:CAI", scopeName: "Cairo region", summary: "With Sara Kamal · Cairo region" }),
          slot("PM", "with_area", { areaName: "Heliopolis", scopeKey: "region:CAI", scopeName: "Cairo region", summary: "Area · Heliopolis · Cairo region" }),
        ],
      }),
      day("2026-11-10", "Tuesday 10 November", { slots: [slot("AM", "admin", { activityLabel: "Office", activityType: "office", summary: "Office" })] }),
    ],
    manager: { hrId: "B-77", name: "Rania Hassan", place: "Training Manager" },
    scopes: regions,
    slotKinds: [
      { key: "with_rep", label: "With a rep" },
      { key: "with_area", label: "An area" },
      { key: "admin", label: "Admin" },
    ],
    writer: { kind: "tm", title: "Training Manager" },
  };
}

async function theScopeWords() {
  // A district, a whole line and a region are three different things, worded as what they are.
  assert.equal(managerGlanceScopeKind({ dmSeatId: "D1", regionCode: null }), "district");
  assert.equal(managerGlanceScopeKind({ dmSeatId: null, regionCode: null }), "line");
  assert.equal(managerGlanceScopeKind({ dmSeatId: null, regionCode: "CAI" }), "region");
  assert.equal(managerGlanceDistrictWho({ dmName: "Nermeen Adel", kind: "district" }), "Nermeen Adel");
  assert.equal(managerGlanceDistrictWho({ dmName: null, kind: "district" }), "Seat is vacant");
  assert.equal(managerGlanceDistrictWho({ dmName: null, kind: "line" }), "Any rep of the line", "a whole line has no seat to be vacant");
  assert.equal(managerGlanceDistrictWho({ dmName: null, kind: "region" }), "The whole region");
  // A regional sales manager's board speaks of district managers; the empty line names no kind of half.
  const district = managerGlanceScopeWords(sampleView());
  assert.deepEqual(district, {
    column: "District",
    every: "Every district manager offered is in the week.",
    label: "District managers",
    none: "No half-day is planned in a district yet.",
    note: "Every district manager this planner plans with; the ones the week does not go to are listed last.",
    title: "District managers in the week",
  });
  assert.ok(!district.none.includes("with a district manager"), "the list counts every half in a district, not only the ones with its district manager");
  // A board with no choice at all (a district manager's own) falls back to districts — and shows no such section.
  assert.equal(managerGlanceScopeWords({ scopes: [] }).label, "District managers");

  // The Training Manager's week, by hand.
  const view = trainingManagerView();
  const words = managerGlanceScopeWords(view);
  assert.equal(words.label, "Regions");
  assert.equal(words.title, "Regions in the week");
  assert.equal(words.column, "Region");
  assert.equal(words.none, "No half-day is planned in a region yet.");
  const glance = managerWeekGlance(view);
  assert.deepEqual(glance.districts.map((entry) => [entry.name, entry.kind, entry.halves, entry.days, entry.withDm]), [["Cairo region", "region", 2, 1, 0]]);
  assert.deepEqual(glance.districtsNotIn, ["Delta region"]);
  assert.equal(glance.halves, 4);
  assert.equal(glance.planned, 3);
  assert.equal(glance.open, 1, "Tuesday PM");
  assert.deepEqual(glance.byKind, { admin: 1, single_visit: 0, with_area: 1, with_dm: 0, with_rep: 1, with_senior: 0 });
  assert.deepEqual(glance.kinds, ["with_rep", "with_area", "admin"], "only the kinds her board offers");
  assert.deepEqual(managerGlanceKindBar(view, glance).map((part) => part.share), [34, 33, 33]);
  assert.equal(glance.customers.ticked, 0, "she never ticks a doctor");
  assert.equal(managerGlanceDistrictWho(glance.districts[0]), "The whole region");

  // Her file says regions, never district managers or a vacant seat.
  const buffer = await buildManagerWeekWorkbook(view, "2026-11-09T08:30:00Z");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const all: string[] = [];
  for (const sheet of workbook.worksheets) sheet.eachRow((row) => row.eachCell((cell) => all.push(String(cell.value ?? ""))));
  assert.ok(all.includes("Regions in the week · 1 of 2"), "the People sheet's title");
  assert.ok(all.includes("The whole region") && all.includes("Planned with") && all.includes("Region"));
  assert.ok(!all.some((value) => /district manager/i.test(value) && !/^With a district manager$/.test(value)), "no word of district managers in a region planner's file");
  assert.ok(!all.includes("Seat is vacant"));
  assert.equal(managerWeekWorkbookFileName(view), "week-plan-rania-hassan-2026-11-07.xlsx");

  // A national sales manager's whole-line choice: no seat, so never "vacant".
  const lineView: ManagerPlanBoardView = {
    ...sampleView(),
    days: [day("2026-11-09", "Monday 9 November", { slots: [slot("AM", "with_rep", { repName: "Omar Said", scopeKey: "line:PED", scopeName: "Any rep in Pedia (no district manager)", summary: "With Omar Said" })] })],
    scopes: [{ dmName: null, dmSeatId: null, group: null, key: "line:PED", lineCode: "PED", lineName: "Pedia", name: "Any rep in Pedia (no district manager)", place: null, regionCode: null }],
  };
  const line = managerWeekGlance(lineView);
  assert.equal(line.districts[0].kind, "line");
  assert.equal(managerGlanceDistrictWho(line.districts[0]), "Any rep of the line");
  const lineBook = new ExcelJS.Workbook();
  await lineBook.xlsx.load((await buildManagerWeekWorkbook(lineView, "2026-11-09T08:30:00Z")) as unknown as ArrayBuffer);
  const lineText: string[] = [];
  lineBook.getWorksheet("People")!.eachRow((row) => row.eachCell((cell) => lineText.push(String(cell.value ?? ""))));
  assert.ok(lineText.includes("Any rep of the line") && !lineText.includes("Seat is vacant"));

  // The panel and the file read these words, never their own.
  const panel = stripComments(readFileSync("src/components/phoenix-crm/manager-week-glance.tsx", "utf8"));
  assert.ok(panel.includes("const words = managerGlanceScopeWords(view);") && panel.includes("label={words.label}") && panel.includes("{words.title}"));
  assert.ok(!panel.includes("District managers in the week") && !panel.includes("with a district manager yet"), "no fixed district words on the screen");
  const file = stripComments(readFileSync("src/lib/phoenix-crm/server/manager-week-workbook.ts", "utf8"));
  assert.ok(file.includes("managerGlanceDistrictWho(district)") && !file.includes('"Seat is vacant"'), "the file's who is the lib's");
}

async function theGridWords() {
  const rows = managerGlanceDays(sampleView());
  // Each day's own word, as the grid and the file read it.
  assert.deepEqual(rows.map(managerGlanceDayState), ["Passed", "Passed", "Planned", "Still open", "Still open", "Still open"], "a passed holiday is passed first");
  assert.equal(managerGlanceDayState({ fieldDay: false, holiday: "Public holiday", passed: false, planned: false }), "Holiday");
  assert.equal(managerGlanceDayState({ fieldDay: false, holiday: null, passed: false, planned: false }), "No field day");
  assert.equal(managerGlanceNoFieldWords({ holiday: "Public holiday" }), "Public holiday · no plan");
  assert.equal(managerGlanceNoFieldWords({ holiday: null }), "No field day");
  // A missing half is said by which half it is.
  assert.equal(managerGlanceMissingHalfWords("AM"), "No morning to plan");
  assert.equal(managerGlanceMissingHalfWords("PM"), "No afternoon to plan");
  // The grid as text, row by row.
  assert.deepEqual(rows.map(managerGlanceGridRow), [
    ["Saturday 7 November", "Passed", "With Nermeen Adel · 2 areas", MANAGER_GLANCE_PASSED_WORDS],
    ["Sunday 8 November", "Passed", "Public holiday · no plan", ""],
    ["Monday 9 November", "Planned", "With Ahmed Ali · 2 customers", "Office"],
    ["Tuesday 10 November", "Still open", "With Sara Kamal · 0 customers", MANAGER_GLANCE_OPEN_WORDS],
    ["Wednesday 11 November", "Still open", "Single visit · Heliopolis · 1 customer", MANAGER_GLANCE_OPEN_WORDS],
    ["Thursday 12 November", "Still open", MANAGER_GLANCE_OPEN_WORDS, "No afternoon to plan"],
  ]);
  // A day holding its afternoon only: the morning is the missing one.
  const pmOnly = managerGlanceDays({ customersOptional: false, days: [day("2026-11-12", "Thursday 12 November", { halves: ["PM"] })] });
  assert.deepEqual(managerGlanceGridRow(pmOnly[0]), ["Thursday 12 November", "Still open", "No morning to plan", MANAGER_GLANCE_OPEN_WORDS]);

  // The file's Week sheet is that grid.
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await buildManagerWeekWorkbook(sampleView(), "2026-11-09T08:30:00Z")) as unknown as ArrayBuffer);
  const week = workbook.getWorksheet("Week")!;
  const lines: string[][] = [];
  week.eachRow((row) => {
    const values = [1, 2, 3, 4].map((column) => String(row.getCell(column).value ?? ""));
    if (/^[A-Z][a-z]+day \d+ November$/.test(values[0])) lines.push(values);
  });
  assert.deepEqual(lines, rows.map(managerGlanceGridRow), "the file's Week sheet reads as the screen's grid");
  const weekText: string[] = [];
  week.eachRow((row) => row.eachCell((cell) => weekText.push(String(cell.value ?? ""))));
  assert.ok(weekText.includes("5 of 9 half-days planned · 3 still to plan · 1 passed with nothing planned"), "the sheet's title is the glance's two lines");

  // The panel reads the same words, and never its own.
  const panel = stripComments(readFileSync("src/components/phoenix-crm/manager-week-glance.tsx", "utf8"));
  assert.ok(panel.includes("{managerGlanceMissingHalfWords(half)}"), "a missing half by its name");
  assert.ok(!panel.includes(">No afternoon to plan<"), "never a fixed afternoon under Morning");
  assert.ok(panel.includes("{managerGlanceDayState(row)}") && !/function noFieldWords\(/.test(panel));
}

function theDistrictManagerDoctors() {
  assert.equal(districtManagerDayCustomerTail({ gone: false, grade: "a", speciality: "Paediatrics" }), " · Paediatrics · Grade A", "a grade read whatever its case");
  assert.equal(districtManagerDayCustomerTail({ gone: false, grade: "D", speciality: " " }), "", "no grade and no speciality say nothing");
  assert.equal(districtManagerDayCustomerTail({ gone: true, grade: null, speciality: null }), " · No longer on the list", "a doctor gone is said, not only struck through");
  assert.equal(districtManagerDayCustomerTail({ gone: true, grade: "B", speciality: "Surgery" }), " · Surgery · Grade B · No longer on the list");
  const board = stripComments(readFileSync("src/components/phoenix-crm/manager-plan-board.tsx", "utf8"));
  assert.ok(board.includes("{districtManagerDayCustomerTail(customer)}"), "the panel's doctor line is the lib's");
  assert.ok(board.includes('<bdi className={customer.gone ? "line-through" : undefined}>{customer.name}</bdi>'), "only the name is struck through, the words stay readable");
  assert.ok(!board.includes("` · Grade ${customer.grade}`"), "never the raw grade");
}

/**
 * A district manager's own week (owner, 2026-10-16) — no district to choose, so no district list: the glance's third
 * tile is the reps gone with. Worked by hand: Nermeen Adel, the same week, viewed on Monday 9.
 *   - Mon 9: AM with Ahmed Ali (Dr. Mona Saleh, Dr. Adel Fawzy); PM with Ahmed Ali again (Dr. Mona Saleh again).
 *   - Tue 10: AM with Hany Saad, her regional manager — With my manager or product manager (Dr. Hany Fathy); PM a single
 *     visit in Shubra (Dr. Samia Lotfy from Manager's own list).
 *   - Wed 11: AM Admin · Training; PM open.
 * So: 6 halves, 5 planned, 1 open; Ahmed Ali 2 half-days; Hany Saad 1 as a manager; 5 ticks, 4 different customers.
 */
function districtManagerView(): ManagerPlanBoardView {
  const base = sampleView();
  return {
    ...base,
    days: [
      day("2026-11-09", "Monday 9 November", {
        slots: [
          slot("AM", "with_rep", { customers: [MONA, ADEL], repName: "Ahmed Ali", repSeatId: "R1", summary: "With Ahmed Ali · 2 customers" }),
          slot("PM", "with_rep", { customers: [MONA], repName: "Ahmed Ali", repSeatId: "R1", summary: "With Ahmed Ali · 1 customer" }),
        ],
      }),
      day("2026-11-10", "Tuesday 10 November", {
        slots: [
          slot("AM", "with_senior", { customers: [HANY], seniorHrId: "B-55", seniorName: "Hany Saad", seniorTitle: "Regional manager", summary: "With Hany Saad (Regional manager) · 1 customer" }),
          slot("PM", "single_visit", { areaName: "Shubra", customers: [{ ...GONE, flag: null, flagLabel: null }], summary: "Single visit · Shubra · 1 customer" }),
        ],
      }),
      day("2026-11-11", "Wednesday 11 November", { slots: [slot("AM", "admin", { activityLabel: "Training", activityType: "training", summary: "Training" })] }),
    ],
    manager: { hrId: "B-31", name: "Nermeen Adel", place: "District Manager · Delta (1) · Pedia" },
    scopes: [],
    slotKinds: [
      { key: "with_rep", label: "With a rep" },
      { key: "with_senior", label: "With my manager or product manager" },
      { key: "admin", label: "Admin" },
      { key: "single_visit", label: "Single visit" },
    ],
    writer: { kind: "dm", title: "District Manager" },
  };
}

async function theDistrictManagersOwnWeek() {
  const view = districtManagerView();
  const glance = managerWeekGlance(view);
  assert.equal(glance.halves, 6);
  assert.equal(glance.planned, 5);
  assert.equal(glance.open, 1, "Wednesday PM");
  assert.equal(glance.passedOpen, 0);
  assert.equal(glance.daysPlanned, 2, "Monday and Tuesday in full");
  assert.deepEqual(glance.districts, [], "a district manager plans one district: no district list");
  assert.deepEqual(glance.districtsNotIn, []);
  assert.deepEqual(glance.reps.map((person) => [person.name, person.halves, person.halfNames]), [["Ahmed Ali", 2, ["Mon 9 AM", "Mon 9 PM"]]], "one rep on two half-days is one rep");
  assert.deepEqual(glance.managers.map((person) => [person.name, person.halves]), [["Hany Saad", 1]], "a manager gone with is counted as a manager, never as a rep");
  assert.equal(managerGlancePeopleLine(glance.reps), "Ahmed Ali 2");
  assert.deepEqual(glance.byKind, { admin: 1, single_visit: 1, with_area: 0, with_dm: 0, with_rep: 2, with_senior: 1 });
  assert.equal(managerGlanceKindsLine(view, glance), "With a rep 2 · With my manager or product manager 1 · Admin 1 · Single visit 1");
  assert.deepEqual(managerGlanceKindBar(view, glance).map((part) => [part.kind, part.share]), [
    ["with_rep", 40],
    ["with_senior", 20],
    ["admin", 20],
    ["single_visit", 20],
  ]);
  const customers = glance.customers;
  assert.equal(customers.ticked, 5, "Mon AM 2, Mon PM 1, Tue AM 1, Tue PM 1");
  assert.equal(customers.distinct, 4, "Dr. Mona Saleh twice is one; the others once each");
  assert.equal(customers.own, 1);
  assert.deepEqual(customers.repeated, [{ name: "Dr. Mona Saleh", times: 2 }]);
  assert.deepEqual(customers.marked, [], "nothing marked on this week");
  assert.equal(managerGlanceGradeLine(customers), "1 A · 1 B · 1 C · 1 with no grade");
  // Her Send step: every coming half, Wednesday PM going empty.
  assert.deepEqual(managerSendTally(view.days, () => null).emptyHalves, ["Wednesday 11 November PM"]);

  // Her file has no district table, and names the people and the customers.
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await buildManagerWeekWorkbook(view, "2026-11-09T08:30:00Z")) as unknown as ArrayBuffer);
  const people: string[] = [];
  workbook.getWorksheet("People")!.eachRow((row) => row.eachCell((cell) => people.push(String(cell.value ?? ""))));
  assert.ok(!people.some((value) => value.startsWith("District managers in the week")), "no district table on a district manager's own file");
  assert.ok(people.includes("Who the week goes with · 1 rep · 1 manager"));
  assert.ok(people.includes("Mon 9 AM · Mon 9 PM"), "the rep's half-days by name");
  const cover: string[] = [];
  workbook.getWorksheet("Cover")!.eachRow((row) => row.eachCell((cell) => cover.push(String(cell.value ?? ""))));
  assert.ok(!cover.includes("Not in the week"), "no districts row on her cover");
  assert.ok(cover.includes("Ticked more than once: Dr. Mona Saleh ×2"));
  assert.equal(managerWeekWorkbookFileName(view), "week-plan-nermeen-adel-2026-11-07.xlsx");
}

export async function runPhoenixCrmManagerWeekGlanceTests(): Promise<void> {
  daysAndWords();
  theWeek();
  theGrid();
  theCustomers();
  theBar();
  theDistrictManagerDay();
  await theWorkbook();
  theExportDoor();
  theBoard();
  theFlatKit();
  theSendStep();
  theApproversView();
  theHubDoor();
  await theScopeWords();
  await theGridWords();
  theDistrictManagerDoctors();
  await theDistrictManagersOwnWeek();
}
