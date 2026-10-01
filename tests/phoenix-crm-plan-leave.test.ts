import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { customerFrequencyRow, plannedOutsideLeave } from "../src/lib/phoenix-crm/customer-frequency.ts";
import {
  buildDailyPlanDays,
  dailyPlanVisitStatus,
  dailyPlanVisitText,
  type DailyPlanSourceItem,
  type DailyPlanSourcePlan,
  type DailyPlanSourceVisit,
} from "../src/lib/phoenix-crm/daily-plan-report.ts";
import { isLeaveDay, leaveDatesFor, leaveDayKey, NO_LEAVE_DAYS } from "../src/lib/phoenix-crm/plan-leave.ts";
import { groupPlanByTerritory, planKeptPercent } from "../src/lib/phoenix-crm/report-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — a planned customer on a day HR approved the rep's leave is ON LEAVE, never missed.
 *
 * Owner, 2026-10-01: "fix missed visits on leave days in plan vs actual". Every report that set the
 * plan against what happened counted a leave day's planned customers as missed — plan against actual
 * ("missed"), the daily plan report ("Not visited") and the frequency report ("Missed 1") — so a week
 * of annual leave read as a week of misses. One rule now (`plan-leave.ts`), read by all three:
 *
 *   - planned, NOT seen, on a leave day → on leave: never missed, and out of every plan-kept figure;
 *   - planned and seen that day → kept, as on any other day.
 *
 * This pins the rule in each report, the wiring that feeds each one HR's leave, and the words on the
 * screens and in the workbook, so no surface can drift back to calling a leave day a miss.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

function item(patch: Pick<DailyPlanSourceItem, "planId" | "date" | "customerId" | "listType">): DailyPlanSourceItem {
  return {
    name: `Customer ${patch.customerId}`,
    grade: "A",
    speciality: "Paediatrics",
    pending: false,
    stale: false,
    phone: null,
    placeLabel: null,
    brick: "Shebin 3",
    area: "Menoufia 2",
    address: null,
    hoursText: "6:00 PM – 8:00 PM",
    exceptionLabel: null,
    exceptionNote: null,
    ...patch,
  };
}

function visit(patch: Pick<DailyPlanSourceVisit, "date" | "customerId" | "capturedAt">): DailyPlanSourceVisit {
  return { isTest: false, offPlan: null, ...patch };
}

