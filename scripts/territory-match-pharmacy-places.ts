// Match the Sales Drilldown's top pharmacies to their exact Google Maps listing (owner, 27 Nov 2026:
// "Free top-2,616 match"). Run by Claude, from the code, never by the owner.
//
//   node --experimental-strip-types --experimental-specifier-resolution=node \
//     --import ./tests/register-alias-loader.mjs --env-file=.env.local \
//     scripts/territory-match-pharmacy-places.ts [--apply] [--limit 100] [--log <file.json>]
//     [--area <area code> --line <line>] [--retry-misses]
//
// --area with --line takes every pharmacy of that area and line over the last six months instead of the
// company's top sellers (owner, 27 Nov 2026: "Try to find the location for all the Cairo East 2 PDF
// pharmacies"). --retry-misses looks up again the ones that had no match, after a rule change.
//
// Each brick's town is asked of Google's geocoder once. Where Google puts the town more than
// BRICK_CENTRE_DOUBT_KM from the stored brick centre, the stored centre is wrong (Cairo East 2's
// عزبة النخل sat in downtown Cairo, 13 km off) and the search is made around Google's town centre.
// A chain's area-wide account (EZB-CA4, every El Ezaby branch in the area) has no one listing and is
// never looked up.
//
// Without --apply it calls nothing and writes nothing: it prints the pharmacies it would look up.
// With --apply it asks Google's place search once per pharmacy (pharmacy name + brick town, around the
// brick centre), judges the answer with pharmacy-place-match.ts, and keeps the verdict and the place id
// in territory_pharmacy_place_matches. Google's listing names go only to the --log file, for checking
// the run by eye — the table keeps the place id alone, the one Places value Google lets an app keep.
//
// 🔴 FREE MEANS CAPPED. Google gives 5,000 place searches a month free, and Phoenix CRM spends from the
// same allowance on every AM validation (about 1,700 by 27 Nov 2026). This script counts its own
// lookups this Cairo month from the table and stops at MONTHLY_BUDGET; it refuses a budget above
// MAX_MONTHLY_BUDGET whatever is passed. What is left waits for the next month's run.

import { writeFileSync } from "node:fs";

import { googleGeocodeAddress, googlePlacesSearchAround } from "@/lib/google-maps/server";
import { pharmacySearchText } from "@/lib/sales/territory/pharmacy-directions";
import {
  isChainAreaAccount,
  MATCH_MAX_LISTINGS,
  MATCH_SEARCH_RADIUS_METERS,
  pickPlaceMatch,
  trustedTownCentre,
  type PlaceMatchVerdict,
} from "@/lib/sales/territory/pharmacy-place-match";
import { haversineKm, isUsablePoint, type Point } from "@/lib/pharmacy-search/geo";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored: a mistyped --aply must not look up nothing
// and say so quietly, nor a mistyped --limt spend the month's allowance (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "territory-match-pharmacy-places",
  entry: import.meta.url,
  known: ["--apply", "--limit", "--budget", "--log", "--area", "--line", "--retry-misses"],
});

/** This script's own lookups per Cairo month. */
const MONTHLY_BUDGET = 2000;
/** Never more, whatever --budget says: the rest of the free 5,000 is Phoenix CRM's. */
const MAX_MONTHLY_BUDGET = 3000;
/** The pharmacies carrying this share of sales value over the three months before this one. */
const SALES_SHARE = 0.8;
const LOOKUP_TIMEOUT_MS = 8000;
/** An area run never asks for more than this in one go, whatever --limit says. */
const AREA_RUN_CAP = 300;
/** Months an area run reads, back from last month. */
const AREA_MONTHS = 6;
const PARALLEL = 4;

type Candidate = {
  distributor_code: string;
  client_code: string;
  client_name: string | null;
  brick_id: string | null;
  brick_name: string | null;
  brick_latitude: number | null;
  brick_longitude: number | null;
  sales_value: number;
  sales_rank: number;
};

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

