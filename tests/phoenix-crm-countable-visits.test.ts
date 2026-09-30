import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — an off-plan visit counts in NOTHING until it is approved.
 *
 * Owner, 2026-09-26. This file exists because the rule is a property of EVERY read rather than of any
 * one function, and because the two ways of getting it wrong are both silent.
 *
 * THE FIRST IS THE ONE THAT VOIDS THE WHOLE FEATURE. "Planned" is not "the customer is on a plan
 * row". The rep owns his own draft plan and today is an editable day, so plan-row existence alone lets
 * him place the doctor at the door, save thirty seconds later, and never be off plan: nobody would
 * ever see an approval queue, the feature would look like it worked, and the rule would be theatre.
 * The test is that the plan had already REACHED REVIEW before this visit's server-issued captured_at.
 *
 * THE SECOND IS A READ PATH THAT IS NOT AN RPC. `loadMonthVisitCounts` is a PostgREST `.from()` in
 * TypeScript, so "I moved every report function to the view" does not reach it — and it feeds
 * `visitsThisMonth`, which is the rep's own standing against his grade norm on the visit form, both
 * planners and the List board. Left on the raw table, a visit nobody has approved quietly satisfies a
 * frequency norm everywhere a rep plans.
 *
 * And one path must NOT move: the anti-fraud judge reads every capture, decided or not. A visit
 * waiting for a decision is exactly the one you most want judged.
 */

const MIGRATION = "supabase/migrations/20260926163000_phoenix_crm_unplanned_visits.sql";

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n"));
}

/** One function's body out of the migration, comments already stripped. */
function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.notEqual(start, -1, `${name} is defined in ${MIGRATION}`);
  const end = sql.indexOf("\n$$;", start);
  assert.notEqual(end, -1, `${name}'s body ends`);
  return sql.slice(start, end);
}

