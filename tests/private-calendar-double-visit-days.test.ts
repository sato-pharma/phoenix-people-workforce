import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildParticipantOrFilter,
  collapseDuplicateVisitSubmissions,
  DOUBLE_VISIT_SLICE_DAYS,
  expandHrIdFilterValues,
} from "../src/lib/crm/reads.ts";
import type { CrmResolutionRow } from "../src/lib/crm/types.ts";
import {
  crmIdsOverriddenTo,
  DOUBLE_VISIT_DAYS_MAX_LISTED,
  DOUBLE_VISIT_DAYS_MAX_PEOPLE,
  DOUBLE_VISIT_FOCUS_MAX_PEOPLE,
  doubleVisitFocusTallies,
  doubleVisitPrivateCalendarItemsFromRows,
  findDoubleVisitCalendarDays,
  findDoubleVisitFocusDays,
  liveDoubleVisitRowsFromMirror,
  readListedDayRuns,
  type DoubleVisitDayReaders,
  type MirrorVisitRow,
} from "../src/lib/double-visit-analytics/service.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import { canonicalHrIdKey, normalizeHrIdForAccess } from "../src/lib/hr-id.ts";

// THE PRIVATE CALENDAR READ THE WHOLE COMPANY'S MONTH OF DOUBLE VISITS FOR ONE REP (2026-10-01,
// "speed up the rep's Private Calendar page"): 2,220 September rows for a rep on 5 of its 24 days,
// 0.7 s of a 0.7 s page. It now finds the days that can reach the calendar first and reads those
// days WHOLE. This suite drives the real attribution and calendar code over a fixture month and
// proves the narrowed calendar equals the whole-month calendar for every person on it: a chain visit
// (NSM → DM → rep), an ambiguous chain left unresolved, a reused CRM account an admin override
// credits to a new rep, a duplicate save, a campaign day, a lowercase hr id, a leaver and a rep with
// no double visit at all. The door itself is DB-backed, so the two requests it makes are emulated
// from the same filter builders the door uses, and the wiring gets a source-shape guard.

const WINDOW = { end: "2026-09-30", start: "2026-09-01" };

function employee(input: Partial<EmployeeDirectoryRow> & { hrId: string }): EmployeeDirectoryRow {
  return {
    areaName: input.areaName ?? null,
    crmId: null,
    departmentName: null,
    displayName: input.displayName ?? input.hrId,
    employmentStatus: "active",
    fullName: input.displayName ?? input.hrId,
    jobTitle: input.jobTitle ?? "Medical Representative",
    lineName: input.lineName ?? null,
    managerHrId: null,
    managerName: null,
    positionTitle: input.positionTitle ?? "Medical Representative",
    regionName: null,
    ...input,
  } as EmployeeDirectoryRow;
}

const EMPLOYEES: EmployeeDirectoryRow[] = [
  employee({ hrId: "B-301", displayName: "Rep One", areaName: "Giza 1", lineName: "Pedia" }),
  employee({ hrId: "B-302", displayName: "Rep Two", areaName: "Giza 2", lineName: "Pedia" }),
  employee({ hrId: "B-303", displayName: "Rep Three", areaName: "Tanta", lineName: "CNS" }),
  employee({ hrId: "B-304", displayName: "Rep Four", areaName: "Alex 1", lineName: "CNS" }),
  employee({ hrId: "B-305", displayName: "Rep Five", areaName: "Mansoura", lineName: "CNS" }),
  employee({ hrId: "B-306", displayName: "Rep Six", areaName: "Giza 3", lineName: "Pedia" }),
  employee({ hrId: "B-399", displayName: "Left Rep", areaName: "Tanta", employmentStatus: "resigned", lineName: "CNS" }),
  employee({ hrId: "B-311", displayName: "DM Giza", jobTitle: "District Manager", positionTitle: "District Manager" }),
  employee({ hrId: "B-312", displayName: "DM Delta", jobTitle: "District Manager", positionTitle: "District Manager" }),
  employee({ hrId: "B-321", displayName: "NSM Pedia", jobTitle: "National Sales Manager", positionTitle: "National Sales Manager" }),
];

// The slot 9001 once belonged to the leaver B-399; the mirror still stamps his hr id on it, and an
// admin override credits it to his replacement B-303.
const RESOLUTIONS: CrmResolutionRow[] = [
  { crmId: 9001, mappedHrId: "B-303", status: "mapped" },
  { crmId: 9002, mappedHrId: null, status: "resigned" },
  { crmId: 9003, mappedHrId: "B-302", status: "pending" },
];

