import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fieldWeekStart } from "../src/lib/phoenix-crm/calendar.ts";
import { parsePlanItems, resolvePlanItems, type PlanRuleCustomer } from "../src/lib/phoenix-crm/plan-rules.ts";
import { suggestForDay, type PlannerCustomer } from "../src/lib/phoenix-crm/suggestions.ts";
import { PHOENIX_CRM_DEFAULT_SETTINGS } from "../src/lib/phoenix-crm/types.ts";

/**
 * Phoenix CRM — a customer carried over from iReports360 and not validated yet.
 *
 * Owner, 2026-09-22, in his own words: "he can normally do his plan never blocked ... but also never
 * counted, counted only when this customer is validated", and "he is validated only once, then this
 * validation is saved".
 *
 * So the whole behaviour is four rules, and each one is pinned here because breaking any of them is
 * silent — the screens keep working and the numbers quietly go wrong:
 *
 *   1. he is planned and visited exactly like anyone else, with no place and no days and hours;
 *   2. his visits count in NOTHING — not coverage, not frequency, not the call rate, not plan against
 *      actual — and he is out of BOTH sides of every one, so planning him never makes a rep look bad;
 *   3. validating makes the visits already saved against him count, with no backfill: every report
 *      joins the customer and reads `validated_at`, and nothing is ever stamped on a visit;
 *   4. validating happens once, and its proof — the live photo, the location, the moment — is frozen.
 */

const SETTINGS = PHOENIX_CRM_DEFAULT_SETTINGS;
const WEEK = fieldWeekStart("2026-09-21");
/** The Sunday of that week: a full day, so it holds doctors as well as accounts. */
const SUNDAY = fieldWeekStart("2026-09-21") === "2026-09-19" ? "2026-09-20" : "";

const PENDING_ID = "11111111-1111-4111-8111-111111111111";
const VALIDATED_ID = "22222222-2222-4222-8222-222222222222";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const GONE_PLACE_ID = "44444444-4444-4444-8444-444444444444";

/** Receives every day, so the timings never decide a test that is about validation. */
const ALWAYS_OPEN = [0, 1, 2, 3, 4, 6].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60, season: "normal" as const }));

function ruleCustomers(): Map<string, PlanRuleCustomer> {
  return new Map<string, PlanRuleCustomer>([
    [PENDING_ID, { customerId: PENDING_ID, name: "Dr Hoda Samir", listType: "PM", pending: true, places: [] }],
    [
      VALIDATED_ID,
      { customerId: VALIDATED_ID, name: "Dr Karim Fouad", listType: "PM", pending: false, places: [{ placeId: PLACE_ID, timings: ALWAYS_OPEN }] },
    ],
  ]);
}

function runPlanningTests() {
  assert.equal(WEEK, "2026-09-19", "the week used here starts on its Saturday");
  assert.ok(SUNDAY, "the day used here is a full day of that week");

  // 1. A customer who is not validated yet is planned with no place, no exception and no note.
  const planned = resolvePlanItems({
    weekStart: WEEK,
    items: [{ planDate: SUNDAY, customerId: PENDING_ID, placeId: null, exceptionType: null, exceptionNote: null }],
    customers: ruleCustomers(),
    settings: SETTINGS,
    isRamadan: () => false,
  });
  assert.ok(planned.ok, `a customer who is not validated yet is refused a plan: ${planned.ok ? "" : planned.error}`);
  assert.equal(planned.value.length, 1);
  assert.equal(planned.value[0].placeId, null, "he is planned with no place — the planner never invents one");
  assert.equal(planned.value[0].receives, true, "nothing is known about when he receives, so no day is an exception");
  assert.equal(planned.value[0].startMinute, null);

  // And the refusal that still has to bite: a VALIDATED customer whose place was removed. The pending
  // branch must not swallow this one, or a real plan item silently loses its place.
  const stale = resolvePlanItems({
    weekStart: WEEK,
    items: [{ planDate: SUNDAY, customerId: VALIDATED_ID, placeId: GONE_PLACE_ID, exceptionType: null, exceptionNote: null }],
    customers: ruleCustomers(),
    settings: SETTINGS,
    isRamadan: () => false,
  });
  assert.equal(stale.ok, false, "a validated customer's removed place is still refused");
  assert.match(stale.ok ? "" : stale.error, /place was changed/);

  // The body the planner sends: a null place is accepted, anything that is not a uuid is not.
  const parsed = parsePlanItems([
    { planDate: SUNDAY, customerId: PENDING_ID, placeId: null },
    { planDate: SUNDAY, customerId: VALIDATED_ID, placeId: PLACE_ID },
  ]);
  assert.ok(parsed.ok, "a plan item with no place is accepted");
  assert.deepEqual(
    parsed.value.map((item) => item.placeId),
    [null, PLACE_ID],
  );
  assert.equal(parsePlanItems([{ planDate: SUNDAY, customerId: PENDING_ID, placeId: "somewhere" }]).ok, false, "a place that is not a uuid is still refused");
}

