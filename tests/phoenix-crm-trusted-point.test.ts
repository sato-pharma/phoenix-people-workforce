import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { VISIT_MAX_ACCURACY_METERS } from "../src/lib/phoenix-crm/entry-rules.ts";
import { distanceMeters } from "../src/lib/phoenix-crm/geo.ts";
import {
  cairoDayOf,
  findTrustedPoint,
  isTrustedPointSource,
  mergeTrustedPointReadings,
  TRUSTED_CORE_METERS,
  TRUSTED_MIN_DAYS,
  TRUSTED_MIN_READINGS,
  type TrustedPointReading,
} from "../src/lib/phoenix-crm/trusted-point-rules.ts";

/**
 * Phoenix CRM — the Super Admin validates a customer on a TRUSTED POINT (owner, 2026-11-10: "we will search
 * all locations for this customer in phx crm, then we will compare with the locations of checkins of this
 * customer from the old crm until we find a trusted point or trusted average location... based on this
 * location we will extract the brick, area and all what we need").
 *
 * 1. The rule (`findTrustedPoint`), behaviourally: a tight cluster like Dr Bahaa Kamal's is trusted and the
 *    600 m and 6 km strays are left out; scattered readings, or agreement on too few days, are not trusted
 *    and say why; a Phoenix reading rougher than the visit's line is dropped; the point is a MEDIAN.
 * 2. The merge (`mergeTrustedPointReadings`), behaviourally: a visit copied from iReports360 is never counted
 *    twice; a retired place still counts; a pin identical to the photo reading is one reading; days are Cairo days.
 * 3. By source: the old-CRM read takes iReports360 rows only (`source <> 'phoenix'`) and never pages with
 *    `.range`; the places read keeps retired places; the signboard backlog skips a place with no photo; the
 *    route and the service are the Super Admin's alone; the migration's guards and grants.
 *
 * Break direction: drop the `.neq("source", "phoenix")` and section 3 fails; count a copied visit as well as
 * its check-in and section 2 fails; swap the median for a mean and section 1's median case fails.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

const BASE = { lat: 30.0131, lon: 31.2089 };
const METRES_PER_DEGREE_LAT = 111_320;

function at(northMetres: number, eastMetres: number): { lat: number; lon: number } {
  return {
    lat: BASE.lat + northMetres / METRES_PER_DEGREE_LAT,
    lon: BASE.lon + eastMetres / (METRES_PER_DEGREE_LAT * Math.cos((BASE.lat * Math.PI) / 180)),
  };
}

function reading(
  northMetres: number,
  eastMetres: number,
  day: string,
  source: TrustedPointReading["source"],
  extra: Partial<TrustedPointReading> = {},
): TrustedPointReading {
  return { ...at(northMetres, eastMetres), day, source, accuracyMeters: source === "phoenix" ? 12 : null, repHrId: "C-1001", ...extra };
}

function runRuleTests(): void {
  assert.equal(TRUSTED_CORE_METERS, 30, "the core radius is 30 m");
  assert.equal(TRUSTED_MIN_READINGS, 5, "a trusted point stands on at least 5 readings");
  assert.equal(TRUSTED_MIN_DAYS, 3, "taken on at least 3 different days");

  // A tight cluster like Dr Bahaa Kamal's: four Phoenix visits and three old-CRM check-ins within a few
  // metres, months apart, plus one Phoenix reading 600 m away and one old check-in 6 km away.
  const bahaa = [
    reading(2, -3, "2026-10-05", "phoenix", { repHrId: "C-2001" }),
    reading(-4, 1, "2026-10-12", "phoenix", { repHrId: "C-2001" }),
    reading(5, 4, "2026-10-19", "phoenix", { repHrId: "C-2001" }),
    reading(-1, -6, "2026-10-26", "phoenix", { repHrId: "C-2001" }),
    reading(8, 6, "2025-03-01", "old_crm", { repHrId: "C-3001" }),
    reading(-9, 3, "2025-04-10", "old_crm", { repHrId: "C-3001" }),
    reading(3, -10, "2025-06-15", "old_crm", { repHrId: null }),
    reading(600, 0, "2026-10-30", "phoenix", { repHrId: "C-2001" }),
    reading(0, 6000, "2025-07-01", "old_crm", { repHrId: "C-3001" }),
  ];
  const found = findTrustedPoint(bahaa);
  assert.equal(found.trusted, true, "a tight cluster over months is trusted");
  if (!found.trusted) return;
  assert.equal(found.readings, 7, "the 600 m and 6 km strays are left out of the core");
  assert.equal(found.of, 9, "every reading offered is counted in `of`");
  assert.deepEqual(found.sources, { phoenix: 4, old_crm: 3 }, "the core counts its sources");
  assert.equal(found.days, 7, "seven different Cairo days");
  assert.equal(found.reps, 2, "a reading with no rep counts as no rep");
  assert.equal(found.firstDay, "2025-03-01");
  assert.equal(found.lastDay, "2026-10-26", "the stray's day is not the last day — it is not in the core");
  assert.ok(distanceMeters(BASE, found) < 6, `the point sits on the cluster, not dragged by the strays (${distanceMeters(BASE, found).toFixed(1)} m)`);
  assert.ok(found.maxSpreadMeters <= TRUSTED_CORE_METERS, "every core reading lies inside the core radius of the point");

  // Scattered readings, 200 m apart: nothing agrees, and the Super Admin is told why.
  const scattered = findTrustedPoint(
    [0, 1, 2, 3, 4, 5].map((step) => reading(step * 200, 0, `2026-10-0${step + 1}`, step % 2 === 0 ? "phoenix" : "old_crm")),
  );
  assert.equal(scattered.trusted, false, "scattered readings are not a trusted point");
  if (scattered.trusted) return;
  assert.ok(scattered.readings < TRUSTED_MIN_READINGS, "fewer than the minimum agree");
  assert.match(scattered.reason, /^Only \d+ of the 6 usable readings agree within 30 m of each other — at least 5 are needed/, "the reason states the count and the rule");

  // Plenty of agreement, but on two days only: one busy afternoon is not months of agreement.
  const twoDays = findTrustedPoint([
    reading(0, 0, "2026-10-05", "phoenix"),
    reading(2, 1, "2026-10-05", "phoenix"),
    reading(-2, 2, "2026-10-05", "old_crm"),
    reading(1, -2, "2026-10-06", "old_crm"),
    reading(-1, -1, "2026-10-06", "phoenix"),
    reading(3, 3, "2026-10-06", "old_crm"),
  ]);
  assert.equal(twoDays.trusted, false, "six agreeing readings on two days are not trusted");
  if (twoDays.trusted) return;
  assert.equal(twoDays.readings, 6);
  assert.match(twoDays.reason, /taken on only 2 different days — at least 3 different days are needed/);

  // A Phoenix reading rougher than the visit's own line is dropped before anything is counted.
  const rough = findTrustedPoint([
    reading(0, 0, "2026-10-01", "phoenix"),
    reading(2, 1, "2026-10-02", "phoenix"),
    reading(-2, 2, "2026-10-03", "phoenix"),
    reading(1, -2, "2026-10-04", "phoenix"),
    reading(-1, -1, "2026-10-05", "phoenix", { accuracyMeters: VISIT_MAX_ACCURACY_METERS + 1 }),
  ]);
  assert.equal(rough.trusted, false, "the rough reading does not make up the fifth");
  assert.equal(rough.readings, 4);

  // Old-CRM readings alone: the densest reading seeds the core, so a second, thinner cluster loses.
  const oldOnly = findTrustedPoint([
    reading(0, 2000, "2025-01-01", "old_crm"),
    reading(3, 2002, "2025-01-02", "old_crm"),
    reading(0, 0, "2025-02-01", "old_crm"),
    reading(4, 2, "2025-03-01", "old_crm"),
    reading(-3, 5, "2025-04-01", "old_crm"),
    reading(2, -4, "2025-05-01", "old_crm"),
    reading(-5, -2, "2025-06-01", "old_crm"),
  ]);
  assert.equal(oldOnly.trusted, true, "five old-CRM check-ins on five days are enough with no Phoenix reading at all");
  if (!oldOnly.trusted) return;
  assert.deepEqual(oldOnly.sources, { phoenix: 0, old_crm: 5 });
  assert.ok(distanceMeters(BASE, oldOnly) < 6, "the denser cluster wins");

  // The point is the per-axis MEDIAN of the core — one reading at the core's edge does not drag it.
  const median = findTrustedPoint([
    reading(0, 0, "2026-10-01", "phoenix"),
    reading(1, 0, "2026-10-02", "phoenix"),
    reading(-1, 0, "2026-10-03", "phoenix"),
    reading(0, 1, "2026-10-04", "phoenix"),
    reading(28, 0, "2026-10-05", "phoenix"),
  ]);
  assert.equal(median.trusted, true);
  if (!median.trusted) return;
  assert.ok(distanceMeters(BASE, median) < 2, `a median, never a mean, which would sit ~6 m north (${distanceMeters(BASE, median).toFixed(1)} m)`);

  const none = findTrustedPoint([]);
  assert.equal(none.trusted, false);
  if (!none.trusted) assert.match(none.reason, /^No visit in Phoenix and no check-in in the old CRM/);
  const outside = findTrustedPoint([{ lat: 0, lon: 0, day: "2026-10-01", source: "old_crm", accuracyMeters: null, repHrId: null }]);
  assert.equal(outside.trusted, false, "a reading outside Egypt is never used");
  if (!outside.trusted) assert.match(outside.reason, /^None of the 1 reading of this customer has a usable location/);

  assert.equal(isTrustedPointSource("trusted"), true);
  assert.equal(isTrustedPointSource("photo"), false);
}

function runMergeTests(): void {
  const point = at(0, 0);
  const merged = mergeTrustedPointReadings({
    visits: [
      // A Phoenix visit of his own.
      { lat: point.lat, lon: point.lon, accuracy_meters: 9, visit_date: "2026-10-05", rep_hr_id: "C-2001", imported_from_ireports360_at: null },
      // A visit COPIED from iReports360 whose check-in is read from the old CRM as well: skipped here.
      { lat: point.lat, lon: point.lon, visit_date: "2026-09-01", rep_hr_id: "C-2001", imported_from_ireports360_at: "2026-10-01T00:00:00Z", ireports360_checkin_id: 555 },
      // A copied visit whose check-in the view no longer carries: that one old-CRM reading, once.
      { lat: point.lat, lon: point.lon, visit_date: "2026-08-01", rep_hr_id: " ", manager_hr_id: "C-9001", imported_from_ireports360_at: "2026-10-01T00:00:00Z", ireports360_checkin_id: 777 },
      // No location: nothing.
      { lat: null, lon: null, visit_date: "2026-10-06", rep_hr_id: "C-2001", imported_from_ireports360_at: null },
    ],
    places: [
      // A RETIRED place (rejected validation) still counts: its photo reading and its distinct pin.
      {
        status: "retired",
        created_by_hr_id: "C-2001",
        captured_at: "2026-10-16T20:00:00Z",
        photo_lat: point.lat,
        photo_lon: point.lon,
        photo_accuracy_meters: 7,
        photo_captured_at: "2026-10-16T23:30:00Z",
        pin_lat: point.lat + 0.00002,
        pin_lon: point.lon,
        pin_accuracy_meters: 11,
      },
      // A pin identical to the photo reading is that reading again: counted once.
      { status: "active", created_by_hr_id: "C-2001", captured_at: "2026-10-20T08:00:00Z", photo_lat: point.lat, photo_lon: point.lon, photo_captured_at: "2026-10-20T08:00:00Z", pin_lat: point.lat, pin_lon: point.lon },
      // A trusted place carries no photo and no pin: nothing.
      { status: "active", created_by_hr_id: "B-10", captured_at: "2026-11-10T19:00:00Z", photo_lat: null, photo_lon: null, pin_lat: null, pin_lon: null },
    ],
    oldCheckins: [
      { checkinId: 555, lat: point.lat, lon: point.lon, checkDate: "2026-09-01T09:00:00Z", agentHrId: "C-2001" },
      { checkinId: 556, lat: point.lat, lon: point.lon, checkDate: "2026-09-08T09:00:00Z", agentHrId: null },
    ],
  });
  assert.deepEqual(
    merged.counts,
    { phoenixVisits: 1, placeReadings: 3, oldCrmCheckins: 3, copiedVisitsSkipped: 1 },
    "one own visit, three place readings (retired included, the duplicate pin once), two old check-ins plus the orphaned copy",
  );
  assert.equal(merged.readings.length, 7, "no reading is counted twice");
  const fromCopies = merged.readings.filter((entry) => entry.day === "2026-09-01");
  assert.equal(fromCopies.length, 1, "a copied visit and its own old-CRM check-in are ONE reading");
  const orphan = merged.readings.find((entry) => entry.day === "2026-08-01");
  assert.equal(orphan?.source, "old_crm", "an orphaned copy counts as the old-CRM reading it is");
  assert.equal(orphan?.repHrId, "C-9001", "a blank rep falls back to the manager");
  const retired = merged.readings.filter((entry) => entry.accuracyMeters === 7 || entry.accuracyMeters === 11);
  assert.deepEqual(
    retired.map((entry) => entry.day).sort(),
    ["2026-10-16", "2026-10-17"],
    "the photo is dated by its own capture in Cairo (23:30 UTC is the next Cairo day), the pin by the place's capture",
  );
  assert.equal(cairoDayOf("2026-10-16T23:30:00Z"), "2026-10-17");
  assert.equal(cairoDayOf(null), null);
}

function runSourceTests(): void {
  // The old CRM's check-ins: iReports360 rows only, never the unified view's mirror of every Phoenix visit.
  const checkins = read("src/lib/crm/trusted-point-checkins.ts");
  assert.match(checkins, /\.from\(CRM_CHECKINS_UNIFIED_VIEW\)/, "the old check-ins are read through the unified view's one constant");
  assert.match(checkins, /\.neq\("source", "phoenix"\)/, "only iReports360 rows — the view's Phoenix rows are the visits already counted");
  assert.doesNotMatch(checkins, /\.range\(/, "one bounded read, never a paged walk of the unified view (performance-phase-3's cap)");

  const server = read("src/lib/phoenix-crm/server/trusted-point.ts");
  const placesFrom = server.indexOf('.from("phoenix_crm_places")\n      .select("id, created_by_hr_id');
  const placesTo = server.indexOf("loadOldCrmCheckinsForContacts(customer.contactIds)", placesFrom);
  assert.ok(placesFrom >= 0 && placesTo > placesFrom, "the readings' places read is found");
  const placesRead = server.slice(placesFrom, placesTo);
  assert.doesNotMatch(placesRead, /status/, "the places read keeps RETIRED places — a rejected capture is still a reading at the door");
  assert.match(placesRead, /photo_lat, photo_lon/, "it reads the photo's own reading");
  assert.match(placesRead, /pin_lat, pin_lon/, "and the Capture-location pin");
  assert.match(server, /return mergeTrustedPointReadings\(\{/, "the rows are merged by the tested pure function, never a second loop");

  // The Super Admin's alone, before anything is read.
  assert.match(server, /export function canPlaceOnTrustedPoint\(viewer: PhoenixCrmViewer\): boolean \{\n  return canDecideSharedPlaces\(viewer\);/);
  for (const name of ["previewTrustedPoint", "placeOnTrustedPoint"]) {
    const from = server.indexOf(`export async function ${name}(viewer`);
    assert.ok(from >= 0, `${name} is found`);
    const body = server.slice(server.indexOf("{\n", from) + 2);
    assert.match(body, /^  assertTrustedPointDecider\(viewer\);/, `${name} refuses everyone but the Super Admin as its first statement`);
  }
  const route = read("app/api/phoenix-crm/list/places/trusted-point/route.ts");
  assert.equal((route.match(/await assertPermission\(access, "phoenix_crm", "update"\);/g) ?? []).length, 2, "both handlers ask for update");
  assert.match(route, /previewTrustedPoint\(viewer, searchOf\(request\)\.get\("customerId"\)\)/);
  assert.match(route, /placeOnTrustedPoint\(viewer, body\?\.customerId\)/, "only the customer's id is read from the browser");
  assert.match(read("src/lib/phoenix-crm/server/list.ts"), /canPlaceOnTrustedPoint: canDecideSharedPlaces\(viewer\),/, "the button follows the same gate");
  assert.match(read("src/components/phoenix-crm/trusted-point-screen.tsx"), /if \(!view\.canPlaceOnTrustedPoint\) \{\n\s+return <ListGone/, "the screen refuses to draw for anyone else");

  // A trusted place has no photo: the nightly signboard reader never picks one up.
  const sweep = read("src/lib/phoenix-crm/server/signboard-sweep.ts");
  assert.equal((sweep.match(/\.not\("photo_path", "is", null\)/g) ?? []).length, 3, "all three signboard reads skip a place with no photo");
  assert.doesNotMatch(read("src/lib/phoenix-crm/server/list.ts"), /String\(row\.photo_path\)/, "a null path is never stringified into the path \"null\"");

  // The migration.
  // Read raw, not through the JS comment lexer: an apostrophe in a SQL comment is not a string opener.
  const sql = readFileSync(new URL("supabase/migrations/20261110213959_phoenix_crm_trusted_point_places.sql", ROOT), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/--.*$/gm, "");
  assert.match(sql, /check \(point_source in \('photo', 'pin', 'moved', 'shared_place', 'trusted'\)\)/);
  assert.match(sql, /check \(photo_path is not null or trusted_basis is not null\)/, "every place but a trusted one still needs its photo");
  assert.match(sql, /\(point_source <> 'trusted' or trusted_basis is not null\)/, "a trusted place carries its evidence");
  for (const refusal of ["archived", "not_on_list", "already_has_place", "location_in_review"]) {
    assert.ok(sql.includes(`raise exception 'phoenix_crm:${refusal}'`), `the RPC refuses ${refusal}`);
  }
  assert.match(sql, /perform pg_advisory_xact_lock\(hashtext\('phoenix_crm:seat:' \|\| v_seat\)\);/, "under the seat's lock");
  assert.match(sql, /revoke execute on function public\.phoenix_crm_place_on_trusted_point\(jsonb\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.phoenix_crm_place_on_trusted_point\(jsonb\) to service_role;/);
  assert.match(read("src/lib/phoenix-crm/server/db.ts"), /"phoenix_crm_place_on_trusted_point"/, "the RPC is a known Customer 360 writer");
}

export function runPhoenixCrmTrustedPointTests(): void {
  runRuleTests();
  runMergeTests();
  runSourceTests();
}