let sequence = 0;
function visit(input: {
  agent: string | null;
  agentCrm?: number | null;
  ampm?: "AM" | "PM";
  contactCrm?: number;
  date: string;
  double: string;
  doubleCrm?: number;
  saved?: string;
  type?: 0 | -8;
}): MirrorVisitRow & { contact_crm_id: number; crm_save_date: string } {
  sequence += 1;
  return {
    agent_crm_id: input.agentCrm ?? 4000 + sequence,
    agent_hr_id: input.agent,
    agent_name: input.agent ? `${input.agent} ( Area / Line )` : "Unmapped ( Somewhere / CNS )",
    ampm: input.ampm ?? "AM",
    contact_crm_id: input.contactCrm ?? 70000 + sequence,
    contact_name: `Dr ${sequence}`,
    crm_save_date: input.saved ?? `${input.date}T10:${String(sequence % 60).padStart(2, "0")}:00+00:00`,
    crm_visit_id: 500000 + sequence,
    customer_name: null,
    double_crm_id: input.doubleCrm ?? 8000 + Number(input.double.replace(/\D/g, "")),
    double_hr_id: input.double,
    double_name: `${input.double} name`,
    // Fixed-width hex in creation order, so the fixture IS the single scan's id order.
    id: `00000000-0000-0000-0000-${sequence.toString(16).padStart(12, "0")}`,
    speciality: sequence % 5 === 0 ? "Pharmacy" : "Pediatrics",
    visit_date: input.date,
    visit_type: input.type ?? 0,
    visit_type_description: input.type === -8 ? "Campaign" : "Regular",
  };
}

const MONTH = [
  // 2 Sep — the NSM rides with the Giza DM, who sees Rep One in the morning and Rep Two after lunch:
  // the NSM's morning row resolves to Rep One and pairs with his row as ONE chain visit.
  visit({ date: "2026-09-02", agent: "B-301", double: "B-311", ampm: "AM" }),
  visit({ date: "2026-09-02", agent: "B-301", double: "B-311", ampm: "AM" }),
  visit({ date: "2026-09-02", agent: "B-302", double: "B-311", ampm: "PM" }),
  visit({ date: "2026-09-02", agent: "B-311", double: "B-321", ampm: "AM" }),
  // 3 Sep — the Giza DM with Rep Two alone.
  visit({ date: "2026-09-03", agent: "B-302", double: "B-311", ampm: "PM" }),
  // 7 Sep — the reused slot: the mirror names the leaver, the override credits Rep Three. The same
  // stop is saved twice (same account, contact, day and type), so the collapse keeps the earlier one.
  visit({ date: "2026-09-07", agent: "B-399", agentCrm: 9001, double: "B-312", contactCrm: 71111, saved: "2026-09-07T09:00:00+00:00" }),
  visit({ date: "2026-09-07", agent: "B-399", agentCrm: 9001, double: "B-312", contactCrm: 71111, saved: "2026-09-07T09:00:30+00:00" }),
  visit({ date: "2026-09-07", agent: "B-305", double: "B-312", ampm: "PM" }),
  // 8 Sep — a campaign day with Rep One.
  visit({ date: "2026-09-08", agent: "B-301", double: "B-311", type: -8 }),
  visit({ date: "2026-09-08", agent: "B-301", double: "B-311", type: -8 }),
  // 10 Sep — Rep Five's row stamped in lowercase; the door's casing variants still find it.
  visit({ date: "2026-09-10", agent: "b-305", double: "B-312", ampm: "PM" }),
  // 15 Sep — the NSM with the Giza DM, who saw TWO reps that morning: ambiguous, never guessed, so the
  // NSM's row stays a visit TO the DM and reaches the DM's own calendar.
  visit({ date: "2026-09-15", agent: "B-301", double: "B-311", ampm: "AM" }),
  visit({ date: "2026-09-15", agent: "B-306", double: "B-311", ampm: "AM" }),
  visit({ date: "2026-09-15", agent: "B-311", double: "B-321", ampm: "AM" }),
  // 21 Sep — a day none of the reps above is on except Rep Six.
  visit({ date: "2026-09-21", agent: "B-306", double: "B-312", ampm: "PM" }),
  // 22 Sep — a visit the CRM submitted with no hr id at all.
  visit({ date: "2026-09-22", agent: null, agentCrm: 4999, double: "B-312", ampm: "AM" }),
  // 28 Sep — the Delta DM with the leaver himself, before the slot moved.
  visit({ date: "2026-09-28", agent: "B-399", agentCrm: 9002, double: "B-312", ampm: "AM" }),
];

