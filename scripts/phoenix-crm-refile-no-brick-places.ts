/**
 * ONE-OFF OPS SCRIPT — file the active places that hold NO brick under today's filing rule.
 *
 * Owner, 2026-11-11 ("Build all six fixes", the Phoenix CRM validation audit): 30 active places were
 * saved with `brick_lookup = 'none_nearby'` and no brick, area or region, so they sit in nobody's
 * territory on every report that groups by brick. They were captured before the seat's OWN area could
 * reach past the trust radius (`OWN_AREA_REACH_KM`, place-location.ts); a capture at the same door today
 * files. This script asks the SAME function a validation asks — `fileBrickForPoint`, with the seat's own
 * area — and writes nothing itself.
 *
 * The set: active, real (`is_test = false`) places with `brick_id` null. A place seated in a venue is
 * never filed on its own: its venue is filed once, by the venue's own seat, and every seat in it takes
 * the venue's answer — a seating copies the venue's location and never resolves it again
 * (`sharedPlaceForSeating`, shared-places.ts). A place the rule still cannot file is listed as `left`
 * and stays as it is. No point moves, so no visit is measured again, and no Google lookup is spent.
 *
 * IT ONLY WRITES FILES, into F:\PHX backup\phoenix-crm-no-brick-refile-<date>\ :
 *   plan.json      — every place and venue, with the brick it would be filed under, and the ones left;
 *   pre-image.sql  — copies the whole rows into phoenix_crm_backup_<date> (never `public`);
 *   apply.sql      — one guarded update per row (`... and brick_id is null`), in one transaction.
 * Applying is a BULK PRODUCTION CHANGE: announce it in plain words (AGENTS.md §8), then run
 *   node scripts/apply-sql-file.mjs <folder>/pre-image.sql production
 *   node scripts/apply-sql-file.mjs <folder>/apply.sql production
 * each with PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com.
 *
 * Usage:
 *   node --env-file-if-exists=.env.local --experimental-strip-types --experimental-specifier-resolution=node \
 *     --experimental-loader ./tests/alias-loader.mjs scripts/phoenix-crm-refile-no-brick-places.ts [--out=<folder>]
 */
import fs from "node:fs";
import path from "node:path";

import { fileBrickForPoint, loadBrickCentroids } from "@/lib/crm/brick-geo";
import { BRICK_TRUST_KM, OWN_AREA_REACH_KM } from "@/lib/phoenix-crm/server/place-location";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

const DATE = "20261111";
const BACKUP_SCHEMA = `phoenix_crm_backup_${DATE}`;

const known = new Set(["out"]);
for (const entry of process.argv.slice(2)) {
  const name = entry.replace(/^--/, "").split("=")[0];
  if (!known.has(name)) throw new Error(`Unknown flag ${entry} — refused rather than ignored.`);
}
const outArg = process.argv.find((entry) => entry.startsWith("--out="));

const text = (value: unknown): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value);
  return trimmed.length > 0 ? trimmed : null;
};
const sqlText = (value: string | null): string => (value === null ? "null" : `'${value.replace(/'/g, "''")}'`);

type Filing = {
  brickId: string;
  brickName: string | null;
  brickDistanceKm: number;
  areaCode: string | null;
  areaName: string | null;
  regionCode: string | null;
  regionName: string | null;
};
type Entry = { id: string; seatId: string; label: string; lat: number; lon: number; filing: Filing | null; nearestKm: number | null };

const LOCATION_COLUMNS = "id, seat_id, lat, lon, brick_id, brick_lookup, brick_distance_km, area_code, status, is_test";

function setClause(filing: Filing): string {
  return [
    "brick_lookup = 'matched'",
    `brick_id = ${sqlText(filing.brickId)}`,
    `brick_name = ${sqlText(filing.brickName)}`,
    `brick_distance_km = ${filing.brickDistanceKm}`,
    `area_code = ${sqlText(filing.areaCode)}`,
    `area_name = ${sqlText(filing.areaName)}`,
    `region_code = ${sqlText(filing.regionCode)}`,
    `region_name = ${sqlText(filing.regionName)}`,
    "updated_at = now()",
  ].join(", ");
}

