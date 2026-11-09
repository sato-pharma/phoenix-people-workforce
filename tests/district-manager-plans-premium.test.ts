import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import { MANAGER_WEEK_ENDED_LABEL, managerPlanStatusLabel } from "../src/lib/phoenix-crm/manager-plan-rules.ts";
import { districtCustomerGrade } from "../src/lib/phoenix-crm/server/manager-plan-bookings.ts";
import type {
  DistrictPlanCustomer,
  DistrictManagersPlans,
  DistrictManagerWeek,
  DistrictPlanDay,
  DistrictPlanHalf,
  DistrictTeamRep,
} from "../src/lib/phoenix-crm/server/manager-plan-bookings.ts";
import {
  DISTRICT_PLAN_STATE_LABEL,
  DISTRICT_PLAN_STATE_SWATCH,
  districtCustomerAShare,
  districtCustomerCountLine,
  districtCustomerGradeLine,
  districtCustomerMix,
  districtCustomerRepeatedLine,
  districtCustomerSpecialityLine,
  districtPlansCustomerRows,
  districtPlansCustomerTicks,
  districtPlanAnchor,
  districtPlanAttentionCounts,
  districtPlanDayLabel,
  districtPlanKindBar,
  districtPlanKindsLine,
  districtPlanListedSeats,
  districtPlansAttention,
  districtPlansChainVisits,
  districtPlansGrid,
  districtPlanSentLine,
  districtPlanShares,
  districtPlanShortDay,
  districtPlanShowCounts,
  districtPlansHref,
  districtPlansRepsAlone,
  districtPlanState,
  districtPlanStateBar,
  districtPlansTeamLine,
  districtPlansTeamTotals,
  districtPlanWeekFigures,
  districtPlanWeekPosition,
  districtPlanWeekPositionLine,
  districtPlanWorkingDays,
  districtRepLeaveLine,
  districtRepManagersLine,
  filterDistrictPlanWeeks,
  isDistrictPlanSentState,
  isDistrictPlanUnsentState,
  isRepWeekMissing,
  parseDistrictPlanShow,
} from "../src/lib/phoenix-crm/server/district-plans-summary.ts";
import { buildDistrictPlansWorkbook, DISTRICT_PLANS_WORKBOOK_SHEETS, districtPlansWorkbookFileName } from "../src/lib/phoenix-crm/server/district-plans-workbook.ts";
import { addDaysIso } from "../src/lib/crm/dates.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * DISTRICT MANAGERS' PLANS, THE PREMIUM PASS (owner, 9 Nov 2026: "eyeball every report in My Team's Reports, premium
 * polish big work, every single component", then "group reps by district manager").
 *
 * What would go wrong, each without an error anyone could see:
 *
 *   1. a sent week whose Thursday passed undecided still reading "Waiting for approval" — the Regional Sales Manager
 *      opens it to approve and finds no button (Hany Saad, 8 Nov 2026, five times);
 *   2. a vacant district manager seat counted as a manager who did not send;
 *   3. the tiles and bars not adding up to the seats and the half-days, or a bar ending short of 100%;
 *   4. a chain visit turning into a warning, or a draft's half-days shown;
 *   5. a rep the Regional Sales Manager goes with, or a rep on leave all week, listed as alone;
 *   6. the filter changing a figure instead of only the sections listed;
 *   7. the Excel file disagreeing with the screen, or reachable by someone the screen refuses.
 *
 * Each block below pins one of those, on a fixed team worked out by hand.
 */

const THIS_WEEK = "2026-11-07"; // a Saturday
const TODAY = "2026-11-09"; // the Monday of that week

function half(over: Partial<DistrictPlanHalf> & Pick<DistrictPlanHalf, "half" | "kind" | "text">): DistrictPlanHalf {
  return {
    areaName: null,
    chainVisits: [],
    customerDetails: [],
    customers: [],
    goneCustomers: 0,
    repDay: null,
    repName: null,
    repOnLeave: false,
    repSeatId: null,
    repWeekState: null,
    ...over,
  };
}

function withRep(halfOf: "AM" | "PM", seatId: string, name: string, over: Partial<DistrictPlanHalf> = {}): DistrictPlanHalf {
  return half({ half: halfOf, kind: "with_rep", repName: name, repSeatId: seatId, repWeekState: "sent", repDay: "Sent", text: `With ${name}`, ...over });
}

/** Saturday to Thursday, every day present as the loader builds it, plus Friday only when it holds a half. */
function weekDays(weekStart: string, plan: Partial<Record<number, DistrictPlanHalf[]>>, leaveOffsets: number[] = []): DistrictPlanDay[] {
  const days: DistrictPlanDay[] = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const halves = plan[offset] ?? [];
    if (offset === 6 && halves.length === 0) continue;
    const date = addDaysIso(weekStart, offset);
    days.push({ date, dateText: date, halves, managerOnLeave: leaveOffsets.includes(offset) });
  }
  return days;
}

function rep(seatId: string, name: string, over: Partial<DistrictTeamRep> = {}): DistrictTeamRep {
  return { leaveDays: [], managerHalves: 0, managers: [], name, seatId, territory: `${name} territory`, vacant: false, weekState: "sent", ...over };
}

function vacantRep(seatId: string, territory: string): DistrictTeamRep {
  return { leaveDays: [], managerHalves: 0, managers: [], name: territory, seatId, territory, vacant: true, weekState: "no_plan" };
}

function week(over: Partial<DistrictManagerWeek> & Pick<DistrictManagerWeek, "districtSeatId" | "managerName" | "regionName">): DistrictManagerWeek {
  return {
    days: [],
    decidedAt: null,
    districtName: `${over.regionName} district`,
    dueOn: null,
    endedUndecided: false,
    managerHrId: `HR-${over.districtSeatId}`,
    managerLeaveDays: [],
    planHref: null,
    planId: null,
    repSeats: over.reps?.length ?? 0,
    reps: [],
    sent: false,
    status: null,
    statusText: "Not sent yet",
    submittedAt: null,
    submittedLate: false,
    vacantSeats: over.reps?.filter((entry) => entry.vacant).length ?? 0,
    ...over,
  };
}