/** The door's `getDoubleVisitRows`, over the fixture: the window, the filters, then the collapse. */
function doorRead(table: typeof MONTH, filter: {
  dateFrom: string;
  dateTo: string;
  participantCrmIds?: readonly number[];
  participantHrIds?: readonly string[];
  visitDates?: readonly string[];
}) {
  const hrValues = new Set(expandHrIdFilterValues(filter.participantHrIds ?? []));
  const crmValues = new Set(filter.participantCrmIds ?? []);
  const named = filter.participantCrmIds != null || filter.participantHrIds != null;
  const listed = filter.visitDates ? new Set(filter.visitDates) : null;
  const matched = table.filter((row) => {
    if (row.visit_date < filter.dateFrom || row.visit_date > filter.dateTo) return false;
    if (listed && !listed.has(row.visit_date)) return false;
    if (!named) return true;
    return (
      (row.agent_hr_id != null && hrValues.has(row.agent_hr_id)) ||
      (row.double_hr_id != null && hrValues.has(row.double_hr_id)) ||
      (row.agent_crm_id != null && crmValues.has(row.agent_crm_id)) ||
      (row.double_crm_id != null && crmValues.has(row.double_crm_id))
    );
  });
  return collapseDuplicateVisitSubmissions(matched);
}

function readersOver(table: typeof MONTH, calls: Array<Record<string, unknown>> = []): DoubleVisitDayReaders {
  return {
    days: async (filter) => {
      calls.push(filter);
      return doorRead(table, filter).map((row) => row.visit_date);
    },
    resolutions: async () => RESOLUTIONS,
  };
}

const keysOf = (hrIds: readonly string[]) =>
  new Set(hrIds.map((hrId) => normalizeHrIdForAccess(hrId)).filter((key): key is string => Boolean(key)));

function calendarItems(table: typeof MONTH, hrIds: readonly string[]) {
  const rows = liveDoubleVisitRowsFromMirror(table, EMPLOYEES, RESOLUTIONS);
  return doubleVisitPrivateCalendarItemsFromRows(rows, keysOf(hrIds));
}

async function runSameCalendarTests() {
  const wholeMonth = doorRead(MONTH, { dateFrom: WINDOW.start, dateTo: WINDOW.end });
  assert.equal(wholeMonth.length, MONTH.length - 1, "the fixture's duplicate save collapses at the door, as on production");

  const calendars: Array<[string, string[]]> = [
    ["Rep One (a chain visit, a campaign day, an ambiguous day)", ["B-301"]],
    ["Rep Two (seen in the afternoon of a chain day)", ["B-302"]],
    ["Rep Three (credited through a reused CRM account)", ["B-303"]],
    ["Rep Four (no double visit at all)", ["B-304"]],
    ["Rep Five (one row stamped in lowercase)", ["B-305"]],
    ["Rep Six (on the ambiguous day)", ["B-306"]],
    ["the leaver (his old slot now credited to someone else)", ["B-399"]],
    ["the Giza DM (performed, and received from the NSM)", ["B-311"]],
    ["the Delta DM", ["B-312"]],
    ["the NSM (a chain he joined)", ["B-321"]],
    ["a DM's team view", ["B-311", "B-301", "B-302", "B-306"]],
  ];
  for (const [label, hrIds] of calendars) {
    const whole = calendarItems(wholeMonth, hrIds);
    const found = await findDoubleVisitCalendarDays(hrIds, WINDOW, readersOver(MONTH));
    assert.ok(found, `${label}: a small scope finds its days`);
    const narrowed = calendarItems(doorRead(MONTH, { dateFrom: WINDOW.start, dateTo: WINDOW.end, visitDates: found.days }), hrIds);
    assert.deepEqual(narrowed, whole, `${label}: the calendar from its days alone is the whole-month calendar, item for item`);
    assert.equal(found.resolutions, RESOLUTIONS, `${label}: one override snapshot decides the days and the credit`);
  }

  // The fixture exercises what it claims to, and the narrowing actually narrows.
  const repOne = calendarItems(wholeMonth, ["B-301"]);
  assert.ok(repOne.some((item) => item.activityKind?.startsWith("chain")), "Rep One's 2 September stop is a chain visit");
  assert.equal((await findDoubleVisitCalendarDays(["B-301"], WINDOW, readersOver(MONTH)))?.days.length, 3, "Rep One reads 3 of the month's 9 days");
  const repThree = calendarItems(wholeMonth, ["B-303"]);
  assert.equal(repThree.length, 1, "the reused account's visit reaches Rep Three");
  assert.deepEqual((await findDoubleVisitCalendarDays(["B-303"], WINDOW, readersOver(MONTH)))?.days, ["2026-09-07"], "found through the override alone");
  assert.equal(calendarItems(wholeMonth, ["B-399"]).filter((item) => item.startDate === "2026-09-07").length, 0, "the override takes the slot's visit off the leaver");
  assert.deepEqual((await findDoubleVisitCalendarDays(["B-304"], WINDOW, readersOver(MONTH)))?.days, [], "no double visit → no day to read");
  assert.deepEqual(calendarItems(wholeMonth, ["B-304"]), []);
  assert.ok(calendarItems(wholeMonth, ["B-305"]).some((item) => item.startDate === "2026-09-10"), "the lowercase row is on Rep Five's calendar");
  assert.ok(
    calendarItems(wholeMonth, ["B-311"]).some((item) => item.startDate === "2026-09-15" && item.status === "received"),
    "the ambiguous chain stays a visit received by the DM",
  );
}

