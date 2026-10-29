import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  mapAttendanceRowToPrivateCalendarItem,
  mapExcuseRowToPrivateCalendarItem,
  mapVacationRowToPrivateCalendarItem,
  type PrivateCalendarItem,
} from "../src/lib/private-calendar/logic.ts";
import { managerOwnVisitItem } from "../src/lib/private-calendar/manager-own-visit-items.ts";
import { mapManagerHalfDayToPrivateCalendarItem, mapPlanRowToPrivateCalendarItem } from "../src/lib/private-calendar/plan-items.ts";

// Tables say every fact once (docs/tables-said-once-fit.md). A private-calendar entry is drawn as a
// title, a time, a status, a chip and then its detail lines; a detail line that restates one of those
// is the same fact printed twice. Template: `everyFactSaidOnce` in tests/phoenix-crm-manager-visit-details.test.ts.

const norm = (value: string | null | undefined) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** Every detail line, minus its "Label: " lead, that equals a fact the entry already shows elsewhere. */
function restatedDetailLines(item: PrivateCalendarItem): string[] {
  const shown = new Set(
    [item.title, item.time, item.status, item.description, ...(item.chipLines ?? [])].map(norm).filter(Boolean),
  );
  return item.detailLines.filter((line) => {
    const body = norm(line.includes(":") ? line.slice(line.indexOf(":") + 1) : line);
    return shown.has(norm(line)) || (body !== "" && shown.has(body));
  });
}

/** The labels that only ever restated the title, the time, the status or the chip. */
const RESTATING_LABELS = /^(Kind|Visits|Activity|Half day|Action|Day part):/;

function assertSaidOnce(label: string, item: PrivateCalendarItem, allowed: RegExp = /^$/) {
  assert.deepEqual(restatedDetailLines(item), [], `${label}: a detail line repeats the title, time, status, description or chip`);
  for (const line of item.detailLines) {
    if (allowed.test(line)) continue;
    assert.ok(!RESTATING_LABELS.test(line), `${label}: "${line}" is a label that only restated what the entry shows`);
  }
}

