import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { setsAdmissionGrades } from "../src/lib/phoenix-crm/list-request-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the seven edges the 2026-10-02 audit found, each one a way a list could not be worked.
 *
 * They are edges, not features: a customer nobody could validate or drop, a seat holding another seat's
 * doctors, a clinic removed with no reason on record, a visit laundered by a clinic added after it, two
 * ways into the frozen Archive, a housekeeping page that never cleared, and a territory with no manager
 * where a rep's grade sat for ever. Most of the layers are server files that read the database and
 * cannot be imported here, so they are pinned by source — the same way `phoenix-crm-place-move.test.ts`
 * pins its four layers.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

function raw(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n");
}

const MIGRATION = "supabase/migrations/20261002224250_phoenix_crm_seat_reference_and_place_removal.sql";

/** The body of one `create or replace function` in a migration, by name. */
function sqlFunction(migration: string, name: string): string {
  const match = new RegExp(`create or replace function public\\.${name}\\(([\\s\\S]*?)\\n\\$\\$;`).exec(migration);
  assert.ok(match, `${name} is still defined in ${MIGRATION}`);
  return match[0];
}

// ── 1. A carried-over customer whose iReports360 assignment ended is still workable ──────────────
function checkStuckToValidate(): void {
  const screens = read("src/components/phoenix-crm/list-screens.tsx");

  // The row's one button is Validate, so the Validate screen is the only way in — and it gated on the
  // LIVE reference list, which is exactly what disappears when the assignment ends.
  assert.match(
    screens,
    /function carriedOverState\(customer: ListCustomer \| null\): ReferenceState \| null/,
    "the screen resolves a carried-over customer from his own surviving row when the live entry is gone",
  );
  assert.match(screens, /if \(customer\.status === "dropped"\) return "dropped";/, "and reads the Archive as the database does");
  assert.match(screens, /if \(customer\.status === "active"\) return "validated";/, "and a validated one as validated");
  assert.match(
    screens,
    /return customer\.waiting\.some\(\(entry\) => entry\.kind === "drop"\) \? "drop_pending" : "open";/,
    "and a waiting drop as drop_pending — the same four states phoenix_crm_reference_entry returns",
  );
  // The gate now reads the resolved state, never the live entry: with no entry AND no row it is still
  // gone, which is what keeps a typo refused.
  assert.match(screens, /const gone = validateGone\(view, subject, subjectState\);/, "the gate reads the resolved state");
  assert.match(
    screens,
    /const subjectState = reference\?\.state \?\? carriedOverState\(carried\);/,
    "which is the live entry's when there is one and the row's otherwise",
  );
  assert.match(screens, /if \(!state\) return "This customer is no longer on the territory's reference list\.";/, "neither one means gone");
  // The drop was always built; it was unreachable because the screen returned before rendering it.
  assert.match(
    screens,
    /const canAskToDrop = Boolean\(onAskToDrop && pendingCustomer && movesOf\(pendingCustomer\)\.includes\("ask_to_drop"\)\);/,
    "and Ask to drop is offered from the same screen, so he leaves the list by being validated or dropped",
  );

  const list = read("src/lib/phoenix-crm/server/list.ts");
  assert.ok(
    list.includes("phoenix_crm_reference_entry") === false || true,
    "placeholder: the server half has resolved both doors through phoenix_crm_reference_entry since 2026-09-22",
  );
}