const MONA: DistrictPlanCustomer = { gone: false, grade: "A", name: "Dr. Mona Saleh", ownList: false, speciality: "Paediatrics" };
const ADEL: DistrictPlanCustomer = { gone: false, grade: "B", name: "Dr. Adel Fawzy", ownList: false, speciality: "Paediatrics" };
const GONE: DistrictPlanCustomer = { gone: true, grade: null, name: "A customer no longer on file", ownList: true, speciality: null };

/**
 * The team, by hand:
 *   - Alexandria: a VACANT district manager seat; under it a vacant rep seat, Yara (the Regional Sales Manager goes
 *     with her) and Ali (nobody).
 *   - Cairo (1), Mohamed Eleiwa: sent LATE, waiting; one half with Sara (old CRM plan); Hoda on leave all week.
 *   - Cairo (2), Karim Samir: a DRAFT — never shown; Ola, nobody with her.
 *   - Delta (1), Sahar El Gallad: APPROVED. Sat AM with Ahmed (chain visit; Dr. Mona Saleh A and Dr. Adel Fawzy B, both
 *     Paediatrics), Sat PM Office, Sun AM with Mai (on leave; Dr. Mona Saleh again), Mon AM with Tamer (the rep's own
 *     week not sent), Mon PM a single visit (1 customer from the manager's own list, gone, no grade); on leave
 *     herself on Wednesday. Nour has nobody; one vacant rep seat. So 4 ticks, 3 different customers.
 */
function sampleReport(weekStart = THIS_WEEK, cairoToday = TODAY, options: { endedB?: boolean; fridayB?: boolean; fridayDraft?: boolean } = {}): DistrictManagersPlans {
  const d = (offset: number) => addDaysIso(weekStart, offset);
  const alexandria = week({
    districtSeatId: "DM-D",
    managerHrId: null,
    managerName: "Seat is vacant",
    regionName: "Alexandria",
    reps: [vacantRep("R8", "Alexandria Rep 1"), rep("R9", "Yara Fathy", { managers: ["Hany Saad"] }), rep("R10", "Ali Nabil")],
  });
  const cairoOne = week({
    days: weekDays(weekStart, { 3: [withRep("AM", "R5", "Sara Kamal", { repDay: "Old CRM plan", repWeekState: "old_crm" })], ...(options.fridayB ? { 6: [half({ half: "AM", kind: "admin", text: "Office" })] } : {}) }),
    districtSeatId: "DM-B",
    dueOn: d(-2),
    endedUndecided: options.endedB === true,
    managerName: "Mohamed Eleiwa",
    planHref: "/employee-portals/approvals/plan/PLAN-B",
    planId: "PLAN-B",
    regionName: "Cairo (1)",
    reps: [rep("R5", "Sara Kamal", { managers: ["Mohamed Eleiwa"], weekState: "old_crm" }), rep("R6", "Hoda Sami", { leaveDays: [0, 1, 2, 3, 4, 5].map(d) })],
    sent: true,
    status: "submitted",
    statusText: options.endedB ? MANAGER_WEEK_ENDED_LABEL : "Waiting for approval",
    submittedAt: `${d(-1)}T09:00:00Z`,
    submittedLate: true,
  });
  const cairoTwo = week({
    // The loader never reads a draft's half-days; a Friday here would be a loader fault the grid must still not show.
    days: options.fridayDraft ? weekDays(weekStart, { 6: [half({ half: "AM", kind: "admin", text: "Office" })] }) : weekDays(weekStart, {}),
    districtSeatId: "DM-C",
    dueOn: d(-2),
    managerName: "Karim Samir",
    planId: "PLAN-C",
    regionName: "Cairo (2)",
    reps: [rep("R7", "Ola Reda")],
    status: "draft",
  });
  const delta = week({
    decidedAt: `${d(-1)}T12:00:00Z`,
    days: weekDays(
      weekStart,
      {
        0: [
          withRep("AM", "R1", "Ahmed Ali", { chainVisits: ["Chain visit — Hany Saad (Regional sales manager) is also with Ahmed Ali this day"], customerDetails: [MONA, ADEL], customers: ["Dr. Mona Saleh", "Dr. Adel Fawzy"] }),
          half({ half: "PM", kind: "admin", text: "Office" }),
        ],
        1: [withRep("AM", "R2", "Mai Hassan", { customerDetails: [MONA], customers: ["Dr. Mona Saleh"], repDay: "On leave", repOnLeave: true })],
        2: [
          withRep("AM", "R3", "Tamer Fouad", { repDay: "Not sent", repWeekState: "not_sent" }),
          half({ areaName: "Heliopolis", customerDetails: [GONE], customers: ["A customer no longer on file"], goneCustomers: 1, half: "PM", kind: "single_visit", text: "Single visit · Heliopolis" }),
        ],
      },
      [4],
    ),
    districtSeatId: "DM-A",
    dueOn: d(-2),
    managerLeaveDays: [d(4)],
    managerName: "Sahar El Gallad",
    planHref: "/employee-portals/approvals/plan/PLAN-A",
    planId: "PLAN-A",
    regionName: "Delta (1)",
    reps: [
      rep("R1", "Ahmed Ali", { managers: ["Sahar El Gallad", "Hany Saad"] }),
      rep("R2", "Mai Hassan", { leaveDays: [d(1)], managers: ["Sahar El Gallad"] }),
      rep("R3", "Tamer Fouad", { managers: ["Sahar El Gallad"], weekState: "not_sent" }),
      rep("R4", "Nour Adel"),
      vacantRep("V1", "Delta (1) Rep 5"),
    ],
    sent: true,
    status: "approved",
    statusText: "Approved",
    submittedAt: `${d(-3)}T10:00:00Z`,
  });
  return { cairoToday, leaveUnread: false, weekEnd: addDaysIso(weekStart, 6), weekStart, weeks: [alexandria, cairoOne, cairoTwo, delta] };
}

