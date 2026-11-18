import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildExportRows } from "../src/lib/private-calendar/export.ts";
import {
  everyInterviewAttendance,
  interviewAttendeesFor,
  interviewHalfDaysFromAttendances,
  mapInterviewToPrivateCalendarItem,
} from "../src/lib/private-calendar/interview-items.ts";
import { describeInterviewHalfDay, interviewHalfOf } from "../src/lib/private-calendar/interview-halves.ts";
import { halfDayReason, judgeHalfDay } from "../src/lib/deductions/half-day-rule.ts";
import { selectPhoenixWorkedDays } from "../src/lib/deductions/phoenix-worked-days.ts";
import { selectProvenWorkedDays } from "../src/lib/deductions/proven-worked-days.ts";
import {
  derivePrivateCalendarExceptions,
  summarizePrivateCalendarItems,
  type PrivateCalendarEmployeeOption,
  type PrivateCalendarItem,
  type PrivateCalendarWorkspace,
} from "../src/lib/private-calendar/logic.ts";
import type { PrivateCalendarInterviewRow } from "../src/lib/recruitment/interview-calendar.ts";

// ─────────────────────────────────────────────────────────────────────────────
// INTERVIEWS ON THE PRIVATE CALENDAR.
//
// Owner, 2026-10-29: "also if he have an interview from calendar throw it in his private calendars".
//
// What this pins:
//   1. Each interview reaches the lead interviewer and every panel member, each once, whatever case the
//      hr id is stored in; a lead who declined does not get it, and a manager it was only shared with
//      never does (the row does not even carry him).
//   2. The item's shape: Cairo time range, the role in the title, names never codes.
//   3. ONE interview is display only; TWO OR MORE in one half are that half day worked (owner,
//      2026-11-18). The morning ends at 1 PM Cairo (his choice the same day).
//   4. The Excel export still prints No Activity Recorded on a day with one interview.
//   5. Every pass reads the source, and the company deductions pass reads it STRICT.
//   6. The deductions: both halves is a proven day; one half drops the day from the full-day
//      readers and the Half Day tab charges the other half at 0.5; a field Thursday's morning is
//      the whole day and its afternoon alone is nothing.
// ─────────────────────────────────────────────────────────────────────────────

const read = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

const mina: PrivateCalendarEmployeeOption = {
  departmentName: "Sales",
  fullName: "Mina Farouk",
  hrId: "B-40",
  jobTitle: "District Manager",
  lineName: "CNS",
  managerHrId: "B-1",
  managerName: "Manager",
};

// 11:00 Cairo on 2026-10-28 (Egypt is on summer time, UTC+3, until the last Friday of October).
const interview: PrivateCalendarInterviewRow = {
  area: "Giza",
  candidateName: "Sara Adel",
  durationMinutes: 45,
  id: "booking-1",
  jobTitle: "Medical Representative",
  leadDeclined: false,
  leadHrId: "b-40",
  line: "CNS",
  panelHrIds: ["B-41", "B-40"],
  platform: "in_office",
  startsAt: "2026-10-28T08:00:00.000Z",
};

function noActivityDays(items: PrivateCalendarItem[]) {
  return derivePrivateCalendarExceptions({
    employees: [mina],
    end: "2026-10-28",
    isExpectedWorkday: () => true,
    items,
    start: "2026-10-28",
    today: "2026-10-31",
  })
    .filter((exception) => exception.code === "no_activity_recorded")
    .map((exception) => exception.date);
}

