import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PLAN_DEADLINE_CAIRO_HOUR,
  PLAN_DEADLINE_CAIRO_MINUTE,
  PLAN_DEADLINE_LABEL,
  planDeadlineAt,
  planDeadlinePassed,
  weeklyPlanDueOn,
} from "../src/lib/phoenix-crm/calendar.ts";
import { planDueLabel, withPlanDeadline } from "../src/lib/phoenix-crm/plan-rules.ts";
import { planReminderDay, repReminder, managerReminder } from "../src/lib/phoenix-crm/plan-reminder-rules.ts";

/**
 * Phoenix CRM — THE PLAN DEADLINE IS 23:55 CAIRO, AND THE REP IS TOLD SO.
 *
 * Owner, 2026-10-02: "the deadline to submit the plan is thuersday 11:5pm and show themn this".
 *
 * Two halves, and the second is the one that was missing. Before this the test was `today > dueOn`, so
 * the cut-off was MIDNIGHT and no screen said so: a rep knew which day his week was due and had to guess
 * the hour of the one thing it is judged on. Now the deadline is an instant, and every place that shows
 * a due date shows the time with it.
 *
 * What must not drift:
 *   1. the hour and the wording live in ONE place each, and the label is what the screens render;
 *   2. SQL and TypeScript resolve the same instant — including 23:55 on the Thursday Egypt leaves DST,
 *      which happens TWICE, where both land on the LATER pass (the forgiving one);
 *   3. the badge flips at 23:55, not at midnight, or the five minutes between them would show a week as
 *      not-yet-overdue while the server stamps that very send late;
 *   4. nothing here refuses a late plan. It is accepted and stamped, always (owner, 2026-09-29).
 */