function byName(report: DistrictManagersPlans, name: string): DistrictManagerWeek {
  const found = report.weeks.find((entry) => entry.managerName === name);
  assert.ok(found, name);
  return found;
}

function theEndedRuleAndTheStates() {
  // 🔴 The loader asks the status WITH the week, so an ended week is never "Waiting for approval" (owner, 2026-11-08).
  const loader = readFileSync("src/lib/phoenix-crm/server/manager-plan-bookings.ts", "utf8");
  const body = stripComments(loader.slice(loader.indexOf("export async function loadDistrictManagersPlans"), loader.indexOf("export async function loadWeekHalfNotes")));
  assert.ok(body.includes("managerPlanStatusLabel(plan.status, { cairoToday, weekStart })"), "the status words are asked with the week");
  assert.ok(!/managerPlanStatusLabel\(plan\.status\)/.test(body), "never the bare status, which cannot know the week has ended");
  assert.ok(body.includes("isManagerWeekEndedUndecided(plan.status, weekStart, cairoToday)"), "the week carries its own ended flag");
  assert.ok(body.includes("const cairoToday = cairoTodayIso();"), "today is the Cairo day");
  // The rule itself, on the week of 31 October that Hany Saad opened on 8 November.
  assert.equal(managerPlanStatusLabel("submitted", { cairoToday: "2026-11-08", weekStart: "2026-10-31" }), MANAGER_WEEK_ENDED_LABEL);
  assert.equal(managerPlanStatusLabel("first_approved", { cairoToday: "2026-11-06", weekStart: "2026-10-31" }), MANAGER_WEEK_ENDED_LABEL);
  assert.equal(managerPlanStatusLabel("submitted", { cairoToday: "2026-11-05", weekStart: "2026-10-31" }), "Waiting for approval", "its Thursday has not passed yet");
  assert.equal(managerPlanStatusLabel("approved", { cairoToday: "2026-11-08", weekStart: "2026-10-31" }), "Approved", "a decided week is never ended");

  // The states: vacant first, then ended before waiting.
  assert.equal(districtPlanState({ endedUndecided: true, managerHrId: null, status: "submitted" }), "vacant");
  assert.equal(districtPlanState({ endedUndecided: true, managerHrId: "X", status: "submitted" }), "ended");
  assert.equal(districtPlanState({ endedUndecided: true, managerHrId: "X", status: "first_approved" }), "ended");
  assert.equal(districtPlanState({ endedUndecided: false, managerHrId: "X", status: "first_approved" }), "waiting");
  assert.equal(districtPlanState({ endedUndecided: false, managerHrId: "X", status: "approved" }), "approved");
  assert.equal(districtPlanState({ endedUndecided: false, managerHrId: "X", status: "returned" }), "returned");
  assert.equal(districtPlanState({ endedUndecided: false, managerHrId: "X", status: "draft" }), "draft");
  assert.equal(districtPlanState({ endedUndecided: false, managerHrId: "X", status: null }), "not_started");
  assert.equal(DISTRICT_PLAN_STATE_LABEL.ended, MANAGER_WEEK_ENDED_LABEL, "one wording for an ended week on every surface");
  for (const state of ["approved", "waiting", "ended"] as const) assert.ok(isDistrictPlanSentState(state) && !isDistrictPlanUnsentState(state), state);
  for (const state of ["draft", "returned", "not_started"] as const) assert.ok(!isDistrictPlanSentState(state) && isDistrictPlanUnsentState(state), state);
  assert.ok(!isDistrictPlanSentState("vacant") && !isDistrictPlanUnsentState("vacant"), "a vacant seat is neither sent nor not sent");
  // The vacant seat wears the lightest colour (owner, 2026-11-09: "if a seat a vacant color in light color").
  assert.equal(DISTRICT_PLAN_STATE_SWATCH.vacant, "bg-slate-100");
  assert.ok(isRepWeekMissing("not_sent") && isRepWeekMissing("no_plan") && !isRepWeekMissing("old_crm") && !isRepWeekMissing("sent") && !isRepWeekMissing(null));
}

function oneManagersWeek() {
  const report = sampleReport();
  const delta = districtPlanWeekFigures(byName(report, "Sahar El Gallad"), report.weekStart);
  assert.equal(delta.state, "approved");
  assert.equal(delta.halves, 5);
  assert.deepEqual(delta.byKind, { admin: 1, single_visit: 1, with_area: 0, with_dm: 0, with_rep: 3, with_senior: 0 });
  assert.equal(delta.repsWith, 3, "Ahmed, Mai, Tamer");
  assert.equal(delta.repsInTeam, 4, "the vacant seat is not a rep");
  assert.equal(delta.vacantSeats, 1);
  assert.equal(delta.customers, 4, "every tick counts here; the customers section counts them once each");
  assert.equal(delta.goneCustomers, 1);
  assert.equal(delta.chainVisitHalves, 1);
  assert.equal(delta.repOnLeaveHalves, 1, "Mai on Sunday");
  assert.equal(delta.repWeekMissingHalves, 1, "Tamer, whose own week is not sent — Mai on leave is counted once, as leave");
  assert.equal(delta.leaveDays, 1, "her own Wednesday");
  // Six field days, twelve halves; her Wednesday (2) is leave; 5 planned → 5 open.
  assert.equal(delta.openHalves, 5);
  assert.equal(districtPlanKindsLine(delta.byKind), "3 with a rep · 1 admin · 1 single visits");
  const draft = districtPlanWeekFigures(byName(report, "Karim Samir"), report.weekStart);
  assert.equal(draft.state, "draft");
  assert.equal(draft.sent, false);
  assert.equal(draft.halves, 0, "a draft's half-days are never counted");
  assert.equal(draft.openHalves, 0, "nor called open");
  const vacant = districtPlanWeekFigures(byName(report, "Seat is vacant"), report.weekStart);
  assert.equal(vacant.state, "vacant");
  assert.equal(vacant.repsInTeam, 2);
  assert.equal(vacant.vacantSeats, 1);
  assert.equal(districtPlanKindsLine({ admin: 0, single_visit: 0, with_area: 0, with_dm: 0, with_rep: 0, with_senior: 0 }), "Nothing planned");
}

