import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { phoenixWorkedDayKey } from "../src/lib/deductions/phoenix-worked-days.ts";
import { selectProvenWorkedDays } from "../src/lib/deductions/proven-worked-days.ts";
import { isConferenceCompanionTitle, pickConferenceCompanions } from "../src/lib/private-calendar/conference-companions.ts";
import { buildLineTrainingQuestions, parseDayQuestionAnswer } from "../src/lib/private-calendar/day-record-question-rules.ts";
import {
  isWithinDayRecordWindow,
  selectLineTrainingDays,
  selectStoredDayRecords,
  summarizeLineTrainingDays,
  type DayRecord,
  type StoredDayRecordRow,
} from "../src/lib/private-calendar/day-records.ts";
import { parseDayRecordDraft, planDayRecordSave } from "../src/lib/private-calendar/day-records-admin.ts";
import { privateCalendarHrIdKey } from "../src/lib/private-calendar/logic.ts";

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE CALENDAR DAY RECORDS (owner, 2026-11-28).
//
// "These activities must be synchronized in her private calendar and not show as deductions", then the
// binding correction: "never automatic … he asks the super admin … gave me the days as MCQ".
//
// What this pins:
//   1. A line's Training day is 2+ distinct people of the line, Training only, inside the manager's
//      employment window (Nourhan Abdelmoniem: hired 1 Dec 2026 — never a November day).
//   2. Only a CONFIRMED, unvoided record covers a day: pending and declined cover nothing.
//   3. The line-training QUESTION asks only days the No Activity engine names and nobody answered yet.
//   4. An answer: ticked days confirmed, unticked declined, a tick outside the question dropped.
//   5. The group save's four skip reasons, and no future day.
//   6. The conference names: the offered list only, never the rep himself.
//   7. A confirmed record proves the worked day for the deductions; a line training day alone does NOT.
//   8. The wiring: every calendar pass reads day records, and the line-training finder never covers.
// ─────────────────────────────────────────────────────────────────────────────

const window = { end: "2026-11-30", start: "2026-11-01" };
const lineNames = new Map([["pedia", "Pedia"]]);

function training(date: string, rep: string, line = "pedia", type = "training") {
  return { activity_date: date, activity_type: type, line_code: line, rep_hr_id: rep };
}

function stored(overrides: Partial<StoredDayRecordRow> = {}): StoredDayRecordRow {
  return {
    activity_type: "training",
    employee_hr_id: "A-8",
    entered_by_hr_id: "B-10",
    id: "11111111-1111-1111-1111-111111111111",
    named_by_hr_id: null,
    note: null,
    origin: "line_training",
    record_date: "2026-11-08",
    status: "confirmed",
    voided_at: null,
    ...overrides,
  };
}

function testLineTrainingDays() {
  const activities = [
    training("2026-11-08", "P-1"),
    training("2026-11-08", "P-2"),
    training("2026-11-08", "p-2"), // the same person in another case is still one
    training("2026-11-09", "P-1"), // one person alone is that rep's own training
    training("2026-11-10", "P-1", "pedia", "meeting"),
    training("2026-11-10", "P-2", "pedia", "meeting"), // meetings, no
    training("2026-11-11", "P-1"),
    training("2026-11-11", "P-3"),
  ];
  const managers = [
    { hireDate: "2025-02-01", hrId: "A-8", lastWorkingDate: null, lineCode: "pedia" },
    { hireDate: "2026-11-10", hrId: "B-155", lastWorkingDate: null, lineCode: "pedia" },
    { hireDate: "2026-12-01", hrId: "AI-0037", lastWorkingDate: null, lineCode: "pedia" },
  ];
  const days = selectLineTrainingDays({ activities, lineNames, managers, window });
  const of = (hrId: string) => days.filter((day) => day.hrId === hrId).map((day) => day.date);
  assert.deepEqual(of("A-8"), ["2026-11-08", "2026-11-11"], "2+ distinct people, Training only");
  assert.deepEqual(of("B-155"), ["2026-11-11"], "never a day before the hire date");
  assert.deepEqual(of("AI-0037"), [], "not hired yet: no day at all");

  const summary = summarizeLineTrainingDays(activities, lineNames);
  assert.deepEqual(summary.map((day) => [day.date, day.people]), [["2026-11-08", 2], ["2026-11-11", 2]]);

  assert.equal(isWithinDayRecordWindow("2026-11-30", { hireDate: "2026-12-01", lastWorkingDate: null }), false);
  assert.equal(isWithinDayRecordWindow("2026-11-30", { hireDate: null, lastWorkingDate: "2026-11-29" }), false);
  assert.equal(isWithinDayRecordWindow("2026-11-29", { hireDate: "2026-11-29", lastWorkingDate: "2026-11-29" }), true);
}

