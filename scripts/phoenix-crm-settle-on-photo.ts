/**
 * ONE-OFF OPS SCRIPT — settle every place that still holds its PIN on its live PHOTO's own reading.
 *
 * Owner, 2026-10-26: "The source of trust that you compare from is the live validation photo. The
 * location on the live validation photo" — "this is the saved location of this customer in the system
 * that we later on compare with it". `pickPlacePoint` (entry-rules.ts) now takes the photo whenever it
 * is within the place's 250 m line or reports no accuracy; this script brings the places validated
 * under the 2026-10-11 sharper-reading rule into line with it.
 *
 * The set: active, real (`is_test = false`) places with `point_source = 'pin'` and a photo reading
 * whose accuracy is unknown or within `PLACE_MAX_ACCURACY_METERS`. A rougher photo keeps the pin, as a
 * new validation would. A moved place and a seat in a polyclinic are never touched.
 * 🔴 A place whose photo sits the far-visit line (`visit_far_meters`) or more from its pin is HELD, never
 * settled here: those are the contradicting readings — Dr Tharwat Milad's photo read 10 km from his door
 * on a cold receiver, and on 22 Oct the owner settled visits at three such places as "the photo's
 * location was the phone's error". They are listed in plan.json as `held` for his own decision.
 *
 * For each place: `lat`/`lon`/`accuracy_meters` become the photo's and `point_source` 'photo'. When the
 * photo sits `REREAD_METRES` or more from the pin, or its brick differs, the address, brick, area and
 * region are read again from it by the same resolver a validation uses (`resolvePlaceLocation`, the
 * seat's own territory breaking a tie); otherwise they stand, since the median place moves 4 m. A
 * lookup that answers no address never blanks the one the row holds. Then every visit to that
 * customer is measured again (`restampVisitLocations`, scope "all"), exactly as after a move.
 * 🔴 It is a direct update, not `phoenix_crm_move_place`: that RPC marks the place 'moved', which says
 * a person corrected it, and a moved place is measured from its point whatever its photo says.
 *
 * DRY RUN IS THE DEFAULT. It reads production and writes into F:\PHX backup\phoenix-crm-photo-point-<date>\:
 *   plan.json      — every place to settle, with its current and new brick and area;
 *   pre-image.sql  — creates public.<pre-image>_places (the whole rows) and public.<pre-image>_visits
 *                    (every visit to those customers: place, distance, flag), RLS on, anon and
 *                    authenticated revoked.
 * It prints how many bricks, areas and visit flags would change. No Google lookup is spent on a dry run.
 *
 * --apply is a BULK PRODUCTION CHANGE. Announce it in plain words (AGENTS.md §8), take the pre-image
 * (`node scripts/apply-sql-file.mjs <folder>/pre-image.sql production`), then pass:
 *   --apply --plan=<folder>/plan.json --pre-image=<pre-image> --actor=<HR id>
 * It refuses unless the pre-image holds every place the plan names, and skips a place whose row changed
 * since the plan was written.
 *
 * Usage:
 *   node --env-file-if-exists=.env.local --experimental-strip-types --experimental-specifier-resolution=node \
 *     --experimental-loader ./tests/alias-loader.mjs scripts/phoenix-crm-settle-on-photo.ts [--out=<folder>]
 */
import fs from "node:fs";
import path from "node:path";

import { loadBrickCentroids, resolveBrickForPoint } from "@/lib/crm/brick-geo";
import { PLACE_MAX_ACCURACY_METERS } from "@/lib/phoenix-crm/entry-rules";
import { checkVisitLocation } from "@/lib/phoenix-crm/geo";
import { BRICK_TRUST_KM, resolvePlaceLocation, territoryOfSeat } from "@/lib/phoenix-crm/server/place-location";
import { loadPhoenixCrmConfig } from "@/lib/phoenix-crm/server/settings";
import { placesFor, restampVisitLocations, type MeasurablePlace } from "@/lib/phoenix-crm/server/visit-locations";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

const DATE = "20261026";
/** Two tables in `public` (so the service client can read them back), RLS on, anon and authenticated revoked. */
const PRE_IMAGE = `phoenix_crm_photo_point_backup_${DATE}`;

