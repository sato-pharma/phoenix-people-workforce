import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  APPROVED_PLAN_STATUSES,
  PLAN_ACTIVITY_TYPES_RECORDED_NOWHERE_ELSE,
  mapPlanRowToPrivateCalendarItem,
  plannedActivityIsRecordedNowhereElse,
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
//   2. 🔴 THE PLAN COVERS NO DAY AT ALL, WHATEVER THE ACTIVITY TITLE. Owner, 2026-10-12: *"NEVER
//      COUNT WEEKLY PLAN AS COVERAGE WHAT IF HE PLANNED BUT DIDNT GO WORK?"* — and then *"Do not
//      ever touch a weekly plan ... compare the plan versus the actual, any title."* This engine's
//      output becomes payroll deduction candidates (getCompanyNoActivityDays → the Deductions
//      module's No Records Activity connector), so a plan excusing a day took real gaps off that
//      board: measured on production for 1 Aug – 7 Oct 2026, excusing every planned type would
//      have erased 364 genuine gaps, and the seven "recorded nowhere else" titles erased their own
//      share between 2026-10-07 and his ruling. The flag survives as a DISPLAY fact only, so the
//      reader comparing plan against actual knows there is nothing else to look for.
//   3. A PLAN NEVER SUPPRESSES AN ATTENDANCE PROBLEM. A Late or Short-day flag is about a punch that
//      exists; only a CRM-verified double visit suppresses one. A plan that silenced those would hide
//      a second class of real finding behind a document the employee wrote himself.
//   4. BOTH ENGINES READ IT. The employee's own calendar and the company no-activity engine share
//      derivePrivateCalendarExceptions, so what the employee is shown and what Deductions
//      adjudicates are the same day by construction — now including that a plan alone leaves the
//      day flagged.
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

