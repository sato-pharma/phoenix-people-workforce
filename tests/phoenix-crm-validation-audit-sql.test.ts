import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripSqlComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM validation audit, 14 Nov 2026 — the SQL half:
 * supabase/migrations/20261114050048_phoenix_crm_validation_audit_fixes.sql.
 *
 * The file replaces four functions, each from the body production held, and changes four things:
 *
 *   1. phoenix_crm_validate_customer — a pending validation review holds the door only while the place it is
 *      about is still active (both doors: the reference list and a customer already listed).
 *   2. phoenix_crm_place_on_trusted_point — it withdraws a drop request still pending on the customer it
 *      validates, as the other validating doors do, and upper-cases the actor.
 *   3. phoenix_crm_insert_place — a place seated in a building is written with no pin reading.
 *   4. `reopened_at` is cleared by every update in these functions that validates a customer.
 *
 * Every pin reads the file with its comments blanked, so the prose that explains a change can never satisfy
 * the pin for it. Each block fails by itself when its change is taken back: remove one `and exists (… pl.status
 * = 'active')` line and block 1 fails; remove the `withdrawn` statement or the `upper(` and block 2 fails; put
 * a bare `coalesce(… 'pin_lat' …)` back and block 3 fails; remove any one `reopened_at = null` and block 4
 * fails.
 */

const ROOT = new URL("../", import.meta.url);
const MIGRATION = "supabase/migrations/20261114050048_phoenix_crm_validation_audit_fixes.sql";
const FUNCTIONS = [
  "phoenix_crm_validate_customer",
  "phoenix_crm_decide_validation_review",
  "phoenix_crm_place_on_trusted_point",
  "phoenix_crm_insert_place",
] as const;
const PLACE_STILL_ACTIVE = String.raw`\s+and exists \(select 1 from public\.phoenix_crm_places pl where pl\.id = r\.place_id and pl\.status = 'active'\)\s+\) then\s+raise exception 'phoenix_crm:location_in_review';`;

function migration(): { raw: string; sql: string } {
  const raw = readFileSync(new URL(MIGRATION, ROOT), "utf8").replace(/\r\n/g, "\n");
  return { raw, sql: stripSqlComments(raw) };
}

/** One function's text, from its `create or replace` line to the line before its closing `$$;`. */
function functionSql(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} is replaced by the migration`);
  const end = sql.indexOf("\n$$;", start);
  assert.ok(end > start, `${name} ends in "$$;"`);
  return sql.slice(start, end);
}

function count(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

function runFileShapeTests(raw: string, sql: string) {
  const opening = sql.split("\n").map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(opening.slice(0, 2), ["begin;", "set local lock_timeout = '5s';"], "one transaction that waits at most 5 seconds for a lock");
  assert.match(sql.trim(), /commit;$/, "it commits at the very end");
  assert.match(sql, /\nnotify pgrst, 'reload schema';\n/, "the API reloads its schema");

  const replaced = [...sql.matchAll(/\bcreate or replace function public\.([a-z_]+)\(/g)].map((match) => match[1]);
  assert.deepEqual([...replaced].sort(), [...FUNCTIONS].sort(), "it replaces these four functions and no other");
  assert.equal(count(sql, /\bcreate\s+(?:or\s+replace\s+)?function\b/gi), FUNCTIONS.length, "no fifth function, and no overload");
  for (const name of FUNCTIONS) {
    const header = new RegExp(String.raw`create or replace function public\.${name}\(([^$]*)\nas \$\$`).exec(sql);
    assert.ok(header, `${name}'s header ends in "as $$"`);
    assert.match(header[1], /\nsecurity definer\nset search_path to 'public'$/, `${name} is SECURITY DEFINER with a fixed search path`);
    assert.equal(
      count(sql, new RegExp(String.raw`^revoke execute on function public\.${name}\([^)]*\) from public, anon, authenticated;$`, "gm")),
      1,
      `${name} is taken away from public, anon and authenticated`,
    );
    assert.equal(
      count(sql, new RegExp(String.raw`^grant execute on function public\.${name}\([^)]*\) to service_role;$`, "gm")),
      1,
      `${name} is given back to the service role`,
    );
  }
  assert.doesNotMatch(sql, /\bgrant\b[^;]*\bto\s+[^;]*\b(?:anon|authenticated|public)\b/i, "nothing is granted to anon, authenticated or public");

  // The header says which body each function started from: the digest production answered before the file.
  for (const digest of [
    "9afe35c9423006f25758c15b2132b850",
    "77737492e3003b763a4580f170aee0f0",
    "4ccbbaf14c251ad0c77534cdeaa1e9fc",
    "0c9e11e60c6d2efa353e38b3c99f7b81",
  ]) {
    assert.ok(raw.includes(digest), `the header records the production body it replaces (${digest})`);
  }
}

/** 1. A review of a place that is no longer active holds nobody at the door. */
function runReviewOfAnActivePlaceTests(sql: string) {
  const door = functionSql(sql, "phoenix_crm_validate_customer");
  assert.match(
    door,
    new RegExp(String.raw`where r\.customer_id = v_ref\.customer_id and r\.status = 'pending'` + PLACE_STILL_ACTIVE),
    "the reference door refuses location_in_review only for a pending review of a place that is still active",
  );
  assert.match(
    door,
    new RegExp(String.raw`where r\.customer_id = v_customer\.id and r\.status = 'pending'` + PLACE_STILL_ACTIVE),
    "the listed door refuses location_in_review only for a pending review of a place that is still active",
  );
  assert.equal(count(door, /raise exception 'phoenix_crm:location_in_review';/g), 2, "the door refuses location_in_review in two places");
  assert.doesNotMatch(
    door,
    /from public\.phoenix_crm_validation_reviews r\s+where r\.customer_id = [a-z_.]+ and r\.status = 'pending'\s+\) then/,
    "neither door counts a pending review whatever became of its place",
  );
}