export function runPrivateCalendarInterviewsTests() {
  // ── 1 · Who sits in it ─────────────────────────────────────────────────────────────────────────
  const both = interviewAttendeesFor([interview], ["B-40", "b-41", "B-99"]);
  assert.deepEqual(
    both.map((entry) => [entry.hrId.toUpperCase(), entry.isLead]),
    [["B-40", true], ["B-41", false]],
    "the lead and the panel each get it once, whatever case the hr id is stored in; a lead also listed on the panel is not doubled",
  );
  assert.deepEqual(interviewAttendeesFor([interview], ["B-99"]), [], "someone who does not sit in it never gets it");

  const declined = interviewAttendeesFor([{ ...interview, leadDeclined: true, panelHrIds: ["B-41"] }], ["B-40", "B-41"]);
  assert.deepEqual(
    declined.map((entry) => [entry.hrId.toUpperCase(), entry.isLead]),
    [["B-41", false]],
    "a lead who declined is not expected there, so his calendar drops it; the panel keeps it",
  );

  const recruitment = read("src/lib/recruitment/interview-calendar.ts");
  const loader = recruitment.slice(recruitment.indexOf("export async function listInterviewsForPrivateCalendar"));
  assert.doesNotMatch(
    loader.slice(0, loader.indexOf("\n}\n")),
    /shared_with_hr_ids/,
    "a manager the interview was only shared with watches it; he does not sit in it, so the private-calendar read never carries him",
  );

  // ── 2 · The item ───────────────────────────────────────────────────────────────────────────────
  const [lead, panel] = both.map(mapInterviewToPrivateCalendarItem);
  assert.ok(lead && panel);
  assert.equal(lead.source, "interview");
  assert.equal(lead.activityKind, "interview");
  assert.equal(lead.severity, "info");
  assert.equal(lead.startDate, "2026-10-28");
  assert.equal(lead.endDate, "2026-10-28");
  assert.equal(lead.time, "11:00 – 11:45", "the time is Cairo local, start to end");
  assert.equal(lead.title, "Interview — Medical Representative");
  assert.deepEqual(lead.chipLines, ["11:00 – 11:45 Interview", "Medical Representative"]);
  assert.deepEqual(lead.detailLines, [
    "Candidate: Sara Adel",
    "Role: Medical Representative",
    "Area and line: Giza · CNS",
    "Platform: In office",
    "Your part: Lead interviewer",
  ]);
  assert.equal(panel.detailLines.at(-1), "Your part: Panel");
  assert.equal(lead.sourceRecordId, null, "the booking id is never printed on the detail panel");
  assert.notEqual(lead.id, panel.id, "each attendee's entry is its own");
  assert.equal(mapInterviewToPrivateCalendarItem({ hrId: "B-40", interview: { ...interview, jobTitle: null }, isLead: true }).title, "Interview");

  // ── 3 · One interview shows; two in a half are that half day ───────────────────────────────────
  assert.deepEqual(noActivityDays([]), ["2026-10-28"]);
  assert.deepEqual(
    noActivityDays([lead]),
    ["2026-10-28"],
    "ONE interview in a half covers nothing — it is shown, and the day still reads No Activity Recorded",
  );
  assert.equal(summarizePrivateCalendarItems([lead]).interview, 1, "the Interviews figure counts them");
  assert.equal(lead.interviewHalf, "AM", "11:00 is the morning");
  assert.equal(interviewHalfOf(12 * 60 + 59), "AM", "12:59 is still the morning");
  assert.equal(interviewHalfOf(13 * 60), "PM", "the afternoon starts at 1 PM Cairo — his choice, 2026-11-18");

  // 28 Oct 2026 is UTC+3 (summer time): 08:00Z is 11:00, 08:45Z is 11:45, 10:00Z is 13:00, 10:30Z is 13:30.
  const at = (id: string, startsAt: string) =>
    mapInterviewToPrivateCalendarItem({ hrId: "B-40", interview: { ...interview, id, startsAt }, isLead: true });
  const morningTwo = [at("m1", "2026-10-28T08:00:00.000Z"), at("m2", "2026-10-28T08:45:00.000Z")];
  assert.deepEqual(noActivityDays(morningTwo), [], "two interviews in the morning are a morning half day — the day is no longer No Activity Recorded");
  const afternoonTwo = [at("a1", "2026-10-28T10:00:00.000Z"), at("a2", "2026-10-28T10:30:00.000Z")];
  assert.deepEqual(noActivityDays(afternoonTwo), [], "two interviews from 1 PM are an afternoon half day");
  assert.deepEqual(
    noActivityDays([at("s1", "2026-10-28T08:00:00.000Z"), at("s2", "2026-10-28T10:00:00.000Z")]),
    ["2026-10-28"],
    "one in the morning and one in the afternoon is not two in ONE half — nothing is covered",
  );
  assert.deepEqual(noActivityDays([morningTwo[0], { ...morningTwo[0] }]), ["2026-10-28"], "the same interview twice is still one interview");
  // Thu 29 Oct 2026 (UTC+3): 08:00Z is 11:00, 11:00Z is 14:00 — one per half, but on a Thursday any hour counts.
  const thursdayNoActivity = derivePrivateCalendarExceptions({
    employees: [mina],
    end: "2026-10-29",
    isExpectedWorkday: () => true,
    items: [at("t1", "2026-10-29T08:00:00.000Z"), at("t2", "2026-10-29T11:00:00.000Z")],
    start: "2026-10-29",
    today: "2026-10-31",
  }).filter((exception) => exception.code === "no_activity_recorded");
  assert.deepEqual(thursdayNoActivity, [], "on a Thursday two interviews at any hour are the Thursday worked (owner, 2026-11-18)");

  // ── 4 · The export keeps the finding on an interview-only day ──────────────────────────────────
  const leadOnMina = { ...lead, employeeName: mina.fullName };
  const exceptions = derivePrivateCalendarExceptions({
    employees: [mina],
    end: "2026-10-28",
    isExpectedWorkday: () => true,
    items: [leadOnMina],
    start: "2026-10-28",
    today: "2026-10-31",
  });
  const workspace = {
    exceptions,
    items: [leadOnMina],
    selectedEmployee: mina,
    teamSummary: [],
    viewMode: "employee",
    weeks: [[{ date: "2026-10-28", inMonth: true }]],
  } as unknown as PrivateCalendarWorkspace;
  const [row] = buildExportRows(workspace);
  assert.ok(row);
  assert.match(row.title, /^Interview — Medical Representative \| No Activity Recorded$/, "the sheet HR keeps still says the day holds no record of work");
  assert.equal(row.severity, "danger");

  // ── 5 · Wiring ─────────────────────────────────────────────────────────────────────────────────
  const service = read("src/lib/private-calendar/service.ts");
  assert.equal(
    service.match(/loadInterviewPrivateCalendarItems\(/g)?.length,
    3,
    "the workspace, the day evidence and the company deductions pass all load the interviews",
  );
  const deductionsPass = service.slice(service.indexOf("export async function getCompanyNoActivityDays"), service.indexOf("export async function getPrivateCalendarDayEvidence"));
  assert.match(
    deductionsPass,
    /loadInterviewPrivateCalendarItems\(hrIds, input\.start, input\.end, \{ strict: true \}\)/,
    "the deductions pass reads interviews STRICT — a failed read throws instead of raising a day he worked",
  );
  assert.match(deductionsPass, /\.\.\.interviews\.items,/, "and feeds them to the same engine the calendar uses");
  assert.match(service, /interview: interviews\.ready,/, "a failed interview read says so, rather than showing a confident empty month");
  assert.match(service, /unreadableSources\.push\("interview"\)/, "a reviewer is told when the interviews could not be read");

  const ui = read("src/components/employee-portal/private-calendar.tsx");
  assert.match(ui, /\n {2}interview: \{/, "an interview has its own entry in the one colour table");
  assert.match(ui, /ready=\{sourceReadiness\.interview\}/, "the Interviews figure says when the interviews could not be read");

  // ── 6 · The deductions ─────────────────────────────────────────────────────────────────────────
  // A district manager's Wed 4 Nov 2026 (winter time, UTC+2): 13:00, 13:30 and 16:30 Cairo — three in the afternoon.
  const on = (id: string, startsAt: string): PrivateCalendarInterviewRow => ({ ...interview, id, leadHrId: "PD-0031", panelHrIds: [], startsAt });
  const halfDays = interviewHalfDaysFromAttendances(
    everyInterviewAttendance([
      on("z1", "2026-11-04T11:00:00.000Z"),
      on("z2", "2026-11-04T11:30:00.000Z"),
      on("z3", "2026-11-04T14:30:00.000Z"),
      // 2 Nov: one interview only — no half.
      on("z4", "2026-11-02T11:00:00.000Z"),
      // Sat 7 Nov: 10:00 and 11:00 in the morning, 14:00 and 15:00 in the afternoon — the whole day.
      on("z5", "2026-11-07T08:00:00.000Z"),
      on("z6", "2026-11-07T09:00:00.000Z"),
      on("z7", "2026-11-07T12:00:00.000Z"),
      on("z8", "2026-11-07T13:00:00.000Z"),
      // Thu 5 Nov: 11:00 and 16:30 — one per half, but on a field Thursday two at ANY hour are the Thursday worked.
      on("z9", "2026-11-05T09:00:00.000Z"),
      on("z10", "2026-11-05T14:30:00.000Z"),
      // Wed 11 Nov: one in the morning, one in the afternoon — not two in ONE half.
      on("z11", "2026-11-11T08:00:00.000Z"),
      on("z12", "2026-11-11T12:00:00.000Z"),
    ]),
  );
  assert.deepEqual(
    halfDays.map((day) => [day.date, day.am, day.pm]),
    [["2026-11-04", false, true], ["2026-11-05", false, false], ["2026-11-07", true, true]],
    "4 Nov covers the afternoon, Thursday 5 Nov is kept (two at any hour), 7 Nov the whole day; 2 Nov (one interview) and 11 Nov (one per half) cover nothing",
  );
  const worked = selectProvenWorkedDays({ interviewHalfDays: halfDays, phoenix: selectPhoenixWorkedDays([]), trips: [] });
  assert.ok(worked.keys.has("pd0031:2026-11-07"), "both halves covered: a proven-worked day, dropped by every deduction reader");
  assert.equal(worked.interviewHalfOnly.has("pd0031:2026-11-07"), false);
  assert.ok(worked.keys.has("pd0031:2026-11-04"), "one half covered: no full-day reader charges the day");
  assert.equal(worked.interviewHalfOnly.get("pd0031:2026-11-04"), "PM", "and the Half Day tab is told which half the interviews hold");
  assert.ok(worked.keys.has("pd0031:2026-11-05"), "a field Thursday with two interviews at any hour is the Thursday worked");
  assert.equal(worked.interviewHalfOnly.has("pd0031:2026-11-05"), false, "and it is whole — there is no Thursday afternoon to charge");
  assert.equal(worked.keys.has("pd0031:2026-11-02"), false, "one interview covers nothing");
  assert.equal(worked.keys.has("pd0031:2026-11-11"), false, "one in each half covers nothing");
  const fourth = halfDays.find((day) => day.date === "2026-11-04");
  const fifth = halfDays.find((day) => day.date === "2026-11-05");
  assert.ok(fourth && fifth);
  assert.equal(describeInterviewHalfDay(fourth), "Interviews on the recruitment calendar: 3 in the afternoon — the afternoon half worked");
  assert.equal(describeInterviewHalfDay(fifth), "Interviews on the recruitment calendar: 2 on a Thursday — the Thursday worked");
  const proven = selectProvenWorkedDays({
    interviewHalfDays: halfDays,
    phoenix: selectPhoenixWorkedDays([{ date: "2026-11-04", dayActivities: [], dayStarts: 0, hrId: "PD-0031", visits: 4 }]),
    trips: [],
  });
  assert.equal(proven.interviewHalfOnly.has("pd0031:2026-11-04"), false, "a day another source already proves is never handed to the Half Day tab");

  // The Half Day tab: the interviews hold the afternoon, nothing holds the morning → 0.5.
  const verdict = judgeHalfDay(undefined, { interviewsPm: true });
  assert.deepEqual(verdict, { coveredBy: ["interviews"], kind: "half_day", missing: "AM" }, "the morning with nothing in it is the half day");
  assert.ok(verdict.kind === "half_day");
  assert.equal(
    halfDayReason(verdict),
    "Interviews in the afternoon only — nothing recorded for the morning: no visit, check-in, approved vacation or request",
  );
  assert.deepEqual(judgeHalfDay(undefined, { interviewsAm: true, vacationPm: true }), { kind: "not_a_half_day" }, "interviews and a half-day vacation make the whole day");

  const halfDayConnector = read("src/lib/deductions/connectors/half-day.ts");
  assert.match(
    halfDayConnector,
    /if \(provenWorked\.keys\.has\(key\) && !interviewHalf\) continue;/,
    "the Half Day tab judges a day only one half of which the interviews cover, instead of skipping it",
  );
  const provenSource = read("src/lib/deductions/proven-worked-days.ts");
  assert.match(provenSource, /loadInterviewHalfDays\(input\)/, "loadProvenWorkedDays reads the interviews");
}