/** A fingerprint attendance item for one day, so a test can put a real punch beside a plan. */
function latePunchFixture(date: string): PrivateCalendarItem {
  return {
    approvalImpact: null,
    description: null,
    detailLines: [],
    employeeDepartmentName: null,
    employeeHrId: employee.hrId,
    employeeJobTitle: null,
    employeeLineName: null,
    employeeName: employee.fullName,
    endDate: date,
    exceptionFlags: ["Late"],
    id: "attendance-late",
    managerName: null,
    severity: "warning",
    source: "attendance",
    sourceLabel: "Fingerprint attendance",
    sourceRecordId: "punch-1",
    sourceSystem: "Fingerprint",
    sourceTable: "attendance_raw_punches",
    startDate: date,
    status: "Late",
    time: "09:40",
    title: "Late arrival",
  };
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
  (function theFlagMarksWhatIsRecordedNowhereElseAndCoversNothing() {
    for (const type of ["Travel", "Admin", "Meeting", "Meeting with Team", "Training", "Event", "Other"]) {
      assert.equal(
        plannedActivityIsRecordedNowhereElse(type),
        true,
        `a planned ${type} day produces no other record, so the reader comparing plan against actual expects nothing beside it`,
      );
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
        plannedActivityIsRecordedNowhereElse(type),
        false,
        `a planned ${type} day is proven by ${record}, never by the plan — excusing it would erase a real gap that becomes a deduction candidate`,
      );
    }
    // A type nobody has taught this rule about must not start excusing days on its own.
    for (const unknown of ["", "   ", "Something New", null, undefined]) {
      assert.equal(plannedActivityIsRecordedNowhereElse(unknown), false, "an unknown or blank activity type says nothing");
    }
    // 🔴 THE RULE ITSELF, at the source: the engine's covered-day test may not name the plan at all.
    // Owner, 2026-10-12 — a planned day that was never worked is exactly what he asked about.
    const engine = read("src/lib/private-calendar/logic.ts");
    const isCoveredBlock = engine.slice(engine.indexOf("const isCovered ="), engine.indexOf("for (const item of attendance)"));
    assert.ok(
      !/plan/i.test(isCoveredBlock),
      "no plan term may appear in the covered-day test — a weekly plan is never coverage (owner, 2026-10-12)",
    );
    assert.ok(
      !(PLAN_ACTIVITY_TYPES_RECORDED_NOWHERE_ELSE as readonly string[]).some((type) => ["Field", "Double Visit", "Office"].includes(type)),
      "the covering list never grows to include a type with its own record",
    );
  })();

  // ── 3 · The exception engine ────────────────────────────────────────────────────────────────────
  (function anApprovedTravelDayStillReadsNoActivityAndSaysWhatWasPlanned() {
    // Weaam Mahmoud's actual 4 October 2026: hr_acknowledged weekly plan 2026-W40, Travel · Upper
    // Egypt 2, approved by her National Sales Manager — and nothing else on the calendar.
    const travel = planItem("2026-10-04", "Travel");
    assert.equal(travel.plannedActivityIsRecordedNowhereElse, true, "the mapper carries the display fact onto the item");
    assert.equal(travel.source, "plan");
    assert.equal(travel.severity, "info", "an approved plan is news, never something to review");
    // 🔴 THE DAY STAYS FLAGGED, and the plan is reported BESIDE the finding rather than instead of
    // it (owner, 2026-10-12). Between 2026-10-07 and that ruling this same day read only "Covered by
    // the approved plan" and carried no finding at all.
    const travelDay = exceptionsFor([travel], "2026-10-04");
    assert.deepEqual(
      travelDay.map((exception) => exception.title),
      ["No Activity Recorded", "Planned, but nothing recorded"],
      "an approved Travel day with nothing recorded is still a No Activity day, with the plan named next to it",
    );
    const [finding, note] = travelDay;
    assert.equal(finding?.severity, "danger", "the finding is the finding — a plan does not soften it");
    assert.equal(finding?.code, "no_activity_recorded");
    assert.equal(note?.severity, "info", "the comparison is news, never a finding — every counter on the screen excludes info");
    assert.equal(note?.code, "planned_but_nothing_recorded");
    assert.deepEqual(note?.relatedItemIds, [travel.id], "the note points at the plan item it is comparing against");
    assert.match(note?.description ?? "", /plan says Travel/, "the note names what was planned");
    assert.match(note?.description ?? "", /not what happened/, "and says plainly that a plan is not a record");

    // And the day the same plan says is Field work: nothing was logged, so the gap stands.
    const field = planItem("2026-10-07", "Field");
    assert.equal(field.plannedActivityIsRecordedNowhereElse, false);
    assert.deepEqual(
      exceptionsFor([field], "2026-10-07").map((exception) => exception.title),
      ["No Activity Recorded"],
      "a planned Field day with no logged visit KEEPS its exception — the plan proves it was expected, not that it happened",
    );

    // The note appears ONLY when the plan is alone. A day that also carries a punch already explains
    // itself, and a second line saying so would be noise on the days that need it least.
    const punchAndPlan: PrivateCalendarItem = {
      ...latePunchFixture("2026-10-04"),
      exceptionFlags: [],
      severity: "info",
      status: "Complete",
      title: "Attendance",
    };
    assert.deepEqual(
      exceptionsFor([travel, punchAndPlan], "2026-10-04").map((exception) => exception.title),
      [],
      "a planned day that also has a punch is covered by the PUNCH, and needs no comparison line",
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
    const latePunch = latePunchFixture("2026-10-06");
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
    // THREE fan-outs since 2026-10-08, still an exact count rather than a floor: a dropped call
    // site has to go red, and `>= 2` would let one of the three fall out silently. The third is
    // getPrivateCalendarDayEvidence, which the Calendar Disputes inbox reads to show the reviewer
    // what Phoenix already holds for the disputed day — the SAME plan the other two read,
    // deliberately, because deciding a dispute against a different source than the calendar being
    // disputed is deciding on other evidence than the one in front of the employee.
    assert.equal(
      [...service.matchAll(/loadPlanPrivateCalendarItems\(/g)].length,
      3,
      "the plan loads in ALL THREE fan-outs — the calendar workspace, the company no-activity engine Deductions reads, and the dispute-day evidence the Calendar Disputes reviewer sees",
    );
    assert.match(service, /plan: plans\.ready,/, "a plan source that could not be read says so, rather than showing a confident empty month");

    // One colour of its own on the screen, and the source's own readiness beside it.
    const ui = read("src/components/employee-portal/private-calendar.tsx");
    assert.match(ui, /\n {2}plan: \{/, "an approved plan has its own entry in the one colour table");
    assert.match(ui, /ready=\{sourceReadiness\.plan\}/, "the Planned figure says when the plan could not be read");
  })();
}