const arg = (name: string): string | null => {
  const hit = process.argv.find((entry) => entry === `--${name}` || entry.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "true";
};
const known = new Set(["apply", "plan", "pre-image", "actor", "out"]);
for (const entry of process.argv.slice(2)) {
  const name = entry.replace(/^--/, "").split("=")[0];
  if (!known.has(name)) throw new Error(`Unknown flag ${entry} — refused rather than ignored.`);
}

const text = (value: unknown): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value);
  return trimmed.length > 0 ? trimmed : null;
};
const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function chunk<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a PostgREST builder, chained by each caller
async function readAll(table: string, columns: string, apply: (query: any) => any): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await apply(getSupabaseAdmin().from(table).select(columns))
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < 1000) return rows;
  }
}

async function loadSeatAreas(): Promise<Map<string, string | null>> {
  const { data, error } = await getSupabaseAdmin().from("au_v_org_tree").select("seat_id, area_code");
  if (error) throw new Error(`au_v_org_tree: ${error.message}`);
  if ((data ?? []).length >= 1000) throw new Error("au_v_org_tree hit PostgREST's 1,000-row cap; paginate before trusting it");
  return new Map(((data ?? []) as Row[]).map((row) => [String(row.seat_id), text(row.area_code)]));
}

const PLACE_COLUMNS =
  "id, customer_id, seat_id, lat, lon, accuracy_meters, point_source, photo_lat, photo_lon, photo_accuracy_meters, brick_id, brick_name, area_code, area_name, captured_at, status, is_test";

/** The places to settle, read live: the same test `pickPlacePoint` applies to a new validation. */
async function readTargets(): Promise<Row[]> {
  const rows = await readAll("phoenix_crm_places", PLACE_COLUMNS, (query) =>
    query.eq("status", "active").eq("is_test", false).eq("point_source", "pin").not("photo_lat", "is", null).not("photo_lon", "is", null),
  );
  return rows.filter((row) => {
    const accuracy = num(row.photo_accuracy_meters);
    return num(row.photo_lat) !== null && num(row.photo_lon) !== null && (accuracy === null || accuracy <= PLACE_MAX_ACCURACY_METERS);
  });
}

/** A photo this close to the pin is the same street: its address and brick stand. */
const REREAD_METRES = 25;

type PlanEntry = {
  placeId: string;
  /** Read the address, brick and area again from the photo (far from the pin, or another brick). */
  reread: boolean;
  customerId: string;
  seatId: string;
  from: { lat: number; lon: number; brickName: string | null; areaName: string | null };
  to: { lat: number; lon: number; accuracyMeters: number | null; brickName: string | null; areaName: string | null };
};

function metresBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

