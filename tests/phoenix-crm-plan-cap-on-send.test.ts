import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  countPlanDays,
  planCapRefusal,
  planDayLabel,
  planSendCapRefusal,
  type PlanDayCount,
} from "../src/lib/phoenix-crm/plan-rules.ts";
import { PHOENIX_CRM_DEFAULT_SETTINGS } from "../src/lib/phoenix-crm/types.ts";

/**
 * Phoenix CRM — THE DAILY CAPS ARE RE-CHECKED WHEN THE REP SENDS THE WEEK, not only when he saves a day.
 *
 * Measured on production 2026-10-03: rep Yasmeen Samy Shawky Mahdy's seat SEAT-CNS-REP-D11, week of
 * Saturday 3 October, held **18 PM** on its Saturday against `phoenix_crm_settings.pm_daily_cap` 15 —
 * sent 2026-10-02 21:30 Cairo and approved by her district manager at 22:35. The cap had not moved
 * (settings last touched 2026-09-17 13:33 Cairo, pm_daily_cap 15), and 62 of that plan's items carry a
 * `created_at` OLDER than the plan row they hang on (2026-10-01 16:32 against a plan row born
 * 2026-10-02 13:12), with every one of them bearing the same `updated_at` of 2026-10-02 21:20 — ten
 * minutes before the send, and with no `saved` event and no version bump between. So they reached the
 * plan from somewhere other than `savePlan`.
 *
 * Why nothing stopped it:
 *   - `savePlan` → `resolvePlanItems` tested the caps against the items of THAT SAVE, which covers only
 *     the days the rep touched. A day he did not touch was never counted;
 *   - `transitionPlan` (the send) called the `phoenix_crm_plan_transition` RPC with NO item or cap
 *     validation at all, and the SQL side checks only week-passed, status, an empty plan, the note and
 *     the returnable day. So the send promoted the day to submitted, and the approval to approved.
 *
 * What this file pins:
 *   1. the caps are ONE rule (`planCapRefusal`), counted by ONE counter (`countPlanDays`) — the save and
 *      the send cannot drift to two different limits or two different sentences;
 *   2. the send counts the WHOLE week, so an untouched over-cap day is refused;
 *   3. and may only NAME a day the rep can still change, so an over-cap day that has passed lets the
 *      send through rather than trapping a plan nobody can fix;
 *   4. `transitionPlan` reads every item row of the week and hands them to that rule — never the
 *      changeable days alone, which is the hole itself.
 */

const CAPS = { pmDailyCap: PHOENIX_CRM_DEFAULT_SETTINGS.pmDailyCap, amDailyCap: PHOENIX_CRM_DEFAULT_SETTINGS.amDailyCap };

const SAT = "2026-10-03";
const SUN = "2026-10-04";
const MON = "2026-10-05";
const WEEK = [SAT, SUN, MON, "2026-10-06", "2026-10-07", "2026-10-08"];

/** `n` items of one list type on one day. */
function day(date: string, listType: "AM" | "PM", n: number): Array<{ planDate: string; listType: "AM" | "PM" }> {
  return Array.from({ length: n }, () => ({ planDate: date, listType }));
}

function counts(entries: Array<[string, PlanDayCount]>): Map<string, PlanDayCount> {
  return new Map(entries);
}