async function runBoundsTests() {
  const calls: Array<Record<string, unknown>> = [];
  const nine = ["B-301", "B-302", "B-303", "B-304", "B-305", "B-306", "B-311", "B-312", "B-321"];
  assert.equal(nine.length, DOUBLE_VISIT_DAYS_MAX_PEOPLE + 1);
  assert.equal(await findDoubleVisitCalendarDays(nine, WINDOW, readersOver(MONTH, calls)), null, "a wider scope reads the whole window");
  assert.equal(calls.length, 0, "and asks nothing first");
  assert.equal(await findDoubleVisitCalendarDays(["", "  "], WINDOW, readersOver(MONTH)), null, "nobody named → no narrowing");

  const failing: DoubleVisitDayReaders = {
    days: async () => {
      throw new Error("statement timeout");
    },
    resolutions: async () => RESOLUTIONS,
  };
  assert.equal(await findDoubleVisitCalendarDays(["B-301"], WINDOW, failing), null, "a failed lookup reads the whole window — slower, never wrong");

  const manyDays: DoubleVisitDayReaders = {
    days: async () => Array.from({ length: DOUBLE_VISIT_DAYS_MAX_LISTED + 1 }, (_, index) => `2026-0${index < 31 ? 8 : 9}-${String((index % 31) + 1).padStart(2, "0")}`),
    resolutions: async () => [],
  };
  assert.equal(await findDoubleVisitCalendarDays(["B-301"], { end: "2026-09-30", start: "2026-08-01" }, manyDays), null, "more days than one in-list carries reads the whole window");

  // Two requests at most, and the CRM-id one only when an override credits someone in scope.
  const repOneCalls: Array<Record<string, unknown>> = [];
  await findDoubleVisitCalendarDays(["B-301"], WINDOW, readersOver(MONTH, repOneCalls));
  assert.deepEqual(repOneCalls, [{ dateFrom: WINDOW.start, dateTo: WINDOW.end, participantHrIds: ["B-301"] }]);
  const repThreeCalls: Array<Record<string, unknown>> = [];
  await findDoubleVisitCalendarDays(["B-303"], WINDOW, readersOver(MONTH, repThreeCalls));
  assert.deepEqual(repThreeCalls, [
    { dateFrom: WINDOW.start, dateTo: WINDOW.end, participantHrIds: ["B-303"] },
    { dateFrom: WINDOW.start, dateTo: WINDOW.end, participantCrmIds: [9001] },
  ]);
}

