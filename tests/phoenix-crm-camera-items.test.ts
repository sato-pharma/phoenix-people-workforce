import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  CAMERA_DAILY_CAP_DEFAULT,
  CAMERA_REVIEWS_PATH,
  cameraApproveAllowed,
  cameraArrival,
  cameraDayAllowance,
  cameraDuration,
  cameraFixGapText,
  cameraSenderName,
  cameraTakenAt,
  cameraVisitDraft,
  parseCameraCap,
  parseCameraDayAllowance,
  type CameraArrivalInput,
  type CameraTime,
} from "../src/lib/phoenix-crm/camera-item-rules.ts";
import { reasonsFor } from "../src/lib/phoenix-crm/validation-feedback.ts";

/**
 * The Phoenix Camera's items and the Super Admin's camera page (owner, 20 Nov 2026: "Phoenix will not reject
 * anything ... leave the decision to the decision maker"; a cap of 3 a day with a tab to control it; "Every camera
 * visit and validation lands there"; "Exclude the SFE totally"). Amended 21 Nov 2026: "EVERY VISIT GOES TO MANUAL REVIEW
 * FIRST" (nothing records itself), and "U ARE ALLOWED 3 A DAYS IF MORE NEEDED WE NEED APPROVAL FROM MANAGERS VIA EMAIL
 * AND SYSTEM ADMIN WILL UPDATE IT FOR THIS DAY ONLY".
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

const at = (iso: string) => new Date(iso);
const anchored = (iso: string): CameraTime => ({ takenAt: at(iso), source: "anchor" });

function arrival(overrides: Partial<CameraArrivalInput>) {
  return cameraArrival({
    intent: "visit",
    sealHolds: true,
    locationProblems: [],
    time: anchored("2026-11-20T09:50:00Z"),
    receivedAt: at("2026-11-20T10:00:00Z"),
    sentThatDay: 0,
    allowance: 3,
    ...overrides,
  });
}

function timeComesFromPhoenixFirst(): void {
  const anchor = at("2026-11-20T08:00:00Z");
  assert.deepEqual(
    cameraTakenAt({ anchorCapturedAt: anchor, sealHolds: true, timeSource: "satellites", takenAtUtc: "2026-11-20T09:00:00Z" }),
    { takenAt: anchor, source: "anchor" },
    "Phoenix's own anchor outranks the satellites",
  );
  assert.equal(
    cameraTakenAt({ anchorCapturedAt: null, sealHolds: true, timeSource: "satellites", takenAtUtc: "2026-11-20T09:00:00Z" }).source,
    "satellites",
    "with no anchor, the satellites' time inside a seal that holds",
  );
  assert.equal(
    cameraTakenAt({ anchorCapturedAt: null, sealHolds: false, timeSource: "satellites", takenAtUtc: "2026-11-20T09:00:00Z" }).source,
    "unconfirmed",
    "a seal that does not hold vouches for no time",
  );
  assert.deepEqual(
    cameraTakenAt({ anchorCapturedAt: null, sealHolds: true, timeSource: "phone", takenAtUtc: "2026-11-20T09:00:00Z" }),
    { takenAt: null, source: "unconfirmed" },
    "the phone's own clock is never enough",
  );
}

function arrivalAlwaysWaitsOrArchives(): void {
  assert.deepEqual(arrival({}), { outcome: "waiting", reasons: [], takenDay: "2026-11-20" }, "every check passed, and it still waits for the Super Admin");
  assert.deepEqual(arrival({ sentThatDay: 2 }), { outcome: "waiting", reasons: [], takenDay: "2026-11-20" }, "the third of the day waits with no reason");
  assert.deepEqual(arrival({ sentThatDay: 3 }).reasons, ["over_cap"], "the fourth is marked over the day's allowance");
  assert.deepEqual(arrival({ sentThatDay: 3, allowance: 5 }).reasons, [], "a raised day takes more without the mark");
  assert.deepEqual(arrival({ sentThatDay: 1, allowance: 0 }).reasons, ["over_cap"], "an allowance below one is read as one");
  assert.deepEqual(arrival({ intent: "validate", sentThatDay: 9 }).reasons, [], "only a visit spends the allowance");
  assert.equal(CAMERA_DAILY_CAP_DEFAULT, 3);
  for (const input of [{}, { sentThatDay: 9 }, { sealHolds: false }, { intent: "new_customer" as const }]) {
    assert.notEqual(arrival(input).outcome, "recorded", "nothing the camera sends records itself");
  }

  // The day's allowance: 3, raised for one rep and one day only, and Approve stops there.
  assert.equal(cameraDayAllowance(3, null), 3);
  assert.equal(cameraDayAllowance(3, 5), 5, "the Super Admin's raise for that day");
  assert.equal(cameraDayAllowance(3, 2), 3, "a raise never lowers the daily limit");
  assert.equal(cameraDayAllowance(0, null), 1);
  assert.deepEqual(cameraApproveAllowed(2, 3), { ok: true }, "the third may be approved");
  const fourth = cameraApproveAllowed(3, 3);
  assert.equal(fourth.ok, false, "the fourth is refused until that day is raised");
  assert.match(fourth.ok ? "" : fourth.reason, /3 of 3 camera visits already approved[\s\S]*manager's approval is in by email/);
  assert.deepEqual(cameraApproveAllowed(3, 4), { ok: true }, "a raised day approves one more");
  assert.equal(parseCameraDayAllowance("5"), 5);
  for (const bad of [0, 21, 2.5, "x", null]) assert.equal(parseCameraDayAllowance(bad), null, `${String(bad)} is refused`);

  // The Phoenix day ends at 02:00 Cairo: 01:30 on the 20th is still the 19th's.
  assert.deepEqual(
    arrival({ time: anchored("2026-11-19T23:30:00Z"), receivedAt: at("2026-11-19T23:50:00Z") }),
    { outcome: "waiting", reasons: [], takenDay: "2026-11-19" },
    "01:30 belongs to the day before, and arriving before 02:00 is the same day",
  );
  assert.deepEqual(
    arrival({ time: anchored("2026-11-19T20:00:00Z"), receivedAt: at("2026-11-20T10:00:00Z") }).reasons,
    ["next_day"],
    "arriving after its Phoenix day ended waits for approval",
  );
  assert.deepEqual(
    arrival({ time: anchored("2026-11-18T20:00:00Z"), receivedAt: at("2026-11-20T10:00:00Z") }),
    { outcome: "archived", reasons: ["too_old"], takenDay: "2026-11-18" },
    "over 36 hours goes to the archive",
  );

  const everything = arrival({
    intent: "new_customer",
    sealHolds: false,
    locationProblems: ["No position"],
    time: { takenAt: null, source: "unconfirmed" },
    sentThatDay: 9,
  });
  assert.equal(everything.outcome, "waiting");
  assert.deepEqual(everything.reasons, ["seal_failed", "new_customer", "time_unconfirmed", "no_location"], "every reason at once; a new customer spends no visit allowance");
  assert.equal(everything.takenDay, null);
  assert.deepEqual(arrival({ intent: "new_customer" }).reasons, ["new_customer"], "a new customer always waits for the Super Admin");
}

function capAndDraftParse(): void {
  assert.equal(parseCameraCap(3), 3);
  assert.equal(parseCameraCap(" 20 "), 20);
  for (const bad of [0, 21, 2.5, "abc", "", null, undefined, -1]) assert.equal(parseCameraCap(bad), null, `${String(bad)} is refused`);

  const offPlan = cameraVisitDraft({ visitType: "out_of_plan", unplannedReason: " The doctor asked me to come today ", products: ["A", "A", " B ", ""], comment: " ok " });
  assert.deepEqual(offPlan, { planned: false, reason: "The doctor asked me to come today", kind: "single", picked: [], products: ["A", "B"], comment: "ok" });
  assert.deepEqual(cameraVisitDraft({ kind: "double", managerHrId: "b-77" }).picked, ["B-77"]);
  assert.equal(cameraVisitDraft({ kind: "double" }).kind, "single", "a double with nobody named is a single");
  assert.deepEqual(cameraVisitDraft({ kind: "chain", managerHrId: "B-1" }), { planned: true, reason: null, kind: "double", picked: ["B-1"], products: [], comment: null });
  assert.equal(cameraVisitDraft({ kind: "chain", managerHrId: "B-1", seniorHrId: "B-2" }).kind, "chain");
  assert.equal(cameraVisitDraft(null).planned, true);
}

function pageWords(): void {
  assert.equal(cameraDuration(42), "42 s");
  assert.equal(cameraDuration(7 * 60 + 5), "7 min");
  assert.equal(cameraDuration(2 * 3600 + 5 * 60), "2 h 5 min");
  assert.equal(cameraDuration(27 * 3600), "1 day 3 h");
  assert.equal(cameraFixGapText(null), null);
  assert.equal(cameraFixGapText(0), "Position taken with the photo");
  assert.equal(cameraFixGapText(90), "Position taken 1 min before the photo");
  assert.equal(cameraFixGapText(-30), "Position taken 30 s after the photo");
}

function aNoTimetableBuildingIsNeverRefusedForOne(): void {
  assert.ok(reasonsFor("schedule").some((reason) => reason.key === "schedule_missing"));
  assert.ok(!reasonsFor("schedule", { buildingHasNoTimetable: true }).some((reason) => reason.key === "schedule_missing"));
  assert.equal(reasonsFor("schedule", { buildingHasNoTimetable: true }).length, reasonsFor("schedule").length - 1, "only that one reason goes");
  const field = read("src/components/phoenix-crm/refusal-reason-field.tsx");
  assert.match(field, /reasonsFor\(kind, \{ buildingHasNoTimetable \}\)/);
  assert.match(read("src/components/phoenix-crm/shared-place-customers.tsx"), /<RefusalReasonField buildingHasNoTimetable=\{noTimetable\}/);
}

function theSyncReceivesEverything(): void {
  const sync = read("src/lib/phoenix-crm/server/field-camera-sync.ts");
  assert.match(sync, /function assertApp\(client: CaptureClient\): void \{\s*[^\n]*\n\s*if \(client !== "app"\) throw notFoundError/, "a browser is answered 404");
  assert.equal(sync.split("assertApp(client);").length - 1, 2, "both the pack and the sync are the app's alone");
  assert.match(sync, /if \(form\.enteredAs !== "rep"\) throw notFoundError/, "the pack is the territory's own rep's");
  assert.match(sync, /\.filter\(\(customer\) => !customer\.outside\)/, "the pack never carries a customer outside his list");
  assert.match(sync, /return receiveCameraItem\(\{ viewer, seat, isTest, bytes, draft \}\)/, "every item goes to the camera page's door");
  assert.match(sync, /export type FieldCameraSyncResult = typeof CAMERA_RECEIVED;/, "the phone is told one thing");
  assert.match(sync, /customerTypes: CUSTOMER_TYPES\.filter\(\(type\) => type !== "Pharmacy"\)/, "a pharmacy is never added from the camera");
  assert.match(sync, /latestApp,/, "the pack carries the newest release for the update button");
  assert.match(sync, /signCameraFile\(String\(row\.storage_path\), RELEASE_URL_SECONDS\)/, "the release link is signed by the one file that opens the camera bucket");

  const items = read("src/lib/phoenix-crm/server/camera-items.ts");
  assert.match(items, /export const CAMERA_RECEIVED = \{ success: true as const, status: "received" as const \};/);
  const receive = items.slice(items.indexOf("export async function receiveCameraItem("), items.indexOf("export type { CameraItemRow"));
  assert.match(receive, /inspectFieldCameraPhoto\(bytes, \{ occupantHrIds: seatOccupants\(seat\), viewerHrId: repHrId, seatId: seat\.seatId \}\)/, "the seal is judged in full, without throwing");
  assert.match(receive, /if \(existing\.data\) return CAMERA_RECEIVED;/, "a resend is the same item");
  assert.match(receive, /customer\.seatId !== seat\.seatId/, "a customer off his list is never filed under it");
  assert.ok(receive.indexOf("loadCameraDailyCap()") > 0 && receive.indexOf("sentVisitsThatDay(repHrId, takenDay, isTest)") > 0, "the allowance is read for the photo's own day");
  assert.match(receive, /const outcome: CameraOutcome = arrival\.outcome;/, "the arrival's own outcome, never upgraded to recorded");
  for (const recorder of ["saveVisit(", "validateWithRepSeal(", "enterMissedVisit(", "phoenix_crm_camera_add_customer"]) {
    assert.ok(!receive.includes(recorder), `the arrival records nothing: no ${recorder}`);
  }
  assert.match(receive, /visit_id: null,\s*validated_place_id: null,/, "an arrival carries no visit and no place");
  assert.match(receive, /photoKind === "business_card"\) \{\s*reasons\.push\("name_photo"\);/, "a business card is always flagged");
  assert.match(receive, /readSealedNamePhoto\(/, "a name photo goes through the reader");
  assert.equal(receive.split("return CAMERA_RECEIVED;").length - 1, 2, "the phone hears the same word either way");

  const route = read("app/api/phoenix-crm/field-camera/sync/route.ts");
  assert.match(route, /assertPermission\(access, "phoenix_crm", "create"\)/);
  assert.ok(route.indexOf("assertSameOriginMutation(request)") < route.indexOf("resolveAccessContext(request)"), "the sync checks its origin first");
}

function theSuperAdminAloneDecides(): void {
  const items = read("src/lib/phoenix-crm/server/camera-items.ts");
  assert.match(items, /if \(!canEnterMissedRecords\(viewer\)\) throw forbiddenError/, "never the SFE");
  for (const name of ["saveCameraDailyCap", "saveCameraDayAllowance", "loadCameraPage", "decideCameraItem"]) {
    const start = items.indexOf(`export async function ${name}(`);
    assert.ok(start > 0, `${name} exists`);
    assert.match(items.slice(start, start + 200), /assertCameraDecider\(viewer\);/, `${name} asks who first`);
  }
  const decide = items.slice(items.indexOf("export async function decideCameraItem("));
  assert.match(decide, /await enterMissedVisit\(viewer, \{/, "an approved visit goes through his Record a missed visit door");
  assert.match(decide, /callPhoenixCrm<Row>\("phoenix_crm_camera_add_customer"/, "an approved new customer is added to the rep's list");
  assert.match(decide, /adminDeleteRecord\(viewer, \{ kind: "visit", id: visitId, test: isTest \}\)/, "a rejected visit recorded at once is taken back");
  assert.match(decide, /refuseValidatedPlace\(viewer, \{ placeId, refusalReason: body\.refusalReason, note \}\)/, "and its place refused, with what is wrong with the photo");
  assert.match(decide, /\.is\("decision", null\)/, "one decision per item");
  assert.match(
    decide,
    /const allowed = cameraApproveAllowed\(facts\.approved, facts\.allowance\);\s*if \(!allowed\.ok\) throw conflictError\(allowed\.reason\);[\s\S]*await enterMissedVisit\(/,
    "Approve stops at the rep's allowance for that day, before the visit is recorded",
  );
  const raise = items.slice(items.indexOf("export async function saveCameraDayAllowance("), items.indexOf("export async function saveCameraDayAllowance(") + 2500);
  assert.match(raise, /managerApproval\.length < 3\) throw validationError/, "a raise needs the manager's email approval written down");
  assert.match(raise, /onConflict: "rep_hr_id,day,is_test"/, "one raise per rep, day and world");
  assert.match(raise, /if \(allowance < approved\) throw validationError/, "a raise never goes below what is already approved");

  for (const path of [
    "app/api/phoenix-crm/camera-reviews/decide/route.ts",
    "app/api/phoenix-crm/camera-reviews/cap/route.ts",
    "app/api/phoenix-crm/camera-reviews/day-allowance/route.ts",
  ]) {
    const route = read(path);
    assert.match(route, /assertPermission\(access, "phoenix_crm", "update"\)/, `${path} asks update`);
    assert.ok(route.indexOf("assertSameOriginMutation(request)") < route.indexOf("resolveAccessContext(request)"), `${path} checks its origin first`);
  }
  const page = read("app/(admin)/admin/field-crm/camera-reviews/page.tsx");
  assert.match(page, /if \(!viewer \|\| !canEnterMissedRecords\(viewer\)\) redirect\("\/admin"\)/, "the page redirects anybody else");

  const nav = read("src/config/system-navigation.ts");
  const card = nav.slice(nav.indexOf(`href: "${CAMERA_REVIEWS_PATH}"`), nav.indexOf(`href: "${CAMERA_REVIEWS_PATH}"`) + 500);
  assert.match(card, /roles: \["Super Admin"\]/, "the card is the Super Admin's alone");
  assert.match(card, /permissions: \[\{ resource: "phoenix_crm", action: "update" \}\]/);
}

function theBoardFitsAndSaysNoNumbersToTheRep(): void {
  const board = read("src/components/phoenix-crm/camera-reviews-board.tsx");
  const widths = [...board.slice(board.indexOf("const COLUMNS = ["), board.indexOf("] as const;")).matchAll(/width: "(\d+)%"/g)].map((match) => Number(match[1]));
  assert.equal(widths.length, 4);
  assert.equal(widths.reduce((sum, width) => sum + width, 0), 100, "the columns fill the table exactly");
  assert.ok(board.indexOf("<CrmCardsOnPhone>") < board.indexOf("<CrmTable"), "the phone cards come first");
  assert.match(board, /RefusalReasonField/, "taking back a recorded validation names what is wrong with the photo");
  assert.match(board, /\{row\.isTest \? <CrmPill tone="orange">Test account<\/CrmPill> : null\}/, "a test item wears its tag");
  assert.match(board, /Every check passed/, "a waiting item with no reason says so");
  assert.match(board, /"\/api\/phoenix-crm\/camera-reviews\/day-allowance"/, "the one-day raise is on the board");
  assert.match(board, /The manager's email approval: who approved it and when/);
  assert.doesNotMatch(board, /overflow-x-auto|overflow-auto|truncate|line-clamp/);

  // The rep's world: the visit save refuses no third visit while a name photo waits for the Super Admin.
  const visits = read("src/lib/phoenix-crm/server/visits.ts");
  assert.match(visits, /\.from\("phoenix_crm_camera_items"\)[\s\S]{0,300}\.eq\("outcome", "waiting"\)\s*\.neq\("photo_kind", "place"\)/);
  assert.match(visits, /customer &&\s*!awaitsNameReview &&\s*unvalidatedVisitRefused\(\{/);
}

function theMigrationIsClosed(): void {
  const migration = read("supabase/migrations/20261120225652_phoenix_crm_camera_items.sql");
  for (const table of ["phoenix_crm_camera_items", "phoenix_crm_field_camera_releases"]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security;`));
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated;`));
  }
  assert.match(migration, /revoke execute on function public\.phoenix_crm_camera_add_customer\(jsonb\) from public, anon, authenticated;/);
  assert.match(migration, /grant execute on function public\.phoenix_crm_camera_add_customer\(jsonb\) to service_role;/);

  const allowances = read("supabase/migrations/20261121012152_phoenix_crm_camera_day_allowances.sql");
  assert.match(allowances, /alter table public\.phoenix_crm_camera_day_allowances enable row level security;/);
  assert.match(allowances, /revoke all on table public\.phoenix_crm_camera_day_allowances from public, anon, authenticated;/);
  assert.match(allowances, /manager_approval text not null/, "the manager's approval is required");
  assert.match(allowances, /primary key \(rep_hr_id, day, is_test\)/, "for one rep and one day only");
}

/** Owner, 23 Nov 2026: "if a record is done by test account, show that this is the test Ibrahim". */
function aTestItemIsNamedAfterItsTestLogin(): void {
  assert.equal(cameraSenderName("Aya Ibrahim", true), "Test · Aya Ibrahim", "a test item names the test login");
  assert.equal(cameraSenderName("Test · Aya Ibrahim", true), "Test · Aya Ibrahim", "never doubled");
  assert.equal(cameraSenderName("Mohamed Salah", false), "Mohamed Salah", "a real rep's item keeps his own name");
  const loader = read("src/lib/phoenix-crm/server/camera-items.ts");
  assert.match(loader, /repName: cameraSenderName\(nameOf\(names, repHrId, repHrId\), row\.is_test === true\)/, "the page's rows carry it");
}

export function runPhoenixCrmCameraItemsTests(): void {
  aTestItemIsNamedAfterItsTestLogin();
  timeComesFromPhoenixFirst();
  arrivalAlwaysWaitsOrArchives();
  capAndDraftParse();
  pageWords();
  aNoTimetableBuildingIsNeverRefusedForOne();
  theSyncReceivesEverything();
  theSuperAdminAloneDecides();
  theBoardFitsAndSaysNoNumbersToTheRep();
  theMigrationIsClosed();
}
