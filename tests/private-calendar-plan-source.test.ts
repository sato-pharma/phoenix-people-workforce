import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  APPROVED_PLAN_STATUSES,
  PLAN_ACTIVITY_TYPES_RECORDED_NOWHERE_ELSE,
  mapPlanRowToPrivateCalendarItem,
  plannedActivityCoversTheDay,
} from "../src/lib/private-calendar/plan-items.ts";
import {
  derivePrivateCalendarExceptions,
  summarizePrivateCalendarItems,
  suppressFieldVisitAttendanceProblems,
  type PrivateCalendarEmployeeOption,
  type PrivateCalendarItem,
} from "../src/lib/private-calendar/logic.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The APPROVED WEEKLY PLAN as a private-calendar source.
//
// Before this, the calendar read only CAPTURED records — a fingerprint punch, an approved leave or
// excuse, a national holiday, a CRM visit. A field manager's approved Travel, Admin or Meeting day
// produces none of those by design: there is no device to punch in Sohag and no customer visit to
// log. So the day read "No Activity Recorded" although the employee's own manager had approved
// exactly that day, in Phoenix, in writing, days before — which is what the 4 October 2026 review
// request was about.
//
// The four properties this pins, because each one wrong is a specific, costly defect:
//   1. APPROVED ONLY. A draft, submitted, returned, rejected or cancelled plan is an intention
//      nobody signed, and it must not take a single day off the exceptions board.
//   2. THE PLAN COVERS THE DAY ONLY WHERE PHOENIX RECORDS IT NOWHERE ELSE. A planned Field or
//      Double Visit day with no logged visit, a planned Office day with no punch, a planned Vacation
//      with no approved leave request — each of those is a REAL gap, and this engine's output
//      becomes payroll deduction candidates (getCompanyNoActivityDays → the Deductions module's No
//      Records Activity connector). Measured on production for 1 Aug – 7 Oct 2026: excusing every
//      planned type would have erased 364 genuine gaps, 318 of them planned double visits with
//      nothing logged.
//   3. A PLAN NEVER SUPPRESSES AN ATTENDANCE PROBLEM. A Late or Short-day flag is about a punch that
//      exists; only a CRM-verified double visit suppresses one. A plan that silenced those would hide
//      a second class of real finding behind a document the employee wrote himself.
//   4. BOTH ENGINES READ IT. The employee's own calendar and the company no-activity engine share
//      derivePrivateCalendarExceptions precisely so that a day the employee sees as covered can never
//      arrive in Deductions as a candidate.
// ─────────────────────────────────────────────────────────────────────────────

const read = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

const employee: PrivateCalendarEmployeeOption = {
  departmentName: "Sales",
  fullName: "Planned Manager",
  hrId: "AI-0013",
  jobTitle: "District Manager",
  lineName: "CNS",
  managerHrId: "AI-0001",
  managerName: "Magdy El Senosey",
};

function planItem(date: string, activityType: string, overrides: Partial<PrivateCalendarItem> = {}) {
  return {
    ...mapPlanRowToPrivateCalendarItem(
      {
        employee_hr_id: employee.hrId,
        employee_name: employee.fullName,
        manager_name: employee.managerName,
        period_key: "2026-W40",
        status: "hr_acknowledged",
      },
      {
        activity_date: date,
        activity_title: activityType,
        activity_type: activityType,
        area: null,
        double_visit_medical_rep_name: null,
        end_time: null,
        id: `item-${date}-${activityType}`,
        location_text: "Upper Egypt 2",
        notes: null,
        objective: null,
        start_time: null,
      },
    ),
    ...overrides,
  } satisfies PrivateCalendarItem;
}

/** Exceptions for one employee over one day, with the plan as the only thing on the calendar. */
function exceptionsFor(items: PrivateCalendarItem[], date: string) {
  return derivePrivateCalendarExceptions({
    employees: [employee],
    end: date,
    // The weekly-off policy is not what is under test here: this day is a workday.
    isExpectedWorkday: () => true,
    items,
    start: date,
    today: "2026-10-31",
  });
}