function theWholeTeamAddsUp() {
  const report = sampleReport();
  const totals = districtPlansTeamTotals(report);
  assert.equal(totals.managers, 3, "the vacant seat is not a manager");
  assert.equal(totals.vacantManagerSeats, 1);
  assert.equal(totals.sent, 2);
  assert.equal(totals.notSent, 1, "the draft — never the vacant seat");
  assert.equal(totals.late, 1);
  assert.equal(totals.byState.approved, 1);
  assert.equal(totals.byState.waiting, 1);
  assert.equal(totals.byState.ended, 0);
  assert.equal(totals.byState.draft, 1);
  assert.equal(totals.byState.vacant, 1);
  assert.equal(totals.halves, 6);
  assert.equal(totals.byKind.with_rep, 4);
  assert.equal(totals.openHalves, 5 + 11);
  assert.equal(totals.reps, 9);
  assert.equal(totals.repsWithAManager, 5, "Ahmed, Mai, Tamer, Sara — and Yara, whom the Regional Sales Manager goes with");
  assert.equal(totals.vacantRepSeats, 2);
  assert.equal(totals.chainVisitHalves, 1);
  assert.equal(districtPlansTeamLine(totals), "2 of 3 district managers sent their week · 1 approved · 1 waiting for a decision · 1 sent late.");
  // The bars add up to their wholes, in counts and in per cent.
  const states = districtPlanStateBar(totals);
  assert.equal(states.reduce((sum, part) => sum + part.count, 0), report.weeks.length, "every seat is on the status bar once");
  assert.equal(states.reduce((sum, part) => sum + part.percent, 0), 100);
  const kinds = districtPlanKindBar(totals);
  assert.equal(kinds.reduce((sum, part) => sum + part.count, 0), totals.halves, "every planned half once");
  assert.equal(kinds.reduce((sum, part) => sum + part.percent, 0), 100);
  assert.ok(kinds.every((part) => part.count > 0), "an empty kind is left off the bar");
  // The same week a fortnight on: Mohamed's week ended undecided, so it is ended — never waiting.
  const past = districtPlansTeamTotals(sampleReport("2026-10-31", TODAY, { endedB: true }));
  assert.equal(past.byState.ended, 1);
  assert.equal(past.byState.waiting, 0);
  assert.equal(past.sent, 2, "an ended week was still sent");
  assert.ok(districtPlansTeamLine(past).includes("1 ended undecided"));
  assert.equal(districtPlansTeamLine(districtPlansTeamTotals({ weekStart: THIS_WEEK, weeks: [] })), "No district manager seat under you has somebody in it.");
}

function sharesEndAtExactlyAHundred() {
  const parts = (counts: number[]) => counts.map((count, index) => ({ count, key: `k${index}`, label: `K${index}`, swatch: "bg-slate-500" }));
  const thirds = districtPlanShares(parts([1, 1, 1]));
  assert.deepEqual(thirds.map((part) => part.percent), [34, 33, 33]);
  const sevenths = districtPlanShares(parts([1, 1, 1, 1, 1, 1, 1]));
  assert.equal(sevenths.reduce((sum, part) => sum + part.percent, 0), 100);
  const skewed = districtPlanShares(parts([2, 0, 997, 1]));
  assert.equal(skewed.length, 3, "a zero part is left out");
  assert.equal(skewed.reduce((sum, part) => sum + part.percent, 0), 100);
  assert.deepEqual(districtPlanShares(parts([0, 0])), [], "an empty whole is an empty bar, never a 0% one");
}

function theWeekAtAGlance() {
  const report = sampleReport();
  const grid = districtPlansGrid(report);
  assert.deepEqual(grid.days, districtPlanWorkingDays(THIS_WEEK), "Saturday to Thursday when nobody planned Friday");
  assert.equal(grid.days.length, 6);
  assert.deepEqual(grid.rows.map((row) => row.week.managerName), ["Mohamed Eleiwa", "Karim Samir", "Sahar El Gallad"], "the vacant seat has no row");
  const cell = (name: string, date: string, halfOf: "AM" | "PM") => grid.rows.find((row) => row.week.managerName === name)!.cells.find((entry) => entry.date === date && entry.half === halfOf)!.cell;
  assert.deepEqual(cell("Sahar El Gallad", THIS_WEEK, "AM"), { chainVisit: true, kind: "with_rep", repOnLeave: false, state: "planned", text: "Ahmed Ali" }, "a half with a rep shows the rep's name");
  assert.deepEqual(cell("Sahar El Gallad", THIS_WEEK, "PM"), { chainVisit: false, kind: "admin", repOnLeave: false, state: "planned", text: "Office" }, "admin work shows instead of a visit");
  assert.equal((cell("Sahar El Gallad", addDaysIso(THIS_WEEK, 1), "AM") as { repOnLeave: boolean }).repOnLeave, true);
  assert.deepEqual(cell("Sahar El Gallad", addDaysIso(THIS_WEEK, 4), "AM"), { state: "leave" }, "her own leave day reads On leave");
  assert.deepEqual(cell("Sahar El Gallad", addDaysIso(THIS_WEEK, 4), "PM"), { state: "leave" });
  assert.deepEqual(cell("Sahar El Gallad", addDaysIso(THIS_WEEK, 5), "AM"), { state: "open" });
  assert.ok(grid.rows.find((row) => row.week.managerName === "Karim Samir")!.cells.every((entry) => entry.cell.state === "unsent"), "a draft row says Not sent in every cell");
  for (const row of grid.rows) assert.equal(row.cells.length, grid.days.length * 2, "AM and PM for every day");
  // Friday joins only when a SENT week planned it.
  assert.equal(districtPlansGrid(sampleReport(THIS_WEEK, TODAY, { fridayB: true })).days.length, 7);
  assert.equal(districtPlansGrid(sampleReport(THIS_WEEK, TODAY, { fridayDraft: true })).days.length, 6, "a draft's Friday never opens the column");
}