function runOverrideTests() {
  assert.deepEqual(crmIdsOverriddenTo(keysOf(["B-303"]), RESOLUTIONS), [9001]);
  assert.deepEqual(crmIdsOverriddenTo(keysOf(["b-303"]), RESOLUTIONS), [9001], "matched as the calendar matches, casing aside");
  assert.deepEqual(crmIdsOverriddenTo(keysOf(["B-302"]), RESOLUTIONS), [], "a pending decision credits nobody, as at attribution");
  assert.deepEqual(crmIdsOverriddenTo(keysOf(["B-399"]), RESOLUTIONS), [], "a resigned decision credits nobody");
  assert.deepEqual(
    crmIdsOverriddenTo(keysOf(["B-303"]), [...RESOLUTIONS, { crmId: 9001, mappedHrId: "B-303", status: "mapped" }, { crmId: 77, mappedHrId: "B-303", status: "mapped" }]),
    [77, 9001],
    "each account once",
  );
}

// THE PORTAL FOCUS PANEL READ EVERY DOUBLE VISIT SINCE JANUARY (2026-10-28, "now fix the
// double-visit read"): 17,535 rows in 44 requests on every District Manager's and NSM's landing, to
// keep the viewer's own visits and up to eight probationers' counts. It now finds those people's days
// and reads them whole, a week of days per request. The same fixture month, with its ids also turned
// backwards (production ids are random, so a later day's rows can sort before an earlier day's), must
// give every viewer the same own visits, row for row and in order, and every shown probationer the
// same count as the whole-window read.

/** The fixture month with ids running against the dates, in id order as the door returns it. */
const BACKWARDS = MONTH.map((row, index) => ({ ...row, id: `00000000-0000-0000-0000-${(0xfff - index).toString(16).padStart(12, "0")}` })).sort(
  (left, right) => (left.id < right.id ? -1 : 1),
);

async function focusFromDays(table: typeof MONTH, viewer: string, probationers: readonly string[]) {
  const viewerKey = canonicalHrIdKey(viewer);
  const found = await findDoubleVisitFocusDays([viewer, ...probationers], WINDOW, readersOver(table));
  assert.ok(found, `${viewer}: the focus finds its days`);
  const mirror = await readListedDayRuns(found.days, WINDOW, async (filter) => doorRead(table, filter));
  return { days: found.days, tallies: doubleVisitFocusTallies(liveDoubleVisitRowsFromMirror(mirror, EMPLOYEES, found.resolutions), viewerKey) };
}

function wholeWindowFocus(table: typeof MONTH, viewer: string) {
  const rows = liveDoubleVisitRowsFromMirror(doorRead(table, { dateFrom: WINDOW.start, dateTo: WINDOW.end }), EMPLOYEES, RESOLUTIONS);
  return doubleVisitFocusTallies(rows, canonicalHrIdKey(viewer));
}

