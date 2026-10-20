import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { isPlanSentForReview } from "../src/lib/phoenix-crm/plan-rules.ts";

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
 *
 * ── THE SECOND HALF OF THE PREDICATE (owner, 2026-10-01) ──────────────────────────────────────────
 *
 * "The customer can be not validated normally and added to the plan normally, also can normally log a
 * visit with validation, but not counted in KPIs till validated." Planning him and visiting him have
 * been free since 2026-09-22 (plan-rules.ts, phoenix-crm-plan-never-blocked). The last clause is a
 * SECOND question about a visit — is its customer on the list yet — and for two years' worth of
 * reading habits it lived nowhere near the first: the view answered only the approval, and each
 * phoenix_crm_report_* function re-typed `validated_at is not null` by hand. That works for a
 * function and cannot work for a PostgREST reader, which has no join to forget, so the Team calendar
 * and the exceptions board counted visits that every report counted at zero.
 *
 * `phoenix_crm_countable_visits.customer_validated` now carries it, and this file pins WHICH READERS
 * ASK FOR IT — including the two that must not, with the reason they give, because a filter added
 * there "for consistency" would turn the rep's own "3 visits saved here, not counting yet" into "No
 * visits saved here yet" and would put a working rep on the never-started list.
 */

const MIGRATION = "supabase/migrations/20260926163000_phoenix_crm_unplanned_visits.sql";
const VALIDATED_VIEW_MIGRATION = "supabase/migrations/20261001060500_phoenix_crm_countable_visits_validated.sql";

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n"));
}

/**
 * The file WITH its comments, for the two readers whose correctness is the stated reason they do not
 * filter. A pin on the `.eq` alone cannot see the difference between a deliberate omission and one
 * nobody has noticed yet, so what is pinned there is the reason.
 */
