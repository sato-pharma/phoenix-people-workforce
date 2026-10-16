import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { addDaysIso } from "../src/lib/crm/dates.ts";
import {
  boardLeadingWeek,
  fieldWeekStart,
  fieldWeeksOfMonth,
  leadingFieldWeekOfMonth,
  PLAN_WEEK_DUE_OVERRIDES,
  plannableWeeks,
  repPlanWeek,
  weekdayOfIsoDay,
  weeklyPlanDueOn,
} from "../src/lib/phoenix-crm/calendar.ts";
import { repWeekState, type RepWeekState } from "../src/lib/phoenix-crm/plan-rules.ts";

/**
 * Phoenix CRM — WEEKLY ONLY (owner, 2026-10-01, after the first Delta (1) session on the plan board).
 *
 * What went wrong that day, measured on production: the board opened on SEPTEMBER (the first plannable
 * month — the week of 26 September still had Thursday 1 October open), four of fourteen reps pressed
 * "Send the month" and were stamped late against a month due on 24 September, one planned a week that
 * had already passed, and reps pressed the "Receives on" filter believing it chose the day.
 *
 * His rulings, pinned here:
 *   1. a rep plans ONE week — the week that begins on the coming Saturday (`repPlanWeek`); never a week
 *      that has passed, never a week ahead of it. The server refuses any other week, the board greys it;
 *   2. the Plan opens on that week's month, that week active, its days, its customers — no month
 *      chooser, no month Send, no Copy last month on the rep's own plan;
 *   3. a sent week changes only through "Ask to edit this week" (tests/phoenix-crm-plan-edit-requests);
 *   4. the week of 3 October 2026 is due Friday 2 October — the Delta reps sent it again on Friday after
 *      the old screen's entries were wiped, and he ruled that on time;
 *   5. (2026-10-02) a rep who missed the deadline still sends the week he is IN, while it has a day left —
 *      late, and stamped late; his visits count as planned only from the moment he sends it.
 */