async function runSameFocusTests() {
  const panels: Array<[string, string, string[]]> = [
    ["the Giza DM (his chain day, his campaign day, his ambiguous day)", "B-311", ["B-301", "B-302", "B-306"]],
    ["the Delta DM (a reused account credited by override, a lowercase row)", "B-312", ["B-303", "B-305"]],
    ["the NSM (reps he reached only through a chain)", "B-321", ["B-301", "B-303", "B-305", "B-306"]],
    ["a viewer with no double visit of his own", "B-304", ["B-301"]],
    ["a full panel: the viewer and eight probationers", "B-321", ["B-301", "B-302", "B-303", "B-304", "B-305", "B-306", "B-399", "B-312"]],
  ];
  for (const [table, order] of [[MONTH, "in id order"], [BACKWARDS, "ids against the dates"]] as const) {
    for (const [label, viewer, probationers] of panels) {
      const whole = wholeWindowFocus(table, viewer);
      const { tallies } = await focusFromDays(table, viewer, probationers);
      assert.deepEqual(tallies.ownRows, whole.ownRows, `${label}, ${order}: the viewer's own visits from the found days are the whole window's, row for row`);
      for (const hrId of probationers) {
        const key = canonicalHrIdKey(hrId) ?? "";
        assert.equal(tallies.dvCountByHrId.get(key) ?? 0, whole.dvCountByHrId.get(key) ?? 0, `${label}, ${order}: ${hrId}'s count is the whole window's`);
      }
    }
  }

  // The fixture exercises what it claims to, and the narrowing actually narrows.
  const nsm = wholeWindowFocus(MONTH, "B-321");
  assert.ok(
    nsm.ownRows.some((row) => row.activity_date === "2026-09-02" && canonicalHrIdKey(row.visited_employee_hr_id) === "b-301"),
    "the NSM's 2 September row is credited, through the chain, to Rep One",
  );
  assert.equal(wholeWindowFocus(MONTH, "B-312").dvCountByHrId.get("b-303"), 1, "the reused account's visit counts once for Rep Three");
  const delta = await focusFromDays(MONTH, "B-312", ["B-303", "B-305"]);
  assert.deepEqual(delta.days, ["2026-09-07", "2026-09-10", "2026-09-21", "2026-09-22", "2026-09-28"], "the Delta DM's panel reads 5 of the month's 9 days");

  // Nine people is the panel's ceiling; the days are not capped — the read takes any number of them.
  assert.equal(DOUBLE_VISIT_FOCUS_MAX_PEOPLE, 9, "the viewer and the eight probationers the panel shows");
  assert.ok(DOUBLE_VISIT_FOCUS_MAX_PEOPLE * 5 <= 50, "nine hr ids in five spellings each stay inside one in-list's 50 values");
  const ten = ["B-321", "B-301", "B-302", "B-303", "B-304", "B-305", "B-306", "B-399", "B-312", "B-311"];
  const calls: Array<Record<string, unknown>> = [];
  assert.equal(await findDoubleVisitFocusDays(ten, WINDOW, readersOver(MONTH, calls)), null, "more people than the panel shows reads the whole window");
  assert.equal(calls.length, 0, "and asks nothing first");
  const manyDays: DoubleVisitDayReaders = {
    days: async () => Array.from({ length: 60 }, (_, index) => `2026-0${index < 30 ? 8 : 9}-${String((index % 30) + 1).padStart(2, "0")}`),
    resolutions: async () => [],
  };
  assert.equal(
    (await findDoubleVisitFocusDays(["B-311"], { end: "2026-09-30", start: "2026-08-01" }, manyDays))?.days.length,
    60,
    "a busy manager's sixty days are read, not given up on",
  );
  const failing: DoubleVisitDayReaders = {
    days: async () => {
      throw new Error("statement timeout");
    },
    resolutions: async () => RESOLUTIONS,
  };
  assert.equal(await findDoubleVisitFocusDays(["B-311"], WINDOW, failing), null, "a failed lookup reads the whole window — slower, never wrong");
}

async function runListedDayRunTests() {
  const days = ["2026-09-02", "2026-09-03", "2026-09-07", "2026-09-08", "2026-09-10", "2026-09-15", "2026-09-21", "2026-09-22", "2026-09-28"];
  const calls: Array<{ dateFrom: string; dateTo: string; visitDates: string[] }> = [];
  const rows = await readListedDayRuns(days, WINDOW, async (filter) => {
    calls.push(filter);
    return doorRead(BACKWARDS, filter);
  });
  assert.deepEqual(
    calls.map((call) => call.visitDates),
    [days.slice(0, DOUBLE_VISIT_SLICE_DAYS), days.slice(DOUBLE_VISIT_SLICE_DAYS)],
    "a week of listed days per request — never the whole list in one URL",
  );
  assert.deepEqual(
    calls.map((call) => [call.dateFrom, call.dateTo]),
    [["2026-09-02", "2026-09-21"], ["2026-09-22", "2026-09-28"]],
    "each request bounded by its own first and last day",
  );
  assert.deepEqual(
    rows,
    doorRead(BACKWARDS, { dateFrom: WINDOW.start, dateTo: WINDOW.end, visitDates: days }),
    "the runs give the one read's rows, in its id order, with the duplicate save collapsed once",
  );

  const tidy: string[][] = [];
  await readListedDayRuns(["2026-09-10", "2026-08-31", "2026-09-02", "2026-09-10", "2026-10-01"], WINDOW, async (filter) => {
    tidy.push(filter.visitDates);
    return [];
  });
  assert.deepEqual(tidy, [["2026-09-02", "2026-09-10"]], "days outside the window are dropped, a repeated day is read once, in order");
  let asked = 0;
  const nothing = await readListedDayRuns([], WINDOW, async () => {
    asked += 1;
    return [] as typeof MONTH;
  });
  assert.deepEqual(nothing, [], "no listed day reads nothing");
  assert.equal(asked, 0, "and asks nothing");
}