function runPickerTests() {
  const customers: PlannerCustomer[] = [
    { customerId: PENDING_ID, name: "Dr Hoda Samir", listType: "PM", grade: "B", speciality: null, visitsThisMonth: 3, pending: true, places: [] },
    {
      customerId: VALIDATED_ID,
      name: "Dr Karim Fouad",
      listType: "PM",
      grade: "B",
      speciality: null,
      visitsThisMonth: 0,
      pending: false,
      places: [{ placeId: PLACE_ID, label: "Clinic", address: "5 Faisal St", lat: 30.05, lon: 31.23, brick: "CA5", zone: "Down town", timings: ALWAYS_OPEN }],
    },
  ];
  const offered = suggestForDay({ weekday: 0, ramadan: false, customers, placed: [], settings: SETTINGS });
  const ids = offered.map((suggestion) => suggestion.customerId);
  assert.ok(ids.includes(PENDING_ID), "a customer who is not validated yet is offered in the picker — hiding him is the wall the owner removed");
  assert.equal(offered.find((suggestion) => suggestion.customerId === PENDING_ID)?.placeId, null, "with no place");
  assert.equal(offered.find((suggestion) => suggestion.customerId === PENDING_ID)?.pending, true);
  assert.deepEqual(ids, [VALIDATED_ID, PENDING_ID], "the customers that can be ranked come first; he is offered after them, never hidden");

  // A VALIDATED customer whose places have all been retired has nothing to plan him at, and is NOT
  // offered as if he were pending — that would label him wrongly and then be refused on save.
  const retired: PlannerCustomer[] = [{ ...customers[1], places: [] }];
  assert.deepEqual(suggestForDay({ weekday: 0, ramadan: false, customers: retired, placed: [], settings: SETTINGS }), [], "a validated customer with no place is not offered");

  // He is placed as he is: the day a pending customer is already on reads back as placed.
  const again = suggestForDay({ weekday: 0, ramadan: false, customers, placed: [{ customerId: PENDING_ID, placeId: null }], settings: SETTINGS });
  assert.equal(again.find((suggestion) => suggestion.customerId === PENDING_ID)?.alreadyOnDay, true);
}

// ── The database: one predicate, on both sides of every report ──────────────────────────────────

const MIGRATION = "supabase/migrations/20260922180258_phoenix_crm_pending_customers.sql";
const DECIDE_FIX = "supabase/migrations/20260922210000_phoenix_crm_decide_request_reads_decision.sql";
const REACHABLE = "supabase/migrations/20260922233000_phoenix_crm_pending_reachable.sql";

function sqlOf(file = MIGRATION): string {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n").replace(/--.*$/gm, "");
}