function raw(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

export function runPhoenixCrmPlanCapOnSendTests(): void {
  // ── 1. One counter, one rule, one sentence ───────────────────────────────────────────────────────
  {
    const tally = countPlanDays([...day(SAT, "PM", 18), ...day(SAT, "AM", 2), ...day(SUN, "PM", 15)]);
    assert.deepEqual(tally.get(SAT), { AM: 2, PM: 18 }, "Saturday's two counts, as production holds them");
    assert.deepEqual(tally.get(SUN), { AM: 0, PM: 15 }, "Sunday's — AM zero, never absent");
    assert.equal(tally.get(MON), undefined, "a day with no customer is not a day");
    assert.deepEqual(countPlanDays([]), new Map(), "an empty plan counts nothing");

    // The sentence is the one the save already used, so a rep reads the same refusal either way.
    assert.equal(
      planCapRefusal({ counts: counts([[SAT, { AM: 0, PM: 18 }]]), settings: CAPS }),
      "Saturday 3 Oct has 18 PM. A day holds 15 PM at most.",
      "the production day, named with its day and its count",
    );
    assert.equal(
      planCapRefusal({ counts: counts([[SAT, { AM: 6, PM: 0 }]]), settings: CAPS }),
      "Saturday 3 Oct has 6 AM. A day holds 5 AM at most.",
      "and the AM cap in the same shape",
    );
    assert.equal(planCapRefusal({ counts: counts([[SAT, { AM: 5, PM: 15 }]]), settings: CAPS }), null, "exactly at both caps is allowed");
    assert.equal(planCapRefusal({ counts: counts([[SAT, { AM: 0, PM: 18 }]]), settings: { pmDailyCap: 18, amDailyCap: 5 } }), null, "the cap is read from settings, never a constant");

    // PM before AM on one day, and the EARLIEST day of several — read in date order, never the order a
    // database read happened to return the rows in.
    assert.equal(
      planCapRefusal({ counts: counts([[SAT, { AM: 6, PM: 18 }]]), settings: CAPS }),
      "Saturday 3 Oct has 18 PM. A day holds 15 PM at most.",
      "a day over on both names its PM",
    );
    assert.equal(
      planCapRefusal({
        counts: counts([
          [MON, { AM: 0, PM: 20 }],
          [SAT, { AM: 0, PM: 18 }],
        ]),
        settings: CAPS,
      }),
      "Saturday 3 Oct has 18 PM. A day holds 15 PM at most.",
      "Saturday is named though Monday was counted first and is worse",
    );
  }

  // ── 2. The send counts the whole week — the day he never touched included ────────────────────────
  {
    // Yasmeen's week as production holds it: Saturday 18 PM + 2 AM, every other day inside the caps.
    const week = [
      ...day(SAT, "PM", 18),
      ...day(SAT, "AM", 2),
      ...day(SUN, "PM", 15),
      ...day(SUN, "AM", 2),
      ...day(MON, "PM", 15),
      ...day(MON, "AM", 2),
    ];
    assert.equal(
      planSendCapRefusal({ items: week, settings: CAPS, changeableDays: WEEK }),
      "Saturday 3 Oct has 18 PM. A day holds 15 PM at most. Take one off that day, save, then send.",
      "the send refuses the week, names Saturday and its 18, and says what to do",
    );

    // The hole itself: counting only the days of the LAST save (the rep's 13:15 save touched Saturday's
    // two AM accounts) finds nothing wrong. This is the assertion the fix exists for.
    assert.equal(
      planSendCapRefusal({ items: day(SAT, "AM", 2), settings: CAPS, changeableDays: WEEK }),
      null,
      "one save's own payload is within cap — which is exactly why the send must count the stored week",
    );

    const within = [...day(SAT, "PM", 15), ...day(SAT, "AM", 5), ...day(SUN, "PM", 15)];
    assert.equal(planSendCapRefusal({ items: within, settings: CAPS, changeableDays: WEEK }), null, "a week inside the caps sends");
    assert.equal(planSendCapRefusal({ items: [], settings: CAPS, changeableDays: WEEK }), null, "an empty week is the RPC's refusal, not this one");
  }

  // ── 3. A locked over-cap day never deadlocks the week ───────────────────────────────────────────
  {
    const over = [...day(SAT, "PM", 18), ...day(SUN, "PM", 15)];
    // Saturday has passed: `repChangeableDays` no longer holds it, so the rep has no way to take anyone
    // off it. Refusing here would leave him a week he can neither fix nor send.
    assert.equal(
      planSendCapRefusal({ items: over, settings: CAPS, changeableDays: [SUN, MON] }),
      null,
      "an over-cap day he can no longer change lets the send through",
    );
    // A week returned for ONE day opens that day alone, so the same holds there.
    assert.equal(planSendCapRefusal({ items: over, settings: CAPS, changeableDays: [SUN] }), null, "and so does a week returned for one OTHER day");
    assert.equal(
      planSendCapRefusal({ items: over, settings: CAPS, changeableDays: [SAT] }),
      "Saturday 3 Oct has 18 PM. A day holds 15 PM at most. Take one off that day, save, then send.",
      "but the returned day itself is his to fix, so it is refused",
    );
    assert.equal(planSendCapRefusal({ items: over, settings: CAPS, changeableDays: [] }), null, "no changeable day at all: nothing can be named");

    // Later in the week, a passed Saturday is skipped and a LATER over-cap day is still named.
    assert.equal(
      planSendCapRefusal({ items: [...day(SAT, "PM", 18), ...day(MON, "AM", 7)], settings: CAPS, changeableDays: [SUN, MON] }),
      "Monday 5 Oct has 7 AM. A day holds 5 AM at most. Take one off that day, save, then send.",
      "the passed day is passed over and the fixable one is named",
    );
  }

  // ── 4. The send is wired to that rule, over the WHOLE week ──────────────────────────────────────
  {
    const plans = raw("src/lib/phoenix-crm/server/plans.ts");
    const transition = plans.slice(plans.indexOf("export async function transitionPlan("), plans.indexOf("// ── The managers' review list"));

    assert.match(transition, /planSendCapRefusal\(\{/, "the send re-checks the caps through the shared rule");
    assert.match(transition, /settings: viewer\.config\.settings,/, "with the live settings, never a constant");
    assert.match(transition, /changeableDays: access\.editableDays,/, "and only the days the rep can still change may be named");
    assert.ok(
      transition.indexOf("planSendCapRefusal({") < transition.indexOf('callPhoenixCrm<Row>("phoenix_crm_plan_transition"'),
      "before the transition is written — the RPC itself checks no cap",
    );

    // 🔴 The read must be the WHOLE week's rows. Narrowing it back to the changeable days is the hole
    // this closes, so the unfiltered read and the filter that feeds the STALE test are pinned apart.
    // Started beside the one-week guard and awaited after it (2026-10-16 speed audit), with the narrow
    // columns a send reads — the venue rides on the item's own place.
    assert.match(transition, /const allRowsRead = loadPlanItemRows\(\[planId\], SEND_ITEM_COLUMNS\);/, "every item row of the week is read, unfiltered");
    assert.match(transition, /const allRows = await allRowsRead;/, "and used whole");
    assert.match(plans, /place:phoenix_crm_places!place_id\(status, shared_place_id\)"/, "the send's rows carry the place's status and its building");
    assert.match(transition, /const openRows = allRows\.filter\(\(row\) => changeable\.has\(String\(row\.plan_date\)\)\);/, "the stale test keeps its own narrower view");
    assert.equal(
      (transition.match(/loadPlanItemRows\(/g) ?? []).length,
      1,
      "read once, used twice — not a second round trip",
    );
    assert.ok(
      !/loadPlanItemRows\(\[planId\], (?:SEND_)?ITEM_COLUMNS\)\)\.filter/.test(transition) && !/allRowsRead\)\.filter/.test(transition),
      "the item read is never filtered in place again: that filter is what hid the untouched day",
    );

    // ── And the save still answers to the same rule, with no second copy of it in the rules file.
    const rules = raw("src/lib/phoenix-crm/plan-rules.ts");
    const resolve = rules.slice(rules.indexOf("export function resolvePlanItems("));
    assert.match(resolve, /planCapRefusal\(\{ counts: countPlanDays\(resolved\), settings: input\.settings \}\)/, "the save counts its own items through the same rule");
    // The comparison itself lives in planCapRefusal and nowhere else, so neither path can grow a second
    // limit: counted inside its body, and counted again over the file with that body removed.
    const capRule = rules.slice(rules.indexOf("export function planCapRefusal("), rules.indexOf("export function planSendCapRefusal("));
    const compare = /counts\.(?:PM|AM) > input\.settings\.(?:pm|am)DailyCap/g;
    assert.equal((capRule.match(compare) ?? []).length, 2, "planCapRefusal holds both comparisons");
    assert.equal((rules.replace(capRule, "").match(compare) ?? []).length, 0, "and nothing else in the rules compares a count with a cap");
    assert.equal((rules.match(/A day holds \$\{/g) ?? []).length, 2, "one sentence for PM and one for AM, in one place");
  }

  // ── 5. The day name the refusal uses is Phoenix's own ────────────────────────────────────────────
  {
    assert.equal(planDayLabel(SAT), "Saturday 3 Oct", "the day as the rep reads it everywhere else");
  }
}
