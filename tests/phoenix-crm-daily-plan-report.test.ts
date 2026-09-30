import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { addDaysIso } from "../src/lib/crm/dates.ts";
import { fieldWeekStart } from "../src/lib/phoenix-crm/calendar.ts";
import {
  buildDailyPlanDays,
  cairoMinuteOfInstant,
  DAILY_PLAN_PRESETS,
  dailyPlanCustomerNotes,
  dailyPlanDates,
  dailyPlanDayIsEmpty,
  dailyPlanPeriodProblem,
  dailyPlanPresetPeriod,
  dailyPlanState,
  dailyPlanStateLabel,
  dailyPlanVisitStatus,
  dailyPlanVisitText,
  lastPlannableDay,
  resolveDailyPlanPeriod,
  statusAtDayEnd,
  type DailyPlanSourceItem,
  type DailyPlanSourcePlan,
  type DailyPlanSourceVisit,
} from "../src/lib/phoenix-crm/daily-plan-report.ts";
import { resolveReportPeriod } from "../src/lib/phoenix-crm/report-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the daily plan report (owner, 2026-09-30: "build the daily plan report").
 *
 * iReports360's Daily Plan rebuilt from Phoenix CRM's own plans: one territory, day by day, the day's
 * start times and other activities, then the AM and the PM customers with where each one is and
 * whether he was seen. Four things about it would be wrong without anybody noticing, and each is
 * pinned here:
 *
 *   1. **It reaches forward.** Every other report section brings a last day after today back to today;
 *      a plan's whole point is the days ahead, so this one runs to the last day a rep can plan. Every
 *      quick pick is readable on every day of 2026–2027.
 *   2. **A day that has passed reads as its plan stood when the day ENDED** — the same test plan
 *      against actual applies in the database (`sent_days`: the last status before the next Cairo
 *      midnight). A plan reopened afterwards must not turn a sent Monday into "Draft", or the two
 *      sections disagree about whether that Monday was planned at all.
 *   3. **The visit day ends at 02:00.** Until then yesterday is still running, so a customer planned
 *      for it is "not yet", never "not visited".
 *   4. **Real and test entries never cross.** A test visit never marks a real plan's customer seen,
 *      and a test plan is listed after the real one, never merged into it.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

// Wednesday 30 September 2026. The field week runs Saturday 26 September to Thursday 1 October.
const TODAY = "2026-09-30";

function item(patch: Partial<DailyPlanSourceItem> & Pick<DailyPlanSourceItem, "planId" | "date" | "customerId" | "listType">): DailyPlanSourceItem {
  return {
    name: `Customer ${patch.customerId}`,
    grade: "A",
    speciality: "Paediatrics",
    pending: false,
    stale: false,
    placeLabel: null,
    brick: "Shebin 3",
    area: "Menoufia 2",
    address: "12 Gamal Abdel Nasser St",
    hoursText: "6:00 PM – 8:00 PM",
    exceptionLabel: null,
    exceptionNote: null,
    ...patch,
  };
}

function visit(patch: Partial<DailyPlanSourceVisit> & Pick<DailyPlanSourceVisit, "date" | "customerId" | "capturedAt">): DailyPlanSourceVisit {
  return { isTest: false, offPlan: null, ...patch };
}

