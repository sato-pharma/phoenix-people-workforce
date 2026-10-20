import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments, stripCommentsCompact, stripSqlComments } from "./support/comment-strip.ts";

import {
  DAY_ACTIVITY_NOTE_MAX,
  PHOENIX_CRM_DAY_ACTIVITIES,
  dayActivityLabel,
  isDayActivity,
  parseDayActivityDraft,
} from "../src/lib/phoenix-crm/day-activities.ts";

/**
 * Phoenix CRM — a DAY ACTIVITY: a working day that was not a call.
 *
 * Owner, 2026-09-26, who asked for it and ruled two things about it in the same breath:
 *
 *   1. It is a **RECORD ONLY** — it changes no call rate, no coverage, no plan-against-actual. A rep
 *      at a training day currently looks, on every board, like a rep who did nothing; this lets his
 *      manager see the difference, it does not excuse the day. Removing a day from a denominator
 *      moves every rate on every manager's board, including for months already reported.
 *   2. **LEAVE IS NOT IN PHOENIX CRM.** HR's vacation module, with its own approval and evidence, is
 *      the only leave record. A second one here would be a truth nothing reconciles — and the one
 *      that pays him is the other one.
 *
 * Both are silent when broken: adding `leave` to a list compiles, and so does the first report that
 * reads this table. That is why they are pinned rather than described.
 */

const MIGRATION = "supabase/migrations/20260926193000_phoenix_crm_day_activities.sql";

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

function sql(path: string = MIGRATION): string {
  return stripSqlComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n"));
}

/** The newest migration to restate the activity-type check: "Sales day" joined it on 2026-09-29. */
const TYPE_CHECK_MIGRATION = "supabase/migrations/20260929235553_phoenix_crm_one_tap_visit.sql";

