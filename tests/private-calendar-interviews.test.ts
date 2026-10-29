import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildExportRows } from "../src/lib/private-calendar/export.ts";
import { interviewAttendeesFor, mapInterviewToPrivateCalendarItem } from "../src/lib/private-calendar/interview-items.ts";
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
//   3. DISPLAY ONLY — an interview never clears No Activity Recorded, because that reading feeds the
//      No Records Activity deductions. The Phoenix CRM "Interviews" day activity is what counts.
//   4. The Excel export still prints that No Activity Recorded on an interview-only day.
//   5. The workspace and the day evidence read the source; the company deductions engine does not.
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

  // ── 3 · Display only ───────────────────────────────────────────────────────────────────────────
  assert.deepEqual(noActivityDays([]), ["2026-10-28"]);
  assert.deepEqual(
    noActivityDays([lead]),
    ["2026-10-28"],
    "an interview never clears No Activity Recorded — that reading feeds the deductions; the CRM Interviews day activity is the record",
  );
  assert.equal(summarizePrivateCalendarItems([lead]).interview, 1, "the Interviews figure counts them");

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
    2,
    "the workspace and the day evidence a reviewer reads load the interviews; the company deductions engine does not",
  );
  const deductionsPass = service.slice(service.indexOf("export async function getCompanyNoActivityDays"), service.indexOf("export async function getPrivateCalendarDayEvidence"));
  assert.doesNotMatch(deductionsPass, /loadInterviewPrivateCalendarItems/, "the deductions engine never reads interviews");
  assert.match(service, /interview: interviews\.ready,/, "a failed interview read says so, rather than showing a confident empty month");
  assert.match(service, /unreadableSources\.push\("interview"\)/, "a reviewer is told when the interviews could not be read");

  const logic = read("src/lib/private-calendar/logic.ts");
  const covered = logic.slice(logic.indexOf("const isCovered ="), logic.indexOf("if (isExpectedWorkday(employee, date) && !isCovered)"));
  assert.doesNotMatch(covered, /interview/, "isCovered never names an interview");

  const ui = read("src/components/employee-portal/private-calendar.tsx");
  assert.match(ui, /\n {2}interview: \{/, "an interview has its own entry in the one colour table");
  assert.match(ui, /ready=\{sourceReadiness\.interview\}/, "the Interviews figure says when the interviews could not be read");
}