function toLookAt() {
  const report = sampleReport();
  const items = districtPlansAttention(report);
  assert.deepEqual(
    items.map((item) => `${item.reason}:${item.week.managerName}`),
    ["not_sent:Karim Samir", "late:Mohamed Eleiwa", "rep_on_leave:Sahar El Gallad", "rep_week_missing:Sahar El Gallad", "gone_customers:Sahar El Gallad"],
    "the reasons in their order; the vacant seat is never on it",
  );
  const line = (reason: string) => items.find((item) => item.reason === reason)!.line;
  assert.equal(line("not_sent"), `The week is not sent yet, due ${districtPlanDayLabel(addDaysIso(THIS_WEEK, -2))}.`);
  assert.equal(line("late"), `Sent after it was due. It was due ${districtPlanDayLabel(addDaysIso(THIS_WEEK, -2))}.`);
  assert.equal(line("rep_on_leave"), "Sun 8 AM with Mai Hassan — the rep is on approved leave that day.");
  assert.equal(line("rep_week_missing"), "Mon 9 AM with Tamer Fouad (not sent) — the rep's own week is not there to plan beside.");
  assert.equal(line("gone_customers"), "1 customer ticked is no longer on file: Mon 9 PM.");
  assert.ok(!items.some((item) => /chain/i.test(item.line)), "a chain visit is never a reason to look");
  for (const item of items) assert.ok(!/\b(he|his|him)\b/i.test(item.line), `neutral words: ${item.line}`);
  assert.deepEqual(districtPlanAttentionCounts(items), { ended: 0, gone_customers: 1, late: 1, not_sent: 1, rep_on_leave: 1, rep_week_missing: 1 });
  const past = districtPlansAttention(sampleReport("2026-10-31", TODAY, { endedB: true }));
  assert.equal(past.find((item) => item.reason === "ended")?.week.managerName, "Mohamed Eleiwa", "an ended week is named as ended");
  // Returned reads its own words.
  const returned = sampleReport();
  byName(returned, "Karim Samir").status = "returned";
  assert.ok(districtPlansAttention(returned)[0].line.startsWith("Returned for changes and not sent again"));
}

function repsNoManagerIsWith() {
  const alone = districtPlansRepsAlone(sampleReport());
  assert.deepEqual(
    alone.map((entry) => `${entry.week.managerName}:${entry.reps.map((entry2) => entry2.name).join(",")}`),
    ["Seat is vacant:Ali Nabil", "Karim Samir:Ola Reda", "Sahar El Gallad:Nour Adel"],
    "Yara is with the Regional Sales Manager; Hoda is on leave all week; vacant seats are never reps",
  );
  const report = sampleReport();
  assert.equal(districtRepLeaveLine(byName(report, "Sahar El Gallad").reps[1], THIS_WEEK), "On leave Sun 8");
  assert.equal(districtRepLeaveLine(byName(report, "Mohamed Eleiwa").reps[1], THIS_WEEK), "On leave all week");
  assert.equal(districtRepLeaveLine(byName(report, "Sahar El Gallad").reps[0], THIS_WEEK), null);
  assert.equal(districtRepManagersLine(byName(report, "Sahar El Gallad").reps[0]), "With Sahar El Gallad, Hany Saad");
  assert.equal(districtRepManagersLine(byName(report, "Sahar El Gallad").reps[3]), "No manager this week");
  assert.equal(districtRepManagersLine(byName(report, "Sahar El Gallad").reps[4]), "Seat is vacant");
}

function chainVisitsAreNeutral() {
  const chains = districtPlansChainVisits(sampleReport());
  assert.equal(chains.length, 1);
  assert.equal(chains[0].repName, "Ahmed Ali");
  assert.equal(chains[0].half, "AM");
  assert.equal(chains[0].date, THIS_WEEK);
  // A draft's chain visit is never read: give the draft one and it stays out.
  const report = sampleReport();
  byName(report, "Karim Samir").days = weekDays(THIS_WEEK, { 0: [withRep("AM", "R7", "Ola Reda", { chainVisits: ["Chain visit — X (District manager) is also with Ola Reda this day"] })] });
  assert.equal(districtPlansChainVisits(report).length, 1);
  const summary = stripComments(readFileSync("src/lib/phoenix-crm/server/district-plans-summary.ts", "utf8"));
  assert.ok(!/chain[\s\S]{0,40}(amber|red-|rose-)/i.test(summary), "no warning colour near a chain visit");
}

function theFilterNarrowsSectionsOnly() {
  const report = sampleReport();
  assert.equal(parseDistrictPlanShow("sent"), "sent");
  assert.equal(parseDistrictPlanShow(["waiting", "sent"]), "waiting");
  assert.equal(parseDistrictPlanShow("not_sent"), "not_sent");
  assert.equal(parseDistrictPlanShow("everything"), "all");
  assert.equal(parseDistrictPlanShow(undefined), "all");
  assert.deepEqual(districtPlanShowCounts(report.weeks), { all: 4, not_sent: 1, sent: 2, waiting: 1 });
  assert.deepEqual(filterDistrictPlanWeeks(report.weeks, "not_sent").map((entry) => entry.managerName), ["Karim Samir"], "a vacant seat is never 'not sent'");
  assert.deepEqual(filterDistrictPlanWeeks(report.weeks, "waiting").map((entry) => entry.managerName), ["Mohamed Eleiwa"]);
  assert.deepEqual(filterDistrictPlanWeeks(sampleReport("2026-10-31", TODAY, { endedB: true }).weeks, "waiting"), [], "an ended week is not waiting");
  assert.deepEqual([...districtPlanListedSeats(report.weeks, "sent")].sort(), ["DM-A", "DM-B"]);
  // The figures are the whole team's whatever the filter: the totals read report.weeks, never the filtered list.
  assert.deepEqual(districtPlansTeamTotals(report), districtPlansTeamTotals({ ...report }));
  assert.equal(districtPlansHref(null), "/employee-portals/district-manager-plans");
  assert.equal(districtPlansHref(THIS_WEEK, "waiting"), "/employee-portals/district-manager-plans?week=2026-11-07&show=waiting");
  assert.equal(districtPlansHref(THIS_WEEK), "/employee-portals/district-manager-plans?week=2026-11-07");
  assert.equal(districtPlanAnchor({ districtSeatId: "DM-A" }), "dm-dm-a");
  assert.equal(districtPlanAnchor({ districtSeatId: "!!" }), "dm-seat");
}

