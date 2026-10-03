import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  FLUSH_AT_EVENTS,
  MAX_EVENTS_PER_BATCH,
  MAX_LABEL_CHARS,
  MAX_QUEUED_EVENTS,
  MAX_VALUE_CHARS,
  SCROLL_SAMPLE_MS,
  TOUCH_TRAIL_KINDS,
  describeElement,
  isSecretField,
  labelOf,
  parseTouchTrailBatch,
  valueForTrail,
} from "../src/lib/phoenix-crm/touch-trail.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE PHOENIX CRM TOUCH TRAIL (owner, 2026-10-03: "every click or every touch on the touch screen for
// this module to be saved in a separate audit trail for Phoenix CRM. Every separate touch, every
// single thing is saved, even if the rep didn't save it … anything you can record, anything you can
// capture … like a file manager grabber. Anything touches him, automatically saved.").
//
// WHAT IT COST NOT TO HAVE IT. Both of 3 Oct's incidents were reconstructed hours afterwards out of
// upload slots and storage bytes, because the module recorded only what a rep SUCCEEDED in saving.
// One rep was refused eighteen times between 16:12 and 18:47 and left no row anywhere; a second was
// refused nine times in 67 seconds and the retry loop he was stuck in — same photo, same reading,
// nine presses — existed nowhere but in his hands. `phoenix_crm_refused_readings` closed that for ONE
// door. This closes it for the module: the screen he opened, the field he filled, the comment he
// typed and abandoned, the button he pressed that did nothing.
//
// FOUR RULES THIS MUST NOT BREAK, AND EVERY ONE OF THEM IS PINNED BELOW:
//   · 🔴 THE REP LEARNS NOTHING NEW (Golden Rule #1). Nothing is drawn, nothing is delayed, nothing is
//     cancelled. The collector returns null, every listener is `{capture, passive}`, and the route
//     answers 204 whatever happened — a readable body would itself tell a rep this exists.
//   · 🔴 IT NEVER COSTS A REP HIS WORK. Every function here is total and every path swallows.
//   · 🔴 A PASSWORD-TYPE FIELD'S VALUE NEVER LEAVES THE BROWSER — dropped at capture, so there is no
//     stored secret for a later redaction to forget.
//   · 🔴 THE ACTOR AND THE TEST FLAG COME FROM THE SESSION, NEVER FROM THE BODY.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATION = "supabase/migrations/20261003221224_phoenix_crm_touch_trail.sql";
const RULES = "src/lib/phoenix-crm/touch-trail.ts";
const COLLECTOR = "src/components/phoenix-crm/touch-trail-collector.tsx";
const WRITER = "src/lib/phoenix-crm/server/touch-trail.ts";
const ROUTE = "app/api/phoenix-crm/touch-trail/route.ts";
const REGISTRY = "src/lib/security/access-registry.ts";
const PORTAL_LAYOUT = "app/employee-portals/field-crm/layout.tsx";
const ADMIN_LAYOUT = "app/(admin)/admin/field-crm/layout.tsx";