function runDoorEmulationGuards() {
  // The emulated door above assumes the participant filters match the agent OR the partner, by hr id
  // (every casing) or by CRM id. Pin the expressions the real door sends.
  const hr = buildParticipantOrFilter({ participantHrIds: ["B-301"] });
  assert.ok(hr?.includes("agent_hr_id.in.(") && hr.includes("double_hr_id.in.("), `hr participants match agent or partner: ${hr}`);
  assert.ok(hr?.includes('"B-301"') && hr.includes('"b-301"'), "every casing of the hr id");
  assert.ok(/companion_hr_ids.ov.{[^}]*"B-301"/.test(hr ?? ""), `and any companion past the two slots, by overlap: ${hr}`);
  const crm = buildParticipantOrFilter({ participantCrmIds: [9001] });
  assert.ok(crm?.includes("agent_crm_id.in.(9001)") && crm.includes("double_crm_id.in.(9001)"), `crm participants match agent or partner: ${crm}`);
}

function runWiringGuards() {
  const service = readFileSync("src/lib/double-visit-analytics/service.ts", "utf8");
  assert.match(
    service,
    /findDoubleVisitCalendarDays\(employeeHrIds, \{ end, start \}\)/,
    "the calendar loader finds its days first",
  );
  assert.match(
    service,
    /\.\.\.\(calendarDays \? \{ crmIdentityResolutions: calendarDays\.resolutions, visitDates: calendarDays\.days \} : \{\}\)/,
    "it reads only those whole days, crediting with the snapshot that found them — and the whole window when it found none",
  );
  assert.match(
    service,
    /columns: "visit_date",\s+includeResignedAgents: true,\s+visitTypes: \[\.\.\.DOUBLE_VISIT_TYPE_CODES\],/,
    "the days are found through the calendar's own door, definition and resigned-agent opt-out",
  );
  assert.match(
    service,
    /options\?\.crmIdentityResolutions \?\? \(await getCrmIdentityResolutions\(\)\)/,
    "every other reader still reads the overrides itself",
  );
  assert.match(
    service,
    /if \(options\?\.visitDates\) return readListedDayRuns\(options\.visitDates, \{ end: dateTo, start: dateFrom \}, read\);/,
    "a listed-day read goes a week of days per request",
  );
  const focus = service.slice(service.indexOf("export async function getDoubleVisitPortalFocus"), service.indexOf("export function doubleVisitFocusTallies"));
  assert.ok(focus.length > 0, "the focus panel's body is located");
  assert.match(focus, /const probationShown = probationOrdered\.slice\(0, FOCUS_PROBATION_DISPLAY_LIMIT\);/);
  assert.match(
    focus,
    /const focusHrIds = \[\.\.\.\(viewerCanonicalKey && viewerHrId \? \[viewerHrId\] : \[\]\), \.\.\.probationShown\.map\(\(row\) => row\.hr_id\)\];/,
    "the panel finds the days of its viewer AND of every probationer it shows a count for",
  );
  assert.match(focus, /findDoubleVisitFocusDays\(focusHrIds, focusWindow\)/);
  assert.match(
    focus,
    /\.\.\.\(focusDays \? \{ crmIdentityResolutions: focusDays\.resolutions, visitDates: focusDays\.days \} : \{\}\)/,
    "it reads only those whole days, crediting with the snapshot that found them — and the whole window when it found none",
  );
  assert.match(focus, /const probation: DoubleVisitFocusProbationEntry\[\] = probationShown\.map\(/, "a count is shown only for a probationer whose days were read");
  assert.match(focus, /doubleVisitFocusTallies\(allDvRows, viewerCanonicalKey\)/, "the panel tallies through the tested helper");

  const reads = readFileSync("src/lib/crm/reads.ts", "utf8");
  assert.match(reads, /if \(filter\.visitDates && filter\.visitDates\.length > 0\) result = result\.in\("visit_date", \[\.\.\.filter\.visitDates\]\);/);
  assert.equal(
    (reads.match(/if \(options\.visitDates && options\.visitDates\.length === 0\) return \[\];/g) ?? []).length,
    2,
    "an empty day list reads nothing, in both visit doors — never every day",
  );
  assert.match(
    reads,
    /const days = windowDays && listedDays \? windowDays\.filter\(\(day\) => listedDays\.has\(day\)\) : windowDays;/,
    "a dense listed-day read requests only the listed days of the window",
  );
}

export async function runPrivateCalendarDoubleVisitDaysTests() {
  await runSameCalendarTests();
  await runBoundsTests();
  await runSameFocusTests();
  await runListedDayRunTests();
  runOverrideTests();
  runDoorEmulationGuards();
  runWiringGuards();
}
