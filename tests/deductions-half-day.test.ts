import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { payrollStepsForCategory } from "../src/lib/automated-payroll/deduction-resync.ts";
import { buildDeductionBuckets, chargeableDeductionDays, linesFor } from "../src/lib/automated-payroll/deductions-source.ts";
import {
  DEDUCTIONS_CATEGORY_CONFIG,
  daysForTickedDates,
  isEligibleForPublish,
} from "../src/lib/deductions/calculations.ts";
import { DEDUCTION_COLLECTORS } from "../src/lib/deductions/collect.ts";
import { detectSuspectDatesFromCounts } from "../src/lib/deductions/connectors/crm.ts";
import { isHalfDayPopulationTitle } from "../src/lib/deductions/connectors/half-day.ts";
import {
  buildHalfDayEvidence,
  buildHalfDayIdentity,
  compactHalfDayHrId,
  countGpsTracesByDate,
  halfDayReason,
  halfDaySlotOfRow,
  judgeHalfDay,
  planItemHalves,
  type HalfDayCheckinRow,
  type HalfDayVisitRow,
} from "../src/lib/deductions/half-day-rule.ts";
import { resolveDecisionCharge } from "../src/lib/deductions/service.ts";
import type { DeductionsCandidateWithDecision, DeductionsDecisionStatus } from "../src/lib/deductions/types.ts";
import { isFieldWorkforceThursday } from "../src/lib/field-workforce-compliance/weekend-policy.ts";

// The half-day rule (owner, 2026-10-08): a district manager or rep who worked only one half of a
// Saturday-to-Wednesday field day and has NOTHING on file for the other half. Each such half is its
// own row at 0.5 day, charged only once approved, through the CRM column. The AM/PM tag is not the
// clock — 862 apparent half days in June-October were 308 once check-ins and save times were read —
// so every assertion below that CLEARS a half is the reason a real employee is not charged.

const SUNDAY = "2026-09-06";
const MONDAY = "2026-09-07";
const REP = "B-901";
const MANAGER = "B-902";
const REP_CRM = "5001";
const MANAGER_CRM = "5002";
const CUSTOMER = "77001";

function visit(overrides: Partial<HalfDayVisitRow>): HalfDayVisitRow {
  return {
    visit_date: SUNDAY,
    visit_type: 0,
    ampm: null,
    crm_save_date: null,
    agent_hr_id: REP,
    agent_crm_id: REP_CRM,
    double_hr_id: null,
    double_crm_id: null,
    double2_hr_id: null,
    double2_crm_id: null,
    contact_crm_id: CUSTOMER,
    ...overrides,
  };
}

function checkin(overrides: Partial<HalfDayCheckinRow>): HalfDayCheckinRow {
  return { agent_hr_id: REP, agent_crm_id: REP_CRM, contact_crm_id: CUSTOMER, check_date: `${SUNDAY}T10:00:00Z`, ...overrides };
}

const identity = buildHalfDayIdentity([
  { hrId: REP, crmId: REP_CRM },
  { hrId: MANAGER, crmId: MANAGER_CRM },
]);

function verdictFor(input: { visits: HalfDayVisitRow[]; checkins?: HalfDayCheckinRow[]; who?: string; day?: string; cover?: Parameters<typeof judgeHalfDay>[1] }) {
  const { byPersonDay } = buildHalfDayEvidence({ visits: input.visits, checkins: input.checkins ?? [], identity });
  const key = `${compactHalfDayHrId(input.who ?? REP)}:${input.day ?? SUNDAY}`;
  return judgeHalfDay(byPersonDay.get(key), input.cover ?? {});
}