/** "YYYY-MM" of the Cairo month, offset by `back` months. */
function cairoMonth(back: number): string {
  const [year, month] = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit" })
    .format(new Date())
    .split("-")
    .map(Number);
  const date = new Date(Date.UTC(year, month - 1 - back, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The instant the current Cairo month began. Cairo has no daylight saving: UTC+2. */
function cairoMonthStartIso(): string {
  const [year, month] = cairoMonth(0).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1, -2)).toISOString();
}

type Db = ReturnType<typeof getSupabaseAdmin>;
type AreaRow = {
  client_code: string | null;
  distributor_code: string | null;
  client_name: string | null;
  brick_id: string | null;
  batch_id: string;
  latest_row_created_at: string | null;
};

/** Every pharmacy of one area and line on the validated sheets of `periods`, each by its latest name and brick. */
async function loadAreaCandidates(db: Db, area: string, line: string, periods: string[], retryMisses: boolean): Promise<Candidate[]> {
  const batches = await db.from("source_of_sales_import_batches").select("id").eq("status", "validated");
  if (batches.error) throw new Error(`list batches: ${batches.error.message}`);
  const validated = new Set((batches.data ?? []).map((batch) => String(batch.id)));
  const rows: AreaRow[] = [];
  for (let from = 0; ; from += 1000) {
    const page = await db
      .from("source_of_sales_customer_directory_rollup")
      .select("client_code, distributor_code, client_name, brick_id, batch_id, latest_row_created_at")
      .in("period", periods)
      .eq("area_code", area)
      .ilike("official_line", line)
      .range(from, from + 999);
    if (page.error) throw new Error(`read ${area} ${line}: ${page.error.message}`);
    rows.push(...((page.data ?? []) as AreaRow[]));
    if (!page.data || page.data.length < 1000) break;
  }
  const latest = new Map<string, AreaRow>();
  for (const row of rows) {
    const distributor = String(row.distributor_code ?? "").trim().toUpperCase();
    const client = String(row.client_code ?? "").trim();
    if (!validated.has(row.batch_id) || !distributor || !client) continue;
    const key = `${distributor}/${client}`;
    const prior = latest.get(key);
    if (!prior || String(row.latest_row_created_at ?? "") > String(prior.latest_row_created_at ?? "")) latest.set(key, row);
  }
  const done = await db.from("territory_pharmacy_place_matches").select("distributor_code, client_code, status");
  if (done.error) throw new Error(`read earlier matches: ${done.error.message}`);
  const settled = new Set(
    (done.data ?? [])
      .filter((match) => match.status !== "lookup_failed" && !(retryMisses && match.status === "no_match"))
      .map((match) => `${match.distributor_code}/${match.client_code}`),
  );
  const todo = [...latest.entries()].filter(([key]) => !settled.has(key));
  const brickIds = [...new Set(todo.map(([, row]) => row.brick_id).filter((id): id is string => Boolean(id)))];
  const bricks = await db.from("source_of_sales_bricks").select("brick_id, brick_name").in("brick_id", brickIds);
  if (bricks.error) throw new Error(`read bricks: ${bricks.error.message}`);
  const centres = await db
    .from("geo_locations")
    .select("source_key, latitude, longitude")
    .eq("source_type", "brick_centroid")
    .in("source_key", brickIds);
  if (centres.error) throw new Error(`read brick centres: ${centres.error.message}`);
  const brickName = new Map((bricks.data ?? []).map((brick) => [String(brick.brick_id), (brick.brick_name as string | null) ?? null]));
  const centre = new Map((centres.data ?? []).map((point) => [String(point.source_key), point]));
  console.log(`${latest.size} pharmacies in ${area} ${line}; ${todo.length} to look up${retryMisses ? " (misses included)" : ""}`);
  return todo.map(([key, row], index) => {
    const point = row.brick_id ? centre.get(row.brick_id) : undefined;
    return {
      distributor_code: key.slice(0, key.indexOf("/")),
      client_code: key.slice(key.indexOf("/") + 1),
      client_name: row.client_name,
      brick_id: row.brick_id,
      brick_name: row.brick_id ? (brickName.get(row.brick_id) ?? null) : null,
      brick_latitude: point ? Number(point.latitude) : null,
      brick_longitude: point ? Number(point.longitude) : null,
      sales_value: 0,
      sales_rank: index + 1,
    };
  });
}

/** Google's centre for each brick town whose stored centre it says is wrong — one geocode per town. */
async function townCentresFor(work: ReadonlyArray<{ row: Candidate; centre: Point }>): Promise<Map<string, Point>> {
  const asked = new Set<string>();
  const out = new Map<string, Point>();
  for (const item of work) {
    const town = String(item.row.brick_name ?? "").trim();
    if (!town || asked.has(town)) continue;
    asked.add(town);
    let geocoded: Point | null = null;
    try {
      const found = await googleGeocodeAddress(`${town}, مصر`);
      geocoded = found ? { latitude: found.lat, longitude: found.lng } : null;
    } catch {
      geocoded = null;
    }
    const trusted = trustedTownCentre(item.centre, geocoded);
    if (trusted) {
      out.set(town, trusted);
      console.log(`  ${town}: stored centre ${haversineKm(item.centre, trusted).toFixed(1)} km from Google's town; searching around Google's`);
    }
  }
  return out;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const budget = Math.min(Number(arg("--budget") ?? MONTHLY_BUDGET), MAX_MONTHLY_BUDGET);
  const limit = Math.max(0, Number(arg("--limit") ?? 100));
  const logPath = arg("--log");
  const area = arg("--area");
  const line = arg("--line");
  if (Boolean(area) !== Boolean(line)) throw new Error("--area and --line go together");
  const retryMisses = process.argv.includes("--retry-misses");
  if (retryMisses && !area) throw new Error("--retry-misses needs --area and --line");
  const periods = [cairoMonth(3), cairoMonth(2), cairoMonth(1)];
  const db = getSupabaseAdmin();

  const used = await db
    .from("territory_pharmacy_place_matches")
    .select("client_code", { count: "exact", head: true })
    .gte("looked_up_at", cairoMonthStartIso());
  if (used.error) throw new Error(`count this month's lookups: ${used.error.message}`);
  const spent = used.count ?? 0;
  const room = Math.max(0, budget - spent);
  const take = Math.min(area ? AREA_RUN_CAP : limit, room);
  console.log(`months ${periods.join(", ")} · this month's lookups ${spent} of ${budget} · this run up to ${take}`);
  if (take === 0) return;

  let candidates: Candidate[];
  if (area && line) {
    const areaPeriods = Array.from({ length: AREA_MONTHS }, (_, index) => cairoMonth(AREA_MONTHS - index));
    candidates = await loadAreaCandidates(db, area, line, areaPeriods, retryMisses);
    if (candidates.length > take) throw new Error(`refusing ${candidates.length} lookups: this run may ask ${take}`);
  } else {
    const { data, error } = await db.rpc("phx_territory_pharmacies_to_match", {
      p_periods: periods,
      p_share: SALES_SHARE,
      p_limit: take + 200,
    });
    if (error) throw new Error(`list pharmacies: ${error.message}`);
    candidates = (data ?? []) as Candidate[];
  }

  const work: Array<{ row: Candidate; searchText: string; centre: Point; townCentre?: Point }> = [];
  for (const row of candidates) {
    if (work.length >= take) break;
    if (isChainAreaAccount(row.client_code)) continue;
    const latitude = Number(row.brick_latitude);
    const longitude = Number(row.brick_longitude);
    const searchText = pharmacySearchText(row.client_name, row.brick_name);
    if (!searchText || !isUsablePoint(latitude, longitude)) continue;
    work.push({ row, searchText, centre: { latitude, longitude } });
  }
  console.log(`${work.length} pharmacies to look up (ranks ${work[0]?.row.sales_rank ?? "-"} to ${work.at(-1)?.row.sales_rank ?? "-"})`);
  if (!apply) {
    for (const item of work.slice(0, 15)) console.log(`  #${item.row.sales_rank} ${item.row.distributor_code}/${item.row.client_code} ${item.searchText}`);
    console.log("dry run: nothing asked of Google, nothing written. Add --apply.");
    return;
  }
  const townCentres = await townCentresFor(work);
  for (const item of work) item.townCentre = townCentres.get(String(item.row.brick_name ?? "").trim());

  const tally: Record<PlaceMatchVerdict["status"], number> = { matched: 0, no_match: 0, ambiguous: 0, lookup_failed: 0 };
  const log: unknown[] = [];
  let next = 0;
  async function worker() {
    while (next < work.length) {
      const item = work[next++];
      const searchCentre = item.townCentre ?? item.centre;
      const listings = await googlePlacesSearchAround(
        item.searchText,
        { lat: searchCentre.latitude, lng: searchCentre.longitude },
        { radiusMeters: MATCH_SEARCH_RADIUS_METERS, maxResultCount: MATCH_MAX_LISTINGS, timeoutMs: LOOKUP_TIMEOUT_MS },
      );
      const verdict = pickPlaceMatch({
        pharmacyName: item.row.client_name ?? "",
        brickName: item.row.brick_name,
        brickCentre: item.centre,
        townCentre: item.townCentre ?? null,
        listings,
      });
      tally[verdict.status] += 1;
      const write = await db.from("territory_pharmacy_place_matches").upsert(
        {
          distributor_code: item.row.distributor_code,
          client_code: item.row.client_code,
          status: verdict.status,
          google_place_id: verdict.status === "matched" ? verdict.placeId : null,
          search_text: item.searchText,
          brick_id: item.row.brick_id,
          looked_up_at: new Date().toISOString(),
        },
        { onConflict: "distributor_code,client_code" },
      );
      if (write.error) throw new Error(`save ${item.row.distributor_code}/${item.row.client_code}: ${write.error.message}`);
      log.push({
        rank: item.row.sales_rank,
        code: `${item.row.distributor_code}/${item.row.client_code}`,
        name: item.row.client_name,
        brick: item.row.brick_name,
        search: item.searchText,
        verdict: verdict.status,
        listing: verdict.status === "matched" ? verdict.listingName : null,
        km: verdict.status === "matched" ? Number(verdict.distanceKm.toFixed(2)) : null,
        answers: (listings ?? []).map(
          (listing) =>
            `${listing.name} (${haversineKm({ latitude: listing.lat, longitude: listing.lng }, searchCentre).toFixed(1)} km)`,
        ),
      });
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, () => worker()));
  if (logPath) writeFileSync(logPath, JSON.stringify(log, null, 1));
  console.log(`looked up ${work.length}: ${tally.matched} matched · ${tally.no_match} no match · ${tally.ambiguous} two or more · ${tally.lookup_failed} lookup failed`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
