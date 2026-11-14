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
import { stripComments } from "./support/comment-strip.ts";

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
  assert.ok(declare.indexOf("canDecideSharedPlaces(viewer)") < declare.indexOf("getSupabaseAdmin()"), "the gate comes first");
  assert.ok(declare.includes('.in("status", ["active", "held"])'), "🔴 a rejected building is never written");
  assert.ok(
    declare.includes('declared ? guarded.is("timetable_exempt_at", null) : guarded.not("timetable_exempt_at", "is", null)'),
    "the update is guarded by the state it expects, so two clicks cannot both land",
  );
  assert.ok(declare.includes("{ timetable_exempt_at: stamp, timetable_exempt_by_hr_id: viewer.hrId, updated_at: stamp }"), "the two marker columns are set together");
  assert.ok(declare.includes("{ timetable_exempt_at: null, timetable_exempt_by_hr_id: null, updated_at: stamp }"), "and cleared together");
  for (const never of ["phoenix_crm_places", "phoenix_crm_customers", "phoenix_crm_validation_reviews", "callPhoenixCrm", "notify", "sendEmail"]) {
    assert.ok(!declare.includes(never), `🔴 the declaration writes the marker and nothing else — it never touches ${never}`);
  }

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

  const list = code("src/components/phoenix-crm/shared-place-list.tsx");
  assert.ok(list.includes('{mode === "team" ? null : <NoTimetableDeclaration row={row} />}'), "🔴 a district manager's board never draws the declaration");
  assert.ok(list.includes("const control = row.noTimetableControl ?? null;"), "the button is the row's own answer");
  assert.ok(list.includes("if (!control) return null;"));
  assert.ok(list.includes('{ sharedPlaceId: row.sharedPlaceId, declared: control === "declare" }'), "it posts the building and which of the two");

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
  assert.ok(panel.includes('<table className="w-full table-fixed border-collapse">') && panel.includes("<colgroup>"), "the desktop table fits its screen");
  assert.ok(!/overflow-x-auto|min-w-\[|rounded/.test(panel), "no sideways scroll and no round corner");
}