async function main(): Promise<void> {
  const supabase = getSupabaseAdmin();
  const [placesRead, venuesRead, seats, centroids] = await Promise.all([
    supabase
      .from("phoenix_crm_places")
      .select(`${LOCATION_COLUMNS}, shared_place_id, customer:phoenix_crm_customers!customer_id(name)`)
      .eq("status", "active")
      .eq("is_test", false)
      .is("brick_id", null)
      .order("id", { ascending: true })
      .range(0, 999),
    supabase
      .from("phoenix_crm_shared_places")
      .select(`${LOCATION_COLUMNS}, name`)
      .eq("status", "active")
      .eq("is_test", false)
      .is("brick_id", null)
      .order("id", { ascending: true })
      .range(0, 999),
    fetchAllRows<Row>(() => getSupabaseAdmin().from("au_v_org_tree").select("seat_id, area_code"), "seat_id"),
    loadBrickCentroids(),
  ]);
  if (placesRead.error) throw new Error(`phoenix_crm_places: ${placesRead.error.message}`);
  if (venuesRead.error) throw new Error(`phoenix_crm_shared_places: ${venuesRead.error.message}`);
  // 🔴 An empty brick list is the resolver's ONLY sign it could not read the master, and it would then
  // answer "no brick" for every place — never plan a single row on that.
  if (centroids.length === 0) throw new Error("The brick master could not be read; nothing was planned.");
  const seatAreas = new Map(seats.map((row) => [String(row.seat_id), text(row.area_code)]));

  const file = (row: Row, label: string): Entry => {
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    const areaCode = seatAreas.get(String(row.seat_id)) ?? null;
    // The live resolver's own filing rule, so the plan names the brick a capture at this door stores today.
    const { filed, measured } = fileBrickForPoint(lat, lon, centroids, {
      areaCodes: areaCode ? [areaCode] : [],
      trustKm: BRICK_TRUST_KM,
      reachKm: OWN_AREA_REACH_KM,
    });
    return {
      id: String(row.id),
      seatId: String(row.seat_id),
      label,
      lat,
      lon,
      nearestKm: measured ? Math.round(measured.distanceKm * 100) / 100 : null,
      filing: filed
        ? {
            brickId: filed.brickId,
            brickName: filed.brickName,
            brickDistanceKm: Math.round(filed.distanceKm * 100) / 100,
            areaCode: filed.areaCode,
            areaName: filed.areaName,
            regionCode: filed.regionCode,
            regionName: filed.regionName,
          }
        : null,
    };
  };

  const places = (placesRead.data ?? []) as Row[];
  const venues = ((venuesRead.data ?? []) as Row[]).map((row) => file(row, text(row.name) ?? "A venue with no name"));
  const venueById = new Map(venues.map((venue) => [venue.id, venue]));
  const ownDoor: Entry[] = [];
  const seated: (Entry & { venueId: string })[] = [];
  const orphans: string[] = [];
  for (const row of places) {
    const customer = (Array.isArray(row.customer) ? row.customer[0] : row.customer) as Row | null | undefined;
    const label = text(customer?.name) ?? "A customer with no name";
    const venueId = text(row.shared_place_id);
    if (!venueId) {
      ownDoor.push(file(row, label));
      continue;
    }
    const venue = venueById.get(venueId);
    // Seated in a venue that HOLDS a brick (or is not active): the seat should have copied it. Listed, never guessed.
    if (!venue) {
      orphans.push(`${label} (${String(row.id)})`);
      continue;
    }
    seated.push({ ...file(row, label), filing: venue.filing, nearestKm: venue.nearestKm, venueId });
  }

  const filedPlaces = [...ownDoor, ...seated].filter((entry) => entry.filing !== null);
  const filedVenues = venues.filter((entry) => entry.filing !== null);
  const left = [...ownDoor, ...seated, ...venues].filter((entry) => entry.filing === null);

  const outDir = outArg ? outArg.slice("--out=".length) : path.join("F:\\PHX backup", `phoenix-crm-no-brick-refile-${DATE}`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "plan.json"),
    JSON.stringify({ date: DATE, backupSchema: BACKUP_SCHEMA, ownDoor, seated, venues, orphans }, null, 2),
  );
  const idList = (entries: readonly Entry[]) => entries.map((entry) => `'${entry.id}'`).join(",\n  ");
  fs.writeFileSync(
    path.join(outDir, "pre-image.sql"),
    `-- Pre-image for scripts/phoenix-crm-refile-no-brick-places.ts (${DATE}): the whole rows, before any brick is written.
begin;
create schema if not exists ${BACKUP_SCHEMA};
revoke all on schema ${BACKUP_SCHEMA} from public, anon, authenticated;
create table ${BACKUP_SCHEMA}.no_brick_places as select * from public.phoenix_crm_places where id in (
  ${idList(filedPlaces) || "null"}
);
create table ${BACKUP_SCHEMA}.no_brick_venues as select * from public.phoenix_crm_shared_places where id in (
  ${idList(filedVenues) || "null"}
);
revoke all on all tables in schema ${BACKUP_SCHEMA} from public, anon, authenticated;
commit;
`,
  );
  fs.writeFileSync(
    path.join(outDir, "apply.sql"),
    `-- scripts/phoenix-crm-refile-no-brick-places.ts (${DATE}): ${filedPlaces.length} places and ${filedVenues.length} venues take the brick
-- today's filing rule gives their own point. A row that gained a brick since the plan was written is skipped.
begin;
${filedVenues.map((entry) => `update public.phoenix_crm_shared_places set ${setClause(entry.filing as Filing)} where id = '${entry.id}' and brick_id is null and status = 'active';`).join("\n")}
${filedPlaces.map((entry) => `update public.phoenix_crm_places set ${setClause(entry.filing as Filing)} where id = '${entry.id}' and brick_id is null and status = 'active';`).join("\n")}
commit;
`,
  );

  console.log(`Active places with no brick: ${places.length} (own door ${ownDoor.length}, seated in a venue ${seated.length + orphans.length}) · venues with no brick: ${venues.length}`);
  console.log(`Would be filed: ${filedPlaces.length} places and ${filedVenues.length} venues · left as they are: ${left.length} · seated in a venue that is not in the set: ${orphans.length}`);
  for (const entry of [...venues, ...ownDoor]) {
    const where = entry.filing
      ? `${entry.filing.brickName ?? entry.filing.brickId} · ${entry.filing.areaName ?? "no area"} (${entry.filing.brickDistanceKm} km)`
      : `LEFT — nearest brick ${entry.nearestKm ?? "unknown"} km away, past the seat's own reach`;
    console.log(`  ${entry.label} [${entry.seatId}] → ${where}`);
  }
  for (const venue of venues) console.log(`  ${seated.filter((entry) => entry.venueId === venue.id).length} seated places take the answer of "${venue.label}"`);
  for (const orphan of orphans) console.log(`  NOT PLANNED — seated in a venue outside the set: ${orphan}`);
  console.log(`Wrote ${outDir}`);
}

await main();