function raw(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

function source(path: string): string {
  return stripComments(raw(path));
}

function stateOf(overrides: Partial<Parameters<typeof repWeekState>[0]>): RepWeekState {
  return repWeekState({
    weekStart: "2026-10-03",
    open: true,
    status: null,
    repWeek: "2026-10-03",
    runningWeek: "2026-09-26",
    editAsked: false,
    editReopened: false,
    ...overrides,
  });
}

export function runPhoenixCrmPlanWeeklyOnlyTests(): void {
  // ── 1. The one week: the one that begins on the coming Saturday ──────────────────────────────────
  {
    assert.equal(weekdayOfIsoDay("2026-10-01"), 4, "1 October 2026 is a Thursday");
    assert.equal(repPlanWeek("2026-10-01"), "2026-10-03", "on Thursday 1 October the rep plans the week of Saturday 3 October");
    assert.equal(repPlanWeek("2026-10-02"), "2026-10-03", "and on Friday 2 October still the same week — it starts tomorrow");
    assert.equal(repPlanWeek("2026-10-03"), "2026-10-10", "on Saturday 3 October his week is the next one: the 3rd is running");
    assert.equal(repPlanWeek("2026-10-08"), "2026-10-10", "and on Thursday 8 October, due day, still the 10th");

    for (let day = "2026-01-01"; day <= "2028-12-31"; day = addDaysIso(day, 1)) {
      const week = repPlanWeek(day);
      assert.equal(weekdayOfIsoDay(week), 6, `${day}: the rep's week starts on a Saturday`);
      assert.equal(week, addDaysIso(fieldWeekStart(day), 7), `${day}: it is the week after the running one`);
      assert.ok(week > day, `${day}: it has not begun yet`);
      assert.ok(plannableWeeks(day).includes(week), `${day}: it is inside the reviewers' window, so a manager can open it`);
    }
  }

  // ── 2. What the rep may do with a week ──────────────────────────────────────────────────────────
  {
    assert.equal(stateOf({}), "plan", "his week, not started: he plans it");
    assert.equal(stateOf({ status: "draft" }), "plan", "his week, a draft: he plans it");
    assert.equal(stateOf({ status: "returned" }), "plan", "his week, returned: he plans it again");
    assert.equal(stateOf({ status: "submitted" }), "sent", "his week, sent: he can only ask to edit it");
    assert.equal(stateOf({ status: "approved" }), "sent", "approved: the same");
    assert.equal(stateOf({ status: "approved", editAsked: true }), "asked", "and once asked, it waits on the request");
    assert.equal(stateOf({ open: false }), "closed", "a week with no day left is closed, whatever it is");

    const next = { weekStart: "2026-10-10" };
    assert.equal(stateOf({ ...next }), "closed", "a week ahead of his is greyed — not open yet");
    assert.equal(stateOf({ ...next, status: "draft" }), "closed", "even one he once drafted under the old board");
    assert.equal(stateOf({ ...next, status: "submitted" }), "sent", "one sent under the old board can only be asked about");

    // The week he is IN (owner, 2026-10-02 — still sent if he never sent it, late and stamped late).
    const running = { weekStart: "2026-09-26", repWeek: "2026-10-03", runningWeek: "2026-09-26" };
    assert.equal(stateOf({ ...running }), "plan", "the running week he never sent is still his to send — late, and stamped late");
    assert.equal(stateOf({ ...running, status: "draft" }), "plan", "and so is a running draft he never sent");
    assert.equal(stateOf({ ...running, open: false }), "closed", "until it has no day left: then it is closed like any passed week");
    assert.equal(stateOf({ ...running, status: "submitted" }), "sent", "once sent, the running week is only asked about");
    assert.equal(stateOf({ ...running, status: "returned" }), "plan", "a running week his manager RETURNED is his to change");
    assert.equal(stateOf({ ...running, status: "draft", editReopened: true }), "plan", "a running week an edit request REOPENED is his to change");
    // Only the week he is in: a week behind it stays closed, whatever it holds.
    assert.equal(stateOf({ ...running, weekStart: "2026-09-19" }), "closed", "a week before the running one never reopens");
    assert.equal(stateOf({ ...running, weekStart: "2026-09-19", status: "draft" }), "closed", "not even a draft of it");
  }

  // ── 3. The running week stays reachable from the board of his week's month ──────────────────────
  {
    // October 2026 opens on a Thursday: its leading week is the week of 26 September, as before.
    assert.equal(leadingFieldWeekOfMonth("2026-10-01"), "2026-09-26");
    assert.equal(boardLeadingWeek("2026-10-01", "2026-10-01"), "2026-09-26", "October's board opens with the week of 26 September");

    // August 2026 opens on a SATURDAY, so it has no leading week — but on Wednesday 29 July his week is
    // 1 August, and the running week of 25 July must still be reachable to ask to edit it.
    assert.equal(weekdayOfIsoDay("2026-08-01"), 6, "1 August 2026 is a Saturday");
    assert.equal(leadingFieldWeekOfMonth("2026-08-01"), null);
    assert.equal(repPlanWeek("2026-07-29"), "2026-08-01");
    assert.equal(boardLeadingWeek("2026-08-01", "2026-07-29"), "2026-07-25", "the running week leads August's board while it has a day ahead");
    assert.ok(!fieldWeeksOfMonth("2026-08-01").includes("2026-07-25"), "it is not one of August's own weeks");
    assert.equal(boardLeadingWeek("2026-08-01", "2026-07-31"), null, "on Friday 31 July it has no day left, so it is not offered");

    // January 2027 opens on a FRIDAY — no field day of its own leads it.
    assert.equal(weekdayOfIsoDay("2027-01-01"), 5, "1 January 2027 is a Friday");
    assert.equal(leadingFieldWeekOfMonth("2027-01-01"), null);
    assert.equal(boardLeadingWeek("2027-01-01", "2026-12-28"), "2026-12-26", "the running week of 26 December leads January's board");

    // Only on the month of HIS week: a reviewer browsing another month gets the leading week or nothing.
    assert.equal(boardLeadingWeek("2026-08-01", "2026-10-01"), null, "August, read in October, has nothing leading it");
  }

  // ── 4. The week the owner moved by hand, the same in TypeScript and SQL ─────────────────────────
  {
    assert.deepEqual(PLAN_WEEK_DUE_OVERRIDES, { "2026-10-03": "2026-10-02" }, "one week only, and it is the Delta re-send");
    assert.equal(weeklyPlanDueOn("2026-10-03"), "2026-10-02", "the week of 3 October is due Friday 2 October");
    assert.equal(weeklyPlanDueOn("2026-10-10"), "2026-10-08", "every other week is due the Thursday before it");
    const migration = readFileSync("supabase/migrations/20261002002251_phoenix_crm_plan_edit_requests.sql", "utf8").replace(/--.*$/gm, "");
    const whens = [...migration.matchAll(/when date '(\d{4}-\d{2}-\d{2})' then date '(\d{4}-\d{2}-\d{2})'/g)].map((match) => [match[1], match[2]]);
    assert.deepEqual(Object.fromEntries(whens), PLAN_WEEK_DUE_OVERRIDES, "phoenix_crm_week_due_on holds exactly the same overrides");
    assert.match(migration, /else p_week_start - 2/, "and the same Thursday-before rule for every other week");
    // The weekly transition reads it, and a re-send after an acknowledged edit keeps its first verdict.
    // 🔴 THE LIVE BODY MOVED ON 2026-10-02, so these two read the LATER migration: the cut-off became an
    // INSTANT (23:55 Cairo), and with `create or replace` only the newest file describes what runs. Left
    // pointing at the older file they would both still pass while pinning a rule the database has not had
    // since — the stale-citation shape, with a green test holding it in place.
    const deadlineMigration = readFileSync(
      "supabase/migrations/20261002122000_phoenix_crm_plan_deadline_2355.sql",
      "utf8",
    ).replace(/--.*$/gm, "");
    assert.match(
      deadlineMigration,
      /due_on = public\.phoenix_crm_week_due_on\(pl\.week_start\),/,
      "the transition stamps the due date from the one function",
    );
    assert.match(
      deadlineMigration,
      /submitted_late = case\s+when exists \(\s+select 1 from public\.phoenix_crm_plan_edit_requests r where r\.plan_id = pl\.id and r\.status = 'reopened'\s+\) then pl\.submitted_late\s+else now\(\) > public\.phoenix_crm_week_deadline_at\(pl\.week_start\)\s+end,/,
      "a week sent again after an agreed edit is never stamped late for it",
    );
  }

  // ── 5. The server refuses every other week ──────────────────────────────────────────────────────
  {
    // Sliced on the section rulers, which are comments — so these three read the file as it is.
    const plans = raw("src/lib/phoenix-crm/server/plans.ts");
    const save = plans.slice(plans.indexOf("export async function savePlan("), plans.indexOf("// ── Sending, reopening and deciding"));
    const assertAt = save.indexOf("await assertRepMayChangeWeek(viewer, seat, isTest, weekStart);");
    assert.ok(assertAt > 0, "a save checks the rep's one week");
    assert.ok(assertAt < save.indexOf('callPhoenixCrm<Row>("phoenix_crm_save_plan"'), "before anything is written");

    const transition = plans.slice(plans.indexOf("export async function transitionPlan("), plans.indexOf("// ── The managers' review list"));
    assert.match(
      transition,
      /if \(action === "reopen"\) \{\s*throw conflictError\("A sent week is no longer taken back\. Open it and press Ask to edit this week\."\);/,
      "a rep's take-back is refused with what to press instead",
    );
    // Handed the plan row the send already read, so the guard does not read it again (2026-10-16).
    assert.match(transition, /await assertRepMayChangeWeek\(viewer, seat, isTest, String\(planRow\.week_start\), planRow\);/, "a send checks the rep's one week too");

    const edits = raw("src/lib/phoenix-crm/server/plan-edits.ts");
    const guard = edits.slice(edits.indexOf("export async function assertRepMayChangeWeek("), edits.indexOf("// ── The rep asks"));
    // ...answering with the days it may change (owner, 2026-10-02: a week returned for ONE day opens
    // that day alone — tests/phoenix-crm-plan-review.test.ts).
    assert.match(guard, /if \(state === "plan"\) \{[\s\S]*?return \{ editableDays: /, "only a week in the 'plan' state passes");
    assert.match(guard, /throw conflictError\(/, "anything else is refused");
    // The server's answer knows the week he is in, so a late send of it passes the same guard (2026-10-02).
    const stateOfRep = edits.slice(edits.indexOf("export function repStateOf("), edits.indexOf("export async function assertRepMayChangeWeek("));
    assert.match(stateOfRep, /runningWeek: fieldWeekStart\(input\.cairoToday\),/, "repStateOf passes the running week from today");

    const monthly = raw("src/lib/phoenix-crm/server/monthly-plans.ts");
    assert.match(monthly, /const monthStart = resolveMonth\(raw\.month, months, monthStartOf\(repPlanWeek\(today\)\)\);/, "the board opens on the month of his week");
    const monthSend = monthly.slice(monthly.indexOf("export async function transitionMonthlyPlanAsRep("), monthly.indexOf("// ── Approve / return"));
    assert.match(monthSend, /throw conflictError\("Plans are sent one week at a time now\./, "a rep's month send or take-back is refused");
    assert.doesNotMatch(monthSend, /phoenix_crm_monthly_plan_transition|phoenix_crm_open_monthly_plan/, "and nothing is written for it");
    for (const flag of ["canEdit: false,", "canSubmit: false,", "canReopen: false,"]) {
      assert.ok(monthly.includes(flag), `the month's own ${flag.split(":")[0]} is off`);
    }
    assert.match(monthly, /canAskToEdit: repState === "sent" && weekPlan !== null,/, "a sent week offers Ask to edit, and only a sent one");
  }

  // ── 6. The rep's own board: one path ───────────────────────────────────────────────────────────
  {
    const board = source("src/components/phoenix-crm/plan-board.tsx");
    assert.match(board, /const repBoard = Boolean\(view\?\.viewerIsRep\) && !onBack;/, "the rep's plan is the one opened from his Plan tab");
    assert.match(board, /\{repBoard \? \([\s\S]*?\) : \(\s*<CrmBlock title="Month">/, "the month chooser is a reviewer's only");
    assert.match(board, /const closed = repBoard && state\.week\.repState === "closed";/, "every week that is not his is greyed");
    assert.match(board, /disabled: closed,/, "greyed means it cannot be pressed");
    assert.match(
      board,
      /\? "Not open yet"\s*: state\.week\.status && state\.week\.status !== "draft"\s*\? state\.week\.statusLabel\s*: "Closed"/,
      "a greyed week behind his reads what was sent, or Closed — never Not started, which invites a tap",
    );
    // Owner, 2026-10-02: "Week 1 · Not started · Sat 3 Oct – Thu 8 Oct … not Fri 2 Oct". A week's button
    // shows its own days under its status; the due date lives in the week's panel only.
    assert.match(
      board,
      /<span className="block">\{status\}<\/span>\s*<span className="block">\{weekLabel\(state\.week\.weekStart\)\}<\/span>/,
      "a week's button shows its status, then its own days",
    );
    assert.doesNotMatch(board, /`due \$\{dayLabel\(state\.week\.dueOn\)\}`/, "the due date is not on the week's button");
    assert.match(board, /view\.weeks\.find\(\(week\) => week\.weekStart === view\.repWeek\)/, "it opens on his week");
    assert.match(
      board,
      /view\.weeks\.find\(\(week\) => week\.repState === "plan" && week\.overdue\) \?\? view\.weeks\.find\(\(week\) => week\.weekStart === view\.repWeek\)/,
      "unless a week he may still send is overdue — the week he is in, never sent — which opens first",
    );
    assert.doesNotMatch(board, /crmPost<[^>]*>\(\s*"\/api\/phoenix-crm\/monthly-plans"/, "it never posts a month send");
    assert.doesNotMatch(board, /action: "reopen"/, "and never takes a week back");
    assert.match(board, /"\/api\/phoenix-crm\/plans\/edit-requests"/, "a sent week is asked about instead");
    // "+ Make weekly plan" lets go of the month and the week on screen, so the default — his week — opens.
    assert.match(board, /if \(weekNonce > 0\) \{\s*setMonth\(null\);\s*setWeekStart\(null\);/, "+ Make weekly plan goes to his week");
    // Suggestions spread a customer over the month's weeks, not over the one week he can change.
    assert.match(
      board,
      /weeksLeft: Math\.max\(1, ownWeeks\.filter\(\(state\) => state\.week\.weekStart >= selected\.week\.weekStart\)\.length\)/,
      "Suggest the week never crams a month's frequency into one week",
    );

    const weekPanel = source("src/components/phoenix-crm/plan-week-panel.tsx");
    assert.doesNotMatch(weekPanel, /Take this week back|Take it back/, "the rep's take-back is gone");
    assert.match(weekPanel, /Ask to edit this week/, "Ask to edit this week is in its place");
    assert.match(weekPanel, /changing it needs your manager and SFE/, "and the Send confirmation says so before he sends");
    assert.match(
      weekPanel,
      /\{week\.weekStart <= today \? " Your visits count as planned from the moment you send it\." : null\}/,
      "a late week he is already in says when its visits start counting as planned",
    );
  }

  console.log("phoenix-crm weekly-only plan: OK");
}