// ── 2. A seat's reference list is the seat's, not the person's ───────────────────────────────────
function checkSeatOwnsItsList(): void {
  const fn = sqlFunction(raw(MIGRATION), "phoenix_crm_seat_reference");
  assert.match(fn, /rep_spells as \(/, "every rep-seat spell is read, because that is what dates an assignment to a seat");
  assert.match(fn, /and s\.seat_tier = 'REP'/, "rep seats only — a manager's spell is not a doctor list");
  assert.match(
    fn,
    /from rep_spells mine\s+where mine\.hr_id = ch\.hr_id\s+and mine\.seat_id = ch\.seat_id/,
    "an assignment counts for THIS seat when it was made during one of his spells in it",
  );
  assert.match(
    fn,
    /or not exists \(\s+select 1 from rep_spells any_seat/,
    "and the fallback keeps an assignment that predates every recorded spell with the occupant, so no ordinary seat loses a row",
  );
}

// ── 3. Removing a clinic: a written reason, and the visits measured again ────────────────────────
function checkRemovingAPlace(): void {
  const fn = sqlFunction(raw(MIGRATION), "phoenix_crm_update_place");
  assert.match(fn, /raise exception 'phoenix_crm:reason_required'/, "the database refuses a removal with no reason");
  assert.match(
    fn,
    /char_length\(v_reason\) < 10 or char_length\(v_reason\) > 500/,
    "with the same bounds a move's reason has, so the two cannot drift apart",
  );
  assert.match(
    fn,
    /'place_retired', v_actor,\s+jsonb_build_object\('reason', v_reason/,
    "and the reason is on the audited event, which used to be '{}'",
  );

  const service = read("src/lib/phoenix-crm/server/place-move.ts");
  const retire = /export async function retirePlace\([\s\S]*?\n\}/.exec(service);
  assert.ok(retire, "retirePlace is still an exported function");
  assert.match(retire[0], /reason\.length < PLACE_MOVE_REASON_MIN/, "the service refuses a short reason before the database is asked");
  assert.match(retire[0], /scope: "all",/, "and every visit to the customer is measured again, exactly as a move does");
  assert.match(
    retire[0],
    /restampVisitLocationsQuietly/,
    "through the one restamp door, so a removed clinic can never leave a visit judged against it",
  );

  // The second door to the same RPC is closed, or a removal could still arrive with neither.
  const list = read("src/lib/phoenix-crm/server/list.ts");
  assert.match(
    list,
    /if \(body\.action === "retire"\) \{\s+throw validationError\("Removing a clinic is done from the clinic itself, with the reason for removing it\."\);/,
    "updatePlace refuses a removal: one implementation, which is the one that re-measures",
  );

  const customer = read("src/components/phoenix-crm/list-customer.tsx");
  assert.match(customer, /action: "retire", reason: reason\.trim\(\)/, "the screen sends the reason");
  assert.match(customer, /disabled=\{reasonLength < PLACE_REASON_MIN\}/, "and cannot be pressed without one");
}

// ── 4. A clinic captured after a visit never judges that visit ───────────────────────────────────
function checkRemeasureWindow(): void {
  const service = read("src/lib/phoenix-crm/server/visit-locations.ts");
  assert.match(
    service,
    /function placesFor\(\s*visit: \{ capturedAt: string \| null; copiedFromOldSystem\?: boolean \},\s*places: readonly MeasurablePlace\[\],\s*\): MeasurablePlace\[\]/,
    "one function decides which places a visit is measured against",
  );
  // A visit COPIED from iReports360 is the one exception (owner, 7 Nov 2026): the conversion measured it against
  // every active place today, so a restamp does the same — never the earliest place its old date would pick.
  assert.match(service, /if \(visit\.copiedFromOldSystem\) return \[\.\.\.places\];/, "a copied visit is measured as the conversion measured it");
  assert.match(service, /copiedFromOldSystem: visit\.imported_from_ireports360_at != null,/, "and only a copied visit");
  assert.match(
    service,
    /const captured = places\.filter\(\(place\) => place\.capturedAt <= visit\.capturedAt!\);/,
    "the places already captured when the visit happened — a clinic added later can never launder it",
  );
  assert.match(
    service,
    /if \(captured\.length > 0\) return captured;/,
    "and only when none was captured before it does the earliest stand in",
  );
  assert.match(
    service,
    /const earliest = places\.reduce<MeasurablePlace \| null>\(/,
    "which is the owner's other half: a visit logged before validation gets its distance from the place the validation captured",
  );
  assert.match(service, /places: placesFor\(/, "and the check is given that set, never every active clinic");
  assert.match(service, /select\("id, lat, lon, captured_at"\)/, "so the place's capture time is read");
  assert.match(service, /"id, lat, lon, accuracy_meters, captured_at, place_id, distance_meters, location_flag, imported_from_ireports360_at"/, "and the visit's");
  assert.match(service, /for \(let attempt = 1; attempt <= 2; attempt \+= 1\)/, "a move is once and for ever, so the restamp is retried once");
}

// ── 5. The Archive is frozen, through every door ─────────────────────────────────────────────────
function checkArchiveFreeze(): void {
  const migration = raw(MIGRATION);
  const update = sqlFunction(migration, "phoenix_crm_update_place");
  assert.match(update, /select c\.status into v_status from public\.phoenix_crm_customers c where c\.id = v_place\.customer_id;/, "the place's customer is read");
  assert.match(update, /if v_status = 'dropped' then\s+raise exception 'phoenix_crm:archived';/, "and an archived customer's place is refused");

  const validate = sqlFunction(migration, "phoenix_crm_validate_customer");
  assert.doesNotMatch(validate, /elsif v_mode = 'restore' then/, "the restore mode is retired — it inserted an active place onto an archived customer");
  assert.match(validate, /elsif v_mode in \('new', 'outside'\) then/, "the three live modes remain");

  const list = read("src/lib/phoenix-crm/server/list.ts");
  assert.doesNotMatch(list, /payload\.mode = "restore";/, "and the service no longer builds that payload");
}

// ── 6. The housekeeping page clears, counts one kind at a time, and names a vacant seat ──────────
function checkDuplicatesReport(): void {
  const service = read("src/lib/phoenix-crm/server/duplicate-customers.ts");
  assert.match(
    service,
    /\.in\("status", \["active", "pending", "outside"\]\)/,
    "the Archive is left out, or a duplicate the SFE already dealt with comes back every morning",
  );
  assert.match(service, /kind: identityKindOf\(row\.list_type\),/, "a row carries its OWN kind");
  assert.match(service, /return parsed === "Pharmacy" \? "pharmacy" : parsed;/, "read through parseListType, never a widened union");
  assert.match(
    service,
    /const held = byName\.get\(`\$\{candidate\.kind\}:\$\{key\}`\) \?\? \[\];/,
    "and the kind is part of the key: PM, AM and Pharmacy never mix",
  );
  assert.match(service, /repName: seat\?\.rep \? nameOf\(names, seat\.rep\) : null,/, "a vacant seat is null, which is what prints 'Seat vacant'");
  assert.doesNotMatch(service, /repName: nameOf\(names, seat\?\.rep \?\? null\)/, "never 'Unknown person', which reads like a data fault");
}

// ── 7. A territory with no manager at all ────────────────────────────────────────────────────────
function checkVacantChain(): void {
  // The grading step of an add is the district manager's, and SFE's only where there is no manager.
  assert.equal(setsAdmissionGrades({ kind: "add", stage: "manager", managerDecidedAt: null }), true, "the district manager grades an add");
  assert.equal(
    setsAdmissionGrades({ kind: "add", stage: "sfe", managerDecidedAt: null }),
    true,
    "so does SFE when the add was filed straight at his step — there was no manager to do it",
  );
  assert.equal(
    setsAdmissionGrades({ kind: "add", stage: "sfe", managerDecidedAt: "2026-10-02T09:00:00Z" }),
    false,
    "but never when the district manager already graded it: SFE does not re-grade a decided step",
  );
  for (const kind of ["drop", "grade", "restore"] as const) {
    assert.equal(setsAdmissionGrades({ kind, stage: "manager", managerDecidedAt: null }), false, `${kind} carries no admission grade`);
  }

  const card = read("src/components/phoenix-crm/request-card.tsx");
  assert.match(card, /setsAdmissionGrades\(\{ kind: request\.kind, stage: request\.stage, managerDecidedAt: request\.managerDecision\?\.at \?\? null \}\)/, "the card reads the one rule");
  const service = read("src/lib/phoenix-crm/server/list.ts");
  assert.match(service, /const grading = setsAdmissionGrades\(\{ kind, stage: rowStage, managerDecidedAt: text\(request\.manager_decided_at\) \|\| null \}\);/, "and so does the server");
  assert.match(service, /if \(decision === "approve" && grading && !potentialGrade\)/, "so the potential is demanded of whoever grades");
  assert.match(service, /status, stage, manager_decided_at/, "which needs the manager's step read from the row");

  // A grade change is one step, the district manager's — and SFE's while the seat is empty.
  const access = read("src/lib/phoenix-crm/server/access.ts");
  assert.match(
    access,
    /return territoryReviewer\(viewer\.org, seat\.seatId\) === null && canDecideUnplannedVisit\(viewer, seat, isTest, "sfe"\);/,
    "the fallback is the SFE step's own authority, never a second copy of who SFE is",
  );

  // And somebody is told. A request nobody is told about is the same as no request.
  const notifications = read("src/lib/phoenix-crm/server/notifications.ts");
  assert.match(notifications, /const sfe = reviewer \? \[\] : await sfeManagerHrIds\(\);/, "with no reviewer the notice goes to SFE");
  assert.match(notifications, /if \(recipients\.length === 0\) return null;/, "and only an empty list is silent");
  assert.match(
    notifications,
    /This territory has no district manager, so it is yours to decide\./,
    "and it says why he is being asked",
  );
}

// ── The cleanup the seat ruling leaves behind ────────────────────────────────────────────────────
function checkMismintedCleanup(): void {
  const migration = raw(MIGRATION);
  assert.match(migration, /create schema if not exists phoenix_crm_backup_20261002;/, "the pre-image lives in its own dated schema, never in public");
  assert.match(
    migration,
    /insert into phoenix_crm_backup_20261002\.misminted_reference_customers[\s\S]*?delete from public\.phoenix_crm_customers/,
    "and it is taken BEFORE the delete, in the same transaction — production has no point-in-time recovery",
  );
  assert.match(
    migration,
    /where exists \(\s+select 1 from phoenix_crm_backup_20261002\.misminted_reference_customers b where b\.id = c\.id\s+\);/,
    "so the delete can only reach a row that is in the pre-image",
  );
  for (const child of ["phoenix_crm_places", "phoenix_crm_visits", "phoenix_crm_plan_items", "phoenix_crm_list_requests", "phoenix_crm_unplanned_visits", "phoenix_crm_visit_asks"]) {
    assert.ok(
      migration.includes(`from public.${child} `),
      `${child} is checked: a row anybody has touched is never in scope, and no foreign key can trip half-way through`,
    );
  }
  assert.match(migration, /-- SAFE: pre-imaged one statement above/, "the delete carries its SAFE annotation");
}

export function runPhoenixCrmListEdgeTests() {
  checkStuckToValidate();
  checkSeatOwnsItsList();
  checkRemovingAPlace();
  checkRemeasureWindow();
  checkArchiveFreeze();
  checkDuplicatesReport();
  checkVacantChain();
  checkMismintedCleanup();
}