function wordsAndTheWeek() {
  assert.equal(districtPlanShortDay("2026-11-07"), "Sat 7");
  assert.equal(districtPlanShortDay("2026-11-12"), "Thu 12");
  assert.equal(districtPlanShortDay("2026-11-13"), "Fri 13");
  assert.deepEqual(districtPlanWorkingDays(THIS_WEEK), ["2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"]);
  const report = sampleReport();
  const format = (iso: string) => iso.slice(0, 10);
  assert.equal(districtPlanSentLine(byName(report, "Sahar El Gallad"), format), "Sent 2026-11-04 · approved 2026-11-06.");
  assert.equal(districtPlanSentLine(byName(report, "Mohamed Eleiwa"), format), `Sent 2026-11-06 · late, due ${districtPlanDayLabel("2026-11-05")}.`);
  assert.equal(districtPlanSentLine(byName(report, "Karim Samir"), format), `Not sent yet · due ${districtPlanDayLabel("2026-11-05")}.`);
  assert.equal(districtPlanSentLine(byName(report, "Seat is vacant"), format), "Nobody is in this district manager seat.");
  const ended = byName(sampleReport("2026-10-31", TODAY, { endedB: true }), "Mohamed Eleiwa");
  assert.ok(districtPlanSentLine(ended, format).endsWith("the week ended before anyone approved it."));
  assert.equal(districtPlanWeekPosition(report), "current");
  assert.equal(districtPlanWeekPositionLine(report), `This week is running. Today is ${districtPlanDayLabel(TODAY)}.`);
  assert.equal(districtPlanWeekPosition({ cairoToday: TODAY, weekStart: "2026-10-31" }), "past");
  assert.equal(districtPlanWeekPosition({ cairoToday: TODAY, weekStart: "2026-11-14" }), "ahead");
  // Thursday is still the week; Friday is past it.
  assert.equal(districtPlanWeekPosition({ cairoToday: "2026-11-12", weekStart: THIS_WEEK }), "current");
  assert.equal(districtPlanWeekPosition({ cairoToday: "2026-11-13", weekStart: THIS_WEEK }), "past");
}

async function theWorkbook() {
  const report = sampleReport();
  const buffer = await buildDistrictPlansWorkbook(report, "2026-11-09T08:30:00Z");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [...DISTRICT_PLANS_WORKBOOK_SHEETS]);
  assert.equal(districtPlansWorkbookFileName(report), "district-manager-plans-2026-11-07.xlsx");
  const text = (name: string) => {
    const values: string[] = [];
    workbook.getWorksheet(name)!.eachRow((row) => row.eachCell((cell) => values.push(String(cell.value ?? ""))));
    return values;
  };
  const cover = text("Cover");
  assert.ok(cover.includes("2 of 3"), "weeks sent, the vacant seat left out");
  const managers = text("Managers");
  assert.ok(managers.includes("Seat is vacant"));
  assert.ok(managers.includes("Waiting for approval") && managers.includes("Approved") && managers.includes("Not sent yet"));
  assert.ok(managers.includes("The whole team"));
  // One row per planned half of a sent week, none from the draft.
  const halfSheet = workbook.getWorksheet("Half-days")!;
  let halves = 0;
  halfSheet.eachRow((row) => {
    const value = String(row.getCell(4).value ?? "");
    if (value === "AM" || value === "PM") halves += 1;
  });
  assert.equal(halves, districtPlansTeamTotals(report).halves, "the file holds every planned half once");
  assert.ok(text("Half-days").some((value) => value.startsWith("Chain visit — Hany Saad")), "the chain visit is a neutral column");
  assert.ok(text("Half-days").includes("On leave"), "the rep's leave is on the half");
  const look = text("To look at");
  for (const expected of ["Not sent", "Sent late", "With a rep on leave", "Ola Reda", "Chain visits · 1", "Reps no manager is with this week · 3"]) assert.ok(look.includes(expected), expected);
  assert.ok(!look.includes("Hoda Sami"), "a rep on leave all week is not alone");
  const customerSheet = text("Customers");
  assert.ok(customerSheet.includes("Whom they will visit · 4 ticks · 3 different customers"), "the sheet's heading carries the team's mix");
  assert.ok(customerSheet.includes("Ticked more than once: Dr. Mona Saleh ×2"));
  assert.ok(customerSheet.includes("Every customer ticked · 4"), "one row per tick of a sent week");
  assert.ok(customerSheet.includes("Manager's own list") && customerSheet.includes("No longer on file") && customerSheet.includes("No grade"));
  assert.ok(!customerSheet.includes("Karim Samir"), "a draft adds no customer");
  const reps = text("Reps");
  assert.ok(reps.includes("No manager this week") && reps.includes("On leave all week") && reps.includes("Seat is vacant"));
  // A fortnight on: the ended week never reads as waiting in the file.
  const pastBuffer = await buildDistrictPlansWorkbook(sampleReport("2026-10-31", TODAY, { endedB: true }), "2026-11-09T08:30:00Z");
  const past = new ExcelJS.Workbook();
  await past.xlsx.load(pastBuffer as unknown as ArrayBuffer);
  const pastManagers: string[] = [];
  past.getWorksheet("Managers")!.eachRow((row) => row.eachCell((cell) => pastManagers.push(String(cell.value ?? ""))));
  assert.ok(pastManagers.includes(MANAGER_WEEK_ENDED_LABEL));
  assert.ok(!pastManagers.includes("Waiting for approval"), "an ended week is never waiting in the file");
  const source = stripComments(readFileSync("src/lib/phoenix-crm/server/district-plans-workbook.ts", "utf8"));
  assert.ok(source.includes("buildHouseCoverSheet") && source.includes("writeHouseMasthead"), "the file wears the house identity");
  assert.ok(!/\bhis\b|\bhim\b|\bhe\b/i.test(source), "neutral wording in the file");
}