function testOnlyConfirmedCovers() {
  const rows = [
    stored({ id: "a", record_date: "2026-11-08" }),
    stored({ id: "b", record_date: "2026-11-09", status: "pending", origin: "rep_named", named_by_hr_id: "P-1" }),
    stored({ id: "c", record_date: "2026-11-10", status: "declined" }),
    stored({ id: "d", record_date: "2026-11-11", voided_at: "2026-11-12T10:00:00Z" }),
    stored({ id: "e", record_date: "2026-12-01" }),
  ];
  assert.deepEqual(
    selectStoredDayRecords(rows, window).map((day) => day.date),
    ["2026-11-08"],
    "pending, declined, voided and out-of-window records cover nothing",
  );
}

function testQuestions() {
  const k = privateCalendarHrIdKey;
  const lineDays = [
    { date: "2026-11-08", lineCode: "pedia", lineName: "Pedia", notes: ["Newcomers training"], people: 9 },
    { date: "2026-11-09", lineCode: "pedia", lineName: "Pedia", notes: [], people: 3 },
    { date: "2026-11-10", lineCode: "pedia", lineName: "Pedia", notes: [], people: 2 },
  ];
  const managers = [
    { hireDate: "2025-02-01", hrId: "A-8", lastWorkingDate: null, lineCode: "pedia", name: "Rasha Sabry" },
    { hireDate: "2026-12-01", hrId: "AI-0037", lastWorkingDate: null, lineCode: "pedia", name: "Nourhan Abdelmoniem" },
  ];
  const questions = buildLineTrainingQuestions({
    answered: new Set([`${k("A-8")}|2026-11-09`]),
    emptyDays: new Set([`${k("a-8")}|2026-11-08`, `${k("A-8")}|2026-11-09`, `${k("AI-0037")}|2026-11-08`]),
    lineDays,
    managers,
  });
  assert.equal(questions.length, 1, "nobody is asked about a day before the hire date");
  assert.equal(questions[0].name, "Rasha Sabry");
  assert.deepEqual(
    questions[0].days.map((day) => day.date),
    ["2026-11-08"],
    "only a day the No Activity engine names and nobody answered yet (10 Nov is covered elsewhere, 9 Nov answered)",
  );
  assert.ok(questions[0].prompt.includes("Pedia was in training on"), questions[0].prompt);
  assert.ok(!/A-8/.test(questions[0].prompt), "names, never codes");
  assert.equal(questions[0].days[0].suggested, null, "no suggestion until the AI has answered");
}

function testAnswers() {
  const answer = parseDayQuestionAnswer({
    dates: ["2026-11-08", "2026-11-11", "bad"],
    hrId: "A-8",
    kind: "line_training",
    ticked: ["2026-11-08", "2026-11-30"],
  });
  assert.equal(answer.kind, "line_training");
  if (answer.kind === "line_training") {
    assert.deepEqual(answer.dates, ["2026-11-08", "2026-11-11"]);
    assert.deepEqual(answer.ticked, ["2026-11-08"], "a tick outside the question's days is dropped");
  }
  const conference = parseDayQuestionAnswer({ confirm: ["x"], decline: ["x", "y"], kind: "rep_named" });
  assert.deepEqual(conference.kind === "rep_named" ? [conference.confirm, conference.decline] : null, [["x"], ["y"]]);
  assert.throws(() => parseDayQuestionAnswer({ kind: "line_training", dates: [], hrId: "A-8" }));
  assert.throws(() => parseDayQuestionAnswer({ kind: "automatic" }));
}

function testGroupSave() {
  assert.throws(() => parseDayRecordDraft({ activityType: "meeting", date: "2026-11-29", hrIds: ["A-8"] }, "2026-11-28"), "no future day");
  assert.throws(() => parseDayRecordDraft({ activityType: "lunch", date: "2026-11-26", hrIds: ["A-8"] }, "2026-11-28"));
  const k = privateCalendarHrIdKey;
  const people = new Map([
    [k("A-8"), { hireDate: "2025-02-01", hrId: "A-8", lastWorkingDate: null, name: "Rasha Sabry" }],
    [k("AI-0037"), { hireDate: "2026-12-01", hrId: "AI-0037", lastWorkingDate: null, name: "Nourhan Abdelmoniem" }],
    [k("B-1"), { hireDate: "2024-01-01", hrId: "B-1", lastWorkingDate: "2026-11-01", name: "Left Early" }],
    [k("B-2"), { hireDate: "2024-01-01", hrId: "B-2", lastWorkingDate: null, name: "Already Recorded" }],
  ]);
  const plan = planDayRecordSave({ date: "2026-11-26", existingKeys: new Set([k("B-2")]), hrIds: ["a-8", "AI-0037", "B-1", "B-2", "ZZ-9"], people });
  assert.deepEqual(plan.write.map((person) => person.name), ["Rasha Sabry"]);
  assert.deepEqual(
    plan.skipped.map((person) => person.reason),
    ["Not hired yet on that day", "Had already left on that day", "Already has a day record for that day", "Not an employee"],
  );
}

