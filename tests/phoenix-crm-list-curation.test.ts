import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the SFE Manager curates a rep's list from outside it.
 *
 * Owner, 2026-10-06: "make the sfe able to enter on any med rep list and delete or drop from it any
 * irrelevant customer or move this customer to and choose where." Two acts, and they fail in opposite
 * directions if either is written loosely:
 *
 *   the DROP must not become a second way for a customer to leave a list. It is filed and decided as a
 *   `drop` request at the SFE step, exactly as `sfeBringBack` is, so the Archive still reads a reason, a
 *   decider and a time — and the REP's own ask still takes its two steps, the district manager then SFE
 *   (owner, 2026-09-29), which is the half a shortcut would quietly delete;
 *
 *   the MOVE must not become a drop-and-add. A validated place is fixed for ever and is keyed on the
 *   CUSTOMER, so re-adding him on the new seat would ask that rep to capture a second place for one
 *   doorway. The customer travels whole instead, and the plan report learns about it — otherwise the
 *   seat he left keeps every day it had already planned for him as a MISS, for a visit the save would
 *   now refuse. That is the same defect `20261002221947` fixed for a dropped customer, in its other
 *   shape, which is why the report is replaced in the same migration as the move.
 *
 * `list.ts` and `access.ts` are server files (they reach the database), so every layer is pinned by
 * source: the database, the service, the access rule, the route, and the button.
 */

const ROOT = new URL("../", import.meta.url);
const MIGRATION = "supabase/migrations/20261006121846_phoenix_crm_move_customer.sql";