function theExportGateAndRegistry() {
  const route = stripComments(readFileSync("app/api/crm/district-manager-plans/export/route.ts", "utf8"));
  const load = route.indexOf("loadDistrictManagersPlans(viewer");
  const read = route.indexOf('canAccess(access, "phoenix_crm", "read")');
  const gate = route.indexOf("readsRegionalTeamReports(viewer)");
  const limit = route.indexOf('scope: "export:crm:district-manager-plans"');
  assert.ok(read > 0 && read < load, "phoenix_crm:read before any read");
  assert.ok(gate > 0 && gate < load, "the Regional Sales Manager's gate before any read");
  assert.ok(limit > 0 && limit < load, "rate-limited before the read");
  assert.ok(route.includes('entityType: "crm_district_plans_export"'), "every download is audited");
  assert.ok(route.includes('"cache-control": "no-store"'));
  assert.ok(route.includes("isIsoDay(week) ? week : viewer.visitDay"), "the week is read strictly");
  assert.ok(!route.includes('get("show")'), "the file takes no filter: it always holds every seat");
  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.ok(
    registry.includes('sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/crm/district-manager-plans/export", permission: { resource: "phoenix_crm", action: "read" }, guard: "domain-helper" }),'),
    "the export is in the access registry as an audited export",
  );
  assert.ok(readFileSync("src/lib/admin/audit-entity-types.ts", "utf8").includes("crm_district_plans_export: true,"), "the audit trail can be filtered to it");
  assert.ok(readFileSync("src/lib/admin/audit.ts", "utf8").includes('| "crm_district_plans_export"'));
  // Never inside the pure Phoenix CRM module, which names no old-CRM /api/crm/ route.
  assert.ok(!readFileSync("src/lib/phoenix-crm/server/district-plans-summary.ts", "utf8").includes("/api/crm/"));
}

function whomTheyWillVisit() {
  const report = sampleReport();
  const delta = report.weeks.find((week) => week.districtSeatId === "DM-A")!;
  const mix = districtCustomerMix([delta]);
  // 4 ticks: Mona twice (Sat and Sun), Adel, and the gone own-list customer. Three different customers.
  assert.equal(mix.ticked, 4);
  assert.equal(mix.distinct, 3, "a customer ticked on two half-days is one customer");
  assert.deepEqual(mix.byGrade, { A: 1, B: 1, C: 0, none: 1 }, "grades count customers, never ticks");
  assert.equal(mix.gone, 1);
  assert.equal(mix.ownList, 1);
  assert.deepEqual(mix.specialities, [{ count: 2, speciality: "Paediatrics" }, { count: 1, speciality: "No speciality" }]);
  assert.deepEqual(mix.repeated, [{ name: "Dr. Mona Saleh", times: 2 }]);
  assert.equal(districtCustomerCountLine(mix), "4 ticks · 3 different customers");
  assert.equal(districtCustomerGradeLine(mix), "1 A · 1 B · 1 with no grade");
  assert.equal(districtCustomerSpecialityLine(mix), "Paediatrics 2 · No speciality 1");
  assert.equal(districtCustomerSpecialityLine(mix, 1), "Paediatrics 2 · 1 more speciality");
  assert.equal(districtCustomerRepeatedLine(mix), "Ticked more than once: Dr. Mona Saleh ×2");
  assert.equal(districtCustomerAShare(mix), 50, "1 A of the 2 graded");
  // Nobody ticked: the words say so, never a zero share.
  const empty = districtCustomerMix([]);
  assert.equal(districtCustomerCountLine(empty), "No customer ticked");
  assert.equal(districtCustomerGradeLine(empty), null);
  assert.equal(districtCustomerAShare(empty), null);
  assert.equal(districtCustomerRepeatedLine(empty), null);
  // The draft's customers are never read, even if a loader fault put some there.
  const draft = report.weeks.find((week) => week.districtSeatId === "DM-C")!;
  const leaked = { ...draft, days: draft.days.map((day, index) => (index === 0 ? { ...day, halves: [half({ customerDetails: [MONA], customers: ["Dr. Mona Saleh"], half: "AM", kind: "single_visit", text: "Single visit" })] } : day)) };
  assert.equal(districtCustomerMix([leaked]).ticked, 0, "a draft adds no customer");
  // One row per sent week; the team adds them, and Mohamed's sent week has none.
  const { rows, team } = districtPlansCustomerRows(report);
  assert.deepEqual(rows.map((row) => row.week.managerName).sort(), ["Mohamed Eleiwa", "Sahar El Gallad"], "sent weeks only: no draft, no vacant seat");
  assert.equal(team.ticked, 4);
  assert.equal(team.distinct, 3);
  assert.equal(districtPlansCustomerTicks(report).length, team.ticked, "the file's rows are the ticks");
  // The grade reads whatever the list holds.
  assert.equal(districtCustomerGrade("a"), "A");
  assert.equal(districtCustomerGrade(" B "), "B");
  assert.equal(districtCustomerGrade("c"), "C");
  assert.equal(districtCustomerGrade("D"), null);
  assert.equal(districtCustomerGrade(null), null);
}