export function runPhoenixCrmDailyPlanReportTests(): void {
  // ── 1. The days: forward to the last plannable day, never past it, at most a month ─────────────
  {
    // Next month's last field week starts Saturday 31 October, so its Thursday is 5 November.
    assert.equal(lastPlannableDay(TODAY), "2026-11-05", "a plan reaches the Thursday of next month's last field week");

    const blank = resolveDailyPlanPeriod({ from: "", to: null, cairoToday: TODAY });
    assert.deepEqual(blank, { ok: true, value: { from: "2026-09-26", to: "2026-10-01" } }, "blank reads this field week, Saturday to Thursday — the days ahead included");

    const ahead = resolveDailyPlanPeriod({ from: "2026-10-03", to: "2026-10-08", cairoToday: TODAY });
    assert.deepEqual(ahead, { ok: true, value: { from: "2026-10-03", to: "2026-10-08" } }, "next week is readable: the days ahead are what a plan is for");
    // …which is exactly what the other sections refuse, and why this report has a rule of its own.
    const shared = resolveReportPeriod({ from: "2026-10-03", to: "2026-10-08", cairoToday: TODAY });
    assert.equal(shared.ok, false, "the shared period brings next week's last day back to today, behind its first day — this report cannot use it");

    const clamped = resolveDailyPlanPeriod({ from: "2026-11-01", to: "2026-11-20", cairoToday: TODAY });
    assert.deepEqual(clamped, { ok: true, value: { from: "2026-11-01", to: "2026-11-05" } }, "a last day past the horizon is brought back to it, as the others bring theirs back to today");

    const tooFar = resolveDailyPlanPeriod({ from: "2026-11-06", to: "2026-11-10", cairoToday: TODAY });
    assert.equal(tooFar.ok, false, "a first day past the last plannable day reads nothing");
    assert.match(tooFar.ok ? "" : tooFar.error, /No plan reaches that far ahead/);

    const long = resolveDailyPlanPeriod({ from: "2026-09-01", to: "2026-10-05", cairoToday: TODAY });
    assert.equal(long.ok, false, "at most a month, like every other section");
    assert.match(long.ok ? "" : long.error, /at most 31 days/);

    assert.equal(resolveDailyPlanPeriod({ from: "2026-10-05", to: "2026-10-01", cairoToday: TODAY }).ok, false, "the first day after the last is refused");
    assert.equal(resolveDailyPlanPeriod({ from: "2026-02-30", to: "", cairoToday: TODAY }).ok, false, "an impossible day is refused");

    // A Friday belongs to the week before it — so a period starting on one closes on the NEXT Thursday.
    assert.deepEqual(resolveDailyPlanPeriod({ from: "2026-10-02", to: "", cairoToday: TODAY }), { ok: true, value: { from: "2026-10-02", to: "2026-10-08" } });

    // The screen's twin refuses what the server would quietly shorten, so the screen never shows more days than it reads.
    assert.match(dailyPlanPeriodProblem({ from: "2026-11-01", to: "2026-11-20" }, TODAY) ?? "", /No plan reaches that far ahead/);
    assert.equal(dailyPlanPeriodProblem({ from: "2026-10-03", to: "2026-10-08" }, TODAY), null);
    assert.equal(dailyPlanPeriodProblem({ from: "2026-10-05", to: "2026-10-01" }, TODAY), "The first day is after the last day.");
  }

  // ── 2. The quick picks: three days, then three whole weeks, readable on every day ──────────────
  {
    assert.deepEqual(
      DAILY_PLAN_PRESETS.map((preset) => preset.value),
      ["yesterday", "today", "tomorrow", "last_week", "this_week", "next_week"],
      "the days, then the weeks, each left to right in time",
    );
    assert.deepEqual(dailyPlanPresetPeriod("yesterday", TODAY), { from: "2026-09-29", to: "2026-09-29" });
    assert.deepEqual(dailyPlanPresetPeriod("today", TODAY), { from: TODAY, to: TODAY });
    assert.deepEqual(dailyPlanPresetPeriod("tomorrow", TODAY), { from: "2026-10-01", to: "2026-10-01" });
    assert.deepEqual(dailyPlanPresetPeriod("this_week", TODAY), { from: "2026-09-26", to: "2026-10-01" }, "this week is the WHOLE week, Thursday included, where the other sections stop at today");
    assert.deepEqual(dailyPlanPresetPeriod("next_week", TODAY), { from: "2026-10-03", to: "2026-10-08" });
    assert.deepEqual(dailyPlanPresetPeriod("last_week", TODAY), { from: "2026-09-19", to: "2026-09-24" });
    // On a Friday the week is the one just finished, as everywhere in the module.
    assert.deepEqual(dailyPlanPresetPeriod("this_week", "2026-10-02"), { from: "2026-09-26", to: "2026-10-01" });
    assert.deepEqual(dailyPlanPresetPeriod("next_week", "2026-10-02"), { from: "2026-10-03", to: "2026-10-08" });

    let checked = 0;
    for (let day = "2026-01-01"; day <= "2027-12-31"; day = addDaysIso(day, 1)) {
      for (const { value } of DAILY_PLAN_PRESETS) {
        const period = dailyPlanPresetPeriod(value, day);
        assert.equal(dailyPlanPeriodProblem(period, day), null, `${value} on ${day} must be readable: ${period.from} to ${period.to}`);
        const resolved = resolveDailyPlanPeriod({ from: period.from, to: period.to, cairoToday: day });
        assert.deepEqual(resolved, { ok: true, value: period }, `${value} on ${day} reads exactly the days it shows`);
        checked += 1;
      }
    }
    assert.ok(checked > 4000, `swept every quick pick on every day of two years — only ${checked}`);
  }

  // ── 3. Friday holds no plan and is left out ─────────────────────────────────────────────────────
  {
    assert.deepEqual(
      dailyPlanDates({ from: "2026-09-30", to: "2026-10-03" }),
      ["2026-09-30", "2026-10-01", "2026-10-03"],
      "Wednesday, Thursday, then Saturday — never Friday",
    );
    assert.deepEqual(dailyPlanDates({ from: "2026-10-02", to: "2026-10-02" }), [], "a Friday alone is no day at all");
  }

  // ── 4. A day that has passed reads as its plan stood when the day ENDED ────────────────────────
  //
  // Cairo is UTC+3 in September 2026, so 28 September ends at 2026-09-28T21:00:00Z — exactly where
  // the database's `(plan_date + 1)::timestamp at time zone 'Africa/Cairo'` puts it.
  {
    const events = [
      { at: "2026-09-27T07:00:00.000000+00:00", toStatus: "draft" as const },
      { at: "2026-09-28T21:00:00+00:00", toStatus: "submitted" as const },
    ];
    assert.equal(statusAtDayEnd(events, "2026-09-28"), "draft", "sent at Cairo midnight is sent the NEXT day, never the day that just ended");
    assert.equal(statusAtDayEnd(events, "2026-09-29"), "submitted");
    assert.equal(statusAtDayEnd(events, "2026-09-26"), null, "nothing recorded by then is nothing");
    assert.equal(
      statusAtDayEnd([{ at: "2026-09-28T20:59:59Z", toStatus: "submitted" }], "2026-09-28"),
      "submitted",
      "a second before Cairo midnight still counts for the day",
    );
    // Winter: Cairo is UTC+2, so 10 December ends at 22:00 UTC.
    assert.equal(statusAtDayEnd([{ at: "2026-12-10T21:30:00Z", toStatus: "approved" }], "2026-12-10"), "approved");
    assert.equal(statusAtDayEnd([{ at: "2026-12-10T22:00:00Z", toStatus: "approved" }], "2026-12-10"), null);
    // Out of order in, read in time order; a tie keeps the order it came in (the database breaks it on the id).
    assert.equal(
      statusAtDayEnd(
        [
          { at: "2026-09-29T10:00:00Z", toStatus: "approved" },
          { at: "2026-09-29T08:00:00Z", toStatus: "submitted" },
        ],
        "2026-09-29",
      ),
      "approved",
    );
    assert.equal(
      statusAtDayEnd(
        [
          { at: "2026-09-29T10:00:00Z", toStatus: "submitted" },
          { at: "2026-09-29T10:00:00Z", toStatus: "draft" },
        ],
        "2026-09-29",
      ),
      "draft",
      "two events at one instant: the later one in the database's order wins",
    );

    // 🔴 The rule the section exists for: a plan REOPENED since (its status is draft NOW) does not
    // rewrite a Monday it had already been sent for.
    assert.equal(
      dailyPlanState({ date: "2026-09-28", cairoToday: TODAY, current: "draft", statusAtEnd: "submitted" }),
      "submitted",
      "a plan reopened since does not rewrite a day it had been sent for",
    );
    assert.equal(dailyPlanState({ date: "2026-09-28", cairoToday: TODAY, current: "approved", statusAtEnd: "draft" }), "not_sent", "approved later is not sent before the day");
    assert.equal(dailyPlanState({ date: "2026-09-28", cairoToday: TODAY, current: "approved", statusAtEnd: null }), "not_sent");
    assert.equal(dailyPlanState({ date: TODAY, cairoToday: TODAY, current: "draft", statusAtEnd: null }), "draft", "today reads the plan as it is now");
    assert.equal(dailyPlanState({ date: "2026-10-03", cairoToday: TODAY, current: "returned", statusAtEnd: null }), "returned");
    assert.equal(dailyPlanState({ date: "2026-10-03", cairoToday: TODAY, current: null, statusAtEnd: null }), "none");
    assert.equal(dailyPlanStateLabel("draft"), "Draft · not sent yet", "a draft says so in words");
    assert.equal(dailyPlanStateLabel("not_sent"), "Not sent before the day");
    assert.equal(dailyPlanStateLabel("none"), "No plan");
  }

  // ── 5. The visit day ends at 02:00: yesterday is "not yet" until then ──────────────────────────
  {
    // 01:30 on Thursday 1 October: the calendar says Thursday, the visit day is still Wednesday.
    const visitDay = "2026-09-30";
    assert.equal(dailyPlanVisitStatus({ date: "2026-09-30", visitDay, visited: false }), "not_yet", "the running day is never a miss");
    assert.equal(dailyPlanVisitStatus({ date: "2026-09-29", visitDay, visited: false }), "not_visited");
    assert.equal(dailyPlanVisitStatus({ date: "2026-10-01", visitDay, visited: false }), "ahead");
    assert.equal(dailyPlanVisitStatus({ date: "2026-09-29", visitDay, visited: true }), "visited");
    assert.equal(dailyPlanVisitText("visited", 615), "Visited 10:15 AM");
    assert.equal(dailyPlanVisitText("ahead", null), "Planned");
    assert.equal(cairoMinuteOfInstant("2026-09-28T07:15:00Z"), 615, "10:15 in Cairo, UTC+3 in September");
    assert.equal(cairoMinuteOfInstant("2026-12-10T07:15:00Z"), 555, "09:15 in Cairo, UTC+2 in December");
  }

  // ── 6. Putting a territory's plans together ────────────────────────────────────────────────────
  {
    const real: DailyPlanSourcePlan = {
      planId: "P-REAL",
      weekStart: "2026-09-26",
      isTest: false,
      status: "draft", // reopened on Tuesday, after Monday had been sent
      submittedLate: true,
      events: [
        { at: "2026-09-24T09:00:00Z", toStatus: "draft" },
        { at: "2026-09-25T09:00:00Z", toStatus: "submitted" },
        { at: "2026-09-29T09:00:00Z", toStatus: "draft" },
      ],
    };
    const test: DailyPlanSourcePlan = { planId: "P-TEST", weekStart: "2026-09-26", isTest: true, status: "approved", submittedLate: false, events: [] };
    const items: DailyPlanSourceItem[] = [
      item({ planId: "P-REAL", date: "2026-09-28", customerId: "A", listType: "AM" }),
      item({ planId: "P-REAL", date: "2026-09-28", customerId: "B", listType: "PM" }),
      item({ planId: "P-REAL", date: "2026-09-28", customerId: "C", listType: "PM", pending: true, brick: null, area: null, hoursText: "No days and hours yet" }),
      item({ planId: "P-REAL", date: "2026-10-01", customerId: "D", listType: "AM" }),
      item({ planId: "P-TEST", date: "2026-09-28", customerId: "B", listType: "PM" }),
    ];
    const visits: DailyPlanSourceVisit[] = [
      // A: seen twice, off the plan first — the visit on the plan is the one that answers.
      visit({ date: "2026-09-28", customerId: "A", capturedAt: "2026-09-28T05:00:00Z", offPlan: "waiting" }),
      visit({ date: "2026-09-28", customerId: "A", capturedAt: "2026-09-28T07:15:00Z" }),
      // C: seen only off the plan, and the approval is still waiting.
      visit({ date: "2026-09-28", customerId: "C", capturedAt: "2026-09-28T16:40:00Z", offPlan: "waiting" }),
      // B was seen only in the TEST world: the real plan's B is not visited.
      visit({ date: "2026-09-28", customerId: "B", capturedAt: "2026-09-28T17:00:00Z", isTest: true }),
    ];
    const days = buildDailyPlanDays({
      period: { from: "2026-09-26", to: "2026-10-03" },
      cairoToday: TODAY,
      visitDay: TODAY,
      plans: [test, real],
      items,
      activities: [{ planId: "P-REAL", date: "2026-09-28", activityType: "meeting", label: "Meeting", halfDay: true, note: null }],
      starts: [{ planId: "P-REAL", date: "2026-09-28", starts: { startAmMinute: 660, startPmMinute: 1020 } }],
      visits,
    });

    assert.deepEqual(
      days.map((day) => `${day.date}${day.isTest ? " test" : ""}`),
      [
        "2026-09-26",
        "2026-09-26 test",
        "2026-09-27",
        "2026-09-27 test",
        "2026-09-28",
        "2026-09-28 test",
        "2026-09-29",
        "2026-09-29 test",
        "2026-09-30",
        "2026-09-30 test",
        "2026-10-01",
        "2026-10-01 test",
        "2026-10-03",
      ],
      "every day but Friday; the real plan, then the test one beside it; a week with no plan still listed once",
    );

    const monday = days.find((day) => day.date === "2026-09-28" && !day.isTest);
    assert.ok(monday);
    assert.equal(monday.state, "submitted", "Monday was sent before it ended — reopening on Tuesday does not rewrite it");
    assert.equal(monday.submittedLate, true);
    assert.equal(monday.startsText, "Start AM 11:00 AM · Start PM 5:00 PM");
    assert.deepEqual(monday.activities.map((activity) => activity.label), ["Meeting"]);
    // AM and PM are two lists — the shape carries no total that could add them.
    assert.deepEqual(monday.am.map((customer) => customer.customerId), ["A"]);
    assert.deepEqual(monday.pm.map((customer) => customer.customerId), ["B", "C"]);
    assert.equal("total" in monday, false, "a day carries no combined count");

    const [a] = monday.am;
    assert.equal(a.status, "visited");
    assert.equal(a.visitedMinute, 615, "the visit ON the plan answers, not the earlier one off it");
    assert.equal(a.offPlan, null);
    const [b, c] = monday.pm;
    assert.equal(b.status, "not_visited", "a TEST visit never marks a real plan's customer seen");
    assert.equal(c.status, "visited");
    assert.equal(c.offPlan, "waiting");
    assert.deepEqual(dailyPlanCustomerNotes(c), ["Not validated yet", "Saved off the plan · waiting for approval"]);

    const testMonday = days.find((day) => day.date === "2026-09-28" && day.isTest);
    assert.ok(testMonday);
    assert.equal(testMonday.pm[0]?.status, "visited", "the test plan's own B was seen in the test world");
    assert.equal(testMonday.state, "not_sent", "an approved test plan with no recorded status by Monday's end was not sent before it");

    const wednesday = days.find((day) => day.date === TODAY && !day.isTest);
    assert.ok(wednesday);
    assert.equal(wednesday.state, "draft", "today reads the plan as it is now");
    assert.equal(wednesday.running, true);
    assert.equal(dailyPlanDayIsEmpty(wednesday), true, "a day with nothing on it says so");

    const thursday = days.find((day) => day.date === "2026-10-01" && !day.isTest);
    assert.ok(thursday);
    assert.deepEqual(thursday.listTypes, ["AM"], "a Thursday is a morning");
    assert.equal(thursday.am[0]?.status, "ahead");

    const nextSaturday = days.find((day) => day.date === "2026-10-03");
    assert.ok(nextSaturday);
    assert.equal(nextSaturday.state, "none", "a week with no plan is listed, not dropped");
    assert.equal(nextSaturday.isTest, false);

    // Real entries only: the test plan is simply not handed in, and nothing of it appears.
    const realOnly = buildDailyPlanDays({
      period: { from: "2026-09-28", to: "2026-09-28" },
      cairoToday: TODAY,
      visitDay: TODAY,
      plans: [real],
      items: items.filter((entry) => entry.planId === "P-REAL"),
      activities: [],
      starts: [],
      visits: visits.filter((entry) => !entry.isTest),
    });
    assert.deepEqual(realOnly.map((day) => day.isTest), [false]);
    assert.equal(fieldWeekStart("2026-09-28"), real.weekStart, "the fixture's Monday sits in the plan's week");
  }

  // ── 7. Where it is wired, and what it never reads ──────────────────────────────────────────────
  {
    const loader = source("src/lib/phoenix-crm/server/daily-plan-report.ts");
    assert.match(loader, /viewer\.scopeTerritories/, "the territory comes from the viewer's own scope — downward only");
    assert.match(loader, /forbiddenError\("This territory is outside your scope\."\)/, "and one outside it is refused, never quietly emptied");
    assert.match(loader, /reportIncludesTest\(viewer, raw\.includeTest\)/, "test entries follow the one rule every report uses");
    assert.match(loader, /\bbuildDays\(/, "a week is read through the plan board's own reading, so hours and standing print as the planner shows them");
    // Golden Rule #1: the rep reads his own plan here, so nothing that measures where he stood may reach it.
    for (const withheld of ["distance_meters", "location_flag", "accuracy_meters", "dwell_seconds"]) {
      assert.equal(loader.includes(withheld), false, `the daily plan never reads ${withheld}`);
    }

    const route = source("app/api/phoenix-crm/reports/route.ts");
    assert.match(route, /section === "daily"\) report = await loadDailyPlanReport\(viewer, filters\)/, "the reports endpoint serves the section");

    const tab = source("src/components/phoenix-crm/reports-tab.tsx");
    assert.match(tab, /value: "daily"/, "the Reports tab offers it");
    assert.match(tab, /useCrmGet<DailyPlanReportView>\(sectionUrl\("daily"\)/, "and reads it like every other section");
  }

  console.log("phoenix-crm daily plan report: OK");
}