function testConferenceNames() {
  assert.equal(isConferenceCompanionTitle("District Sales Manager"), true);
  assert.equal(isConferenceCompanionTitle("Group Product Manager"), true);
  assert.equal(isConferenceCompanionTitle("Medical Representative"), false);
  const offered = [
    { hrId: "A-8", jobTitle: "Group Product Manager", name: "Rasha Sabry" },
    { hrId: "D-1", jobTitle: "District Sales Manager", name: "A Manager" },
  ];
  const picked = pickConferenceCompanions({ offered, repHrId: "D-1", ticked: ["a-8", "A-8", "D-1", "NOT-OFFERED"] });
  assert.deepEqual(picked.map((person) => person.hrId), ["A-8"], "the offered list only, once, never the rep himself");
}

function testProvenWorkedDays() {
  const record = (origin: DayRecord["origin"]): DayRecord => ({
    activityType: "training",
    date: "2026-11-08",
    enteredByHrId: "B-10",
    hrId: "A-8",
    id: "a",
    lineName: null,
    namedByHrId: null,
    namedByName: null,
    note: null,
    origin,
    people: null,
  });
  const empty = { evidence: new Map(), keys: new Set<string>() };
  const key = phoenixWorkedDayKey("A-8", "2026-11-08");
  assert.ok(key);
  const proven = selectProvenWorkedDays({ dayRecords: [record("line_training")], phoenix: empty, trips: [] });
  assert.ok(proven.keys.has(key!), "a CONFIRMED day record proves the worked day, so it is never a deduction candidate");
  assert.ok(selectProvenWorkedDays({ phoenix: empty, trips: [] }).keys.has(key!) === false, "without it the day stays open");
}

function testWiring() {
  const read = (path: string) => readFileSync(path, "utf8");
  const service = read("src/lib/private-calendar/service.ts");
  assert.equal(
    service.split("loadDayRecordPrivateCalendarItems(").length - 1,
    4,
    "the workspace, the company No Activity pass, the day evidence and the Phoenix CRM entries all read day records",
  );
  assert.ok(service.includes("loadDayRecordPrivateCalendarItems(hrIds, input.start, input.end, { strict: true })"), "the deductions pass reads them STRICT");

  const records = read("src/lib/private-calendar/day-records.ts");
  const loadDayRecords = records.slice(records.indexOf("export async function loadDayRecords("));
  assert.ok(!loadDayRecords.slice(0, 400).includes("loadLineTrainingDays"), "a line's training day is a QUESTION, never coverage — never automatic");
  assert.ok(records.includes('.eq("status", "confirmed")'), "only a confirmed record is read as coverage");

  const proven = read("src/lib/deductions/proven-worked-days.ts");
  assert.ok(proven.includes("loadDayRecords("), "the deductions fold reads the day records");

  const route = read("app/api/private-calendar/day-records/route.ts");
  assert.ok(route.split("assertDayRecordActor(access)").length - 1 >= 2, "both verbs are Super Admin only, before the body");
  const questions = read("src/lib/private-calendar/day-record-questions.ts");
  assert.ok(questions.includes('component: "private_calendar_day_questions"'), "the AI goes through the one door, on its own board line");
  assert.ok(!questions.includes(".insert(") || questions.indexOf(".insert(") > questions.indexOf("export async function answerDayRecordQuestion"), "only his answer writes");

  const save = read("src/lib/phoenix-crm/server/day-activities.ts");
  assert.ok(save.includes("if (!isTest) {"), "a test account never names anyone");
  assert.ok(save.includes('parsed.value.activityType === "conference" && !parsed.value.halfDay'), "only a whole-day Conference asks who was there");
  const companions = read("src/lib/private-calendar/conference-companions.ts");
  assert.ok(companions.includes('status: "pending"'), "a rep's name is pending until the Super Admin confirms it");
}

export function runPrivateCalendarDayRecordsTests() {
  testLineTrainingDays();
  testOnlyConfirmedCovers();
  testQuestions();
  testAnswers();
  testGroupSave();
  testConferenceNames();
  testProvenWorkedDays();
  testWiring();
}