function source(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. A SECRET IS DROPPED AT CAPTURE, AND EVERYTHING ELSE THE REP TYPED IS KEPT
// ─────────────────────────────────────────────────────────────────────────────

function runSecretTests() {
  assert.equal(isSecretField({ type: "password" }), true, "a password field is a secret");
  assert.equal(isSecretField({ type: "PASSWORD" }), true, "whatever its case");
  assert.equal(isSecretField({ type: "text", autocomplete: "current-password" }), true, "a text field a password manager fills is a secret");
  assert.equal(isSecretField({ type: "text", autocomplete: "one-time-code" }), true, "and so is a one-time code");
  assert.equal(isSecretField({ type: "text", name: "newPassword" }), true, "and a field NAMED for a password, whatever its type");
  assert.equal(isSecretField({ type: "textarea", name: "comment" }), false, "a comment box is not a secret");
  assert.equal(isSecretField({}), false, "and an unnamed, untyped element is not one either");

  const secret = valueForTrail({ type: "password", name: "password" }, "hunter2hunter");
  assert.equal(secret.value, null, "🔴 a password's TEXT is never recorded, at the point of capture");
  assert.equal(secret.valueLength, 13, "its LENGTH is — that a password of 13 characters was typed tells a failed sign-in from an abandoned one, and discloses nothing");

  // The thing the owner asked for by name: the comment a rep wrote and then deleted.
  const abandoned = valueForTrail(
    { type: "textarea", name: "comment" },
    "Dr Hassan asked for the Pedia leaflet and said he would start with two patients",
  );
  assert.equal(
    abandoned.value,
    "Dr Hassan asked for the Pedia leaflet and said he would start with two patients",
    "the comment a rep typed is kept IN FULL, including one he goes on to delete — the single most useful thing in this table",
  );
  assert.equal(abandoned.valueLength, 79, "with its length beside it");

  const long = valueForTrail({ type: "textarea" }, "x".repeat(MAX_VALUE_CHARS + 500));
  assert.equal(long.value?.length, MAX_VALUE_CHARS, `a body longer than ${MAX_VALUE_CHARS} is stored cut to it`);
  assert.equal(long.valueLength, MAX_VALUE_CHARS + 500, "and the TRUE length is still recorded, so nothing silently looks shorter than it was");
  assert.doesNotMatch(long.value ?? "", /…|\.\.\./, "cut, never ellipsed — an added ellipsis is indistinguishable from one the rep typed himself");

  assert.deepEqual(valueForTrail({ type: "text" }, ""), { value: null, valueLength: 0 }, "an empty field records nothing and says so");
  assert.deepEqual(valueForTrail({ type: "text" }, null), { value: null, valueLength: 0 }, "and a missing value is total, never a throw");
  assert.deepEqual(valueForTrail({ type: "checkbox" }, "true"), { value: "true", valueLength: 4 }, "a checkbox's state is its value");
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. AN ELEMENT IS NAMED SO THAT LAST MONTH'S ROWS STILL MATCH THIS MONTH'S CODE
// ─────────────────────────────────────────────────────────────────────────────

function runDescriptorTests() {
  assert.equal(
    describeElement({ tag: "BUTTON", trailId: "save-visit", id: "x17", name: "save" }),
    "button@save-visit",
    "a hand-placed data-trail wins — it is the only name a refactor cannot rename out from under this table",
  );
  assert.equal(describeElement({ tag: "INPUT", type: "text", name: "comment" }), "input[type=text]#name=comment", "then the form identity a developer already maintains");
  assert.equal(describeElement({ tag: "DIV", id: "day-card" }), "div#day-card", "then the id");
  assert.equal(describeElement({ tag: "SECTION" }), "section", "and a tag alone is a legitimate descriptor");
  assert.equal(describeElement({}), "unknown", "an element with nothing at all still produces a row, never a throw");
  assert.equal(describeElement({ tag: "BUTTON", role: "tab" }), "button[role=tab]", "a role is carried, because two identical buttons differ by it");

  const descriptor = describeElement({ tag: "button", trailId: "save", id: "a", name: "b", role: "button", type: "submit" });
  assert.doesNotMatch(descriptor, /flex|rounded|px-|text-|bg-/, "🔴 a class list is NEVER part of a descriptor — Tailwind classes change with every restyle and would make last month's rows unmatchable");
  assert.doesNotMatch(source(RULES), /className|classList|\.class\b/, "and the rules file never reaches for one");

  assert.equal(labelOf("  Save   the\n visit  "), "Save the visit", "a label is flattened to the words a human would have read");
  assert.equal(labelOf("   "), null, "whitespace is no label");
  assert.equal(labelOf(undefined), null, "nor is a missing one");
  assert.equal(labelOf("y".repeat(MAX_LABEL_CHARS + 40))?.length, MAX_LABEL_CHARS, `a label is capped at ${MAX_LABEL_CHARS} — a tap landing on a card must not record the whole card`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE SERVER'S READ IS TOTAL — RUBBISH RECORDS LESS, NEVER AN ERROR
// ─────────────────────────────────────────────────────────────────────────────

function runParseTests() {
  const good = parseTouchTrailBatch({
    events: [{ kind: "tap", msSinceLoad: 1240, element: "button@save-visit", pointerX: 180.6, pointerY: 402.2 }],
    seatId: "SEAT-BENHA-1",
    sessionId: "c0ffee",
    test: false,
  });
  assert.ok(good, "a well-formed batch reads back");
  assert.equal(good.events.length, 1);
  assert.equal(good.events[0].pointerX, 181, "a fractional CSS pixel is rounded, never refused");
  assert.equal(good.sessionId, "c0ffee");
  assert.equal(good.test, false);

  assert.equal(parseTouchTrailBatch(null), null, "nothing at all is nothing to record");
  assert.equal(parseTouchTrailBatch("not json"), null, "and neither is a string");
  assert.equal(parseTouchTrailBatch({ events: [{ kind: "tap" }] }), null, "a batch with no sessionId is dropped — a row that cannot be put back in sequence is not evidence");
  assert.equal(parseTouchTrailBatch({ sessionId: "a", events: [] }), null, "an empty batch writes nothing");
  assert.equal(parseTouchTrailBatch({ sessionId: "a", events: "lots" }), null, "a non-array events field is dropped, not iterated");

  const mixed = parseTouchTrailBatch({
    sessionId: "a",
    events: [{ kind: "tap" }, { nokind: true }, null, "tap", { kind: "   " }, { kind: "press" }],
  });
  assert.ok(mixed, "a batch with some bad events still records the good ones");
  assert.deepEqual(mixed.events.map((event) => event.kind), ["tap", "press"], "exactly the events that name a kind");

  const flood = parseTouchTrailBatch({
    sessionId: "a",
    events: Array.from({ length: MAX_EVENTS_PER_BATCH + 50 }, () => ({ kind: "scroll" })),
  });
  assert.equal(flood?.events.length, MAX_EVENTS_PER_BATCH, `one request writes at most ${MAX_EVENTS_PER_BATCH} rows — a browser cannot make the server insert without limit`);

  const nonsense = parseTouchTrailBatch({
    sessionId: "a",
    events: [{ kind: "tap", msSinceLoad: "banana", deviceAt: "not a date", pointerX: Number.POSITIVE_INFINITY, viewportW: "375" }],
  });
  assert.equal(nonsense?.events[0].msSinceLoad, null, "an unreadable number becomes null");
  assert.equal(nonsense?.events[0].deviceAt, null, "an unreadable date becomes null");
  assert.equal(nonsense?.events[0].pointerX, null, "and so does an infinity, which would break the insert");
  assert.equal(nonsense?.events[0].viewportW, 375, "a numeric string is read, because a browser is allowed to be sloppy");

  const overlong = parseTouchTrailBatch({ sessionId: "a", events: [{ kind: "type", value: "z".repeat(MAX_VALUE_CHARS + 10) }] });
  assert.equal(overlong?.events[0].value?.length, MAX_VALUE_CHARS, "and the cap is enforced AGAIN on the way in, not only at capture");

  // Scroll is the only sampled kind, and the kinds are a stated set.
  assert.ok(TOUCH_TRAIL_KINDS.includes("scroll"), "scroll is one of the kinds");
  assert.ok(SCROLL_SAMPLE_MS >= 1_000, "and it is coalesced to at most one row a second per screen — kept, because 'he scrolled the list and pressed nothing' is a real finding");
  assert.ok(FLUSH_AT_EVENTS <= MAX_EVENTS_PER_BATCH, "the buffer flushes well before a batch is full, so nothing is ever trimmed for size");
  assert.ok(MAX_QUEUED_EVENTS > 0, "and an offline phone holds a bounded queue, never an unbounded one");
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE REP CANNOT TELL IT EXISTS (GOLDEN RULE #1)
// ─────────────────────────────────────────────────────────────────────────────

function runBlindTests() {
  const collector = source(COLLECTOR);
  const code = stripComments(collector);

  assert.match(code, /return null;\s*}\s*$/, "the collector renders NOTHING — it returns null");
  assert.match(code, /capture:\s*true,\s*passive:\s*true/, "🔴 every listener is capture-phase and PASSIVE, so it can never swallow or delay a rep's own tap");
  assert.doesNotMatch(code, /addEventListener\([^)]*\)\s*;?\s*\/\/.*non-passive/i, "and nothing opts back out of it");
  for (const forbidden of [/preventDefault/, /stopPropagation/, /stopImmediatePropagation/, /\balert\(/, /confirm\(/]) {
    assert.doesNotMatch(code, forbidden, `the collector never ${String(forbidden)} — it observes, it does not intervene`);
  }
  assert.doesNotMatch(code, /beforeunload/, "🔴 `pagehide`, never `beforeunload` — the latter makes a page ineligible for the back/forward cache, which is a cost a rep WOULD feel");
  assert.match(code, /pagehide/, "and the leaving flush is on pagehide");
  assert.match(code, /sendBeacon/, "handed to sendBeacon, because a closing page has no promise left to await");

  // Every error path swallows. Count the catches rather than naming them: the shape is what matters.
  const catches = (code.match(/catch\s*(?:\([^)]*\))?\s*{/g) ?? []).length;
  assert.ok(catches >= 7, `every path swallows — found only ${catches} catch blocks, so something now throws into a rep's session`);
  assert.match(code, /\.catch\(\(\) =>/, "and a rejected post is swallowed too, not left unhandled");
  assert.doesNotMatch(code, /\bthrow\b/, "🔴 the collector NEVER throws: a trail that fails is a trail with a hole in it, never a rep who is stuck");

  // The secret is dropped HERE, in the browser, not on the way in.
  assert.match(code, /valueForTrail/, "the collector asks valueForTrail for a field's contents");
  assert.doesNotMatch(code, /\bfield\.value\b[^;]*JSON\.stringify/, "and never puts a raw field value straight into a request body");

  const writer = source(WRITER);
  assert.match(writer, /console\.error/, "a failed insert is LOGGED");
  assert.doesNotMatch(stripComments(writer), /\bthrow\b/, "and never thrown — the rep is not waiting on this and must never pay for it");
  assert.match(writer, /Promise<void>/, "the writer returns void, like every other evidence writer in this module");

  const route = source(ROUTE);
  const routeCode = stripComments(route);
  assert.equal((routeCode.match(/status:\s*204/g) ?? []).length, 4, "🔴 the route answers 204 on EVERY path — a count, an id or an error message is exactly what would tell a rep this table exists");
  assert.doesNotMatch(routeCode, /NextResponse\.json/, "it never returns a readable body");
  assert.doesNotMatch(routeCode, /phoenixCrmFailure/, "not even the module's own failure helper, which writes one");
  assert.match(routeCode, /await request\.text\(\)/, "🔴 the body is read as TEXT and parsed — a beacon's content type is the browser's to choose, and request.json() would refuse the flush from a page that is already closing");
  assert.match(routeCode, /assertSameOriginMutation/, "the shared CSRF gate still runs");
  assert.match(routeCode, /assertPermission\(access, "phoenix_crm", "read"\)/, "and the permission is `read` — a rep who may OPEN the module is a rep whose taps belong in its trail");

  // Rule 4: the two fields an investigation leans on come from the session.
  assert.match(routeCode, /personKey\(access\.hrId\)/, "🔴 the ACTOR is resolved from the session, never read from the body");
  assert.doesNotMatch(routeCode, /actorHrId:\s*batch\./, "a browser can never name whose hands these were");
  assert.match(routeCode, /Boolean\(access\.testPersona\) \|\| batch\.test/, "🔴 and the test flag is the session's OR the body's — a body may only ADD it, so a real rep cannot hide in the test world by claiming he is in it");

  // Mounted once per subtree, in both halves of the module.
  for (const [path, label] of [[PORTAL_LAYOUT, "the rep's app"], [ADMIN_LAYOUT, "the admin twin"]] as const) {
    const layout = source(path);
    assert.match(layout, /PhoenixCrmTouchTrail/, `${label} mounts the collector`);
    assert.match(layout, /\{children\}/, `${label} still renders its children — the layout adds nothing else`);
    assert.doesNotMatch(stripComments(layout), /className|<div|<p>|style=/, `${label} draws NOTHING of its own`);
  }

  assert.match(
    source(REGISTRY),
    /pattern: "\/api\/phoenix-crm\/touch-trail", permission: \{ resource: "phoenix_crm", action: "read" \}/,
    "the route is declared in the access registry — without it the required `validate` job goes red, and nothing would state what gates it",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE TABLE ITSELF
// ─────────────────────────────────────────────────────────────────────────────

function runMigrationTests() {
  const migration = source(MIGRATION);
  const sql = stripSqlComments(migration);

  assert.match(sql.trim(), /^begin;/, "one transaction");
  assert.match(sql.trim(), /commit;$/, "committed at the very end");
  assert.match(sql, /set local lock_timeout = '5s';/, "waiting at most five seconds for any lock");
  assert.match(sql, /notify pgrst, 'reload schema';/, "and the API sees the new table without a restart");

  assert.match(sql, /create table if not exists public\.phoenix_crm_touch_trail \(/, "it creates the one table");
  assert.equal((sql.match(/\bcreate\s+table\b/gi) ?? []).length, 1, "and only that one");
  assert.doesNotMatch(sql, /create or replace function/i, "it defines no function");
  assert.doesNotMatch(sql, /\balter table public\.phoenix_crm_(?!touch_trail)/i, "and alters nothing that already exists");

  for (const statement of [
    "alter table public.phoenix_crm_touch_trail enable row level security;",
    "create policy phoenix_crm_touch_trail_service_role\n  on public.phoenix_crm_touch_trail for all to service_role using (true) with check (true);",
    "revoke all on table public.phoenix_crm_touch_trail from public, anon, authenticated;",
    "grant all on table public.phoenix_crm_touch_trail to service_role;",
  ]) {
    assert.ok(migration.includes(statement), `locked to the service role — missing: ${statement.split("\n")[0]}`);
  }

  assert.doesNotMatch(sql, /\bcurrent_date\b/i, "a day is always the Cairo day, stated — current_date is the database's UTC day");
  assert.match(sql, /visit_day date/, "so the caller writes visit_day from cairoBusinessDay");
  assert.match(sql, /occurred_at timestamptz not null default now\(\)/, "the server's clock is the one nobody can set");
  assert.match(sql, /device_at timestamptz/, "the phone's own is kept beside it, because a disagreement between them is itself a finding");
  assert.match(sql, /id bigint generated always as identity primary key/, "a monotonic key, so this table can be paged by keyset — PostgREST stops at 1,000 rows with no error and no marker");

  assert.doesNotMatch(
    sql,
    /\bunique\b/i,
    "🔴 and it is deliberately UNKEYED — nine identical presses are nine rows, and a constraint on any column here would collapse exactly the repetition that IS the evidence",
  );

  assert.match(migration, /drop table if exists public\.phoenix_crm_touch_trail;/, "with its rollback stated");
  assert.match(migration, /index if not exists phoenix_crm_touch_trail_session_idx/, "and the index that replays one page load in order");
}

export function runPhoenixCrmTouchTrailTests() {
  runSecretTests();
  runDescriptorTests();
  runParseTests();
  runBlindTests();
  runMigrationTests();
}