function raw(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
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

  // ── The SECOND half: the customer's own admission to the list (owner, 2026-10-01) ─────────────
  //
  // The view carries it as a column rather than a filter. A filter would read tidier — "the one
  // predicate, finally one thing" — and would break the rep's own screens, which is why the shape is
  // pinned and not only the column's existence.
  {
    const validated = source(VALIDATED_VIEW_MIGRATION);
    assert.ok(
      validated.includes("create or replace view public.phoenix_crm_countable_visits"),
      "the view is recreated with the validation half on it",
    );
    assert.match(
      validated,
      /phoenix_crm_countable_visits\s*\nwith \(security_invoker = true\)/,
      "and still inherits the base table's RLS — without it the view is a hole through the module's service-role-only rule",
    );
    // 🔴 THE STATEMENT, NOT THE FILE. `stripComments` is a JS/TS lexer and leaves SQL's own `--`
    // prose in place, so a negative assertion read against the whole file is answered by the header
    // explaining the rule — the first cut of this test went red on its own documentation, on the word
    // "nowhere" sitting 80 characters from a quoted `validated_at is not null`.
    const create = validated.lastIndexOf("create or replace view public.phoenix_crm_countable_visits");
    assert.notEqual(create, -1, "the view's own CREATE is in this migration");
    const whereAt = validated.indexOf("where", create);
    assert.notEqual(whereAt, -1, "and it has a WHERE");
    const statement = validated.slice(create, validated.indexOf(";", whereAt) + 1);
    const whereClause = statement.slice(statement.indexOf("where"));

    assert.match(statement, /\(c\.validated_at is not null\) as customer_validated/, "the column is the customer's own admission");
    // INNER, not left: phoenix_crm_visits.customer_id is not null and carries the foreign key, so no
    // visit can fall out of the view through this join — and a left join would let a null stand for
    // "no customer", which cannot happen.
    assert.match(statement, /join public\.phoenix_crm_customers c on c\.id = v\.customer_id/, "joined to the customer");
    assert.equal(
      /left join public\.phoenix_crm_customers/.test(statement),
      false,
      "the customer join is inner: a left join would invent a third state for a column that has two",
    );
    // 🔴 THE WHERE IS UNCHANGED. The column must not become a filter: the rows it would remove are
    // the ones the rep is shown as "saved here, not counting yet".
    assert.equal(
      whereClause.replace(/\s+/g, " ").trim(),
      "where not v.is_unplanned or u.status = 'approved' or v.unplanned_kind = 'out_of_list';",
      "no row leaves the view — the validation half is a column each reader asks for, never a filter",
    );
    assert.equal(
      whereClause.includes("validated_at"),
      false,
      "a WHERE on validation would turn the rep's 'saved here, not counting yet' into 'no visits saved here yet'",
    );
    assert.match(validated, /revoke all on table public\.phoenix_crm_countable_visits from public, anon, authenticated;/);
    assert.match(validated, /grant select on table public\.phoenix_crm_countable_visits to service_role;/);

    // And it is the LAST word on the view: a later migration replacing it without the column would
    // leave every `.eq("customer_validated", true)` below failing the WHOLE read, which is how
    // PostgREST answers a column that is not there.
    const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const latestView = migrations
      .filter((file) => source(`supabase/migrations/${file}`).includes("create or replace view public.phoenix_crm_countable_visits"))
      .pop();
    // Since 2026-10-03 the newest is 20261003174346 (a pharmacy needs no validation), which keeps the
    // column — what is pinned is the column, so the next replacement is held to it whatever its name.
    assert.ok(latestView, "the view is defined by some migration");
    assert.match(
      source(`supabase/migrations/${latestView}`),
      /\) as customer_validated\b/,
      `the newest definition of the view (${latestView}) still carries customer_validated`,
    );
  }

  // ── Which readers ask for it, and which deliberately do not ───────────────────────────────────
  {
    const problems: string[] = [];

    // A tally or a rate — something a person is measured by. Every one of these holds the line, or
    // two screens disagree about one rep's day with nothing to say which is lying.
    //
    // TWO WAYS TO HOLD IT, since 2026-10-02. `query` keeps the `.eq` and never sees the held-back
    // rows. `code` READS them and partitions in TypeScript, because the screen has to SAY how many
    // are waiting — a manager cannot read a zero he is given no reason for, and on a team that has
    // just started every visit is in that state. `code` is the stricter of the two to assert: the
    // body must NAME the column in its select (PostgREST fails the whole read for a column it was
    // not given) AND exclude it explicitly, so an omission cannot pass as a partition.
    const filters: Array<{ path: string; from: string; reads: number; mode: "query" | "code"; alsoIn?: string }> = [
      // AM · PM · Pharmacies per rep per day: what counts as work must be what colours a cell, and
      // the cell now also says how many of that day's visits are waiting on their customers.
      // `foldVisitRow` holds the partition since 2026-10-19: a rep's row and a manager's row fold a visit
      // through the one function, so the exclusion is read there and the read is read here.
      { alsoIn: "function foldVisitRow", from: "async function loadVisitDays", mode: "code", path: "src/lib/phoenix-crm/server/team-calendar.ts", reads: 1 },
      // The exceptions board, where an inflated tally REMOVES the row rather than showing a wrong
      // number: the board exists to raise the territory whose count is low.
      { from: "async function loadVisitTallies", mode: "query", path: "src/lib/phoenix-crm/server/exceptions.ts", reads: 1 },
      // Frequency and the tracking sheet.
      { from: "async function visitDaysByCustomer", mode: "code", path: "src/lib/phoenix-crm/server/reports.ts", reads: 1 },
    ];
    for (const { path, from, reads, mode, alsoIn } of filters) {
      const text = source(path);
      const start = text.indexOf(from);
      if (start === -1) {
        problems.push(`${path}: ${from} is gone — re-point this pin at whatever replaced it`);
        continue;
      }
      // To the next top-level declaration, so one function's reads cannot be read as another's.
      const next = text.indexOf("\n}\n", start);
      let body = text.slice(start, next === -1 ? text.length : next);
      if (alsoIn) {
        const also = text.indexOf(alsoIn);
        if (also === -1) problems.push(`${path}: ${alsoIn} is gone — re-point this pin at whatever replaced it`);
        else body += text.slice(also, text.indexOf("\n}\n", also));
      }
      const found = [...body.matchAll(/\.from\("phoenix_crm_countable_visits"\)/g)].length;
      const filtered = [...body.matchAll(/\.eq\("customer_validated", true\)/g)].length;
      if (found !== reads) problems.push(`${path}: ${from} reads the countable view ${found} time(s), expected ${reads}`);
      if (mode === "query") {
        if (filtered !== reads) problems.push(`${path}: ${from} asks for customer_validated ${filtered} time(s), expected ${reads}`);
        continue;
      }
      // `code`: it must READ the column and EXCLUDE on it. Either half alone is an unfiltered tally.
      if (filtered > 0) {
        problems.push(`${path}: ${from} partitions in code, so the query must not also filter — the held-back rows would never arrive`);
      }
      if (!/\.select\("[^"]*customer_validated/.test(body)) {
        problems.push(`${path}: ${from} must NAME customer_validated in its select, or PostgREST fails the whole read`);
      }
      if (!/customer_validated !== true/.test(body)) {
        problems.push(`${path}: ${from} reads customer_validated but never excludes on it — the tally is counting unvalidated visits`);
      }
    }

    // 🔴 THE TWO THAT MUST NOT FILTER, pinned by the REASON they give. The `.eq` is one line; the
    // reason is what stops the next session adding it "for consistency".
    //
    //   loadMonthVisitCounts — feeds "3 visits saved here, not counting yet" beside a customer the
    //     rep has not validated. Filtered, that honest sentence becomes "No visits saved here yet"
    //     about visits he really made.
    //   loadVisitFirsts     — the adoption board asks whether a territory has STARTED. A rep logging
    //     a visit to a carried-over doctor has plainly started; filtering would put him on the
    //     "never touched it" list for doing the work, and would look truest in the first weeks, when
    //     almost nobody is validated yet.
    const exempt: Array<{ path: string; from: string; says: RegExp }> = [
      {
        // It asks WHEN he last worked, so the grid reaches that far. A started team whose customers
        // are all unvalidated would otherwise read as never having worked, and the calendar would
        // stop before its own visits — the worst case is exactly the first weeks it is needed for.
        from: "async function latestWorkedMonth",
        path: "src/lib/phoenix-crm/server/team-calendar.ts",
        says: /Not filtered: this asks WHEN he last worked/,
      },
      {
        from: "export async function loadMonthVisitCounts",
        path: "src/lib/phoenix-crm/server/list.ts",
        says: /DOES NOT ASK FOR `customer_validated`, AND MUST NOT/,
      },
      {
        from: "async function loadVisitFirsts",
        path: "src/lib/phoenix-crm/server/adoption.ts",
        says: /NO `customer_validated` FILTER, DELIBERATELY/,
      },
    ];
    for (const { path, from, says } of exempt) {
      const text = source(path);
      const start = text.indexOf(from);
      if (start === -1) {
        problems.push(`${path}: ${from} is gone — re-point this pin at whatever replaced it`);
        continue;
      }
      const next = text.indexOf("\n}\n", start);
      const body = text.slice(start, next === -1 ? text.length : next);
      if (body.includes('.eq("customer_validated", true)')) {
        problems.push(`${path}: ${from} must NOT filter on customer_validated — it is counting what was SAVED, not what counts`);
      }
      // The comment, read off the file with its comments intact.
      if (!says.test(raw(path))) {
        problems.push(`${path}: the stated reason ${from} does not filter is gone — without it the omission reads as an oversight`);
      }
    }

    assert.deepEqual(problems, [], problems.join("; "));
  }

  // ── And the rep's own screens still say his saved work was saved ──────────────────────────────
  {
    const labels = source("src/components/phoenix-crm/labels.ts");
    // The count rides in from `plural(...)`, so the pin is the words around it.
    assert.match(labels, /saved here, not counting yet/, "the sentence loadMonthVisitCounts exists to be able to say");
    assert.match(labels, /plan them and visit them as normal/, "and the planner says so in the rep's own words");
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
    // Since 2026-10-01 the form reads today's plan row ONCE — it has to show the status too, to say
    // why Planned has nobody to offer — and narrows it to the sent set through a named predicate.
    const visits = source("src/lib/phoenix-crm/server/visits.ts");
    assert.match(
      visits,
      /isPlanSentForReview\(planDay\.status\) \? planDay\.customerIds : \[\]/,
      "the picker counts only a plan that has gone for review",
    );
    for (const status of ["submitted", "approved"] as const) {
      assert.equal(isPlanSentForReview(status), true, `${status} is authority at the door`);
    }
    for (const status of ["draft", "returned", null] as const) {
      assert.equal(isPlanSentForReview(status), false, `${status ?? "no plan row"} is the rep's own to edit, so it is not`);
    }
  }

  // ── The legacy vendor KPI stack is untouched ─────────────────────────────────────────────────
  {
    // Phoenix CRM is a separate module on purpose: those three read ireports360_visits and have no
    // business knowing this module exists. If one of them ever does, the boundary has moved.
    for (const path of ["src/lib/crm/call-rate.ts", "src/lib/crm/rep-doctor-lists.ts", "src/lib/crm/rep-kpi-reports.ts"]) {
      assert.equal(source(path).includes("phoenix_crm"), false, `${path} must not read Phoenix CRM's own tables`);
    }
  }

  // ── The per-day report names a manager's own visits (owner, 2026-10-20) ───────────────────────
  {
    const body = functionBody(source("supabase/migrations/20261020052000_phoenix_crm_by_day_names_the_manager.sql"), "phoenix_crm_report_visits_by_day");
    const own = "(case when v.rep_hr_id is null then v.manager_hr_id end)";
    assert.equal(body.split(own).length - 1, 4, "both CTEs select and group by the manager, and only where no rep was on the visit");
    assert.ok(body.includes("and w.manager_hr_id is not distinct from c.manager_hr_id"), "the waiting count joins on the manager too");
    assert.ok(body.includes("from public.phoenix_crm_countable_visits v"), "still counted through the view");
  }

  console.log("phoenix-crm countable visits: OK");
}