/** 2. The trusted point withdraws a pending drop request where it validates, and stores the actor upper-cased. */
function runTrustedPointTests(sql: string) {
  const trusted = functionSql(sql, "phoenix_crm_place_on_trusted_point");
  assert.match(
    trusted,
    /\n  v_actor text := upper\(nullif\(trim\(coalesce\(p ->> 'actor_hr_id', ''\)\), ''\)\);\n/,
    "the actor's HR id is upper-cased on the way in",
  );
  assert.match(
    trusted,
    new RegExp(
      String.raw`if v_customer\.status = 'pending' then\s+update public\.phoenix_crm_customers c\s+set status = 'active',[^;]*where c\.id = v_customer\.id;` +
        String.raw`\s+with withdrawn as \(\s+update public\.phoenix_crm_list_requests q\s+set status = 'withdrawn',[^;]*` +
        String.raw`decided_by_hr_id = v_actor,\s+decision_note = 'Validated instead of dropped'\s+` +
        String.raw`where q\.seat_id = v_seat\s+and q\.is_test = v_is_test\s+and q\.kind = 'drop'\s+and q\.status = 'pending'\s+and \(\s+` +
        String.raw`q\.customer_id = v_customer\.id\s+or \(q\.customer_id is null and v_customer\.reference_contact_crm_id is not null and q\.reference_contact_crm_id = v_customer\.reference_contact_crm_id\)\s+\)\s+` +
        String.raw`returning q\.id\s+\)\s+insert into public\.phoenix_crm_list_events \(seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test\)\s+` +
        String.raw`select v_seat, v_customer\.id, w\.id, 'request_withdrawn', v_actor, jsonb_build_object\('why', 'validated'\), v_is_test\s+from withdrawn w;` +
        String.raw`\s+v_event := 'customer_validated';\s+else\s+v_event := 'place_added';`,
    ),
    "validating on a trusted point withdraws his pending drop request and writes request_withdrawn — and only in the branch that validates",
  );
  assert.equal(count(trusted, /with withdrawn as \(/g), 1, "the withdrawal runs once, where the customer becomes active");
}

/** 3. A seating has no reading of its own: the building's point is never copied into the pin. */
function runSeatedPlacePinTests(sql: string) {
  const insert = functionSql(sql, "phoenix_crm_insert_place");
  for (const [pin, point, cast] of [
    ["pin_lat", "lat", "double precision"],
    ["pin_lon", "lon", "double precision"],
    ["pin_accuracy_meters", "accuracy_meters", "numeric"],
  ] as const) {
    assert.ok(
      insert.includes(
        `\n    case when v_source = 'shared_place' then null else coalesce((p_place ->> '${pin}')::${cast}, (p_place ->> '${point}')::${cast}) end,\n`,
      ),
      `${pin} is null for a place seated in a building, and the reading (or the one point sent) for any other`,
    );
    assert.equal(count(insert, new RegExp(String.raw`p_place ->> '${pin}'`, "g")), 1, `${pin} is read in one place only`);
  }
  assert.doesNotMatch(insert, /^\s*coalesce\(\(p_place ->> 'pin_/m, "no pin column is written without asking whether the place is a seating");
  assert.match(insert, /\n  v_source text := coalesce\(p_place ->> 'point_source', 'pin'\);\n/, "v_source is still the place's own point_source");
}

/** 4. A validated customer carries no stamp of an old refusal. */
function runRefusalStampTests(sql: string) {
  const validating = [...sql.matchAll(/update public\.phoenix_crm_customers c\s+set status = 'active',[^;]*;/g)].map((match) => match[0]);
  assert.equal(validating.length, 4, "four updates in the file validate a customer: two at the door, the approval of a held one, the trusted point");
  for (const statement of validating) {
    assert.match(statement, /\n\s+reopened_at = null,\n/, `the update that validates a customer clears reopened_at — ${statement.split("\n").slice(0, 4).join(" ").replace(/\s+/g, " ")}`);
  }
  for (const [name, updates] of [
    ["phoenix_crm_validate_customer", 2],
    ["phoenix_crm_decide_validation_review", 1],
    ["phoenix_crm_place_on_trusted_point", 1],
    ["phoenix_crm_insert_place", 0],
  ] as const) {
    assert.equal(count(functionSql(sql, name), /\breopened_at = null\b/g), updates, `${name} clears reopened_at ${updates} time(s)`);
  }
  // The refusal still stamps it: clearing on validation must never have taken the stamp itself away.
  assert.match(
    functionSql(sql, "phoenix_crm_decide_validation_review"),
    /update public\.phoenix_crm_customers c\s+set reopened_at = now\(\), updated_at = now\(\)\s+where c\.id = v_customer\.id and c\.status = 'pending';/,
    "a refused validation still stamps reopened_at on the customer it sends back",
  );
}

export async function runPhoenixCrmValidationAuditSqlTests(): Promise<void> {
  const { raw, sql } = migration();
  runFileShapeTests(raw, sql);
  runReviewOfAnActivePlaceTests(sql);
  runTrustedPointTests(sql);
  runSeatedPlacePinTests(sql);
  runRefusalStampTests(sql);
}