export function runPhoenixCrmPlanLeaveTests(): void {
  // ── The key ─────────────────────────────────────────────────────────────────────────────────────
  {
    const leave = new Set([leaveDayKey("R1", "2026-10-04")]);
    assert.equal(isLeaveDay(leave, "R1", "2026-10-04"), true);
    assert.equal(isLeaveDay(leave, "R2", "2026-10-04"), false, "leave is the rep's, so it is one territory's, never the whole team's day");
    assert.equal(isLeaveDay(leave, "R1", "2026-10-05"), false);
    assert.equal(isLeaveDay(NO_LEAVE_DAYS, "R1", "2026-10-04"), false);
    assert.deepEqual([...leaveDatesFor(leave, "R1", ["2026-10-03", "2026-10-04", "2026-10-05"])], ["2026-10-04"]);
  }

  // ── 1. Plan against actual ──────────────────────────────────────────────────────────────────────
  {
    const rows = [
      // A working day: its two misses stay misses.
      { seat_id: "R1", day: "2026-10-03", list_type: "PM", planned: 10, visited_planned: 8, missed: 2, unplanned: 0 },
      // A leave day: nine planned, one seen anyway, eight not seen.
      { seat_id: "R1", day: "2026-10-04", list_type: "PM", planned: 9, visited_planned: 1, missed: 8, unplanned: 0 },
      { seat_id: "R1", day: "2026-10-04", list_type: "AM", planned: 2, visited_planned: 0, missed: 2, unplanned: 0 },
      // Another territory, the same day, nobody on leave there.
      { seat_id: "R2", day: "2026-10-04", list_type: "PM", planned: 5, visited_planned: 3, missed: 2, unplanned: 0 },
    ];
    const leave = new Set([leaveDayKey("R1", "2026-10-04")]);
    const { groups, totals } = groupPlanByTerritory(rows, leave);
    const r1 = groups.find((group) => group.seatId === "R1");
    const r2 = groups.find((group) => group.seatId === "R2");
    assert.ok(r1 && r2);

    const leaveDay = r1.days.find((day) => day.date === "2026-10-04");
    assert.ok(leaveDay);
    assert.equal(leaveDay.pm.missed, 0, "🔴 a leave day's unseen planned customers are never missed");
    assert.equal(leaveDay.pm.onLeave, 8, "they are on leave, and said so");
    assert.equal(leaveDay.pm.planned, 1, "and out of planned — only the one he saw is a plan he could keep");
    assert.equal(leaveDay.pm.visitedPlanned, 1, "the one he saw that day still counts as a kept plan: the visit happened");

    assert.equal(r1.pm.missed, 2, "the working day's misses are untouched");
    assert.equal(r1.pm.onLeave, 8);
    assert.equal(r1.pm.planned, 11);
    assert.equal(planKeptPercent(r1.pm), 81.8, "9 kept of the 11 he could keep — a week of leave cannot pull this down");
    assert.equal(r1.am.onLeave, 2);
    assert.equal(planKeptPercent(r1.am), null, "a list planned only on a leave day has no figure — never 0%");

    assert.equal(r2.pm.missed, 2, "nobody else's day is touched by one rep's leave");
    assert.equal(r2.pm.onLeave, 0);
    assert.equal(totals.PM.missed, 4);
    assert.equal(totals.PM.onLeave, 8);
    assert.equal(totals.AM.onLeave, 2, "AM and PM stay apart, as every count does");

    // Without leave the report reads exactly as it did — the rule adds a figure, it changes nothing else.
    const plain = groupPlanByTerritory(rows);
    assert.equal(plain.totals.PM.missed, 12);
    assert.equal(plain.totals.PM.onLeave, 0);
    assert.equal(plain.totals.PM.planned, 24);
  }

  // ── 2. The daily plan report ────────────────────────────────────────────────────────────────────
  {
    const visitDay = "2026-09-30";
    assert.equal(dailyPlanVisitStatus({ date: "2026-09-28", visitDay, visited: false, onLeave: true }), "on_leave", "🔴 a leave day reads On leave, never Not visited");
    assert.equal(dailyPlanVisitStatus({ date: "2026-09-28", visitDay, visited: true, onLeave: true }), "visited", "seen on a leave day is still seen");
    assert.equal(dailyPlanVisitStatus({ date: visitDay, visitDay, visited: false, onLeave: true }), "on_leave", "a leave day still running");
    assert.equal(dailyPlanVisitStatus({ date: "2026-10-01", visitDay, visited: false, onLeave: true }), "on_leave", "and one ahead");
    assert.equal(dailyPlanVisitStatus({ date: "2026-09-28", visitDay, visited: false }), "not_visited", "a working day is judged as it always was");
    assert.equal(dailyPlanVisitText("on_leave", null), "On leave");

    const plan: DailyPlanSourcePlan = { planId: "P", weekStart: "2026-09-26", isTest: false, status: "approved", submittedLate: false, events: [] };
    const days = buildDailyPlanDays({
      period: { from: "2026-09-28", to: "2026-09-29" },
      cairoToday: visitDay,
      visitDay,
      plans: [plan],
      items: [
        item({ planId: "P", date: "2026-09-28", customerId: "A", listType: "PM" }),
        item({ planId: "P", date: "2026-09-28", customerId: "B", listType: "PM" }),
        item({ planId: "P", date: "2026-09-29", customerId: "C", listType: "PM" }),
      ],
      activities: [],
      starts: [],
      visits: [visit({ date: "2026-09-28", customerId: "A", capturedAt: "2026-09-28T16:00:00Z" })],
      leaveDays: new Set(["2026-09-28"]),
    });
    const monday = days.find((day) => day.date === "2026-09-28");
    const tuesday = days.find((day) => day.date === "2026-09-29");
    assert.ok(monday && tuesday);
    assert.equal(monday.onLeave, true, "the day itself says it was leave");
    assert.deepEqual(
      monday.pm.map((customer) => `${customer.customerId} ${customer.status}`),
      ["A visited", "B on_leave"],
      "the one he saw is visited; the one he did not is on leave",
    );
    assert.equal(tuesday.onLeave, false);
    assert.deepEqual(tuesday.pm.map((customer) => customer.status), ["not_visited"], "the next working day keeps its miss");
  }

  // ── 3. Frequency per customer ───────────────────────────────────────────────────────────────────
  {
    const onLeave = (day: string) => day === "2026-10-04" || day === "2026-10-05";
    assert.deepEqual(
      plannedOutsideLeave({ planDays: ["2026-10-04", "2026-10-05", "2026-10-06"], visitDays: ["2026-10-05"], isLeaveDay: onLeave }),
      { planned: 2, onLeave: 1 },
      "planned on a leave day and not seen is on leave; seen on one, it still counts as planned",
    );
    assert.deepEqual(plannedOutsideLeave({ planDays: ["2026-10-04", "2026-10-04"], visitDays: [], isLeaveDay: () => false }), { planned: 2, onLeave: 0 });

    const settings = { gradeTargets: { AM: { A: 1, B: null, C: null }, PM: { A: 3, B: 2, C: 1 } } } as Parameters<typeof customerFrequencyRow>[1];
    const row = customerFrequencyRow({ customerId: "1", grade: "B", listType: "PM", name: "Seen on both working days", planned: 2, plannedOnLeave: 1, visits: 2 }, settings);
    assert.equal(row.againstPlan, 0, "🔴 the leave-day planning is not counted against the plan — he kept every plan he could");
    assert.equal(row.plannedOnLeave, 1, "and it is said apart");
    assert.equal(customerFrequencyRow({ customerId: "2", grade: "B", listType: "PM", name: "No leave", planned: 1, visits: 1 }, settings).plannedOnLeave, 0, "absent is none");
  }

  // ── 4. Every report is fed HR's leave, and says so when it cannot be read ──────────────────────
  {
    const reader = source("src/lib/phoenix-crm/server/leave-days.ts");
    assert.match(reader, /loadApprovedLeaveDays\(/, "leave comes through HR's vacation module");
    assert.doesNotMatch(reader, /\.from\(/, "this module reads no table itself — HR owns leave");
    assert.doesNotMatch(reader, /phoenix_crm_visits|countable_visits/, "and leave is never inferred from a gap in the visits");
    assert.match(reader, /return \{ days: new Set<string>\(\), unread: true \};/, "a failed read is SAID — the report keeps its figures and carries unread");

    const reports = source("src/lib/phoenix-crm/server/reports.ts");
    assert.match(reports, /loadSeatLeaveDays\(chosen\.seats, period\)/, "plan against actual reads the chosen territories' leave");
    assert.match(reports, /groupPlanByTerritory\(\s*asRows\(data\)\.filter\(\(row\) => seatsById\.has\(String\(row\.seat_id\)\)\),\s*leave\.days,\s*\)/, "and applies it");
    assert.match(reports, /leaveUnread: leave\.unread,/);
    assert.match(reports, /loadSeatLeaveDays\(\[seat\], \{ from: month\.monthStart, to: month\.monthEnd \}\)/, "frequency reads the month's leave");
    assert.match(reports, /plannedOutsideLeave\(\{/, "and counts planned outside it");

    const daily = source("src/lib/phoenix-crm/server/daily-plan-report.ts");
    assert.match(daily, /loadSeatLeaveDays\(\[seat\], period\)/, "the daily plan reads its territory's leave");
    assert.match(daily, /leaveDays: leaveDatesFor\(leave\.days, seat\.seatId, dates\)/);
    assert.match(daily, /leaveUnread: leave\.unread,/);
  }

  // ── 5. The words, on the screens and in the workbook ───────────────────────────────────────────
  {
    const tab = source("src/components/phoenix-crm/reports-tab.tsx");
    assert.ok(tab.includes("`${countText(counts.onLeave)} on leave`"), "plan against actual says how many were on leave");
    assert.ok(tab.includes("on leave, never counted here"), "and the Missed figure says they are not in it");
    assert.ok(tab.includes("` · ${countText(row.plannedOnLeave)} on leave`"), "frequency says it beside the plan column");
    assert.equal((tab.match(/\{LEAVE_UNREAD_NOTE\}/g) ?? []).length, 2, "both sections say so when leave could not be read");

    const dailyTab = source("src/components/phoenix-crm/daily-plan-report.tsx");
    assert.match(dailyTab, /on_leave: "neutral"/, "On leave is a fact HR recorded, never the warning colour Not visited wears");
    assert.ok(dailyTab.includes('<CrmPill key="leave" tone="neutral">On leave</CrmPill>'), "the day says it was leave");
    assert.ok(dailyTab.includes("{LEAVE_UNREAD_NOTE}"));

    const workbook = source("src/lib/phoenix-crm/server/reports-workbook.ts");
    assert.ok(workbook.includes('counted("AM on leave")') && workbook.includes('counted("PM on leave")'), "the download matches the screen, AM and PM apart");
    assert.ok(workbook.includes("row.am.onLeave") && workbook.includes("row.pm.onLeave"));
    assert.ok(workbook.includes('counted("Planned on leave", 17)') && workbook.includes("row.plannedOnLeave"), "and the frequency sheet carries it too");
    assert.ok(workbook.includes('day.onLeave ? "on leave" : null'), "and the daily plan sheet names the day as the screen does");
  }

  console.log("phoenix-crm plan leave: OK");
}