function halfDayCandidate(decision: { status: DeductionsDecisionStatus; appliedValue?: number | null; appliedDates?: string[] | null } | null): DeductionsCandidateWithDecision {
  return {
    id: "half-1",
    category: "crm_half_day",
    sourceSystem: "crm_half_day",
    sourceRecordId: `crm-half-day:b901:${SUNDAY}`,
    candidateKey: "key",
    employeeHrId: REP,
    employeeHrIdCompact: compactHalfDayHrId(REP) ?? "",
    employeeName: "Test Rep",
    monthKey: "2026-09",
    month: 9,
    year: 2026,
    unit: "days",
    rawValue: 0.5,
    estimatedAmount: 250,
    calculationStatus: "calculated",
    severity: "Medium",
    reason: "test",
    evidence: {},
    dates: [SUNDAY],
    hierarchySnapshot: {},
    createdBy: "test",
    createdAt: "",
    refreshedAt: null,
    lockedAt: null,
    supersededAt: null,
    supersededByCandidateId: null,
    hireDate: null,
    holidayBridges: [],
    decision: decision
      ? {
          id: "d",
          candidateId: "half-1",
          decisionStatus: decision.status,
          decisionReason: "reviewed",
          hrNote: "",
          appliedValue: decision.appliedValue ?? null,
          appliedAmount: null,
          appliedDates: decision.appliedDates ?? null,
          decidedBy: "B-10",
          decidedAt: "",
          actorRoleAtDecision: "super_admin",
          createdAt: "",
          updatedAt: "",
        }
      : null,
  };
}