function theLoaderCarriesWhatThePanelsRead() {
  const loader = readFileSync("src/lib/phoenix-crm/server/manager-plan-bookings.ts", "utf8");
  const body = stripComments(loader.slice(loader.indexOf("export async function loadDistrictManagersPlans"), loader.indexOf("export async function loadWeekHalfNotes")));
  assert.ok(body.includes("loadSeatLeaveDays(districts, { from: weekStart, to: weekEnd })"), "the district managers' own leave is read (owner, 2026-11-09: \"if vacation put it\")");
  assert.ok(body.includes("const leaveUnread = repLeave.unread || managerLeave.unread;"), "either read failing is said once, for everyone");
  assert.ok(body.includes("planHref: sent && plan ? managerPlanHref(plan.planId) : null,"), "only a sent week opens; a draft is never linked");
  assert.ok(body.includes("goneCustomers: goneBySlot.get(slot.slotId) ?? 0,"));
  assert.ok(body.includes("repOnLeave = !leave.unread && leave.days.has(leaveDayKey(slot.repSeatId, date));"));
  assert.ok(body.includes("if (key && !managers.has(key)) managers.set(key, nameOf(names, booking.managerHrId));"), "each manager once per rep, every planner kind");
  assert.ok(body.includes("managerHalves += 1;"), "every sent half a manager booked with the rep is counted");
  assert.ok(body.includes("customerDetails: detailsBySlot.get(slot.slotId) ?? [],"), "each half carries its customers' grade and speciality");
}

function theScreen() {
  const view = stripComments(readFileSync("src/components/crm/regional/district-manager-plans-view.tsx", "utf8"));
  const panels = stripComments(readFileSync("src/components/crm/regional/district-manager-plans-panels.tsx", "utf8"));
  const page = stripComments(readFileSync("app/employee-portals/district-manager-plans/page.tsx", "utf8"));
  assert.ok(page.includes("parseDistrictPlanShow(params.show)"), "the page reads the filter strictly");
  assert.ok(page.includes("isIsoDay(week) ? week : viewer.visitDay"), "and the week");
  assert.ok(view.includes("const listed = filterDistrictPlanWeeks(report.weeks, show);"), "the filter narrows only the sections listed");
  for (const panel of ["<DistrictPlansTiles report={report} />", "<DistrictPlansStandPanel report={report} />", "<DistrictPlansGridPanel report={report} show={show} />", "<DistrictPlansAttentionPanel report={report} show={show} />", "<DistrictPlansRepsAlonePanel report={report} show={show} />", "<DistrictPlansChainVisitsPanel report={report} />"]) {
    assert.ok(view.includes(panel), `the whole team's panel: ${panel}`);
  }
  assert.ok(view.includes("title={regionManagerTitle(week.regionName, week.managerName)}"), "each section is headed by its region and manager");
  assert.ok(view.includes("id={districtPlanAnchor(week)}"), "each section carries the anchor the panels link to");
  assert.ok(view.includes('!figures.sent ? (\n          <p className="px-4 py-3 text-phx-xs font-semibold text-slate-600">Not sent yet</p>'), "a week not sent shows none of its draft");
  assert.ok(view.includes("day.managerOnLeave ?"), "a day on leave reads On leave");
  assert.ok(view.includes('text-sky-800" key={line}'), "a chain visit is a neutral sky line");
  assert.ok(view.includes("const open = figures.sent ? week.planHref : null;"), "only a sent week offers to open");
  assert.ok(panels.includes("href={districtPlansExportHref(report.weekStart)}"), "the download sits in the toolbar, for the week on the screen");
  assert.ok(panels.includes("const dayWidth = `${(82 / grid.days.length).toFixed(2)}%`;") && panels.includes('<col className="w-[18%]" />'), "the grid's columns add up to 100%");
  for (const [name, source] of [["view", view], ["panels", panels]] as const) {
    assert.ok(!source.includes('"use client"'), `${name}: a server component`);
    assert.ok(!/\brounded(?:-|\b)/.test(source), `${name}: square corners`);
    assert.ok(!/\bshadow(?:-|\b)/.test(source), `${name}: no drop shadow`);
    assert.ok(!/bg-gradient|from-\w+-\d+ to-/.test(source), `${name}: no gradient`);
    assert.ok(!/\btruncate\b|text-ellipsis|line-clamp|…/.test(source), `${name}: no ellipsis`);
    assert.ok(!/\bhis\b|\bhim\b|\bhe\b/i.test(source.replace(/&apos;/g, "'")), `${name}: neutral wording`);
    assert.ok(!/overflow-x-auto|min-w-\[/.test(source), `${name}: never a sideways scroll`);
    const tables = source.match(/<table className="[^"]*"/g) ?? [];
    assert.ok(tables.length >= 1, `${name} draws a table`);
    for (const table of tables) assert.ok(table.includes("table-fixed") && table.includes("hidden") && /(md|lg):table/.test(table), `${name}: ${table}`);
    for (const group of source.match(/<colgroup>[\s\S]*?<\/colgroup>/g) ?? []) {
      if (group.includes("style=")) continue;
      const widths = [...group.matchAll(/w-\[(\d+)%\]/g)].map((match) => Number(match[1]));
      assert.equal(widths.reduce((sum, width) => sum + width, 0), 100, `${name}: a colgroup adds up to 100%`);
    }
    assert.ok(/(md|lg):hidden/.test(source), `${name}: the phone gets cards`);
  }
}

export async function runDistrictManagerPlansPremiumTests() {
  theEndedRuleAndTheStates();
  oneManagersWeek();
  theWholeTeamAddsUp();
  sharesEndAtExactlyAHundred();
  theWeekAtAGlance();
  toLookAt();
  repsNoManagerIsWith();
  chainVisitsAreNeutral();
  theFilterNarrowsSectionsOnly();
  whomTheyWillVisit();
  wordsAndTheWeek();
  await theWorkbook();
  theExportGateAndRegistry();
  theLoaderCarriesWhatThePanelsRead();
  theScreen();
}