function migration(): string {
  return readFileSync(
    new URL("../supabase/migrations/20261002122000_phoenix_crm_plan_deadline_2355.sql", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
}

export function runPhoenixCrmPlanDeadlineTests(): void {
  // ── 1. One hour, one wording ─────────────────────────────────────────────────────────────────────
  {
    assert.equal(PLAN_DEADLINE_CAIRO_HOUR, 23, "11 PM");
    assert.equal(PLAN_DEADLINE_CAIRO_MINUTE, 55, "and 55 minutes — five before midnight, his own figure");
    assert.equal(PLAN_DEADLINE_LABEL, "11:55 PM", "written the way he wrote it, not 23:55");

    // The label a rep reads carries BOTH halves. This is the whole of "show themn this".
    assert.equal(planDueLabel("2026-10-08"), "Thursday, 8 October 2026 at 11:55 PM");
    assert.equal(planDueLabel(null), "—", "and nothing invents a deadline where there is no due date");
    assert.ok(planDueLabel("2026-10-08").includes(PLAN_DEADLINE_LABEL), "the composer uses the one wording");

    // 🔴 THE JOIN IS SHARED, THE DATE STYLE IS NOT. The Team tab reads a compact date in a row beside a
    // dozen reps, so it keeps "Thu 8 Oct 2026" and takes the deadline through the same joiner — one
    // wording for both screens, which is what stops a reviewer and his rep reading two deadlines.
    assert.equal(withPlanDeadline("Thu 8 Oct 2026"), "Thu 8 Oct 2026 at 11:55 PM");
    assert.ok(planDueLabel("2026-10-08").endsWith(`at ${PLAN_DEADLINE_LABEL}`), "the rep's label is built from that joiner");
    const teamTab = readFileSync(new URL("../src/components/phoenix-crm/team-tab.tsx", import.meta.url), "utf8");
    assert.match(
      teamTab,
      /Due \{withPlanDeadline\(dayLabelWithYear\(row\.plan\.dueOn\)\)\}/,
      "the Team tab's Due cell shows the hour that decided the reviewer's own 'Sent late' pill",
    );
    assert.ok(!/Due \{dayLabelWithYear\(/.test(teamTab), "and nothing there prints a bare due date beside it");
  }

  // ── 2. The instant, and the once-a-year fold ─────────────────────────────────────────────────────
  {
    // Cairo is UTC+3 in summer: 23:55 is 20:55Z.
    assert.equal(planDeadlineAt("2026-10-08").toISOString(), "2026-10-08T20:55:00.000Z");
    // And UTC+2 in winter: 23:55 is 21:55Z.
    assert.equal(planDeadlineAt("2026-11-05").toISOString(), "2026-11-05T21:55:00.000Z");

    // 🔴 THE AMBIGUOUS ONE. Egypt leaves DST at Cairo midnight on Thursday 29 October 2026 — a plan due
    // date — so 23:55 that evening happens twice: 20:55Z (UTC+3) and again 21:55Z (UTC+2). Both sides
    // take the LATER, so a rep whose own clock reads 23:55 is on time on either pass of it. Postgres
    // resolves `at time zone 'Africa/Cairo'` to 21:55Z here; read back from production, not assumed.
    assert.equal(weeklyPlanDueOn("2026-10-31"), "2026-10-29", "the week of 31 October is due Thursday 29 October");
    assert.equal(planDeadlineAt("2026-10-29").toISOString(), "2026-10-29T21:55:00.000Z", "the later of the two passes");

    // The due-date overrides carry through: the week of 3 October is due on the FRIDAY, at 23:55.
    assert.equal(planDeadlineAt(weeklyPlanDueOn("2026-10-03")).toISOString(), "2026-10-02T20:55:00.000Z");
  }

  // ── 3. The badge flips at 23:55, not at midnight ─────────────────────────────────────────────────
  {
    const dueOn = "2026-10-08";
    const at = (iso: string) => planDeadlinePassed(dueOn, new Date(iso));

    assert.equal(at("2026-10-08T20:54:59.000Z"), false, "23:54:59 Cairo — on time");
    assert.equal(at("2026-10-08T20:55:00.000Z"), false, "23:55:00 exactly — on time, the deadline is inclusive");
    assert.equal(at("2026-10-08T20:55:01.000Z"), true, "one second later — late");
    // The five minutes a date test used to get wrong: 23:58 is LATE now, and read as on time before.
    assert.equal(at("2026-10-08T20:58:00.000Z"), true, "23:58 Cairo on the due day is late");
    assert.equal(at("2026-10-08T21:30:00.000Z"), true, "and so is anything after midnight");
    assert.equal(at("2026-10-07T23:00:00.000Z"), false, "the day before is never late");
  }

  // ── 4. SQL says the same thing, in the one place that runs ───────────────────────────────────────
  {
    const sql = migration();
    assert.match(
      sql,
      /select \(public\.phoenix_crm_week_due_on\(p_week_start\) \+ time '23:55'\) at time zone 'Africa\/Cairo';/,
      "the deadline is the due date at 23:55 Cairo, built on the ONE due-date function so the overrides carry",
    );
    assert.match(sql, /returns timestamptz\nlanguage sql\nstable\n/, "STABLE, never immutable: zone rules can change under it");
    assert.match(
      sql,
      /else now\(\) > public\.phoenix_crm_week_deadline_at\(pl\.week_start\)/,
      "lateness is the server's clock against that instant — never a date against a date",
    );
    assert.ok(
      !/v_today > public\.phoenix_crm_week_due_on/.test(sql),
      "and the midnight test is gone, not left beside it",
    );
    // Accepted and stamped, never refused: the submit branch raises for an empty plan and a bad
    // transition, and for nothing to do with the deadline.
    const submit = sql.slice(sql.indexOf("if v_action = 'submit' then"), sql.indexOf("elsif v_action = 'reopen'"));
    assert.ok(submit.includes("phoenix_crm:empty_plan"), "an empty plan is still refused");
    assert.ok(
      !/raise exception[^;]*(late|deadline|overdue)/i.test(submit),
      "nothing refuses a plan for being late",
    );
    assert.match(sql, /grant execute on function public\.phoenix_crm_week_deadline_at\(date\) to service_role;/);
    assert.match(sql, /revoke execute on function public\.phoenix_crm_week_deadline_at\(date\) from public, anon, authenticated;/);
  }

  // ── 5. The reminder that reaches his phone names the hour ────────────────────────────────────────
  {
    // Thursday 8 October is the due date for the week of 10 October; the reminder speaks from that day.
    const day = planReminderDay("2026-10-08");
    assert.ok(day, "the due day is a reminder day");
    assert.equal(day.late, false);
    const onTime = repReminder({ hrId: "PD-0001", day, cairoToday: "2026-10-08", draftStarted: true });
    assert.ok(onTime.message.includes(`due tonight at ${PLAN_DEADLINE_LABEL}`), "it says the hour, not just tonight");

    const after = planReminderDay("2026-10-09");
    assert.ok(after, "the day after is still a reminder day");
    assert.equal(after.late, true);
    const lateNotice = repReminder({ hrId: "PD-0001", day: after, cairoToday: "2026-10-09", draftStarted: true });
    assert.ok(lateNotice.message.includes(`at ${PLAN_DEADLINE_LABEL}`), "and the late wording carries it too");
    assert.ok(lateNotice.message.includes("A late week is still accepted"), "while still telling him it is accepted");

    const manager = managerReminder({ hrId: "PD-0100", day, cairoToday: "2026-10-08", repNames: ["Aya Ibrahim"] });
    assert.ok(manager, "the manager hears about his own reps");
    assert.ok(manager.message.includes(`due tonight at ${PLAN_DEADLINE_LABEL}`), "with the same deadline");
  }
}
