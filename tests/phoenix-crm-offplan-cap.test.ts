import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fieldWeekStart } from "../src/lib/phoenix-crm/calendar.ts";
import { addDaysIso } from "../src/lib/crm/dates.ts";
import {
  offPlanAllowance,
  offPlanAllowanceSentence,
  offPlanBlock,
  offPlanStandingFull,
  offPlanStandingKey,
  offPlanStandingLine,
  offPlanStandings,
  offPlanWeekWindow,
} from "../src/lib/phoenix-crm/offplan-cap-rules.ts";
import {
  OFFPLAN_DAY_FULL_CODE,
  OFFPLAN_DAY_FULL_TEXT,
  OFFPLAN_WEEK_FULL_CODE,
  OFFPLAN_WEEK_FULL_TEXT,
} from "../src/lib/phoenix-crm/unplanned-rules.ts";
import { PHOENIX_CRM_DEFAULT_SETTINGS } from "../src/lib/phoenix-crm/types.ts";

const MIGRATION = "supabase/migrations/20261010214440_phoenix_crm_offplan_visit_caps.sql";

/** The trigger's own week arithmetic, in JavaScript: Saturday = 0 ... Friday = 6. */
function sqlWeekStart(isoDay: string): string {
  const dow = new Date(`${isoDay}T12:00:00Z`).getUTCDay();
  return addDaysIso(isoDay, -((dow + 1) % 7));
}

/** Owner, 2026-10-10: at most 2 doctors a day and 8 a week out of plan, enforced at the door. */
export function runPhoenixCrmOffplanCapTests(): void {
  // His numbers are the defaults — and only the defaults: the Super Admin moves them in Settings.
  assert.equal(PHOENIX_CRM_DEFAULT_SETTINGS.offPlanDailyCap, 2);
  assert.equal(PHOENIX_CRM_DEFAULT_SETTINGS.offPlanWeeklyCap, 8);

  const migration = readFileSync(MIGRATION, "utf8");
  assert.ok(migration.includes("offplan_daily_cap integer not null default 2"), "the daily column defaults to his two");
  assert.ok(migration.includes("offplan_weekly_cap integer not null default 8"), "the weekly column defaults to his eight");
  assert.ok(migration.includes("select s.offplan_daily_cap, s.offplan_weekly_cap into v_daily, v_weekly"), "🔴 the trigger READS the settings rather than hard-coding 2 and 8");
  assert.ok(migration.includes(`raise exception '${OFFPLAN_DAY_FULL_CODE}'`), "the day refusal");
  assert.ok(migration.includes(`raise exception '${OFFPLAN_WEEK_FULL_CODE}'`), "the week refusal");
  assert.ok(migration.includes("before insert on public.phoenix_crm_visits"), "at the door, on the visit itself");
  assert.ok(
    migration.includes("when (new.unplanned_kind = 'out_of_plan' and new.list_type in ('AM', 'PM'))"),
    "🔴 only an out-of-plan DOCTOR visit — never out-of-list, never a pharmacy, and an ordinary visit pays nothing",
  );
  assert.ok(migration.includes("count(distinct v.customer_id)"), "it counts DOCTORS, not visits");
  assert.ok(migration.includes("v.customer_id <> new.customer_id"), "a doctor already counted never takes a second place");
  assert.ok(migration.includes("v.seat_id = new.seat_id"), "per seat, so a rep's number is his own");
  assert.ok(migration.includes("revoke execute on function public.phoenix_crm_offplan_visit_cap() from public, anon, authenticated"), "the SECURITY DEFINER function is closed to the browser roles");

  // The week is the FIELD week — Saturday to Thursday, a Friday closing the week before it — and the
  // trigger's arithmetic must agree with calendar.ts for every day of a long run, a month boundary included.
  assert.ok(migration.includes("new.visit_date - ((extract(dow from new.visit_date)::integer + 1) % 7)"), "the trigger's week start");
  for (let offset = 0; offset < 400; offset += 1) {
    const day = addDaysIso("2026-09-01", offset);
    assert.equal(sqlWeekStart(day), fieldWeekStart(day), `the trigger and the module agree on the week of ${day}`);
  }
  assert.equal(fieldWeekStart("2026-10-09"), "2026-10-03", "a Friday belongs to the week before it");

  // The rep is told in words that name no number and no check, through the one REFUSALS table.
  assert.equal(OFFPLAN_DAY_FULL_CODE, "phoenix_crm:offplan_day_full");
  assert.equal(OFFPLAN_WEEK_FULL_CODE, "phoenix_crm:offplan_week_full");
  for (const text of [OFFPLAN_DAY_FULL_TEXT, OFFPLAN_WEEK_FULL_TEXT]) {
    assert.ok(!/\d/.test(text), "the cap is a setting, so no number is written into the sentence");
    assert.ok(!/check|flag|violation|monitor/i.test(text), "golden rule #1: nothing says he is being checked");
  }
  const db = readFileSync("src/lib/phoenix-crm/server/db.ts", "utf8");
  assert.ok(db.includes("offplan_day_full: { status: 409, message: OFFPLAN_DAY_FULL_TEXT }"), "the day refusal becomes a 409 the rep can read");
  assert.ok(db.includes("offplan_week_full: { status: 409, message: OFFPLAN_WEEK_FULL_TEXT }"), "and so does the week's");

  // Read live from the settings row, written by the Super Admin's save, and editable on the Settings tab.
  const settings = readFileSync("src/lib/phoenix-crm/server/settings.ts", "utf8");
  assert.ok(settings.includes("offplan_daily_cap, offplan_weekly_cap"), "loaded with the config");
  assert.ok(settings.includes("offplan_daily_cap: integerIn(body.offPlanDailyCap, 1, 20"), "saved, bounded by the column's own CHECK");
  assert.ok(settings.includes("offplan_weekly_cap: integerIn(body.offPlanWeeklyCap, 1, 100"), "the weekly one too");
  const tab = readFileSync("src/components/phoenix-crm/settings-tab.tsx", "utf8");
  assert.ok(tab.includes("...OFF_PLAN_FIELDS"), "the two numbers are in the Settings tab's own field list");
  assert.ok(tab.includes("{OFF_PLAN_FIELDS.map(numberField)}"), "and drawn");

  // Deliberately NOT a settled outbox code, for the reason the polyclinic cap is not: that list is mirrored.
  const outbox = readFileSync("src/lib/phoenix-crm/outbox-rules.ts", "utf8");
  const settled = /OUTBOX_SETTLED_CODES: readonly string\[\] = \[([\s\S]*?)\]/.exec(outbox);
  assert.ok(settled && !settled[1].includes("offplan"), "the mirrored settled list stays identical on both sides");

  checkAllowanceDisplay();
}