export function runPrivateCalendarPlanSourceTests() {
  // ── 1 · Approved only ───────────────────────────────────────────────────────────────────────────
  (function onlyAnApprovedPlanIsReadAtAll() {
    assert.deepEqual(
      [...APPROVED_PLAN_STATUSES].sort(),
      ["final_approved", "hr_acknowledged", "manager_approved"],
      "a plan counts once its manager has signed it off — and nothing else does",
    );
    for (const status of ["draft", "submitted", "manager_returned", "manager_rejected", "ceo_returned", "ceo_rejected", "cancelled"]) {
      assert.ok(
        !(APPROVED_PLAN_STATUSES as readonly string[]).includes(status),
        `${status} is an intention nobody approved and must never cover a day`,
      );
    }

    // The status filter is on the query, not applied in memory afterwards — a read that fetched every
    // plan and filtered later would still be one `.filter` away from covering a draft.
    const loader = read("src/lib/private-calendar/plan-items.ts");
    assert.match(loader, /\.in\("status", APPROVED_PLAN_STATUSES\)/, "the database read itself is restricted to approved plans");
    assert.match(loader, /\.eq\("plan_kind", "weekly"\)/, "the WEEKLY plan is the operative one — the owner's own wording");
  })();

  // ── 2 · Which planned activity stands on its own ────────────────────────────────────────────────
  (function onlyAnActivityRecordedNowhereElseCoversTheDay() {
    for (const type of ["Travel", "Admin", "Meeting", "Meeting with Team", "Training", "Event", "Other"]) {
      assert.equal(plannedActivityCoversTheDay(type), true, `an approved ${type} day produces no other record, so the plan is its only evidence`);
    }
    // THE LOAD-BEARING HALF. Each of these has its own system of record, and the plan proves only
    // that the day was expected — which is the opposite of proving it happened.
    for (const [type, record] of [
      ["Field", "the CRM visit"],
      ["Double Visit", "the CRM double visit"],
      ["Office", "the fingerprint punch"],
      ["Vacation", "the approved leave request"],
      ["Excuse", "the approved excuse request"],
      ["National Vacation", "the holiday calendar"],
    ] as const) {
      assert.equal(
        plannedActivityCoversTheDay(type),
        false,
        `a planned ${type} day is proven by ${record}, never by the plan — excusing it would erase a real gap that becomes a deduction candidate`,
      );
    }
    // A type nobody has taught this rule about must not start excusing days on its own.
    for (const unknown of ["", "   ", "Something New", null, undefined]) {
      assert.equal(plannedActivityCoversTheDay(unknown), false, "an unknown or blank activity type covers nothing");
    }
    assert.ok(
      !(PLAN_ACTIVITY_TYPES_RECORDED_NOWHERE_ELSE as readonly string[]).some((type) => ["Field", "Double Visit", "Office"].includes(type)),
      "the covering list never grows to include a type with its own record",
    );
  })();

  // ── 3 · The exception engine ────────────────────────────────────────────────────────────────────
  (function anApprovedTravelDayStopsReadingNoActivity() {
    // Weaam Mahmoud's actual 4 October 2026: hr_acknowledged weekly plan 2026-W40, Travel · Upper
    // Egypt 2, approved by her National Sales Manager — and nothing else on the calendar.
    const travel = planItem("2026-10-04", "Travel");
    assert.equal(travel.plannedActivityCoversTheDay, true, "the mapper carries the coverage decision onto the item");
    assert.equal(travel.source, "plan");
    assert.equal(travel.severity, "info", "an approved plan is news, never something to review");
    assert.deepEqual(
      exceptionsFor([travel], "2026-10-04").map((exception) => exception.title),
      [],
      "an approved Travel day with nothing else recorded no longer reads No Activity Recorded",
    );

    // And the day the same plan says is Field work: nothing was logged, so the gap stands.
    const field = planItem("2026-10-07", "Field");
    assert.equal(field.plannedActivityCoversTheDay, false);
    assert.deepEqual(
      exceptionsFor([field], "2026-10-07").map((exception) => exception.title),
      ["No Activity Recorded"],
      "a planned Field day with no logged visit KEEPS its exception — the plan proves it was expected, not that it happened",
    );

    // The same, for the two other types that have their own record and are the bulk of the volume.
    for (const type of ["Double Visit", "Office"]) {
      assert.deepEqual(
        exceptionsFor([planItem("2026-10-07", type)], "2026-10-07").map((exception) => exception.title),
        ["No Activity Recorded"],
        `a planned ${type} day with nothing recorded keeps its exception`,
      );
    }

    // An empty calendar is unchanged: adding the source must not make the exception itself go away.
    assert.deepEqual(
      exceptionsFor([], "2026-10-07").map((exception) => exception.title),
      ["No Activity Recorded"],
      "a day with no plan and no record still reads No Activity Recorded",
    );

    // The plan has its own counted slot, so the key figures cannot silently fold it into another.
    assert.equal(summarizePrivateCalendarItems([travel, field]).plan, 2, "plan days are counted as their own kind");
  })();

  // ── 4 · A plan never silences an attendance problem, and both engines read it ───────────────────
  (function aPlanSuppressesNothingAndBothEnginesReadIt() {
    const latePunch: PrivateCalendarItem = {
      approvalImpact: null,
      description: null,
      detailLines: [],
      employeeDepartmentName: null,
      employeeHrId: employee.hrId,
      employeeJobTitle: null,
      employeeLineName: null,
      employeeName: employee.fullName,
      endDate: "2026-10-06",
      exceptionFlags: ["Late"],
      id: "attendance-late",
      managerName: null,
      severity: "warning",
      source: "attendance",
      sourceLabel: "Fingerprint attendance",
      sourceRecordId: "punch-1",
      sourceSystem: "Fingerprint",
      sourceTable: "attendance_raw_punches",
      startDate: "2026-10-06",
      status: "Late",
      time: "09:40",
      title: "Late arrival",
    };
    const plannedAdmin = planItem("2026-10-06", "Admin");
    // Only a CRM-verified double visit suppresses a Late flag. A plan is a document the employee
    // wrote himself, so it must leave the punch problem exactly where it is.
    const kept = suppressFieldVisitAttendanceProblems([latePunch, plannedAdmin]);
    assert.ok(kept.some((item) => item.id === "attendance-late"), "an approved plan does not suppress a Late punch");
    assert.deepEqual(
      exceptionsFor([latePunch, plannedAdmin], "2026-10-06").map((exception) => exception.title),
      ["Late"],
      "the Late flag still surfaces on a planned Admin day — the plan only answers the nothing-at-all exception",
    );

    // Both engines, from one source. getCompanyNoActivityDays is what the Deductions module's No
    // Records Activity connector adjudicates, so a day the employee's own calendar shows as covered
    // must never arrive there as a candidate.
    const service = read("src/lib/private-calendar/service.ts");
    assert.match(
      service,
      /import \{ loadPlanPrivateCalendarItems \} from "@\/lib\/private-calendar\/plan-items";/,
      "the service reads the plan through the one shared loader",
    );
    assert.equal(
      [...service.matchAll(/loadPlanPrivateCalendarItems\(/g)].length,
      2,
      "the plan loads in BOTH fan-outs — the calendar workspace AND the company no-activity engine Deductions reads",
    );
    assert.match(service, /plan: plans\.ready,/, "a plan source that could not be read says so, rather than showing a confident empty month");

    // One colour of its own on the screen, and the source's own readiness beside it.
    const ui = read("src/components/employee-portal/private-calendar.tsx");
    assert.match(ui, /\n {2}plan: \{/, "an approved plan has its own entry in the one colour table");
    assert.match(ui, /ready=\{sourceReadiness\.plan\}/, "the Planned figure says when the plan could not be read");
  })();
}