/** One function's text, from its header to its closing `$$;`. */
function functionSql(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} is in the migration`);
  const end = sql.indexOf("\n$$;", start);
  assert.ok(end > start, `${name} ends in "$$;"`);
  return sql.slice(start, end);
}

function runMigrationTests() {
  const sql = sqlOf();

  // A pending row is a real customer row, so "does it count?" is one predicate everywhere.
  assert.match(sql, /check \(status in \('active', 'pending', 'dropped'\)\)/, "a customer can stand pending");
  assert.match(
    sql,
    /alter table public\.phoenix_crm_plan_items\s+alter column place_id drop not null;/,
    "a plan item can name no place — a customer who is not validated yet has none",
  );
  // The invariant "active implies validated" is kept by leaving its CHECK alone: it already admits a
  // pending row with no validated_at, and dropping it would let a customer go active unvalidated.
  assert.match(
    readFileSync("supabase/migrations/20260916150000_phoenix_crm.sql", "utf8"),
    /constraint phoenix_crm_customers_active_is_validated check \(status <> 'active' or validated_at is not null\)/,
    "the invariant that an ACTIVE customer is a validated one is still declared",
  );
  assert.doesNotMatch(sql, /drop constraint[^;]*active_is_validated/, "and this migration does not drop it");

  // Minting the carried-over list is idempotent: read the list twice and nothing doubles.
  const ensure = functionSql(sql, "phoenix_crm_ensure_reference_customers");
  assert.match(ensure, /'pending'/, "a carried-over customer is minted pending");
  assert.match(
    ensure,
    /on conflict \(seat_id, reference_contact_crm_id, is_test\) where reference_contact_crm_id is not null\s+do nothing/,
    "minting twice mints nothing — the list is read on every screen, and a second read must not double a customer",
  );
  assert.doesNotMatch(ensure, /validated_at/, "minting never stamps a validation");

  // Rule 1: planning and visiting accept pending; only a customer who LEFT the list is refused.
  assert.match(functionSql(sql, "phoenix_crm_save_plan"), /status in \('active', 'pending'\)/, "a plan may name a customer who is not validated yet");
  assert.match(functionSql(sql, "phoenix_crm_save_visit"), /not in \('active', 'pending'\)/, "a visit may be saved on a customer who is not validated yet");

  // Rule 2 and 3: every report joins the customer and reads validated_at. Nothing is stamped on a visit,
  // so validating makes the visits ALREADY saved against him count, with no backfill anywhere.
  const REPORTS = [
    ["phoenix_crm_report_visits_by_day", 1],
    // Both sides again: the customers counted (the denominator) and the month's visits (the numerator).
    ["phoenix_crm_report_coverage", 2],
    // Both branches of its union: the rep's own visits and the manager's.
    ["phoenix_crm_report_manager_visits", 2],
    // Both sides: the planned denominator and the visited numerator. One alone would score a rep on a
    // plan he is not credited for — exactly the thing the owner said must never happen.
    ["phoenix_crm_report_plan_vs_actual", 2],
  ] as const;
  for (const [name, times] of REPORTS) {
    const body = functionSql(sql, name);
    assert.equal(
      (body.match(/c\.validated_at is not null/g) ?? []).length,
      times,
      `${name} filters on the customer being validated, ${times} time(s) — a report that counts a pending visit is the one thing this change must not do`,
    );
  }
  assert.doesNotMatch(sql, /update public\.phoenix_crm_visits\b/, "no visit is ever restamped — validating counts what is already there");

  // Rule 4: validating is once. The refusal is the first migration's and is not softened here.
  const validate = functionSql(sql, "phoenix_crm_validate_customer");
  assert.match(validate, /raise exception 'phoenix_crm:already_validated'/, "a customer is validated once, and a second attempt is refused");
  assert.match(validate, /v_prev_status/, "a pending customer validating reads as validated, never as one brought back from the dead");
  assert.match(validate, /'customer_validated'/);
  assert.match(validate, /'customer_restored'/);

  // The proof stays proof: nothing in this migration touches a place's photo, its location or when it
  // was taken. (phoenix_crm_update_place is not replaced here at all, which is the strongest form of it.)
  assert.doesNotMatch(sql, /\bcreate or replace function public\.phoenix_crm_update_place\b/, "the place editor is untouched: the evidence columns have no writer");
  for (const column of ["photo_path", "captured_at"]) {
    assert.doesNotMatch(sql, new RegExp(`set[^;]*\\b${column}\\s*=`), `${column} is never rewritten — it is the proof`);
  }

  // The name and the speciality are changed later, on their own, and never by validating.
  const rename = functionSql(sql, "phoenix_crm_rename_customer");
  assert.match(rename, /raise exception 'phoenix_crm:customer_dropped'/, "a customer that left the list is not renamed");
  assert.doesNotMatch(rename, /\bgrade\b/, "the grade is not changed here — it keeps its proposal flow, because it sets the rep's own target");
  // Validating a carried-over customer is the three captures and nothing else: the update that turns a
  // pending row into a validated one writes the stamp, and never a name, a speciality or a grade.
  const flip = /update public\.phoenix_crm_customers c\s+set status = 'active',([\s\S]*?)where c\.id = v_ref\.customer_id/.exec(validate);
  assert.ok(flip, "the update that validates a customer already on the list is still there");
  for (const column of ["name", "speciality", "grade"]) {
    assert.doesNotMatch(flip[1], new RegExp(`\\b${column}\\s*=`), `validating writes ${column} — it is the three captures and nothing else, and the name is changed later on its own`);
  }

  // Owner, 2026-09-23: "keep the iReports360 grades on validation". The check above says validating
  // does not OVERWRITE a grade; these two say what the grade actually is, which is the half a future
  // session would change while leaving that one green. Re-grading at the door is the obvious-looking
  // improvement here — the rep is standing in front of the doctor — and it is refused, because the
  // grade sets that rep's own target and so is never his to set.
  const refInsert = /insert into public\.phoenix_crm_customers \([\s\S]*?'reference', v_ref\.contact_crm_id,[\s\S]*?\)/.exec(validate);
  assert.ok(refInsert, "validating a carried-over customer still mints him from the reference row");
  assert.match(refInsert[0], /\bv_ref\.grade\b/, "a carried-over customer keeps the grade iReports360 gave him — it is copied from the reference row, never asked for at the door");

  // And the one customer a rep creates himself is graded by nobody: the row goes in with NO grade and
  // a 'grade' request goes to the district manager. A literal grade here would be the rep grading.
  const newInsert = /elsif v_mode = 'new' then([\s\S]*?)elsif v_mode = 'restore' then/.exec(validate);
  assert.ok(newInsert, "validating still has the branch for a customer the rep adds himself");
  assert.match(newInsert[1], /'grade', v_customer\.id/, "a rep-added customer opens a grade REQUEST — the grade is proposed, never applied");
  assert.doesNotMatch(newInsert[1], /grade[^,)]*=>?\s*'[ABC]'/, "a rep never writes a grade himself, not even on a customer he created");
}

// ── The screens ─────────────────────────────────────────────────────────────────────────────────

function runScreenTests() {
  const source = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

  // The wall the owner removed: a plan is never refused because the list is not finished.
  const plans = source("src/lib/phoenix-crm/server/plans.ts");
  assert.doesNotMatch(plans, /phoenix_crm_list_not_ready/, "nothing about the rep's list refuses a plan any more");
  // The Plan board replaced plan-tab.tsx on 2026-09-29; the wall stays gone from every file of it.
  for (const file of ["plan-board.tsx", "plan-week-panel.tsx", "plan-day-panel.tsx"]) {
    assert.doesNotMatch(source(`src/components/phoenix-crm/${file}`), /phoenix_crm_list_not_ready/, `${file} never waits on the list`);
  }

  // A pending customer is not stale. Stale blocks submitting, and he is planned on purpose.
  assert.match(
    plans,
    /if \(status !== "active" && status !== "pending"\) return true;/,
    "a customer who is not validated yet is not stale — marking him stale would block the rep from sending his week",
  );

  // He is never shown as having left the list: that is the one wrong word on the whole screen.
  const customer = source("src/components/phoenix-crm/list-customer.tsx");
  // Through the one rule that knows a PHARMACY never waits on a validation (owner, 2026-10-03).
  const pendingBranch = customer.indexOf("const pending = awaitsValidation(customer);");
  assert.ok(pendingBranch > 0, "the customer's page knows a pending customer");
  // Since 2026-09-29 a customer can also wait OUTSIDE the list (met on an out-of-list visit), so "not
  // active and not pending" is no longer "left": the Archive pill keys on the one status that means it.
  assert.match(customer, /const archived = customer\.status === "dropped";/, "the Archive is exactly the dropped status");
  assert.match(customer, /\{archived \? <CrmPill>In the Archive<\/CrmPill> : null\}/, "the Archive pill is shown only to a customer that is actually in it");
  assert.doesNotMatch(customer, /\{!active && !pending \? <CrmPill>/, "a customer waiting outside the list is never shown as having left it");

  // The one sentence, said once and shared, so four screens cannot drift apart.
  const labels = source("src/components/phoenix-crm/labels.ts");
  for (const forbidden of [/\bcannot\b/i, /\bmust\b/i, /\bblocked\b/i, /\bmissing\b/i]) {
    const pending = labels.slice(labels.indexOf("PENDING_PILL"), labels.indexOf("export function monthVisitsText"));
    assert.doesNotMatch(pending, forbidden, "what a rep reads about a customer he has not validated states a fact with the fix inside it — never cannot, must, blocked or missing");
  }

  // ── Asking to drop a customer who is not validated yet ────────────────────────────────────────
  // Besides Validate and Add a visit, the drop request is the ONLY screen a rep can open on a customer
  // he has not validated — rule 1 says a carried-over customer leaves the list by being validated or
  // by being removed, and this is the removing. Every other surface swapped to the pending wording;
  // this one was missed and still printed "1 of 3 visits this month": a target he does not have and a
  // shortfall he cannot owe, on the one screen where the rep is explaining why he should go.
  const screens = source("src/components/phoenix-crm/list-screens.tsx");
  const dropStart = screens.indexOf("export function DropScreen(");
  assert.ok(dropStart > 0, "the drop-request screen is still in list-screens.tsx");
  const drop = screens.slice(dropStart);
  assert.match(
    drop,
    /const notValidated = customer !== null && awaitsValidation\(customer\);/,
    "the drop screen tells a customer's OWN pending status apart from a drop request already waiting — the two meanings of the word collide on this one screen, and reusing the name is how it would break again",
  );
  const heading = /customer && notValidated \? \(([\s\S]*?)\) : customer \? \(([\s\S]*?)\) : reference/.exec(drop);
  assert.ok(heading, "a customer who is not validated yet is read on his own branch of the drop screen's heading");
  assert.match(
    heading[1],
    /pendingVisitsText\(customer\.visitsThisMonth\)/,
    "who is told what his saved visits are, in the module's one shared pending sentence",
  );
  assert.doesNotMatch(heading[1], /monthVisitsText/, "and is never scored against a target he does not have");
  assert.doesNotMatch(heading[1], /placesDaysText/, "nor told he has no place, which is simply what not validated means");
  assert.match(
    heading[2],
    /monthVisitsText\(customer\.visitsThisMonth, customer\.target\)/,
    "while a validated customer still reads on this screen exactly as he did",
  );
  assert.match(drop, /<CrmPill tone="orange">\{PENDING_PILL\}<\/CrmPill>/, "and the screen says which kind of customer this is, in the same words as everywhere else");

  // The module's locked look, still: no horizontal scroll, no ellipsis, no rounded corner.
  for (const file of ["src/components/phoenix-crm/list-tab.tsx", "src/components/phoenix-crm/list-customer.tsx", "src/components/phoenix-crm/plan-board.tsx", "src/components/phoenix-crm/plan-week-panel.tsx", "src/components/phoenix-crm/plan-day-panel.tsx", "src/components/phoenix-crm/list-screens.tsx"]) {
    const body = source(file);
    for (const banned of [/\btruncate\b/, /\bline-clamp-/, /\boverflow-x-auto\b/, /\brounded-(?!none\b)/]) {
      assert.doesNotMatch(body, banned, `${file} breaks the module's look`);
    }
  }
}