function read(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

function raw(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n");
}

/** `export (async )?function name(...) { ... }` — the text from its signature to its closing brace at column 0. */
function functionBody(source: string, name: string): string {
  const match = new RegExp(`export (?:async )?function ${name}\\([\\s\\S]*?\\n\\}`).exec(source);
  assert.ok(match, `${name} is still declared as an exported function — this test resolves it by that name`);
  return match[0];
}

// ── 1. The database ──────────────────────────────────────────────────────────────────────────────
function checkDatabase(): void {
  const migration = raw(MIGRATION);

  // The record of a move, and nothing that can reach it from a browser key.
  assert.match(migration, /create table if not exists public\.phoenix_crm_customer_moves \(/, "every move is on record in its own table");
  assert.match(migration, /from_seat_id <> to_seat_id/, "a move goes somewhere else");
  assert.match(migration, /char_length\(btrim\(reason\)\) between 10 and 500/, "and carries a written reason, the same bounds a place move has");
  // Locked the way every other table in this module is — the four statements `phoenix-crm-boundary`
  // holds each of them to. PUBLIC is revoked and not only anon and authenticated, because those two
  // inherit the privilege THROUGH it and revoking the pair alone is a no-op.
  assert.match(migration, /alter table public\.phoenix_crm_customer_moves enable row level security;/, "RLS on");
  assert.match(
    migration,
    /create policy phoenix_crm_customer_moves_service_role\n  on public\.phoenix_crm_customer_moves for all to service_role using \(true\) with check \(true\);/,
    "with the one service-role policy the module's other tables carry",
  );
  assert.match(migration, /revoke all on table public\.phoenix_crm_customer_moves from public, anon, authenticated;/, "and nothing granted to a browser role");
  assert.match(migration, /grant all on table public\.phoenix_crm_customer_moves to service_role;/, "only the service role reaches it");

  const fn = /create or replace function public\.phoenix_crm_move_customer\(p jsonb\)([\s\S]*?)\n\$\$;/.exec(migration);
  assert.ok(fn, "phoenix_crm_move_customer is in this migration");
  const body = fn[1];

  assert.match(body, /raise exception 'phoenix_crm:same_seat';/, "moving a customer to the rep he is already with is refused");
  assert.match(body, /raise exception 'phoenix_crm:note_required';/, "a reason under ten characters is refused by the database too, not only by the screen");
  assert.match(body, /raise exception 'phoenix_crm:customer_dropped';/, "an archived customer is not on a list to hand over");
  assert.match(body, /raise exception 'phoenix_crm:not_on_list';/, "and neither is one waiting outside it");

  // 🔴 THE DUPLICATE IS THE WHOLE RISK OF A MOVE: one customer, one name key per seat and list.
  assert.match(
    body,
    /public\.phoenix_crm_fold_name\(c\.name\) = public\.phoenix_crm_fold_name\(v_customer\.name\)/,
    "the destination is checked on the FOLDED name, the same fold the sheet loader and the rename use",
  );
  assert.match(body, /c\.status <> 'dropped'/, "an archived namesake on the destination is not a clash — he is off the list");
  assert.match(body, /raise exception 'phoenix_crm:duplicate_at_destination';/, "and a real clash is refused rather than moved onto");
  assert.match(
    body,
    /c\.reference_contact_crm_id = v_customer\.reference_contact_crm_id/,
    "so is the destination already carrying his iReports360 row, which the unique index would refuse anyway",
  );

  // Both seats are locked, in a fixed order: two moves in opposite directions must not deadlock.
  assert.match(body, /pg_advisory_xact_lock\(hashtext\('phoenix_crm:seat:' \|\| least\(v_from_seat, v_to_seat\)\)\)/, "the lower seat is locked first");
  assert.match(body, /pg_advisory_xact_lock\(hashtext\('phoenix_crm:seat:' \|\| greatest\(v_from_seat, v_to_seat\)\)\)/, "then the higher one");

  // The customer travels whole.
  // Read the ONE statement that rewrites the customer and assert on its SET list alone. A blanket
  // search of the whole function is answered by the request withdrawal's own `set status = 'withdrawn'`
  // two statements below, so it passes while proving nothing — it did, before this was narrowed.
  const setList = /update public\.phoenix_crm_customers c\n  set ([\s\S]*?)\n  where /.exec(body);
  assert.ok(setList, "one statement rewrites the customer, and this is it");
  assert.equal(
    setList[1],
    "seat_id = v_to_seat,\n      line_code = v_to_line,\n      updated_at = now()",
    "it moves his seat and his line, and touches nothing else",
  );
  for (const kept of ["grade", "potential_grade", "validated_at", "status"]) {
    assert.doesNotMatch(
      setList[1],
      new RegExp(`\\b${kept}\\s*=`),
      `a move never rewrites ${kept} — the customer is handed over as he stands, not re-admitted`,
    );
  }
  assert.match(
    body,
    /update public\.phoenix_crm_places pl\s+set seat_id = v_to_seat,/,
    "and his clinics travel with him: a validated place is fixed for ever and belongs to the customer",
  );
  assert.doesNotMatch(body, /delete from public\.phoenix_crm_places/, "a move never deletes a place");
  assert.doesNotMatch(body, /update public\.phoenix_crm_visits/, "and never touches a visit: the work stays with the rep who did it");

  // What was waiting belonged to the seat he left.
  assert.match(body, /set status = 'withdrawn',/, "a request still waiting is withdrawn");
  assert.match(body, /'The customer moved to another rep'/, "with the reason on it, so the old rep's screen says what happened");

  // Each list's own history reads it.
  assert.match(body, /'customer_moved_out'/, "the list he left records that he went");
  assert.match(body, /'customer_moved_in'/, "and the list he joined records where he came from");

  // The one rule the new-migration audit also enforces, kept here because it is the function's teeth.
  assert.match(
    migration,
    /revoke execute on function public\.phoenix_crm_move_customer\(jsonb\) from public, anon, authenticated;/,
    "PUBLIC is revoked, not only anon and authenticated — they inherit EXECUTE through it",
  );
  assert.match(migration, /grant execute on function public\.phoenix_crm_move_customer\(jsonb\) to service_role;/, "and only the service role may call it");
}

// ── 2. The plan report counts him on one seat at a time ──────────────────────────────────────────
function checkPlanReport(): void {
  const migration = raw(MIGRATION);
  const fn = /create or replace function public\.phoenix_crm_report_plan_vs_actual\(([\s\S]*?)\n\$\$;/.exec(migration);
  assert.ok(fn, "the plan report is replaced in the same migration as the move — one without the other is the defect");
  const body = fn[1];

  assert.match(
    body,
    /left join lateral \(\s*select m\.to_seat_id\s*from public\.phoenix_crm_customer_moves m/,
    "each planned day asks which seat held the customer",
  );
  assert.match(
    body,
    /\(m\.moved_at at time zone 'Africa\/Cairo'\)::date <= i\.plan_date/,
    "as at the end of that CAIRO day — the UTC date would move a move made before 02:00 into the day before",
  );
  assert.match(body, /order by m\.moved_at desc, m\.id desc\s*limit 1/, "the NEWEST move at or before the day decides");
  assert.match(
    body,
    /\(held_by\.to_seat_id is null or held_by\.to_seat_id = pl\.seat_id\)/,
    "so a day after he was handed on is out of THIS seat's denominator, and no move at all changes nothing",
  );
  // A max(moved_at) would read "he once left" rather than "where is he now", and would keep excluding
  // the days after a customer moved BACK to the same rep.
  assert.doesNotMatch(body, /max\(m\.moved_at\)/, "the newest move, never the newest departure");

  // The dropped-customer rule of 20261002221947 is still there, untouched.
  assert.match(
    body,
    /c\.status <> 'dropped'\s*\n?\s*or i\.plan_date <= \(\(c\.status_changed_at at time zone 'Africa\/Cairo'\)::date\)/,
    "and a dropped customer's days after the drop are still out",
  );
}

// ── 3. The service ───────────────────────────────────────────────────────────────────────────────
function checkService(): void {
  const list = read("src/lib/phoenix-crm/server/list.ts");

  const drop = functionBody(list, "sfeDropFromList");
  const dropGate = drop.indexOf("assertListCurator(viewer, seat, isTest);");
  const dropCall = drop.indexOf("callPhoenixCrm");
  assert.ok(dropGate > -1 && dropCall > -1 && dropGate < dropCall, "WHO is checked before anything is written");
  assert.match(drop, /kind: "drop",/, "the drop is filed as a drop request");
  assert.match(drop, /first_stage: "sfe",/, "at the SFE step — never skipping the request trail");
  assert.match(drop, /decision: "approve",[\s\S]*?stage: "sfe",/, "and decided in the same breath, as a bring-back is");
  assert.match(drop, /const drop = parseDropDraft\(body\);/, "with a reason from the module's own list, the rep's own drop screen included");

  const move = functionBody(list, "moveCustomerToSeat");
  const moveGate = move.indexOf("assertListCurator(viewer, seat, isTest);");
  const moveCall = move.indexOf("callPhoenixCrm");
  assert.ok(moveGate > -1 && moveCall > -1 && moveGate < moveCall, "and before a customer is moved");
  // 🔴 THE DESTINATION IS RESOLVED IN THE ORGANOGRAM, NEVER TAKEN FROM THE PHONE: a seat id in a body
  // would otherwise move a customer onto a list the viewer cannot see, and set its line from the body.
  assert.match(
    move,
    /const target = viewer\.scopeTerritories\.find\(\(entry\) => entry\.seatId === toSeatId\);/,
    "the destination seat must be one the viewer already reaches",
  );
  assert.match(move, /if \(!target\) throw forbiddenError\(/, "and anything else is refused");
  assert.match(move, /const toLineCode = lineCodeOf\(target\);/, "the destination's LINE comes from the organogram, not the body");
  assert.match(move, /assertListCurator\(viewer, target, isTest\);/, "and he must be able to curate the list he is moving the customer ONTO as well");
  assert.match(move, /reason\.length < CUSTOMER_MOVE_REASON_MIN/, "a reason under ten characters never reaches the database");
  assert.match(list, /export const CUSTOMER_MOVE_REASON_MIN = 10;/, "which is ten, the same as a place move's");

  // The view carries both from the one rule, and the targets cost nothing for anybody else.
  assert.match(list, /canCurateList: canCurate,/, "the list view carries canCurateList from the one rule");
  assert.match(
    list,
    /const canCurate = canCurateList\(viewer, seat, isTest\);\s*const targetSeats = canCurate\s*\?/,
    "and the move targets are resolved only for a curator",
  );
  assert.match(
    list,
    /entry\.seatId !== seat\.seatId && Boolean\(entry\.lineCode\)/,
    "never this seat itself, and never a seat with no line, which could not hold a customer",
  );
  assert.match(list, /\.\.\.targetSeats\.map\(\(entry\) => entry\.occupantHrId\),/, "the reps' names ride in the batch this page already reads");
}

// ── 4. Who may do it ────────────────────────────────────────────────────────────────────────────
function checkAccess(): void {
  const access = read("src/lib/phoenix-crm/server/access.ts");
  const can = functionBody(access, "canCurateList");
  // One rule, delegated — not a second copy that drifts. Moving a clinic and moving a customer are the
  // same kind of act: rewriting a validated record somebody else captured, with a reason, on record.
  assert.match(can, /return canMovePlaces\(viewer, seat, isTest\);/, "curating a list is the place-movers' set of people, by delegation");
  const assertCurator = functionBody(access, "assertListCurator");
  assert.match(assertCurator, /if \(!canCurateList\(viewer, seat, isTest\)\) \{\s*throw forbiddenError\(/, "the assert is the same rule, refusing");

  // 🔴 AND THE REP'S OWN PATH IS UNCHANGED. createListRequest still routes a rep's ask through
  // firstRequestStage, which is the district manager wherever the territory has one.
  const list = read("src/lib/phoenix-crm/server/list.ts");
  const createRequest = functionBody(list, "createListRequest");
  assert.match(
    createRequest,
    /first_stage: firstRequestStage\(territoryReviewer\(viewer\.org, seat\.seatId\) !== null\),/,
    "a rep's own ask to drop still starts with his district manager — the SFE's own door never shortens it",
  );

  for (const [path, service] of [
    ["app/api/phoenix-crm/list/curate/drop/route.ts", "sfeDropFromList"],
    ["app/api/phoenix-crm/list/curate/move/route.ts", "moveCustomerToSeat"],
  ] as const) {
    const route = read(path);
    assert.match(route, /await assertPermission\(access, "phoenix_crm", "approve"\);/, `${path} is an approver's route`);
    assert.match(route, new RegExp(`${service}\\(viewer, body\\)`), `${path} goes through the service`);
    assert.match(route, /const csrf = assertSameOriginMutation\(request\);/, `${path} refuses a cross-origin write`);
  }

  // Both routes are declared, or the required `validate` job goes red on the access registry.
  const registry = read("src/lib/security/access-registry.ts");
  for (const pattern of ["/api/phoenix-crm/list/curate/drop", "/api/phoenix-crm/list/curate/move"]) {
    const line = registry.split("\n").find((entry) => entry.includes(`pattern: "${pattern}"`));
    assert.ok(line, `${pattern} is declared in the access registry`);
    assert.match(line, /classification: "mutation", required: true/, `${pattern} is an audited mutation`);
    assert.match(line, /csrfRequired: true/, `${pattern} requires CSRF`);
  }

  // The refusals the screen shows are the database's own codes, in words the SFE can act on.
  const db = read("src/lib/phoenix-crm/server/db.ts");
  assert.match(db, /same_seat: \{ status: 400,/, "same_seat has a sentence");
  assert.match(db, /duplicate_at_destination: \{\s*status: 409,/, "and so does a clash at the destination");
}

// ── 5. The screen ───────────────────────────────────────────────────────────────────────────────
function checkScreen(): void {
  const customer = read("src/components/phoenix-crm/list-customer.tsx");

  const gate = customer.indexOf("{view.canCurateList && (active || pending) ? (");
  assert.ok(gate > -1, "the SFE's two acts are drawn only where the server says canCurateList, and only on the list");
  assert.ok(
    customer.indexOf("<CurateFromList", gate) > gate && customer.indexOf("<CurateFromList", gate) - gate < 200,
    "and that gate is the one wrapping them",
  );

  assert.match(customer, /"\/api\/phoenix-crm\/list\/curate\/drop"/, "Drop from this list posts to the curate drop route");
  assert.match(customer, /"\/api\/phoenix-crm\/list\/curate\/move"/, "Move to another rep posts to the curate move route");
  assert.match(customer, /moveReady = toSeatId !== "" && moveReason\.trim\(\)\.length >= MOVE_CUSTOMER_REASON_MIN/, "the move waits for a rep and a reason");
  assert.match(customer, /disabled=\{!dropReason \|\| \(dropReason === "other" && !dropNote\.trim\(\)\)\}/, "and the drop waits for its reason");

  // 🔴 THE PICKER IS NAMES, NEVER CODES (owner's standing rule), and the admin combo box FLATTENS an
  // optgroup — so the line is written into each label instead, or the grouping is lost silently.
  assert.match(customer, /target\.repName \?\? "Seat with no rep today", target\.lineName, target\.territoryName/, "each option reads by the rep's name and his line");
  const picker = /<CrmSelect id="curate-move-to"[\s\S]*?<\/CrmSelect>/.exec(customer);
  assert.ok(picker, "the destination is a CrmSelect, which is a combo box on an admin account");
  assert.doesNotMatch(picker[0], /optgroup/, "and carries no optgroup, which that combo box would flatten away");
  assert.doesNotMatch(picker[0], /seatId\}<\//, "a seat id is the picker's value and is never printed");

  // The rep never sees any of this: the flag comes from the server, and his own view has it false.
  const list = read("src/lib/phoenix-crm/server/list.ts");
  assert.doesNotMatch(list, /canCurateList: true/, "nothing hands the flag out unconditionally");
}

export async function runPhoenixCrmListCurationTests() {
  checkDatabase();
  checkPlanReport();
  checkService();
  checkAccess();
  checkScreen();
}