async function dryRun(): Promise<void> {
  const outDir = arg("out") ?? path.join("F:\\PHX backup", `phoenix-crm-photo-point-${DATE}`);
  const [targets, seatAreas, centroids, config] = await Promise.all([readTargets(), loadSeatAreas(), loadBrickCentroids(), loadPhoenixCrmConfig()]);
  // 🔴 An empty brick list is the resolver's ONLY sign it could not read the master, and it would then
  // answer "no brick" for every place — never settle a single row on that.
  if (centroids.length === 0) throw new Error("The brick master could not be read; nothing was planned.");

  const plan: PlanEntry[] = [];
  let brickChanges = 0;
  let areaChanges = 0;
  const held: { placeId: string; customerId: string; metres: number; photoAccuracyMeters: number | null }[] = [];
  for (const row of targets) {
    const photo = { lat: Number(row.photo_lat), lon: Number(row.photo_lon) };
    const apart = metresBetween({ lat: Number(row.lat), lon: Number(row.lon) }, photo);
    if (apart >= config.settings.visitFarMeters) {
      held.push({ placeId: String(row.id), customerId: String(row.customer_id), metres: Math.round(apart), photoAccuracyMeters: num(row.photo_accuracy_meters) });
      continue;
    }
    const areaCode = seatAreas.get(String(row.seat_id)) ?? null;
    const brick = resolveBrickForPoint(photo.lat, photo.lon, centroids, { areaCodes: areaCode ? [areaCode] : [], withinKm: BRICK_TRUST_KM });
    const trusted = brick && brick.distanceKm <= BRICK_TRUST_KM ? brick : null;
    if ((trusted?.brickId ?? null) !== text(row.brick_id)) brickChanges += 1;
    if ((trusted?.areaCode ?? null) !== text(row.area_code)) areaChanges += 1;
    plan.push({
      placeId: String(row.id),
      reread: apart >= REREAD_METRES || (trusted?.brickId ?? null) !== text(row.brick_id),
      customerId: String(row.customer_id),
      seatId: String(row.seat_id),
      from: { lat: Number(row.lat), lon: Number(row.lon), brickName: text(row.brick_name), areaName: text(row.area_name) },
      to: { ...photo, accuracyMeters: num(row.photo_accuracy_meters), brickName: trusted?.brickName ?? null, areaName: trusted?.areaName ?? null },
    });
  }

  // Every visit to these customers, measured the way the restamp will measure it, against each
  // customer's active places with the settled ones on their photo.
  const customerIds = [...new Set(plan.map((entry) => entry.customerId))];
  const settled = new Map(plan.map((entry) => [entry.placeId, entry.to]));
  const flips = new Map<string, number>();
  const flipped: { visitId: string; customerId: string; from: unknown; to: string; metres: number | null }[] = [];
  let visitsRead = 0;
  for (const part of chunk(customerIds, 150)) {
    const [places, visits] = await Promise.all([
      readAll("phoenix_crm_places", "id, customer_id, lat, lon, captured_at", (q) => q.in("customer_id", part).eq("is_test", false).eq("status", "active")),
      readAll("phoenix_crm_visits", "id, customer_id, seat_id, lat, lon, accuracy_meters, captured_at, location_flag", (q) => q.in("customer_id", part).eq("is_test", false)),
    ]);
    const byCustomer = new Map<string, MeasurablePlace[]>();
    for (const place of places) {
      const moved = settled.get(String(place.id));
      const list = byCustomer.get(String(place.customer_id)) ?? [];
      list.push({ id: String(place.id), lat: moved ? moved.lat : Number(place.lat), lon: moved ? moved.lon : Number(place.lon), capturedAt: String(place.captured_at ?? "") });
      byCustomer.set(String(place.customer_id), list);
    }
    for (const visit of visits) {
      const lat = num(visit.lat);
      const lon = num(visit.lon);
      if (lat === null || lon === null) continue;
      visitsRead += 1;
      const check = checkVisitLocation({
        fix: { lat, lon, accuracyMeters: num(visit.accuracy_meters) },
        places: placesFor({ capturedAt: text(visit.captured_at) }, byCustomer.get(String(visit.customer_id)) ?? []),
        farMeters: config.settings.visitFarMeters,
        weakGpsMeters: config.settings.weakGpsMeters,
      });
      if (check.flag !== visit.location_flag) {
        const key = `${visit.location_flag ?? "none"} → ${check.flag}`;
        flips.set(key, (flips.get(key) ?? 0) + 1);
        flipped.push({ visitId: String(visit.id), customerId: String(visit.customer_id), from: visit.location_flag, to: check.flag, metres: check.distanceMeters === null ? null : Math.round(check.distanceMeters) });
      }
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "plan.json"), JSON.stringify({ date: DATE, preImage: PRE_IMAGE, places: plan, flipped, held }, null, 2));
  const placeIds = plan.map((entry) => `'${entry.placeId}'`).join(",\n  ");
  const customerList = customerIds.map((id) => `'${id}'`).join(",\n  ");
  fs.writeFileSync(
    path.join(outDir, "pre-image.sql"),
    `-- Pre-image for scripts/phoenix-crm-settle-on-photo.ts (${DATE}).
create table public.${PRE_IMAGE}_places as select * from public.phoenix_crm_places where id in (
  ${placeIds}
);
create table public.${PRE_IMAGE}_visits as select id, customer_id, place_id, distance_meters, location_flag from public.phoenix_crm_visits where is_test = false and customer_id in (
  ${customerList}
);
alter table public.${PRE_IMAGE}_places enable row level security;
alter table public.${PRE_IMAGE}_visits enable row level security;
revoke all on public.${PRE_IMAGE}_places, public.${PRE_IMAGE}_visits from anon, authenticated;
notify pgrst, 'reload schema';
`,
  );

  const far = plan.map((entry) => metresBetween(entry.from, entry.to)).sort((a, b) => a - b);
  console.log(`Places to settle on their photo: ${plan.length} (customers ${customerIds.length}) · held, photo ${config.settings.visitFarMeters} m or more from the pin: ${held.length}`);
  console.log(`Pin to photo: median ${Math.round(far[Math.floor(far.length / 2)] ?? 0)} m, 50 m or more ${far.filter((m) => m >= 50).length}, largest ${Math.round(far.at(-1) ?? 0)} m`);
  console.log(`Brick would change: ${brickChanges} · area would change: ${areaChanges} · address read again: ${plan.filter((entry) => entry.reread).length}`);
  console.log(`Visits measured: ${visitsRead} · flags that would change: ${[...flips.values()].reduce((a, b) => a + b, 0)}`);
  for (const [key, count] of [...flips.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${key}: ${count}`);
  console.log(`Wrote ${outDir}`);
}

async function apply(): Promise<void> {
  const planPath = arg("plan");
  const preImage = arg("pre-image");
  const actor = text(arg("actor"))?.toUpperCase() ?? null;
  if (!planPath || !preImage || !actor) throw new Error("--apply needs --plan, --pre-image and --actor.");
  if (!/^phoenix_crm_photo_point_backup_\d{8}$/.test(preImage)) throw new Error(`--pre-image must name a dated backup, not ${preImage}`);
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as { preImage: string; places: PlanEntry[] };
  if (plan.preImage !== preImage) throw new Error(`The plan was written for ${plan.preImage}, not ${preImage}.`);

  const supabase = getSupabaseAdmin();
  let held = 0;
  for (const part of chunk(plan.places.map((entry) => entry.placeId), 150)) {
    const backup = await supabase.from(`${preImage}_places`).select("id", { count: "exact", head: true }).in("id", part);
    if (backup.error) throw new Error(`The pre-image ${preImage}_places could not be read: ${backup.error.message}`);
    held += backup.count ?? 0;
  }
  if (held !== plan.places.length) throw new Error(`The pre-image holds ${held} of the ${plan.places.length} places the plan names — refused.`);
  const visitsBackup = await supabase.from(`${preImage}_visits`).select("id", { count: "exact", head: true });
  if (visitsBackup.error) throw new Error(`The pre-image ${preImage}_visits could not be read: ${visitsBackup.error.message}`);

  const [seatAreas, centroids, config] = await Promise.all([loadSeatAreas(), loadBrickCentroids(), loadPhoenixCrmConfig()]);
  if (centroids.length === 0) throw new Error("The brick master could not be read; nothing was written.");

  let settled = 0;
  let skipped = 0;
  const customers = new Map<string, string>();
  for (const entry of plan.places) {
    const { data, error } = await supabase.from("phoenix_crm_places").select(PLACE_COLUMNS).eq("id", entry.placeId).maybeSingle();
    if (error) throw new Error(`phoenix_crm_places: ${error.message}`);
    const row = data as Row | null;
    // The row must still be the one planned: active, real, on its pin, with the same photo.
    if (!row || row.status !== "active" || row.is_test !== false || row.point_source !== "pin" || num(row.photo_lat) !== entry.to.lat || num(row.photo_lon) !== entry.to.lon) {
      skipped += 1;
      continue;
    }
    const areaCode = seatAreas.get(entry.seatId) ?? null;
    const point = { lat: entry.to.lat, lon: entry.to.lon, accuracyMeters: entry.to.accuracyMeters };
    const location: Record<string, unknown> = entry.reread ? await resolvePlaceLocation(point, territoryOfSeat({ areaCode })) : {};
    // A lookup that found no address keeps the row's own; the brick and area are the resolver's answer.
    if (entry.reread && location.address == null) {
      delete location.address;
      delete location.zone;
    }
    const update = await supabase
      .from("phoenix_crm_places")
      .update({ lat: point.lat, lon: point.lon, accuracy_meters: point.accuracyMeters, point_source: "photo", ...location, updated_at: new Date().toISOString() })
      .eq("id", entry.placeId)
      .eq("point_source", "pin");
    if (update.error) throw new Error(`Settling ${entry.placeId}: ${update.error.message}`);
    settled += 1;
    customers.set(entry.customerId, entry.seatId);
  }

  let restamped = 0;
  for (const [customerId, seatId] of customers) {
    restamped += await restampVisitLocations({ seatId, isTest: false, customerId, actorHrId: actor, settings: config.settings, scope: "all" });
  }
  console.log(`Settled on the photo: ${settled} · skipped (changed since the plan): ${skipped} · visits measured again: ${restamped}`);
}

await (arg("apply") ? apply() : dryRun());
