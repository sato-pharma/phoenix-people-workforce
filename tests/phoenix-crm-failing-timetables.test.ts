import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  FAILING_TIMETABLE_LOOKBACK_DAYS,
  FAILING_TIMETABLE_MIN_DAYS,
  failingTimetableSentence,
  failingTimetables,
  noTimetableControl,
  NO_TIMETABLE_DECLARE_EXPLAINER,
  type TimetableRefusal,
} from "../src/lib/phoenix-crm/failing-timetable-rules.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

/**
 * Timetables that keep failing, and the Super Admin's "This building has no timetable" (owner, 14 Nov
 * 2026, "List + declare").
 *
 * Measured that morning: 380 timetable photographs refused in 30 days across 174 buildings, 28 of them
 * refused on two or more different days, and no screen named them. The declaration existed only as two
 * columns set by hand on one building.
 */

const ROOT = new URL("../", import.meta.url);

function code(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

function refusal(sharedPlaceId: string | null, repHrId: string | null, visitDate: string | null, refusedAt: string): TimetableRefusal {
  return { sharedPlaceId, repHrId, visitDate, refusedAt };
}

export function runPhoenixCrmFailingTimetablesTests(): void {
  assert.equal(FAILING_TIMETABLE_LOOKBACK_DAYS, 30);
  assert.equal(FAILING_TIMETABLE_MIN_DAYS, 2);

  // ── Which buildings are listed, and in what order ─────────────────────────────────────────────
  const listed = failingTimetables([
    // One rep's ordinary tries on ONE day: it already ends in a hold the administrator sees.
    refusal("one-day", "B-1", "2026-11-10", "2026-11-10T09:00:00Z"),
    refusal("one-day", "B-1", "2026-11-10", "2026-11-10T09:02:00Z"),
    refusal("one-day", "B-1", "2026-11-10", "2026-11-10T09:04:00Z"),
    // A refusal with no visit day is never a second day for a building refused on one.
    refusal("one-day", "B-1", null, "2026-11-11T09:00:00Z"),
    // Two different days.
    refusal("two-days", "b-2", "2026-11-03", "2026-11-03T10:00:00Z"),
    refusal("two-days", "B-2", "2026-11-09", "2026-11-09T10:00:00Z"),
    // Three different days, two people.
    refusal("three-days", "B-3", "2026-11-01", "2026-11-01T08:00:00Z"),
    refusal("three-days", "B-3", "2026-11-05", "2026-11-05T08:00:00Z"),
    refusal("three-days", "B-4", "2026-11-12", "2026-11-12T08:00:00Z"),
    refusal("three-days", "B-4", "2026-11-12", "2026-11-12T08:03:00Z"),
    // Rows that cannot say which building or which day.
    refusal(null, "B-5", "2026-11-12", "2026-11-12T08:00:00Z"),
    refusal("no-day", "B-5", null, "2026-11-11T08:00:00Z"),
    refusal("no-day", "B-5", null, "2026-11-12T08:00:00Z"),
  ]);
  assert.deepEqual(
    listed.map((building) => building.sharedPlaceId),
    ["three-days", "two-days"],
    "🔴 only a building refused on two or more DIFFERENT days is listed, the one refused on the most days first",
  );
  assert.deepEqual(listed[0], { sharedPlaceId: "three-days", refusals: 4, days: 3, reps: 2, lastRefusedAt: "2026-11-12T08:03:00Z" });
  assert.equal(listed[1].reps, 1, "one person written in two cases is one person");
  assert.deepEqual(failingTimetables([]), []);

  const tie = failingTimetables([
    refusal("older", "B-1", "2026-11-01", "2026-11-01T08:00:00Z"),
    refusal("older", "B-1", "2026-11-02", "2026-11-02T08:00:00Z"),
    refusal("newer", "B-1", "2026-11-08", "2026-11-08T08:00:00Z"),
    refusal("newer", "B-1", "2026-11-09", "2026-11-09T08:00:00Z"),
    refusal("more", "B-1", "2026-11-01", "2026-11-01T08:00:00Z"),
    refusal("more", "B-1", "2026-11-02", "2026-11-02T08:00:00Z"),
    refusal("more", "B-1", "2026-11-02", "2026-11-02T08:05:00Z"),
  ]);
  assert.deepEqual(tie.map((building) => building.sharedPlaceId), ["more", "newer", "older"], "equal days: the most refusals, then the most recent");

  assert.equal(failingTimetableSentence({ refusals: 4, days: 3, reps: 2 }), "4 timetable photos refused on 3 different days, from 2 people");
  assert.equal(failingTimetableSentence({ refusals: 2, days: 2, reps: 1 }), "2 timetable photos refused on 2 different days", "one person is not counted aloud");

  // ── Who may declare, and on which building ────────────────────────────────────────────────────
  assert.equal(noTimetableControl({ canDeclare: true, status: "active", exempt: false }), "declare");
  assert.equal(noTimetableControl({ canDeclare: true, status: "held", exempt: false }), "declare", "a building still being checked can be declared");
  assert.equal(noTimetableControl({ canDeclare: true, status: "active", exempt: true }), "withdraw", "a declared building can be taken back");
  assert.equal(noTimetableControl({ canDeclare: true, status: "retired", exempt: false }), null, "🔴 a rejected building takes neither");
  assert.equal(noTimetableControl({ canDeclare: true, status: "retired", exempt: true }), null);
  assert.equal(noTimetableControl({ canDeclare: false, status: "active", exempt: false }), null, "🔴 nobody but the Super Admin is drawn the button");
  assert.equal(noTimetableControl({ canDeclare: false, status: "active", exempt: true }), null);
  assert.ok(NO_TIMETABLE_DECLARE_EXPLAINER.includes("Nobody is validated by this"), "🔴 the first click says what the declaration does NOT do");

  // ── The read ──────────────────────────────────────────────────────────────────────────────────
  const server = code("src/lib/phoenix-crm/server/failing-timetables.ts");
  const load = server.slice(server.indexOf("export async function loadFailingTimetables("), server.indexOf("export type NoTimetableDeclaration"));
  assert.ok(load.includes("if (!canDecideValidationReviews(viewer)) return EMPTY;"), "🔴 the list is the deciders' alone — anybody else is handed nothing");
  assert.ok(load.includes('.in("reason", ["timetable_unreadable", "timetable_missing"])'), "only the two timetable refusals are read");
  assert.ok(load.includes('.eq("is_test", false)'), "a test entry is never listed");
  assert.match(
    load,
    /return Boolean\(row\) && row\?\.status !== "retired" && !row\?\.timetable_exempt_at && row\?\.is_test !== true;/,
    "🔴 a rejected building and one declared to have no timetable are not listed",
  );
  assert.ok(load.includes("total: listed.length,"), "the count is every listed building, not only the ones drawn");

  // ── The declaration ───────────────────────────────────────────────────────────────────────────
  const declare = server.slice(server.indexOf("export async function setSharedPlaceNoTimetable("));
  assert.ok(
    declare.includes('if (!canDecideSharedPlaces(viewer)) throw forbiddenError("Only the Super Admin declares that a building has no timetable.");'),
    "🔴 the Super Admin alone, checked before anything is read",
  );
  assert.ok(declare.indexOf("canDecideSharedPlaces(viewer)") < declare.indexOf("callPhoenixCrm"), "the gate comes first");
  // Owner, 14 Nov 2026: "Record who took back". The marker and its trail row are one transaction, so the
  // app no longer writes the two columns itself: it calls the one function, and names who is doing it.
  assert.ok(
    declare.includes('callPhoenixCrm<Row | null>("phoenix_crm_set_shared_place_no_timetable", {\n    p: { shared_place_id: sharedPlaceId, actor_hr_id: viewer.hrId, declared },'),
    "🔴 the declaration and its take-back go through the ONE database function, with who is doing it",
  );
  assert.equal(declare.split("callPhoenixCrm").length - 1, 1, "and that one call is the only thing it runs");
  assert.ok(declare.includes('if (outcome === "written") return { sharedPlaceId, name: String(answer?.name ?? ""), declared };'));
  assert.ok(declare.includes('if (outcome === "missing") throw notFoundError('), "a building that is gone is said so");
  assert.ok(declare.includes('if (outcome === "retired") throw conflictError('), "🔴 a rejected building is refused, in words");
  assert.ok(declare.includes('if (outcome === "unchanged") {'), "a second click is told the first one landed");
  for (const never of ["getSupabaseAdmin", ".update(", ".insert(", "phoenix_crm_places", "phoenix_crm_customers", "phoenix_crm_validation_reviews", "notify", "sendEmail"]) {
    assert.ok(!declare.includes(never), `🔴 the declaration writes the marker and its trail and nothing else — it never touches ${never}`);
  }

  // ── The function, and the trail it writes ─────────────────────────────────────────────────────
  const migration = stripSqlComments(
    readFileSync(new URL("supabase/migrations/20261114155530_phoenix_crm_shared_place_timetable_marks.sql", ROOT), "utf8").replace(/\r\n/g, "\n"),
  );
  const fn = migration.slice(migration.indexOf("create or replace function public.phoenix_crm_set_shared_place_no_timetable(p jsonb)"), migration.indexOf("$$;"));
  assert.ok(fn.length > 0, "the migration defines the function");
  assert.ok(fn.includes("from public.phoenix_crm_shared_places sp where sp.id = v_id for update;"), "🔴 the building's row is locked, so two clicks cannot both land");
  assert.ok(fn.includes("if v_place.status not in ('active', 'held') then\n    return jsonb_build_object('outcome', 'retired');"), "🔴 a rejected building is never written");
  assert.ok(
    fn.includes("if v_declared = (v_place.timetable_exempt_at is not null) then\n    return jsonb_build_object('outcome', 'unchanged');"),
    "a building already in the state asked for is left as it is, with no trail row",
  );
  assert.ok(fn.indexOf("for update;") < fn.indexOf("update public.phoenix_crm_shared_places sp"), "every check is made under the lock, before the first write");
  assert.ok(fn.includes("set timetable_exempt_at = now(), timetable_exempt_by_hr_id = v_actor, updated_at = now()"), "the two marker columns are set together");
  assert.ok(fn.includes("set timetable_exempt_at = null, timetable_exempt_by_hr_id = null, updated_at = now()"), "and cleared together");
  assert.ok(
    fn.includes("values (v_id, 'taken_back', v_actor, now(), v_place.timetable_exempt_at, v_place.timetable_exempt_by_hr_id);"),
    "🔴 a take-back records who took it back, and keeps whose declaration it ended and when — the building's two columns are cleared at that moment",
  );
  assert.ok(fn.includes("values (v_id, 'declared', v_actor, now());"), "a declaration leaves its own row too");
  assert.equal(fn.split("update public.").length - 1, 2, "the building is the only row it updates, once on each side");
  assert.equal(fn.split("insert into public.phoenix_crm_shared_place_timetable_marks").length - 1, 2, "and the trail is the only table it inserts into");
  for (const never of ["phoenix_crm_places", "phoenix_crm_customers", "phoenix_crm_validation_reviews", "delete from", "outbox", "notif"]) {
    assert.ok(!fn.includes(never), `🔴 the function validates nobody and tells nobody — it never touches ${never}`);
  }
  assert.ok(
    migration.indexOf("grant all on table public.phoenix_crm_shared_place_timetable_marks to service_role;") >= 0 &&
      migration.indexOf("grant all on table public.phoenix_crm_shared_place_timetable_marks to service_role;") <
        migration.indexOf("revoke update, delete on table public.phoenix_crm_shared_place_timetable_marks from service_role;"),
    "🔴 the trail is append-only: after the module's lock, update and delete are taken back from the app too",
  );
  // And TRUNCATE, which empties the whole trail in one statement and skips row security (owner, 14 Nov 2026:
  // "fix the truncate grant"). A later file, because the first was already applied on both databases.
  const noTruncate = stripSqlComments(
    readFileSync(new URL("supabase/migrations/20261114173756_phoenix_crm_timetable_marks_no_truncate.sql", ROOT), "utf8").replace(/\r\n/g, "\n"),
  );
  assert.ok(
    noTruncate.includes("revoke truncate on table public.phoenix_crm_shared_place_timetable_marks from service_role;"),
    "🔴 the app cannot empty the trail either",
  );
  assert.ok(
    noTruncate.includes("and privilege_type in ('TRUNCATE', 'UPDATE', 'DELETE');") && noTruncate.includes("raise exception 'phoenix_crm_shared_place_timetable_marks: service_role still holds %'"),
    "and the migration refuses to commit while the service role still holds any of the three",
  );
  assert.ok(!/\bgrant\b/i.test(noTruncate.replace(/role_table_grants/g, "")), "it grants nothing");
  assert.ok(
    !/\.from\("phoenix_crm_shared_place_timetable_marks"\)\s*\.(?:insert|update|upsert|delete)\(/.test(code("src/lib/phoenix-crm/server/shared-places.ts") + server),
    "and no service writes the trail itself: the function is its only writer",
  );
  assert.ok(migration.includes("alter table public.phoenix_crm_shared_place_timetable_marks enable row level security;"));
  assert.ok(
    migration.includes("revoke execute on function public.phoenix_crm_set_shared_place_no_timetable(jsonb) from public, anon, authenticated;") &&
      migration.includes("grant execute on function public.phoenix_crm_set_shared_place_no_timetable(jsonb) to service_role;"),
    "the function is the server's alone",
  );

  const route = code("app/api/phoenix-crm/validation-reviews/shared-place/no-timetable/route.ts");
  assert.ok(route.includes('await assertPermission(access, "phoenix_crm", "update");'), "the route's first gate is `update`, which the SFE Manager does not hold");
  assert.ok(route.indexOf("assertSameOriginMutation(request)") < route.indexOf("assertPermission("), "CSRF is checked before anything else");
  assert.ok(!/export async function (GET|PUT|PATCH|DELETE)\b/.test(route), "POST only");
  assert.ok(
    code("src/lib/security/access-registry.ts").includes(
      'pattern: "/api/phoenix-crm/validation-reviews/shared-place/no-timetable", permission: { resource: "phoenix_crm", action: "update" }',
    ),
    "and the registry names the same permission",
  );

  // ── The screens ───────────────────────────────────────────────────────────────────────────────
  const places = code("src/lib/phoenix-crm/server/shared-places.ts");
  assert.ok(places.includes("const canDeclare = canDecideSharedPlaces(viewer);"), "the board asks once who may declare");
  assert.ok(
    places.includes("noTimetableControl: noTimetableControl({ canDeclare, status: base.status, exempt: text(row.timetable_exempt_at) !== null }),"),
    "and every row says what this viewer may do",
  );
  // The last take-back, on the building's own row (owner, 14 Nov 2026: "Record who took back").
  assert.ok(
    places.includes("const takeBacks = decides ? await loadTimetableTakeBacks() : new Map<string, Row>();"),
    "🔴 the trail is read for the deciders alone — a manager's board never learns who took anything back",
  );
  assert.ok(
    places.includes('.from("phoenix_crm_shared_place_timetable_marks")') && places.includes('.eq("action", "taken_back")'),
    "it reads the take-backs from the trail",
  );
  assert.ok(
    places.includes('.order("acted_at", { ascending: false })\n        .order("id", { ascending: false }),\n    { maxRows: 5_000,') && places.includes("if (!latest.has(building)) latest.set(building, row);"),
    "newest first, and the first one met for a building is its latest",
  );
  assert.ok(
    places.includes("const takenBack = text(row.timetable_exempt_at) ? null : (takeBacks.get(String(row.id)) ?? null);"),
    "🔴 a building declared again shows its declaration, never the take-back before it",
  );
  assert.ok(
    places.includes('byName: decides ? nameOf(names, text(takenBack.actor_hr_id), "The administrator") : null,') &&
      places.includes('declaredByName: decides ? nameOf(names, text(takenBack.declared_by_hr_id), "The administrator") : null,'),
    "both people are named, never shown as a code",
  );

  const list = code("src/components/phoenix-crm/shared-place-list.tsx");
  assert.ok(list.includes('{mode === "team" ? null : <NoTimetableDeclaration row={row} />}'), "🔴 a district manager's board never draws the declaration");
  assert.ok(list.includes("const control = row.noTimetableControl ?? null;"), "the button is the row's own answer");
  assert.ok(list.includes("if (!control) return null;"));
  assert.ok(list.includes('{ sharedPlaceId: row.sharedPlaceId, declared: control === "declare" }'), "it posts the building and which of the two");
  assert.ok(
    list.includes('{mode === "team" || !row.timetableTakenBack ? null : ('),
    "🔴 the take-back line is drawn only where there is one, and never on a district manager's board",
  );
  assert.ok(
    list.includes("was taken back by {row.timetableTakenBack.byName}, {row.timetableTakenBack.atText}.") &&
      list.includes("{row.timetableTakenBack.declaredByName}, {row.timetableTakenBack.declaredAtText}."),
    "it says who took it back and when, and whose declaration that was",
  );

  const board = code("src/components/phoenix-crm/validation-reviews-board.tsx");
  assert.ok(board.includes("{!team && failingTimetables ? ("), "🔴 the list is drawn on the deciders' board only");
  assert.ok(
    board.includes("venues: sharedPlaces.filter((venue) => venue.sharedPlaceId === onlyBuilding), seated, filters: EMPTY_VALIDATION_REVIEW_FILTERS, cutoff: null"),
    "🔴 a building opened from the list is read past the filters",
  );
  const page = code("app/(admin)/admin/field-crm/validation-reviews/page.tsx");
  assert.ok(page.includes("loadFailingTimetables(viewer),") && page.includes("failingTimetables={failingTimetables}"), "the Super Admin's page reads it and hands it in");
  assert.ok(!code("app/employee-portals/place-checks/page.tsx").includes("failingTimetables"), "🔴 the district manager's page never does");

  const panel = code("src/components/phoenix-crm/failing-timetables-panel.tsx");
  assert.ok(panel.includes("if (view.total === 0) return null;"), "nothing failing, nothing drawn");
  assert.ok(
    panel.includes('<CrmTable columns={["32%", "46%", "22%"]}>') && !panel.includes("<table"),
    "🔴 the desktop table is the module's own CrmTable, never a table written by hand",
  );
  assert.ok(panel.includes("<CrmCardsOnPhone>"), "and the same buildings are cards on a phone");
  assert.ok(!/overflow-x-auto|min-w-\[|rounded/.test(panel), "no sideways scroll and no round corner");
}