export async function runPhoenixCrmCountableVisitsTests(): Promise<void> {
  const sql = source(MIGRATION);

  // ── The one predicate ────────────────────────────────────────────────────────────────────────
  {
    assert.ok(sql.includes("create or replace view public.phoenix_crm_countable_visits"), "the view exists");
    // Without security_invoker the view runs as its owner and is a hole straight through the module's
    // service-role-only guarantee — the very thing the rest of the module is built to prevent.
    assert.match(sql, /phoenix_crm_countable_visits\s*\nwith \(security_invoker = true\)/, "the view inherits the base table's RLS");
    assert.match(sql, /revoke all on table public\.phoenix_crm_countable_visits from public, anon, authenticated;/);
    assert.match(sql, /grant select on table public\.phoenix_crm_countable_visits to service_role;/);
    assert.match(sql, /where not v\.is_unplanned or u\.status = 'approved'/, "counted: on a sent plan, or approved");
  }

  // ── Every function that COUNTS reads the view ────────────────────────────────────────────────
  {
    const problems: string[] = [];

    // These two count, and nothing else. A read of the base table in either is the defect.
    for (const name of ["phoenix_crm_report_manager_visits", "phoenix_crm_report_coverage"]) {
      const body = functionBody(sql, name);
      if (!body.includes("public.phoenix_crm_countable_visits")) problems.push(`${name} must read phoenix_crm_countable_visits`);
      if (body.includes("from public.phoenix_crm_visits")) problems.push(`${name} must not read phoenix_crm_visits directly`);
    }

    // The visit counts come from the view; a SECOND pass over the base table counts the ones still
    // waiting, beside the figure and never inside it — a day that reads low because three visits are
    // with the manager has to say so, or the dip reads as a rep who did not work. So the base table is
    // allowed here, but ONLY where it is joined to the approval row.
    {
      const body = functionBody(sql, "phoenix_crm_report_visits_by_day");
      if (!body.includes("from public.phoenix_crm_countable_visits v")) problems.push("visits_by_day must count through the view");
      if (!body.includes("unplanned_waiting")) problems.push("visits_by_day must say how many are waiting");
      for (const match of body.matchAll(/from public\.phoenix_crm_visits v/g)) {
        const after = body.slice(match.index ?? 0, (match.index ?? 0) + 300);
        if (!after.includes("join public.phoenix_crm_unplanned_visits")) {
          problems.push("visits_by_day reads phoenix_crm_visits somewhere other than the waiting count");
        }
      }
    }

    // Plan against actual reads the BASE table on purpose: its job is to show the manager the off-plan
    // work, and a visit that has vanished from the report cannot be approved by anybody. Its
    // `visited_planned` is unaffected either way, because a planned visit is never an unplanned one.
    // What the decision changes here is the two columns beside the count.
    {
      const body = functionBody(sql, "phoenix_crm_report_plan_vs_actual");
      if (!body.includes("from public.phoenix_crm_visits v")) problems.push("plan_vs_actual must still show every off-plan visit");
      if (!body.includes("unplanned_waiting")) problems.push("plan_vs_actual must count the ones still waiting");
      if (!body.includes("unplanned_refused")) problems.push("plan_vs_actual must count the ones refused");
      // A visit the rep did not PLAN is not a plan he kept, however the plan was edited afterwards:
      // visit off-plan at 10:00, reopen that evening, add her to the day, submit, and the day becomes
      // a sent day with her on it. Without this the ratio flattered him and disagreed with the visit
      // count on the same screen, which reads the countable view.
      if (!body.includes("j.is_planned and j.is_visited and not j.is_unplanned")) {
        problems.push("plan_vs_actual must not count an off-plan visit as a kept plan");
      }
      // And it is surfaced rather than silently re-read as a miss — he WAS there.
      if (!body.includes("planned_waiting")) problems.push("plan_vs_actual must show a seen-but-waiting customer as such, not as missed");
    }

    // Collected and asserted once: a per-name assert inside the loop reports only the first failure.
    assert.deepEqual(problems, [], problems.join("; "));
  }

  // ── Out of list: the visit is countable, the CUSTOMER's admission decides (2026-09-29) ──────────
  //
  // An out-of-list visit has no approval row of its own — the district manager and SFE approve the
  // customer, not the visit. So the view admits it, and what keeps it out of every figure until he is
  // on the list is the OTHER half of the predicate: each counting report joins the customer and reads
  // `validated_at is not null`, which an outside customer does not have until SFE admits him. Both
  // halves are pinned, because either one alone looks complete.
  {
    const oneTap = source("supabase/migrations/20260929235553_phoenix_crm_one_tap_visit.sql");
    assert.match(oneTap, /phoenix_crm_countable_visits\s*\nwith \(security_invoker = true\)/, "the recreated view still inherits the base table's RLS");
    assert.match(
      oneTap,
      /where not v\.is_unplanned or u\.status = 'approved' or v\.unplanned_kind = 'out_of_list'/,
      "an out-of-list visit is countable, with no approval row to wait on",
    );
    assert.match(oneTap, /revoke all on table public\.phoenix_crm_countable_visits from public, anon, authenticated;/);
    assert.match(oneTap, /grant select on table public\.phoenix_crm_countable_visits to service_role;/);

    const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const name of ["phoenix_crm_report_manager_visits", "phoenix_crm_report_coverage", "phoenix_crm_report_visits_by_day"]) {
      // The LATEST definition is the one production runs.
      const latest = migrations.filter((file) => source(`supabase/migrations/${file}`).includes(`create or replace function public.${name}(`)).pop();
      assert.ok(latest, `${name} is defined in a migration`);
      const text = source(`supabase/migrations/${latest}`);
      const start = text.indexOf(`create or replace function public.${name}(`);
      const body = text.slice(start, text.indexOf("\n$$;", start));
      assert.ok(body.includes("validated_at is not null"), `${name} (${latest}) counts a customer's visits only once he is validated and on the list`);
    }
  }

  // ── The read path that is not an RPC ─────────────────────────────────────────────────────────
  {
    const list = source("src/lib/phoenix-crm/server/list.ts");
    const start = list.indexOf("export async function loadMonthVisitCounts");
    assert.notEqual(start, -1, "loadMonthVisitCounts is still there");
    const body = list.slice(start, start + 900);
    assert.ok(body.includes('.from("phoenix_crm_countable_visits")'), "loadMonthVisitCounts must read the countable view");
    assert.equal(body.includes('.from("phoenix_crm_visits")'), false, "and never the raw table");
  }

  // ── The anti-fraud path must NOT be filtered ─────────────────────────────────────────────────
  {
    const integrity = source("src/lib/phoenix-crm/server/location-integrity.ts");
    assert.equal(
      integrity.includes("phoenix_crm_countable_visits"),
      false,
      "the integrity judge reads every capture: a visit waiting for a decision is the one you most want judged",
    );
  }

  // ── The rep still sees his own waiting visit ─────────────────────────────────────────────────
  {
    const visits = source("src/lib/phoenix-crm/server/visits.ts");
    const start = visits.indexOf("async function loadVisitRows");
    assert.notEqual(start, -1);
    assert.ok(visits.slice(start, start + 600).includes('.from("phoenix_crm_visits")'), "his day shows the visit, with a pill on it");
  }

  // ── The loophole is closed, and stays closed ─────────────────────────────────────────────────
  {
    const save = functionBody(sql, "phoenix_crm_save_visit");
    assert.match(save, /v_on_sent_plan/, "the save resolves whether the visit was planned");
    assert.match(save, /phoenix_crm_plan_events/, "from the plan's own history");
    assert.match(save, /e\.created_at <= v_captured_at/, "as it stood BEFORE the visit");
    // The SHAPE, not just the words. An `exists` over the events asks "did this plan ever reach
    // review", which is a different and much weaker question: the events table is append-only, so a
    // Saturday 'submitted' row outlives every reopen, and a rep at an unplanned door could tap
    // Reopen, add the doctor and save with no reason and no approval. It must read the LATEST event
    // at that moment and test THAT, which is what phoenix_crm_report_plan_vs_actual's sent_days does.
    const sentPlan = save.slice(save.indexOf("v_on_sent_plan :="), save.indexOf("clarification_required"));
    assert.match(sentPlan, /order by e\.created_at desc, e\.id desc\s+limit 1/, "the plan's status is the LATEST event at captured_at");
    assert.match(sentPlan, /\)\s*in \('submitted', 'approved'\)/, "and only a sent or approved plan is authority");
    assert.equal(
      /exists \(\s*select 1\s*from public\.phoenix_crm_plan_events/.test(sentPlan),
      false,
      "an exists() over the events asks whether the plan EVER reached review, which a reopen defeats",
    );
    assert.match(save, /raise exception 'phoenix_crm:clarification_required'/, "an off-plan visit needs a reason");
    assert.match(save, /not v_on_sent_plan/, "and is stamped on the visit");

    // The screen's twin of the same test, so the picker and the server agree about what "planned" is.
    const visits = source("src/lib/phoenix-crm/server/visits.ts");
    const start = visits.indexOf("async function plannedCustomerIds");
    assert.notEqual(start, -1);
    const planned = visits.slice(start, start + 700);
    assert.ok(planned.includes('.in("status", ["submitted", "approved"])'), "the picker counts only a plan that has gone for review");
  }

  // ── The legacy vendor KPI stack is untouched ─────────────────────────────────────────────────
  {
    // Phoenix CRM is a separate module on purpose: those three read ireports360_visits and have no
    // business knowing this module exists. If one of them ever does, the boundary has moved.
    for (const path of ["src/lib/crm/call-rate.ts", "src/lib/crm/rep-doctor-lists.ts", "src/lib/crm/rep-kpi-reports.ts"]) {
      assert.equal(source(path).includes("phoenix_crm"), false, `${path} must not read Phoenix CRM's own tables`);
    }
  }

  console.log("phoenix-crm countable visits: OK");
}