export function runPhoenixCrmDayActivitiesTests(): void {
  // ── The vocabulary is Phoenix's own, and holds no leave ─────────────────────────────────────────
  {
    const keys = PHOENIX_CRM_DAY_ACTIVITIES.map((entry) => entry.key);
    // The owner's order on the visit's first screen (2026-09-29): his four, then the other three — and
    // "Sales day" is new.
    assert.deepEqual(keys, ["meeting", "conference", "health_day", "sales_day", "training", "admin_work", "travel"]);

    for (const banned of ["leave", "annual", "vacation", "sick", "casual", "absent", "holiday"]) {
      assert.equal(keys.includes(banned as never), false, `${banned} is HR's, not the CRM's — one leave record, not two`);
    }
    // And the database agrees, or the list is only half a rule.
    const check = /check \(activity_type in \(([^)]+)\)\)/.exec(sql(TYPE_CHECK_MIGRATION));
    assert.ok(check, "the column constrains its own values");
    for (const key of keys) assert.ok(check[1].includes(`'${key}'`), `${key} is allowed by the check constraint`);
    assert.equal(/leave|vacation|sick/i.test(check[1]), false, "no leave value reaches the database either");
  }

  // ── An unknown kind is REFUSED, not coerced ─────────────────────────────────────────────────────
  //
  // Unlike a visit's optional extras, the kind IS the record: filing a training day as something else
  // would be worse than refusing it.
  {
    assert.equal(parseDayActivityDraft({ activityType: "leave" }).ok, false, "a leave day is refused outright");
    assert.equal(parseDayActivityDraft({ activityType: "" }).ok, false);
    assert.equal(parseDayActivityDraft({}).ok, false);
    assert.equal(isDayActivity("training"), true);
    assert.equal(isDayActivity("leave"), false);

    const good = parseDayActivityDraft({ activityType: "training", halfDay: true, note: "  Regional day  " });
    assert.equal(good.ok, true);
    if (good.ok) assert.deepEqual(good.value, { activityType: "training", halfDay: true, note: "Regional day" });

    const long = parseDayActivityDraft({ activityType: "meeting", note: "x".repeat(DAY_ACTIVITY_NOTE_MAX + 1) });
    assert.equal(long.ok, false, "a note over the cap is refused, not silently cut");

    assert.equal(dayActivityLabel("admin_work"), "Admin work");
  }

  // ── It is a RECORD: nothing that scores a rep reads it ──────────────────────────────────────────
  //
  // 🔴 The assertion the owner's first ruling lives in. The day a report function starts joining this
  // table, every rate on every manager's board moves — including for months already reported — and
  // that is his decision to make on its own day, not a consequence of a feature that records a day.
  {
    for (const path of [
      // server/reports.ts is deliberately NOT here since 2026-10-01: asked whether a recorded activity
      // should excuse a missed plan, the owner answered "show it beside the miss". Plan against actual
      // SHOWS the day's activity and scores nothing by it — the pin after this loop holds that. The
      // counting rules (report-rules.ts) stay in this list: they never see an activity at all.
      "src/lib/phoenix-crm/report-rules.ts",
      "src/lib/phoenix-crm/coverage.ts",
      // server/today.ts is deliberately NOT here since 2026-09-29: the owner asked for the day's activity
      // "beside the plan" on Today. It SHOWS it and scores nothing — the pin after this loop holds that.
      "src/lib/phoenix-crm/today-rules.ts",
    ]) {
      const code = source(path);
      assert.equal(
        /phoenix_crm_day_activities|day-activities|dayActivity/.test(code),
        false,
        `${path} must not read a day activity — it is a record, and it moves no figure (owner, 2026-09-26)`,
      );
    }
    // Today SHOWS the day's activity and nothing more: it is passed through as its own field, and the
    // stops and the four counts are built without it.
    {
      const today = source("src/lib/phoenix-crm/server/today.ts");
      const build = /buildTodayStops\(\{[\s\S]*?\}\);/.exec(today)?.[0] ?? "";
      assert.ok(build.length > 0, "Today still builds its stops in one call");
      assert.equal(/dayActivity|plannedActivity/.test(build), false, "the day's activity never reaches the stops or the counts");
    }
    // Plan against actual SHOWS the day's activity beside its misses and nothing more (owner,
    // 2026-10-01: "show it beside the miss"). It is read once, for that report alone; it never enters a
    // call that builds a figure; and it reaches the row only as the words printed beside the day.
    {
      const reports = source("src/lib/phoenix-crm/server/reports.ts");
      assert.equal((reports.match(/loadSeatDayActivities\(/g) ?? []).length, 1, "only plan against actual reads it");
      const groupings = [...reports.matchAll(/groupPlanByTerritory\([\s\S]*?\);/g)].map((match) => match[0]);
      assert.ok(groupings.length >= 2, "plan against actual and its comparison still build their figures in groupPlanByTerritory");
      for (const grouping of groupings) {
        assert.equal(/activit/i.test(grouping), false, `the day's activity never reaches the figures: ${grouping}`);
      }
      assert.match(reports, /activities: activitiesBySeat\.get\(group\.seatId\) \?\? \{\},/, "it reaches the row as words, beside the figures");
      const tab = source("src/components/phoenix-crm/reports-tab.tsx");
      assert.ok(tab.includes("`Other activity: ${activity}`"), "and the day prints it on its own line, under that day's AM and PM");
    }
    // And the report RPCs in the newest migration touching them name no such table.
    const reports = stripSqlComments(
      readFileSync(new URL("../supabase/migrations/20260926163000_phoenix_crm_unplanned_visits.sql", import.meta.url), "utf8"),
    );
    assert.equal(reports.includes("phoenix_crm_day_activities"), false, "no report function joins it");
  }

  // ── One a day, replaced rather than piled up, and never back-dated ──────────────────────────────
  {
    const text = sql();
    assert.match(text, /constraint phoenix_crm_day_activities_one_a_day unique \(seat_id, activity_date, is_test\)/);
    assert.match(text, /on conflict \(seat_id, activity_date, is_test\) do update/, "saving twice replaces");
    assert.match(text, /pg_advisory_xact_lock\(hashtext\('phoenix_crm:day_activity:/, "two saves on one day cannot race");
    assert.equal(/current_date/.test(text), false, "the Cairo day comes from the caller — the server runs in UTC");

    // The day is the viewer's own VISIT day, never the body's: back-dating a day activity is the same
    // hole as back-dating a visit, and the module closed that one already. Since 2026-09-29 that day
    // runs until 02:00 the next morning, exactly as a visit's does (owner: "maximum 2 AM").
    const service = stripCommentsCompact(readFileSync(new URL("../src/lib/phoenix-crm/server/day-activities.ts", import.meta.url), "utf8"));
    assert.ok(service.includes("activity_date: viewer.visitDay"), "the date is the server's, not the phone's");
    assert.equal(service.includes("activity_date: viewer.cairoToday"), false, "and it is the visit day, not the calendar day");
    assert.equal(/activity_date:\s*raw\./.test(service), false, "and never comes from the request body");
  }

  // ── The rep's own day to describe ───────────────────────────────────────────────────────────────
  //
  // A manager enters a VISIT on a rep's territory — he was there, with him — but never a day
  // activity, which is a statement about how the rep spent his own day.
  {
    const service = source("src/lib/phoenix-crm/server/day-activities.ts");
    assert.ok(service.includes("territoryForDayWrite"), "writing is the rep's own on his seat, or a district manager's on HIS seat (owner, 2026-10-20)");
    assert.ok(service.includes("territoryForRead"), "reading follows the territory's own scope");
    const visits = source("src/lib/phoenix-crm/server/visits.ts");
    assert.ok(visits.includes("canSetDayActivity"), "the day view says whether this viewer may set it");
    assert.ok(visits.includes("canWriteAsRep("), "and answers it with the module's own rep test");
  }

  // ── The four service-role lines, and the function's own grants ──────────────────────────────────
  {
    const text = sql();
    assert.match(text, /alter table public\.phoenix_crm_day_activities enable row level security;/);
    assert.match(text, /revoke all on table public\.phoenix_crm_day_activities from public, anon, authenticated;/);
    assert.match(text, /grant all on table public\.phoenix_crm_day_activities to service_role;/);
    assert.match(text, /revoke execute on function public\.phoenix_crm_save_day_activity\(jsonb\) from public, anon, authenticated;/);
    assert.match(text, /grant execute on function public\.phoenix_crm_save_day_activity\(jsonb\) to service_role;/);
  }

  console.log("phoenix-crm day activities: OK");
}
