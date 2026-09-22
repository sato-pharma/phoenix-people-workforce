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
      places: [{ placeId: PLACE_ID, label: "Clinic", lat: 30.05, lon: 31.23, brick: "CA5", zone: "Down town", timings: ALWAYS_OPEN }],
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

function sqlOf(): string {
  return readFileSync(MIGRATION, "utf8").replace(/\r\n/g, "\n").replace(/--.*$/gm, "");
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
}

// ── The screens ─────────────────────────────────────────────────────────────────────────────────

function runScreenTests() {
  const source = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

  // The wall the owner removed: a plan is never refused because the list is not finished.
  const plans = source("src/lib/phoenix-crm/server/plans.ts");
  assert.doesNotMatch(plans, /phoenix_crm_list_not_ready/, "nothing about the rep's list refuses a plan any more");
  assert.doesNotMatch(source("src/components/phoenix-crm/plan-tab.tsx"), /phoenix_crm_list_not_ready/);

  // A pending customer is not stale. Stale blocks submitting, and he is planned on purpose.
  assert.match(
    plans,
    /if \(status !== "active" && status !== "pending"\) return true;/,
    "a customer who is not validated yet is not stale — marking him stale would block the rep from sending his week",
  );

  // He is never shown as having left the list: that is the one wrong word on the whole screen.
  const customer = source("src/components/phoenix-crm/list-customer.tsx");
  const pendingBranch = customer.indexOf('customer.status === "pending"');
  assert.ok(pendingBranch > 0, "the customer's page knows a pending customer");
  assert.match(customer, /\{!active && !pending \? <CrmPill>Left the list<\/CrmPill> : null\}/, '"Left the list" is shown only to a customer that actually left it');

  // The one sentence, said once and shared, so four screens cannot drift apart.
  const labels = source("src/components/phoenix-crm/labels.ts");
  for (const forbidden of [/\bcannot\b/i, /\bmust\b/i, /\bblocked\b/i, /\bmissing\b/i]) {
    const pending = labels.slice(labels.indexOf("PENDING_PILL"), labels.indexOf("export function monthVisitsText"));
    assert.doesNotMatch(pending, forbidden, "what a rep reads about a customer he has not validated states a fact with the fix inside it — never cannot, must, blocked or missing");
  }

  // The module's locked look, still: no horizontal scroll, no ellipsis, no rounded corner.
  for (const file of ["src/components/phoenix-crm/list-tab.tsx", "src/components/phoenix-crm/list-customer.tsx", "src/components/phoenix-crm/plan-tab.tsx", "src/components/phoenix-crm/list-screens.tsx"]) {
    const body = source(file);
    for (const banned of [/\btruncate\b/, /\bline-clamp-/, /\boverflow-x-auto\b/, /\brounded-(?!none\b)/]) {
      assert.doesNotMatch(body, banned, `${file} breaks the module's look`);
    }
  }
}

export function runPhoenixCrmPendingCustomerTests() {
  runPlanningTests();
  runPickerTests();
  runMigrationTests();
  runScreenTests();
}