export async function runDeductionsHalfDayTests(): Promise<void> {
  // ── Which half a CRM row speaks for ───────────────────────────────────────
  {
    assert.equal(halfDaySlotOfRow(visit({ ampm: "AM" })), "AM");
    assert.equal(halfDaySlotOfRow(visit({ ampm: " pm " })), "PM", "the tag is read case- and space-insensitively");
    // Untagged customer calls are placed by WHEN they were saved, on the day itself.
    assert.equal(halfDaySlotOfRow(visit({ crm_save_date: `${SUNDAY}T09:30:00Z` })), "AM");
    assert.equal(halfDaySlotOfRow(visit({ crm_save_date: `${SUNDAY}T14:10:00Z` })), "BOTH", "13-15 could be either half");
    assert.equal(halfDaySlotOfRow(visit({ crm_save_date: `${SUNDAY}T19:00:00Z` })), "PM");
    assert.equal(halfDaySlotOfRow(visit({ crm_save_date: `${MONDAY}T09:00:00Z` })), "BOTH", "saved another day says nothing about the hour");
    assert.equal(halfDaySlotOfRow(visit({ crm_save_date: null })), "BOTH");
    // A Phoenix "Pharmacy" tag is a place, not a half.
    assert.equal(halfDaySlotOfRow(visit({ ampm: "Pharmacy", crm_save_date: `${SUNDAY}T18:00:00Z` })), "PM");
    // Campaign visits (-8) and the unlabelled field visit (-30) are customer calls like any other.
    assert.equal(halfDaySlotOfRow(visit({ visit_type: -8, crm_save_date: `${SUNDAY}T10:00:00Z` })), "AM");
    assert.equal(halfDaySlotOfRow(visit({ visit_type: -30, crm_save_date: `${SUNDAY}T20:00:00Z` })), "PM");
    // An untagged non-visit activity (a meeting) is a whole-day activity.
    assert.equal(halfDaySlotOfRow(visit({ visit_type: -11, crm_save_date: `${SUNDAY}T09:00:00Z` })), "BOTH");
    // Annual Vacation covers nothing — the day is the vacation connector's, tagged or not.
    assert.equal(halfDaySlotOfRow(visit({ visit_type: -4, ampm: "AM" })), null);
  }

  // ── A half with no trace at all is a half day ─────────────────────────────
  {
    const verdict = verdictFor({ visits: [visit({ ampm: "PM", crm_save_date: `${SUNDAY}T15:00:00Z` })] });
    assert.deepEqual(verdict, { kind: "half_day", missing: "AM", coveredBy: ["crm"] });
    assert.match(halfDayReason(verdict as Extract<typeof verdict, { kind: "half_day" }>), /^Worked the afternoon only — nothing recorded for the morning/);

    const morningOnly = verdictFor({ visits: [visit({ ampm: "AM", crm_save_date: `${SUNDAY}T11:00:00Z` })] });
    assert.deepEqual(morningOnly, { kind: "half_day", missing: "PM", coveredBy: ["crm"] });
  }

  // ── The tag is not the clock: every timed trace clears the missing half ───
  {
    const pmTagged = [visit({ ampm: "PM", crm_save_date: `${SUNDAY}T15:00:00Z` })];
    assert.deepEqual(
      verdictFor({ visits: pmTagged, checkins: [checkin({ check_date: `${SUNDAY}T10:20:00Z` })] }),
      { kind: "cleared", missing: "AM", by: "morning_trace" },
      "a PM-tagged visit with his own 10:20 check-in at that customer is a worked morning — 1,962 such visits in Aug-Sep",
    );
    assert.deepEqual(
      verdictFor({ visits: pmTagged, checkins: [checkin({ contact_crm_id: "88001", check_date: `${SUNDAY}T10:20:00Z` })] }),
      { kind: "cleared", missing: "AM", by: "morning_trace" },
      "his own 10:20 check-in ANYWHERE proves he was in the field that morning, logged visit or not",
    );
    assert.equal(
      verdictFor({ visits: pmTagged, checkins: [checkin({ check_date: `${SUNDAY}T14:30:00Z` })] }).kind,
      "cleared",
      "the 13-15 band is mixed, so it clears either half rather than charge on a guess",
    );
    assert.equal(
      verdictFor({ visits: pmTagged, checkins: [checkin({ check_date: `${SUNDAY}T17:30:00Z` })] }).kind,
      "half_day",
      "an evening check-in proves nothing about the morning",
    );
    assert.equal(
      verdictFor({ visits: [visit({ ampm: "PM", crm_save_date: `${SUNDAY}T10:00:00Z` })] }).kind,
      "cleared",
      "a PM-tagged row SAVED at 10:00 on the day was written in the morning",
    );
    const amTagged = [visit({ ampm: "AM", crm_save_date: `${SUNDAY}T11:00:00Z` })];
    assert.equal(
      verdictFor({ visits: amTagged, checkins: [checkin({ check_date: `${MONDAY}T01:30:00Z` })] }).kind,
      "cleared",
      "a check-in after midnight is the tail of the evening before",
    );
    assert.equal(
      verdictFor({ visits: [visit({ ampm: "AM", crm_save_date: `${MONDAY}T02:00:00Z` })] }).kind,
      "cleared",
      "a row saved before 04:00 the next day was written that evening",
    );
  }

  // ── A Phoenix visit's capture time is that team's check-in ────────────────
  // A started team logs no iReports360 check-in, and its `ampm` is the customer LIST, not the hour.
  {
    assert.equal(
      verdictFor({ visits: [visit({ source: "phoenix", ampm: "PM", crm_save_date: `${SUNDAY}T14:10:00Z` })] }).kind,
      "cleared",
      "a Phoenix PM-list visit captured at 14:10 is a trace in the morning band, exactly like a 14:10 check-in",
    );
    assert.equal(
      verdictFor({ visits: [visit({ source: "phoenix", ampm: "AM", crm_save_date: `${SUNDAY}T15:40:00Z` })] }).kind,
      "cleared",
      "a Phoenix AM-list visit captured at 15:40 clears the afternoon",
    );
    assert.equal(
      verdictFor({ visits: [visit({ source: "ireports360", ampm: "AM", crm_save_date: `${SUNDAY}T15:40:00Z` })] }).kind,
      "half_day",
      "an iReports360 SAVE time is not a check-in — 15:40 clears nothing there",
    );
    assert.equal(
      verdictFor({ visits: [visit({ source: "phoenix", ampm: "AM", crm_save_date: `${SUNDAY}T11:00:00Z` })] }).kind,
      "half_day",
      "a Phoenix capture still proves only the half it falls in",
    );
  }

  // ── Managers: a double visit credits him, and the rep's check-in is his clock ──
  {
    const doubleVisit = visit({ ampm: "PM", crm_save_date: `${SUNDAY}T15:00:00Z`, double_hr_id: MANAGER, double_crm_id: MANAGER_CRM });
    assert.deepEqual(
      verdictFor({ visits: [doubleVisit], who: MANAGER }),
      { kind: "half_day", missing: "AM", coveredBy: ["crm"] },
      "a manager credited on an afternoon double visit and nothing else left the morning empty",
    );
    assert.equal(
      verdictFor({ visits: [doubleVisit], who: MANAGER, checkins: [checkin({ agent_hr_id: null, check_date: `${SUNDAY}T09:40:00Z` })] }).kind,
      "cleared",
      "the rep's 09:40 check-in at that customer places the manager's visit in the morning",
    );
    // The rep resigned and the mirror never stamped an hr id on the partner slot — the crm id
    // still credits the manager, so the day does not disappear.
    const departedPartnerRow = visit({
      ampm: "AM",
      crm_save_date: `${SUNDAY}T11:00:00Z`,
      agent_hr_id: null,
      double_hr_id: null,
      double_crm_id: MANAGER_CRM,
    });
    const { byPersonDay } = buildHalfDayEvidence({ visits: [departedPartnerRow], checkins: [], identity });
    const managerDay = byPersonDay.get(`${compactHalfDayHrId(MANAGER)}:${SUNDAY}`);
    assert.ok(managerDay?.am, "a blank hr id falls back to the crm id");
    assert.equal(managerDay?.partnerVisits, 1);
    assert.ok(byPersonDay.get(`${compactHalfDayHrId(REP)}:${SUNDAY}`)?.am, "the rep is credited through his crm id too");
  }

  // ── A crm id two people claim credits nobody, and is counted ──────────────
  {
    const shared = buildHalfDayIdentity([
      { hrId: REP, crmId: "9000" },
      { hrId: MANAGER, crmId: "9000" },
    ]);
    assert.ok(shared.ambiguousCrmIds.has("9000"));
    const built = buildHalfDayEvidence({
      visits: [visit({ agent_hr_id: null, agent_crm_id: "9000", ampm: "AM" })],
      checkins: [],
      identity: shared,
    });
    assert.equal(built.unattributable, 1);
    for (const who of [REP, MANAGER]) {
      const day = built.byPersonDay.get(`${compactHalfDayHrId(who)}:${SUNDAY}`);
      assert.equal(day?.am, false, "an ambiguous row is never credited to either person");
      assert.deepEqual(
        judgeHalfDay(day, { planPm: true }),
        { kind: "left_alone", why: "unattributed_row" },
        "and neither person's day is judged on half the evidence",
      );
    }
  }

  // ── Campaign visits count; a CRM leave row leaves the day alone ───────────
  {
    const built = buildHalfDayEvidence({
      visits: [
        visit({ visit_type: -8, crm_save_date: `${SUNDAY}T09:00:00Z` }),
        visit({ ampm: "PM", crm_save_date: `${SUNDAY}T15:00:00Z` }),
      ],
      checkins: [],
      identity,
    });
    const day = built.byPersonDay.get(`${compactHalfDayHrId(REP)}:${SUNDAY}`);
    assert.equal(day?.campaignVisits, 1);
    assert.equal(judgeHalfDay(day, {}).kind, "not_a_half_day", "a morning campaign visit is a worked morning");
    assert.deepEqual(
      verdictFor({ visits: [visit({ ampm: "AM" }), visit({ visit_type: -4, ampm: "PM" })] }),
      { kind: "left_alone", why: "crm_leave" },
    );
  }

  // ── Vacations, plans and requests ─────────────────────────────────────────
  {
    const amOff = judgeHalfDay(undefined, { vacationAm: true });
    assert.deepEqual(amOff, { kind: "half_day", missing: "PM", coveredBy: ["approved_vacation"] }, "AM off approved and an empty afternoon");
    assert.match(halfDayReason(amOff as Extract<typeof amOff, { kind: "half_day" }>), /^AM off approved — nothing recorded for the afternoon/);
    assert.equal(
      verdictFor({ visits: [visit({ ampm: "PM", crm_save_date: `${SUNDAY}T15:00:00Z` })], cover: { vacationAm: true } }).kind,
      "not_a_half_day",
      "AM off approved + afternoon visits is a full day accounted for",
    );
    assert.equal(
      verdictFor({ visits: [visit({ ampm: "AM", crm_save_date: `${SUNDAY}T11:00:00Z` })], cover: { planPm: true } }).kind,
      "not_a_half_day",
      "an approved afternoon plan item covers the afternoon",
    );
    assert.deepEqual(
      verdictFor({ visits: [visit({ ampm: "AM" })], cover: { leaveTheDayAlone: true } }),
      { kind: "left_alone", why: "request_on_file" },
      "a pending, returned or full-day request on file is never second-guessed",
    );
    assert.equal(judgeHalfDay(undefined, {}).kind, "not_a_half_day", "a whole empty day belongs to the no-activity connectors, not here");

    assert.deepEqual(planItemHalves({ start_time: "09:00", end_time: "11:00" }), { am: true, pm: false });
    assert.deepEqual(planItemHalves({ start_time: "15:00:00", end_time: "17:00:00" }), { am: false, pm: true });
    assert.deepEqual(planItemHalves({ start_time: "13:00", end_time: "16:00" }), { am: true, pm: true }, "running past 14:00 covers the afternoon too");
    assert.deepEqual(planItemHalves({ start_time: "10:00", end_time: null }), { am: true, pm: true }, "no end time cannot prove the afternoon was free");
    assert.deepEqual(planItemHalves({ start_time: null, end_time: null }), { am: true, pm: true });
  }

  // ── Who is judged, and which days ─────────────────────────────────────────
  {
    assert.equal(isHalfDayPopulationTitle("District Manager"), "district_manager");
    assert.equal(isHalfDayPopulationTitle("District Sales Manager"), "district_manager");
    assert.equal(isHalfDayPopulationTitle("Medical Representative"), "rep");
    assert.equal(isHalfDayPopulationTitle("Regional Manager"), null);
    assert.equal(isHalfDayPopulationTitle("HR Manager"), null);

    assert.equal(isFieldWorkforceThursday("2026-09-03"), true, "a Thursday is a morning-only day");
    const connector = stripComments(readFileSync("src/lib/deductions/connectors/half-day.ts", "utf8"));
    const judged = connector.slice(connector.indexOf("const judgedDays = days.filter("), connector.indexOf("const drafts: DeductionsCandidateDraft[]"));
    for (const clause of [
      /isFieldForceWorkingDay\(day\)/,
      /!isFieldWorkforceThursday\(day\)/,
      /!holidays\.has\(day\)/,
      /!suspectDates\.has\(day\)/,
      /!gpsGapDates\.has\(day\)/,
    ]) {
      assert.match(judged, clause, `Thursdays, Fridays, national holidays, CRM gap days and GPS gap days are never judged (${clause})`);
    }
    assert.match(connector, /detectSuspectDatesFromCounts\(gpsTraceCounts\)/, "a day whose GPS arrived short is detected like a CRM gap day");
    assert.match(connector, /scanVisitsForRangeIncludingDeparted[<(]/, "a resigned rep's rows — and the manager's double visits on them — must stay in view");
    assert.match(connector, /includeResignedAgents: true/, "a resigned rep's check-ins must stay in view too");
    assert.match(connector, /rawValue: 0\.5/, "each half day is half a day, never a whole one");
    assert.match(connector, /deductionDays: 0\.5/, "and priced at Base ÷ the month's days × 0.5");
    assert.match(connector, /DeductionsConnectorDegradedError\(CONNECTOR, `the CRM visit feed returned no rows/, "an empty feed fails closed");
    assert.match(connector, /gpsTraceTotal === 0/, "a dense month with no GPS traces at all fails closed");
    assert.match(connector, /contact_crm_id, source"/, "the visit read carries the source, or a Phoenix capture cannot be told apart");

    // The GPS trace count: iReports360 check-ins plus Phoenix captures on the visit's own day.
    const counts = countGpsTracesByDate({
      days: [SUNDAY, MONDAY],
      checkins: [{ check_date: `${SUNDAY}T09:00:00Z` }, { check_date: `${MONDAY}T10:00:00Z` }, { check_date: "2026-08-31T10:00:00Z" }],
      visits: [
        { visit_date: SUNDAY, crm_save_date: `${SUNDAY}T11:00:00Z`, source: "phoenix" },
        { visit_date: SUNDAY, crm_save_date: `${MONDAY}T11:00:00Z`, source: "phoenix" },
        { visit_date: SUNDAY, crm_save_date: `${SUNDAY}T11:00:00Z`, source: "ireports360" },
      ],
    });
    assert.deepEqual([...counts], [[SUNDAY, 2], [MONDAY, 1]], "a vendor visit is not a GPS trace, and a capture on another day is not this day's");
    // A working day whose GPS arrived at a tenth of normal is a gap, not a company that stayed home.
    const month = new Map<string, number>();
    for (let day = 1; day <= 30; day += 1) {
      const date = `2026-09-${String(day).padStart(2, "0")}`;
      month.set(date, new Date(`${date}T00:00:00Z`).getUTCDay() === 5 ? 5 : 900);
    }
    month.set("2026-09-07", 90);
    assert.ok(detectSuspectDatesFromCounts(month).has("2026-09-07"), "a GPS gap day is never judged");
    assert.ok(!detectSuspectDatesFromCounts(month).has("2026-09-06"));
  }

  // ── Registered, approval-only, paid through the CRM column ────────────────
  {
    const config = DEDUCTIONS_CATEGORY_CONFIG.crm_half_day;
    assert.equal(config.label, "Half Day (CRM)");
    assert.equal(config.requiresApproval, true, "\"you decide each\" — nothing is charged until approved");
    assert.equal(config.salaryRecordsColumn, "crm");
    assert.equal(isEligibleForPublish(halfDayCandidate({ status: "Pending" })), false);
    assert.equal(isEligibleForPublish(halfDayCandidate(null)), false);
    assert.equal(isEligibleForPublish(halfDayCandidate({ status: "Approved for Payroll" })), true);

    const order = DEDUCTION_COLLECTORS.map((collector) => collector.key);
    assert.ok(order.includes("crm_half_day"));
    assert.equal(
      DEDUCTION_COLLECTORS.find((collector) => collector.key === "crm_half_day")?.reconcilesWholeCategory,
      "crm_half_day",
      "a re-run replaces the category's unpublished rows instead of stacking a second copy",
    );

    assert.deepEqual(
      payrollStepsForCategory("crm_half_day", true),
      payrollStepsForCategory("crm", true),
      "a decided half day re-opens the same Part 1 CRM steps a CRM day does",
    );
    assert.deepEqual(payrollStepsForCategory("crm_half_day", false), payrollStepsForCategory("crm", false));
  }

  // ── A ticked half-day date is 0.5, never 1 ────────────────────────────────
  {
    assert.equal(daysForTickedDates({ rawValue: 0.5, detectedDates: 1, tickedDates: 1 }), 0.5);
    assert.equal(daysForTickedDates({ rawValue: 0.5, detectedDates: 1, tickedDates: 0 }), 0);
    assert.equal(daysForTickedDates({ rawValue: 4, detectedDates: 4, tickedDates: 3 }), 3, "a full-day CRM row still counts its ticks");
    assert.equal(
      daysForTickedDates({ rawValue: 3, detectedDates: 5, tickedDates: 3 }),
      3,
      "a vacation row's dates are calendar days, Fridays included — a pro-rata over them would read 1.8 days; keep the count",
    );
    assert.equal(daysForTickedDates({ rawValue: 3, detectedDates: 5, tickedDates: 4 }), 4, "and over-detected stays refused, as before");

    const charge = resolveDecisionCharge({
      candidate: { unit: "days", rawValue: 0.5, estimatedAmount: 250, dates: [SUNDAY] },
      appliedDates: [SUNDAY],
    });
    assert.equal(charge.appliedValue, 0.5, "the ticked date must not be refused as 1 day of a 0.5-day finding");
    assert.equal(charge.appliedAmount, 250);

    // Payroll: approved untouched, and approved after the editor saved 0.5, both charge half a day.
    assert.equal(chargeableDeductionDays(halfDayCandidate({ status: "Approved for Payroll" })), 0.5);
    assert.equal(
      chargeableDeductionDays(halfDayCandidate({ status: "Approved for Payroll", appliedValue: 0.5, appliedDates: [SUNDAY] })),
      0.5,
    );
    const buckets = buildDeductionBuckets([halfDayCandidate({ status: "Approved for Payroll" })]);
    const compact = compactHalfDayHrId(REP) ?? "";
    assert.equal(buckets.get(compact)?.buckets.crm, 250, "an approved half day lands in the CRM bucket");
    assert.equal(linesFor(buckets, compact, "crm").length, 1, "so every CRM payroll step sees the line");
    const pending = buildDeductionBuckets([halfDayCandidate({ status: "Pending" })]);
    assert.equal(pending.get(compact)?.buckets.crm, 0, "a pending half day pays nothing");
  }
}