/**
 * The manager's decision, and the one key that made every approval a refusal.
 *
 * 20260922180258 replaced `phoenix_crm_decide_request` wholesale to teach it that a PENDING customer
 * can be dropped, and while rewriting it read its input from `approve` instead of `decision`. The
 * caller has always sent `decision` (src/lib/phoenix-crm/server/list.ts), so the key was never there,
 * `coalesce(..., false)` won every time, and the approve branch was dead code: no grade was ever
 * applied and NO customer could be taken off a list — one of the only two ways a carried-over
 * customer ever leaves it.
 *
 * It was silent in the worst way: the manager clicked Approve and was told the request was REFUSED.
 * Nothing threw, nothing logged, and no test looked at the key. This one does, on both sides — the
 * function and its caller must name the same key, or the next rewrite breaks it the same way.
 */
function runDecideRequestTests() {
  const sql = sqlOf(DECIDE_FIX);
  const decide = functionSql(sql, "phoenix_crm_decide_request");

  // The key itself: read from `decision`, never from `approve`.
  assert.match(decide, /v_decision text := coalesce\(p ->> 'decision', ''\)/, "the decision is read from the `decision` key");
  assert.match(decide, /if v_decision = 'approve' then/, "and the approve branch turns on it");
  assert.doesNotMatch(decide, /p ->> 'approve'/, "`approve` is not a key this function has ever been sent");

  // A payload with no usable decision is bad_input — NEVER a silent refusal. This is the assertion
  // that would have caught the regression: without it, a missing key just means "refused".
  assert.match(
    decide,
    /if v_actor is null or v_request_id is null or v_decision not in \('approve', 'refuse'\) then\s+raise exception 'phoenix_crm:bad_input';/,
    "a payload with no decision, or an unknown one, is refused as bad input rather than silently recorded as a refusal",
  );

  // The caller and the function must agree about the key.
  const caller = readFileSync("src/lib/phoenix-crm/server/list.ts", "utf8");
  assert.match(
    caller,
    /callPhoenixCrm<Row>\("phoenix_crm_decide_request", \{\s*p: \{[^}]*\bdecision\b/,
    "the caller sends `decision`, which is what the function reads",
  );

  // The error code the UI actually tests for. `already_decided` reaches neither db.ts's map nor the
  // card, so a second decision surfaced as an opaque 500 instead of "already decided".
  assert.match(decide, /raise exception 'phoenix_crm:request_decided'/, "a second decision raises the code the UI knows");
  assert.doesNotMatch(decide, /already_decided/, "and not one nothing maps");
  assert.match(readFileSync("src/lib/phoenix-crm/server/db.ts", "utf8"), /request_decided: \{ status: 409/, "which db.ts maps to a 409");

  // The note guard the rewrite dropped: over-long notes belong in bad_input, not in a table CHECK.
  assert.match(
    decide,
    /if v_note is not null and char_length\(v_note\) > 500 then\s+raise exception 'phoenix_crm:bad_input';/,
    "an over-long note is bad input, not a 500 from the table's own CHECK",
  );

  // The pending-customer drop branch the rewrite was FOR must survive the repair. (sqlOf strips
  // comments, so this reads the code: an existing pending row is UPDATED to dropped, where the old
  // version could only insert a fresh dropped row and refused when one already existed.)
  assert.match(decide, /raise exception 'phoenix_crm:already_validated'/, "a validated customer is not dropped down this path");
  assert.match(
    decide,
    /set status = 'dropped',[\s\S]*?where c\.id = v_customer\.id\s+returning c\.\* into v_customer;/,
    "an existing pending row is updated to dropped rather than refused for existing",
  );
}

/**
 * The two rules that were reachable only in the easy case, and the screens the first pass never got to.
 *
 * Rule 1 — "it leaves only by being validated or removed." Both doors ran through
 * phoenix_crm_seat_reference, which reads live iReports360 assignments. End the assignment and the
 * pending row rightly survived while BOTH doors raised not_on_reference_list: a customer with no way
 * off the list at all, which is the state rule 1 forbids.
 *
 * Rule 5 — "on validation his already-logged visits start counting", ruled literally by the owner on
 * 2026-09-22. Coverage demanded the validation fall inside the month, so a month that closed first
 * never reopened.
 *
 * Rule 4 — a pending visit counts in no metric. The visit form was the one screen that had never
 * heard the word, and it printed "2 of 3 visits this month" over visits that count for nothing.
 */
function runPendingReachableTests() {
  const sql = sqlOf(REACHABLE);
  const source = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

  // ── Rule 1: one resolver, used by both doors ───────────────────────────────────────────────────
  const helper = functionSql(sql, "phoenix_crm_reference_entry");
  assert.match(helper, /from public\.phoenix_crm_seat_reference\(array\[p_seat_id\], p_is_test\) r/, "the live reference list is still read first");
  assert.match(
    helper,
    /from public\.phoenix_crm_customers c\s+where c\.seat_id = p_seat_id/,
    "and a customer whose iReports360 assignment ended is resolved from his own surviving row",
  );
  // The fallback must not shadow a live entry, or a stale customer row would answer for a live one.
  assert.match(helper, /and not exists \(\s+select 1\s+from public\.phoenix_crm_seat_reference/, "the fallback fires only when the live list has nothing");
  // seat_reference's own vocabulary, or every caller reading `state` misreads the fallback row.
  for (const state of ["dropped", "validated", "drop_pending", "open"]) {
    assert.match(helper, new RegExp(`'${state}'`), `the fallback speaks seat_reference's '${state}'`);
  }

  for (const name of ["phoenix_crm_validate_customer", "phoenix_crm_create_request"]) {
    const body = functionSql(sql, name);
    assert.match(body, /from public\.phoenix_crm_reference_entry\(/, `${name} resolves the contact through the shared entry`);
    assert.doesNotMatch(
      body,
      /from public\.phoenix_crm_seat_reference\(/,
      `${name} no longer reads the live assignment list directly — that is what stranded a carried-over customer`,
    );
    assert.match(body, /raise exception 'phoenix_crm:not_on_reference_list'/, `${name} still refuses a contact that is on neither`);
  }

  // ── Rule 5: coverage reopens the month ─────────────────────────────────────────────────────────
  const coverage = functionSql(sql, "phoenix_crm_report_coverage");
  assert.match(coverage, /and c\.validated_at is not null/, "coverage still counts only validated customers");
  assert.doesNotMatch(
    coverage,
    /validated_at < \(b\.next_month/,
    "but no longer demands the validation happened inside the month — a rep validated in October has his September visits counted in September",
  );
  // The clause beside it stays: a customer dropped later still belongs to the month he was dropped in.
  assert.match(coverage, /c\.status = 'active' or c\.status_changed_at >= \(b\.month_start/, "a dropped customer still belongs to the month he was dropped in");

  // ── Rule 4: the visit form knows the word ──────────────────────────────────────────────────────
  // The Add flow was split out of visits-tab.tsx on 2026-09-29: the picker and the form are read together.
  const visits = ["visit-customer-picker.tsx", "visit-log-form.tsx"].map((file) => source(`src/components/phoenix-crm/${file}`)).join("\n");
  assert.match(
    visits,
    // The picker's line is wrapped since it also says a third visit before validation is refused (31 Oct 2026).
    /customer\.pending\s*\?\s*pendingVisitsText\(customer\.visitsThisMonth\)\s*:\s*monthVisitsText\(customer\.visitsThisMonth, customer\.target\)/,
    "the visit form never prints a month standing over visits that count for nothing",
  );
  assert.equal(
    visits.match(/customer\.pending\s*\?\s*pendingVisitsText\(/g)?.length,
    2,
    "in the picker AND in the chosen-customer summary — both said 2 of 3 before",
  );
  assert.match(visits, /\{customer\.pending \? <CrmPill tone="orange">\{PENDING_PILL\}<\/CrmPill> : null\}/, "the picker carries the same pill as every other screen");
  assert.match(visits, /\{PENDING_COUNTS_NOTE\}/, "and the one sentence that says what validating buys");

  // ── The Validate hand-off: Add Visit → the List's Validate screen ──────────────────────────────
  const listTab = source("src/components/phoenix-crm/list-tab.tsx");
  assert.match(
    listTab,
    // The full-name hand-off (owner, 2026-11-09) sits behind it, and the tab's own screen comes last.
    /const current: ListScreen = validateHandoff\s*\? \{ name: "validate", contactCrmId: validateHandoff\.contactCrmId \}\s*: fullNameHandoff\s*\? \{ name: "edit-details", customerId: fullNameHandoff\.customerId \}\s*: screen;/,
    "the hand-off outranks whatever screen the tab was left on",
  );
  assert.match(
    listTab,
    /const working = current\.name !== "home" && current\.name !== "customer" && current\.name !== "saved";/,
    "and the held-work guard reads `current`, or the page could swap the tab away from a validation he is standing at the door to finish",
  );
  assert.match(listTab, /switch \(current\.name\) \{/, "every screen is dispatched from `current`");
  assert.match(listTab, /if \(validateHandoff\) onPendingValidateDone\?\.\(\);\s+if \(fullNameHandoff\) onPendingFullNameDone\?\.\(\);\s+setScreen\(next\);/, "moving anywhere deliberately ends the hand-off, or the tab sticks on it");

  // The "Validate now" nudge after a visit is GONE (owner, 2026-09-29): a visit needs no photo, and
  // validating happens on the List, once and for good — never offered from the visit flow.
  assert.doesNotMatch(
    source("src/components/phoenix-crm/visits-tab.tsx"),
    /saved\.validate !== null/,
    "the visit flow no longer hands the rep to Validate after saving",
  );
  assert.match(
    source("src/lib/phoenix-crm/server/visits.ts"),
    /referenceContactCrmId: numberOrNull\(row\.reference_contact_crm_id\)/,
    "which the visit form's own read carries, so the nudge costs no second request",
  );

  // ── The Team tab no longer tells managers plans wait for validation ────────────────────────────
  const team = source("src/components/phoenix-crm/team-tab.tsx");
  assert.doesNotMatch(
    team,
    /weekly plans start once/i,
    "the wall the owner removed is not still described to his managers",
  );
  assert.doesNotMatch(team, /<CrmPill tone="warn">Validating<\/CrmPill>/, "a territory part-way through its list is not a warning");
  assert.match(team, /const currentFilter: ListFilter = filter \?\? "all";/, "and the section does not open pre-filtered to the territories still validating");
}

export function runPhoenixCrmPendingCustomerTests() {
  runPlanningTests();
  runPickerTests();
  runMigrationTests();
  runDecideRequestTests();
  runPendingReachableTests();
  runScreenTests();
}