/** What both sides SHOW of the allowance (owner, 2026-10-10: "make it appear to reps ... and to their managers"). */
function checkAllowanceDisplay(): void {
  const caps = { offPlanDailyCap: 2, offPlanWeeklyCap: 8 };
  // 2026-10-10 is a Saturday: it opens the week; Friday 2026-10-09 closes the week before it.
  assert.deepEqual(offPlanWeekWindow("2026-10-14"), { from: "2026-10-10", to: "2026-10-16" }, "the week runs Saturday to Friday");
  const rows = [
    { customerId: "a", visitDate: "2026-10-10" },
    { customerId: "b", visitDate: "2026-10-10" },
    { customerId: "a", visitDate: "2026-10-12" },
    { customerId: "c", visitDate: "2026-10-12" },
    { customerId: "d", visitDate: "2026-10-09" },
  ];
  const saturday = offPlanAllowance({ rows, day: "2026-10-10", caps });
  assert.deepEqual([saturday.day.used, saturday.week.used], [2, 3], "two doctors that day, three that week, the Friday before left out");
  assert.equal(offPlanBlock(saturday, "z"), "day", "a full day offers nobody new");
  assert.equal(offPlanBlock(saturday, "a"), null, "a doctor already counted is never blocked by his own place");
  const monday = offPlanAllowance({ rows, day: "2026-10-12", caps });
  assert.deepEqual([monday.day.used, monday.week.used], [2, 3], "a doctor seen twice in the week counts once");
  const tuesday = offPlanAllowance({ rows, day: "2026-10-13", caps });
  assert.equal(offPlanBlock(tuesday, "z"), null, "an empty day with room in the week offers everyone");
  const tight = offPlanAllowance({ rows, day: "2026-10-13", caps: { offPlanDailyCap: 2, offPlanWeeklyCap: 3 } });
  assert.equal(offPlanBlock(tight, "z"), "week", "a full week offers nobody new");
  assert.equal(offPlanBlock(tight, "c"), null, "but a doctor already in the week stays open");

  // The words: one sentence, the tighter limit first, nothing that reads as being checked.
  assert.match(offPlanAllowanceSentence(saturday), /^You have visited 2 customers out of plan today/, "a full day says so first");
  assert.match(offPlanAllowanceSentence(saturday, "manager"), /^The rep has visited 2 customers/, "a manager entering for him reads it about the rep");
  assert.match(offPlanAllowanceSentence(tuesday), /^You can take 2 customers more out of plan today\.$/, "room says how much");
  assert.match(offPlanAllowanceSentence(tight), /most a week holds/, "a full week says so");
  for (const sentence of [saturday, monday, tuesday, tight].map((allowance) => offPlanAllowanceSentence(allowance))) {
    assert.ok(!/check|flag|violation|monitor|warning/i.test(sentence), "golden rule #1: nothing says he is being checked");
  }

  // The manager's line, per seat and day, from one read.
  const standings = offPlanStandings({
    rows: rows.map((row) => ({ ...row, seatId: "seat-1" })),
    asks: [
      { seatId: "seat-1", day: "2026-10-10" },
      { seatId: "seat-2", day: "2026-10-10" },
    ],
    caps,
  });
  const first = standings.get(offPlanStandingKey("seat-1", "2026-10-10"));
  assert.ok(first, "the first seat has a standing");
  assert.equal(offPlanStandingLine(first), "Out of plan that day 2 of 2 · that week 3 of 8");
  assert.equal(offPlanStandingFull(first), true, "a reached day is amber on the card");
  const second = standings.get(offPlanStandingKey("seat-2", "2026-10-10"));
  assert.ok(second && second.day.used === 0 && !offPlanStandingFull(second), "another seat's doctors are never counted against him");

  // Source pins: both sides read the one rule, and nothing is re-derived in a component.
  const team = readFileSync("src/lib/phoenix-crm/server/team.ts", "utf8");
  assert.ok(team.includes("repOffPlan: offPlanStandingsRead.get(offPlanStandingKey(view.seatId, view.visitDate))"), "each waiting off-plan visit carries where its rep stood");
  const visits = readFileSync("src/lib/phoenix-crm/server/visits.ts", "utf8");
  assert.ok(visits.includes("offPlan: offPlanAllowance({ rows: offPlanRows, day: today, caps: settings, exemptions: offPlanExemptions })"), "the visit form carries the allowance");
  const card = readFileSync("src/components/phoenix-crm/unplanned-visit-card.tsx", "utf8");
  assert.ok(card.includes("<OffPlanStandingStrip standing={day.visits[0].repOffPlan} />"), "the managers' card shows it");
  const start = readFileSync("src/components/phoenix-crm/visit-start.tsx", "utf8");
  assert.ok(start.includes("<OffPlanAllowanceCard allowance={offPlan}"), "the rep sees it before choosing who");
  assert.ok(start.includes("disabled={outOfPlanOpenCount === 0 && outOfPlanCount > 0}"), "and Out of plan closes when it holds no place");
  const picker = readFileSync("src/components/phoenix-crm/visit-customer-picker.tsx", "utf8");
  assert.ok(picker.includes("offPlanBlock(offPlan, customer.customerId)"), "the picker lists a doctor the allowance cannot take, but does not offer him");
  // A third visit before validation is listed and not offered too (System Audit, 31 Oct 2026).
  assert.ok(picker.includes("disabled={customer.visitedToday || blocked !== null || customer.validateFirst || customer.needsFullName === true}"), "disabled, not hidden");
  assert.ok(picker.includes("<OffPlanAllowanceCard allowance={offPlan} className=\"mt-3\" compact"), "and the reason step reminds him, compactly");
  const component = readFileSync("src/components/phoenix-crm/offplan-allowance.tsx", "utf8");
  assert.ok(!/rounded-(?!none)/.test(component), "square edges");
  assert.ok(!/overflow-x/.test(component), "never a horizontal scroll");
}