export function runPrivateCalendarSaidOnceTests() {
  // An approved weekly plan item: the chip carries activity and place, the status carries "approved".
  const plan = mapPlanRowToPrivateCalendarItem(
    { employee_hr_id: "E-1", employee_name: "Employee One", manager_name: "Manager One", period_key: "2026-W43", status: "manager_approved" },
    {
      activity_date: "2026-10-20",
      activity_title: "Pharmacy round",
      activity_type: "Field",
      area: "Nasr City",
      double_visit_medical_rep_name: null,
      end_time: "14:00",
      id: "item-1",
      location_text: null,
      notes: null,
      objective: "Launch the new line",
      start_time: "09:00",
    } as unknown as Parameters<typeof mapPlanRowToPrivateCalendarItem>[1],
  );
  assertSaidOnce("plan item", plan);
  assert.ok(plan.chipLines?.some((line) => line.includes("Nasr City")), "the place is the chip's, so no Where line");
  assert.ok(plan.detailLines.includes("Objective: Launch the new line"), "a fact only the detail carries stays");
  assert.ok(plan.detailLines.some((line) => /Manager One/.test(line)), "who signed the week off is a fact no other field carries");
  assert.ok(!/^Approved by the manager/.test(plan.approvalImpact ?? ""), "the note does not say 'approved' a third time");

  // A Phoenix CRM half-day: the half is the time, the activity is the title and chip.
  const halfDay = mapManagerHalfDayToPrivateCalendarItem(
    {
      activityLabel: null,
      activityType: null,
      areaName: "Maadi",
      customerCount: 6,
      date: "2026-10-21",
      decidedByHrId: "M-1",
      firstApproverHrId: null,
      half: "AM",
      isTest: false,
      kind: "single_visit",
      legacyType: "Field",
      managerHrId: "E-2",
      managerSeatId: null,
      note: null,
      plannerKind: "district_manager",
      planId: "plan-1",
      repHrId: null,
      repSeatId: null,
      seniorHrId: null,
      slotId: "slot-1",
      status: "approved",
      weekStart: "2026-10-18",
    } as unknown as Parameters<typeof mapManagerHalfDayToPrivateCalendarItem>[0],
    { approver: "Manager One", rep: null },
  );
  assertSaidOnce("manager half-day", halfDay);
  assert.equal(halfDay.time, "AM");
  assert.ok(!halfDay.detailLines.some((line) => /^Half day:/.test(line)), "'Half day: AM' under a time of 'AM' is the same fact twice");
  assert.ok(halfDay.detailLines.includes("Customers planned: 6"), "the planned customer count is only said here");

  // A manager's own single visits: kind is the chip's first line, the count is the title.
  const own = managerOwnVisitItem({ date: "2026-10-19", hrId: "B-116", visits: 2 });
  assertSaidOnce("manager own visits", own);

  // Attendance: the recommended action is the description, so no "Action:" line; minutes stay.
  const attendance = mapAttendanceRowToPrivateCalendarItem({
    actualFirstPunch: "9:40 AM",
    actualLastPunch: "5:10 PM",
    dateIso: "2026-10-20",
    deductionDays: "0.25",
    earlyLeaveMinutes: "",
    employeeHrId: "E-1",
    employeeName: "Employee One",
    lateMinutes: "25",
    recommendedAction: "Deduct quarter day",
    scheduledEnd: "5:00 PM",
    scheduledStart: "9:00 AM",
    status: "Late",
    timeLong: "07:30",
  });
  assertSaidOnce("attendance", attendance);
  assert.equal(attendance.description, "Deduct quarter day");
  assert.ok(attendance.detailLines.includes("Late: 25 min"), "the late minutes are not in the title, chip or time, so they stay");

  // Vacation: "pending" is said once (the source label and status), never in the title too.
  const vacation = (pending: boolean, dayPart: string, paid: string) =>
    mapVacationRowToPrivateCalendarItem(
      {
        day_part: dayPart,
        duration_days: "1",
        employee_hr_id: "E-1",
        employee_name: "Employee One",
        end_date: "2026-10-22",
        id: "vac-1",
        paid_duration_days: paid,
        payment_status: "paid",
        start_date: "2026-10-22",
        status: pending ? "pending_manager" : "approved",
        vacation_type: "annual",
      },
      { pending },
    );
  const pendingVacation = vacation(true, "full_day", "1");
  assertSaidOnce("pending vacation", pendingVacation);
  assert.ok(!/pending/i.test(pendingVacation.title), "'(pending)' in the title repeats the status and the source label");
  assert.ok(!/pending/i.test(pendingVacation.approvalImpact ?? ""), "the note does not say pending a third time");
  assert.match(pendingVacation.sourceLabel, /pending/i, "pending is said once, in the source label");
  assert.ok(!pendingVacation.detailLines.some((line) => /^Paid:/.test(line)), "Paid equal to Duration is the same number twice");
  assert.ok(vacation(false, "full_day", "0.5").detailLines.some((line) => line === "Paid: 0.5 day(s)"), "a paid figure that differs stays");
  const half = vacation(false, "pm_only", "1");
  assert.equal(half.time, "PM only");
  assert.ok(!half.detailLines.some((line) => /^Day part:/.test(line)), "the day part is the time");

  // Excuse: the two hours are said once, in the time.
  const excuse = mapExcuseRowToPrivateCalendarItem({
    duration_hours: "2",
    employee_hr_id: "E-1",
    employee_name: "Employee One",
    excuse_date: "2026-10-22",
    excuse_type: "morning",
    id: "ex-1",
    status: "approved",
  });
  assertSaidOnce("excuse", excuse);
  assert.equal(excuse.time, "Morning (2h)");
  assert.deepEqual(excuse.detailLines, [], "an excuse has nothing to say beyond its title and time");
  assert.ok(!/2-hour|2 hour/i.test(excuse.approvalImpact ?? ""), "the note does not repeat the duration");

  // The two builders that read the database (so no fixture reaches them) are held by their source: neither
  // may write the "Kind:", "Visits:" or "Customer N:" lines that restated the title, the time and the chip.
  for (const file of ["field-visits", "phoenix-work-evidence-items", "manager-own-visit-items"]) {
    const source = stripComments(readFileSync(`src/lib/private-calendar/${file}.ts`, "utf8"));
    assert.ok(!/`Kind: /.test(source), `${file}.ts writes a "Kind:" line that repeats the title`);
    assert.ok(!/`Visits: /.test(source), `${file}.ts writes a "Visits:" line that repeats the time`);
    assert.ok(!/`Customer \$\{/.test(source), `${file}.ts writes "Customer N:" lines that repeat the chip`);
  }
}
