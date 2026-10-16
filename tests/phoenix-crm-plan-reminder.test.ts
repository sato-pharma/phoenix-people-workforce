import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { phoenixCrmChannels } from "../src/lib/notifications/phoenix-crm-channel-guard.ts";
import { JOB_SCHEDULES } from "../src/lib/observability/job-schedule.ts";
import { resolvePlanItems, type PlanRuleCustomer } from "../src/lib/phoenix-crm/plan-rules.ts";
import {
  isUnsentStatus,
  managerReminder,
  PLAN_REMINDER_CRON,
  PLAN_REMINDER_JOB_SLUG,
  PLAN_REMINDER_MAX_NAMES,
  planReminderDay,
  reminderTickOf,
  repReminder,
  territoriesOfStartedTeams,
} from "../src/lib/phoenix-crm/plan-reminder-rules.ts";
import { firstDayToPlan, weekProblems, type DraftWeek } from "../src/lib/phoenix-crm/plan-week-draft.ts";
import { buildOrgIndex, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";

/**
 * Owner, 2026-10-02 — two things the coming week needed on the day it was due:
 *
 *   1. THE REMINDER. The new plan went live at 01:55 Cairo; by 11:20 none of the 13 Delta (1) reps had
 *      sent the week of 3 October, due that night. "Your coming week is not sent" goes to the rep and
 *      to his district manager, in-app, by Telegram and to the phone, never by email — and only in the
 *      teams that have started (his choice), the 06:55 digest's own rule.
 *   2. THE HOLIDAY. Thursday 8 October (Armed Forces Day, the day off he moved from the 6th) could be
 *      planned like any working day: Suggest filled it, and a rep put two customers on it. A public
 *      holiday now holds nothing, is greyed as a day off, and a save naming it is refused.
 */

const source = (path: string) => stripComments(readFileSync(path, "utf8"));

function seat(overrides: Partial<OrgSeat> & Pick<OrgSeat, "seatId" | "tier" | "path">): OrgSeat {
  return {
    parentSeatId: null,
    occupantHrId: null,
    lineCode: "pedia",
    lineName: "Pedia",
    areaName: "Area",
    regionName: "Delta (1)",
    seatLabel: overrides.tier,
    ...overrides,
  };
}

export function runPhoenixCrmPlanReminderTests() {
  // ── When it speaks ─────────────────────────────────────────────────────────────────────────────
  {
    // The week of 3 October was due on FRIDAY 2 October by his own ruling, so Thursday the 1st is quiet.
    assert.equal(planReminderDay("2026-10-01"), null, "Thursday 1 Oct: the week of 3 Oct is not due until Friday");
    assert.deepEqual(planReminderDay("2026-10-02"), { weekStart: "2026-10-03", dueOn: "2026-10-02", late: false }, "Friday 2 Oct: due tonight");
    assert.equal(planReminderDay("2026-10-03"), null, "Saturday: the week has started, and the next one is not due yet");
    assert.equal(planReminderDay("2026-10-07"), null, "Wednesday: nothing is due");
    // An ordinary week is due on the Thursday before it.
    assert.deepEqual(planReminderDay("2026-10-08"), { weekStart: "2026-10-10", dueOn: "2026-10-08", late: false }, "Thursday 8 Oct: due tonight");
    assert.deepEqual(planReminderDay("2026-10-09"), { weekStart: "2026-10-10", dueOn: "2026-10-08", late: true }, "Friday 9 Oct: late, still accepted");
    // Every day of a year: it speaks on two days a week at most, always before the week starts.
    let days = 0;
    for (let index = 0; index < 366; index += 1) {
      const date = new Date(Date.UTC(2027, 0, 1 + index)).toISOString().slice(0, 10);
      const day = planReminderDay(date);
      if (!day) continue;
      days += 1;
      assert.ok(date >= day.dueOn && date < day.weekStart, `${date} speaks only between the due day and the week`);
    }
    assert.ok(days >= 100 && days <= 106, `two reminder days a week over 2027, got ${days}`);
  }

  // ── What counts as not sent ─────────────────────────────────────────────────────────────────────
  {
    for (const status of [undefined, null, "", "draft", "returned"]) assert.equal(isUnsentStatus(status), true, `${String(status)} is not sent`);
    for (const status of ["submitted", "approved"]) assert.equal(isUnsentStatus(status), false, `${status} has gone for review`);
  }

  // ── The words, and the keys that stop a second send ─────────────────────────────────────────────
  {
    const due = { weekStart: "2026-10-03", dueOn: "2026-10-02", late: false };
    const rep = repReminder({ hrId: "PD-0013", day: due, cairoToday: "2026-10-02", tick: "noon", draftStarted: false });
    // 🔴 The deadline LEADS the title, because a phone shows the heading and cuts it (owner, 2026-10-02).
    assert.equal(rep.title, "Due tonight, 11:55 PM — your week of Saturday 3 Oct");
    assert.ok(rep.message.startsWith("Your plan is not sent yet."), rep.message);
    assert.ok(!rep.message.startsWith("It "), "the body carries its own subject now the title is the deadline");
    assert.equal(rep.idempotencyKey, "phoenix_crm:plan_reminder:rep:PD-0013:2026-10-03:2026-10-02:noon", "one per rep per week per Cairo day per tick");
    // 🔴 "Yes, remind again" (owner, 2026-10-02): the 17:57 tick tells whoever is STILL not sent, in its own words.
    const evening = repReminder({ hrId: "PD-0013", day: due, cairoToday: "2026-10-02", tick: "evening", draftStarted: false });
    assert.equal(evening.title, rep.title, "the deadline still leads the heading at 17:57");
    assert.ok(evening.message.startsWith("Your plan is still not sent."), evening.message);
    assert.notEqual(evening.idempotencyKey, rep.idempotencyKey, "the evening tick is its own send, so a rep still not sent hears it");
    assert.equal(reminderTickOf(12), "noon");
    assert.equal(reminderTickOf(17), "evening");
    const late = repReminder({ hrId: "PD-0013", day: { ...due, late: true }, cairoToday: "2026-10-03", tick: "noon", draftStarted: true });
    assert.equal(late.title, "Was due Friday 2 Oct, 11:55 PM — your week of Saturday 3 Oct", "the day it was due, with its hour");
    assert.ok(late.message.includes("A late week is still accepted."), "late is accepted and says so — never refused");
    assert.ok(late.message.includes("press Send"), late.message);
    assert.notEqual(late.idempotencyKey, rep.idempotencyKey, "a new day is a new key");

    assert.equal(managerReminder({ hrId: "D-1", day: due, cairoToday: "2026-10-02", tick: "noon", repNames: [] }), null, "a manager whose team has all sent hears nothing");
    const one = managerReminder({ hrId: "D-1", day: due, cairoToday: "2026-10-02", tick: "noon", repNames: ["Ebtissam Alaa ElDin Anwar"] });
    // 🔴 His title leads with the deadline as well (owner, 2026-10-02) — same phone, same cut heading —
    // and the evening tick's "still" rides INSIDE it rather than replacing it.
    assert.equal(one?.title, "Due tonight, 11:55 PM — 1 of your reps has not sent the week of Saturday 3 Oct");
    assert.equal(one?.message, "Not sent yet: Ebtissam Alaa ElDin Anwar.", "the names carry the body on their own");
    const stillOne = managerReminder({ hrId: "D-1", day: due, cairoToday: "2026-10-02", tick: "evening", repNames: ["Ebtissam Alaa ElDin Anwar"] });
    assert.equal(stillOne?.title, "Due tonight, 11:55 PM — 1 of your reps still has not sent the week of Saturday 3 Oct");
    const many = managerReminder({
      hrId: "D-1",
      day: due,
      cairoToday: "2026-10-02",
      tick: "noon",
      repNames: Array.from({ length: PLAN_REMINDER_MAX_NAMES + 3 }, (_, index) => `Rep ${String(index).padStart(2, "0")}`),
    });
    assert.ok(many?.message.endsWith(", and 3 more."), "past the limit it counts the rest");
    assert.equal(many?.idempotencyKey, "phoenix_crm:plan_reminder:dm:D-1:2026-10-03:2026-10-02:noon");
  }

  // ── 🔴 Teams that started, and only those (owner, 2026-10-02) ─────────────────────────────────────
  {
    const org = buildOrgIndex([
      seat({ seatId: "CEO", tier: "CEO", path: ["CEO"], occupantHrId: "B-2" }),
      seat({ seatId: "DM-A", tier: "DM", parentSeatId: "CEO", path: ["CEO", "DM-A"], occupantHrId: "D-A" }),
      seat({ seatId: "DM-B", tier: "DM", parentSeatId: "CEO", path: ["CEO", "DM-B"], occupantHrId: "D-B" }),
      seat({ seatId: "A1", tier: "REP", parentSeatId: "DM-A", path: ["CEO", "DM-A", "A1"], occupantHrId: "R-A1" }),
      seat({ seatId: "A2", tier: "REP", parentSeatId: "DM-A", path: ["CEO", "DM-A", "A2"], occupantHrId: "R-A2" }),
      seat({ seatId: "B1", tier: "REP", parentSeatId: "DM-B", path: ["CEO", "DM-B", "B1"], occupantHrId: "R-B1" }),
    ]);
    const territories = org.territories;
    const chosen = territoriesOfStartedTeams(org, territories, new Set(["A1"])).map((entry) => entry.seatId).sort();
    assert.deepEqual(chosen, ["A1", "A2"], "A2 has not started on his own, but his team has — he is reminded too");
    assert.deepEqual(territoriesOfStartedTeams(org, territories, new Set()), [], "nobody has started: nobody is told");
  }

  // ── 🔴 Email since 2026-10-08, the phone and Telegram ──────────────────────────────────────────────────────
  {
    assert.deepEqual(phoenixCrmChannels("plan_reminder"), ["in_app", "telegram", "push"], "no email (owner, 2026-10-13, reversing 2026-10-08)");
    const runner = source("src/lib/phoenix-crm/server/plan-reminder.ts");
    assert.ok(runner.includes('channels: phoenixCrmChannels("plan_reminder"),'), "the runner asks the guard for its channels, and names none itself");
    assert.equal(/"email"/.test(runner), false, "and never names email");
    assert.ok(runner.includes("module: PHOENIX_CRM_NOTIFICATION_MODULE"), "under the module key the email guard filters on");
    assert.ok(runner.includes('.eq("is_test", false)'), "real plans only — the test world has no reminder");
    assert.ok(runner.includes("seatsWithRealActivity("), "a team starts the way the 06:55 digest says a territory starts");
    assert.ok(runner.includes("territoriesOfStartedTeams(org, staffed, started)"), "and the whole team follows its first rep");
    assert.ok(runner.includes("seat.occupantHrId))"), "a vacant territory has nobody to remind and is never raised");
  }

  // ── The module's scheduled senders deliver several people at once (Phoenix CRM performance audit, 2026-10-16) ──
  //
  // One person at a time made a run as slow as its slowest Telegram round trip times the people on
  // it. Four at once keeps three things exactly as they were: every send is counted once, delivered
  // or failed; one failure never costs anybody else; and one person's own notices still go in their
  // order (a rep who also reviews another territory gets two reminders, and they must not swap).
  {
    for (const [path, item] of [
      ["src/lib/phoenix-crm/server/plan-reminder.ts", "notice"],
      ["src/lib/phoenix-crm/server/daily-digest.ts", "digest"],
      ["src/lib/phoenix-crm/server/approval-nudge.ts", "notice"],
      ["src/lib/phoenix-crm/server/visit-rollup.ts", "rollup"],
    ] as const) {
      const sender = source(path);
      assert.ok(sender.includes("const DELIVERIES_AT_ONCE = 4;"), `${path}: four people at once`);
      assert.match(
        sender,
        new RegExp(
          `await mapWithConcurrency\\(\\[\\.\\.\\.perPerson\\.values\\(\\)\\], DELIVERIES_AT_ONCE, async \\(theirs\\) => \\{\\s*for \\(const ${item} of theirs\\) \\{\\s*try \\{\\s*await send\\(${item}\\);\\s*delivered \\+= 1;\\s*\\} catch \\(error\\) \\{\\s*failed \\+= 1;`,
        ),
        `${path}: grouped per person, one person's notices in order, each in its own try and counted once`,
      );
      assert.match(sender, new RegExp(`perPerson\\.set\\(${item}\\.hrId, `), `${path}: grouped by the person it is addressed to`);
    }
    // The weekly scan is one entry per person by construction (a map keyed on the HR id), so it needs no
    // grouping — and it still starts them in the same sorted order.
    const scan = source("src/lib/phoenix-crm/server/fraud-scan.ts");
    assert.match(scan, /const recipients = \[\.\.\.tierByHrId\]\.sort\(\(left, right\) => left\[0\]\.localeCompare\(right\[0\]\)\);/);
    assert.match(scan, /await mapWithConcurrency\(recipients, DELIVERIES_AT_ONCE, async \(\[hrId, tier\]\) => \{\s*try \{/);

    // The reminder's two gates do not wait for each other, and the live-team gate still filters.
    const reminder = source("src/lib/phoenix-crm/server/plan-reminder.ts");
    assert.match(
      reminder,
      /const \[started, live\] = await Promise\.all\(\[seatsWithRealActivity\(staffed\.map\(\(seat\) => seat\.seatId\)\), loadLiveTeamSeatIds\(cairoToday\)\]\);/,
      "who has started and which teams are live are asked at once",
    );
  }

  // ── The job is declared, scheduled and registered in one sitting ────────────────────────────────
  {
    const declared = JOB_SCHEDULES.find((entry) => entry.slug === PLAN_REMINDER_JOB_SLUG);
    assert.equal(declared?.schedule, PLAN_REMINDER_CRON, "the heartbeat expects the ticks cron-job.org fires");
    assert.equal(declared?.watchingSince, undefined, "a new job is never given a restore floor");
    const sync = readFileSync("scripts/cronjob-sync.mjs", "utf8");
    assert.match(sync, /"phoenix-crm-plan-reminder": \{[\s\S]*?path: "\/api\/cron\/phoenix-crm-plan-reminder"[\s\S]*?hours: \[12, 17\], minutes: \[57\]/);
    const route = source("app/api/cron/phoenix-crm-plan-reminder/route.ts");
    assert.ok(route.includes('assertCronAuthorized(request, "cron/phoenix-crm-plan-reminder")'), "behind CRON_SECRET");
    assert.ok(route.includes("withDeadMansSwitch(PLAN_REMINDER_JOB_SLUG"), "and it reports its own heartbeat");
    assert.ok(readFileSync("src/lib/security/access-registry.ts", "utf8").includes('pattern: "/api/cron/phoenix-crm-plan-reminder"'));
    assert.ok(readFileSync("docs/observability.md", "utf8").includes("| `phoenix-crm-plan-reminder` | `57 12,17 * * *` |"));
  }

  // ── 🔴 A public holiday holds nothing (owner, 2026-10-02) ─────────────────────────────────────────
  {
    const customer: PlanRuleCustomer = { customerId: "C-1", name: "Dr Hany", listType: "AM", pending: true, places: [] };
    const refused = resolvePlanItems({
      weekStart: "2026-10-03",
      items: [{ customerId: "C-1", placeId: null, planDate: "2026-10-08", exceptionType: null, exceptionNote: null }],
      customers: new Map([["C-1", customer]]),
      settings: { amDailyCap: 5, pmDailyCap: 15, sharedPlaceDailyCap: 3 },
      isRamadan: () => false,
      holidays: new Map([["2026-10-08", "Armed Forces Day"]]),
    });
    assert.equal(refused.ok, false, "a save naming the holiday is refused");
    assert.ok(!refused.ok && refused.error.includes("public holiday (Armed Forces Day)"), "and the refusal names it");
    const allowed = resolvePlanItems({
      weekStart: "2026-10-03",
      items: [{ customerId: "C-1", placeId: null, planDate: "2026-10-06", exceptionType: null, exceptionNote: null }],
      customers: new Map([["C-1", customer]]),
      settings: { amDailyCap: 5, pmDailyCap: 15, sharedPlaceDailyCap: 3 },
      isRamadan: () => false,
      holidays: new Map([["2026-10-08", "Armed Forces Day"]]),
    });
    assert.equal(allowed.ok, true, "6 October is a working day — the day off was moved to the 8th");

    const day = (date: string, holiday: string | null, items: DraftWeek["days"][number]["items"] = []) => ({
      date,
      listTypes: holiday ? [] : (["AM", "PM"] as const),
      holiday,
      ramadan: false,
      editable: true,
      activities: [],
      starts: { startAmMinute: null, startPmMinute: null },
      items,
    });
    const week: DraftWeek = { weekStart: "2026-10-03", plan: null, days: [day("2026-10-03", "Some Holiday"), day("2026-10-04", null)] };
    assert.equal(firstDayToPlan(week.days)?.date, "2026-10-04", "the board never opens on a holiday");
    const held: DraftWeek = {
      weekStart: "2026-10-03",
      plan: null,
      days: [day("2026-10-08", "Armed Forces Day", [{ customerId: "C-1", placeId: null, listType: "AM", name: "Dr Hany", exceptionType: null, exceptionNote: null }])],
    };
    const problems = weekProblems(
      held,
      [{ customerId: "C-1", placeId: null, planDate: "2026-10-08", exceptionType: null, exceptionNote: null }],
      new Map([["C-1", { customerId: "C-1", name: "Dr Hany", listType: "AM", grade: null, speciality: null, visitsThisMonth: 0, pending: true, reference: null, places: [] }]]),
      { amDailyCap: 5, pmDailyCap: 15 },
    );
    assert.deepEqual(problems.map((problem) => problem.kind), ["holiday"], "a customer left on a holiday is named as a holiday, not as a Thursday morning");

    const plans = source("src/lib/phoenix-crm/server/plans.ts");
    // One day-off path since the same day: a holiday, or the rep's own approved leave (phoenix-crm-plan-screen-extras).
    assert.ok(plans.includes("const dayOff = planDayOff(date, input.holidays, input.leave);"), "a holiday is a day off");
    assert.ok(plans.includes("listTypes: dayOff ? [] : planDayListTypes(date),"), "a holiday holds no list, as a Friday — so Suggest and every copy skip it");
    assert.ok(plans.includes("loadPlanHolidays(weekStart, addDaysIso(weekStart, 5)),"), "the week planner and the save both read the week's holidays");
    assert.equal((plans.match(/\bholidays,\n/g) ?? []).length >= 2, true, "and hand them to the day builder and the save check");
    const month = source("src/lib/phoenix-crm/server/monthly-plans.ts");
    assert.ok(month.includes("loadPlanHolidays(addDaysIso(monthStart, -14), addDaysIso(monthEndOf(monthStart), 14)),"), "the month board reads them in its first wave");
    assert.ok(month.includes("isRamadan, activities, starts, holidays, leave, pendingLeave });"), "and every week of it is built with them");
    const holidaysReader = source("src/lib/phoenix-crm/server/plan-holidays.ts");
    assert.ok(holidaysReader.includes("getConfirmedNationalHolidays(period)"), "the company's confirmed calendar — the 6 → 8 October move included");
    assert.ok(holidaysReader.includes(".catch("), "and a calendar that cannot be read leaves the day plannable, never breaks the board");
    const panel = source("src/components/phoenix-crm/plan-week-panel.tsx");
    assert.ok(panel.includes("const off = dayOffOf(day);") && panel.includes("`Day off · ${off.name}`,"), "the day picker names the holiday");
    assert.ok(panel.includes("disabled: counts.AM + counts.PM === 0,"), "and greys it, unless something is still on it to take off");
    const board = source("src/components/phoenix-crm/plan-board.tsx");
    assert.ok(board.includes(".find((entry) => entry.listTypes.length > 0)"), "\"Next day\" steps over a holiday");
  }
}
