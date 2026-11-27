// Match the Sales Drilldown's top pharmacies to their exact Google Maps listing (owner, 27 Nov 2026:
// "Free top-2,616 match"). Run by Claude, from the code, never by the owner.
//
//   node --experimental-strip-types --experimental-specifier-resolution=node \
//     --import ./tests/register-alias-loader.mjs --env-file=.env.local \
//     scripts/territory-match-pharmacy-places.ts [--apply] [--limit 100] [--log <file.json>]
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

import { googlePlacesSearchAround } from "@/lib/google-maps/server";
import { pharmacySearchText } from "@/lib/sales/territory/pharmacy-directions";
import {
  MATCH_MAX_LISTINGS,
  MATCH_SEARCH_RADIUS_METERS,
  pickPlaceMatch,
  type PlaceMatchVerdict,
} from "@/lib/sales/territory/pharmacy-place-match";
import { haversineKm, isUsablePoint } from "@/lib/pharmacy-search/geo";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored: a mistyped --aply must not look up nothing
// and say so quietly, nor a mistyped --limt spend the month's allowance (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "territory-match-pharmacy-places",
  entry: import.meta.url,
  known: ["--apply", "--limit", "--budget", "--log"],
});

/** This script's own lookups per Cairo month. */
const MONTHLY_BUDGET = 2000;
/** Never more, whatever --budget says: the rest of the free 5,000 is Phoenix CRM's. */
const MAX_MONTHLY_BUDGET = 3000;
/** The pharmacies carrying this share of sales value over the three months before this one. */
const SALES_SHARE = 0.8;
const LOOKUP_TIMEOUT_MS = 8000;
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

async function main() {
  const apply = process.argv.includes("--apply");
  const budget = Math.min(Number(arg("--budget") ?? MONTHLY_BUDGET), MAX_MONTHLY_BUDGET);
  const limit = Math.max(0, Number(arg("--limit") ?? 100));
  const logPath = arg("--log");
  const periods = [cairoMonth(3), cairoMonth(2), cairoMonth(1)];
  const db = getSupabaseAdmin();

  const used = await db
    .from("territory_pharmacy_place_matches")
    .select("client_code", { count: "exact", head: true })
    .gte("looked_up_at", cairoMonthStartIso());
  if (used.error) throw new Error(`count this month's lookups: ${used.error.message}`);
  const spent = used.count ?? 0;
  const room = Math.max(0, budget - spent);
  const take = Math.min(limit, room);
  console.log(`months ${periods.join(", ")} · this month's lookups ${spent} of ${budget} · this run up to ${take}`);
  if (take === 0) return;

  const { data, error } = await db.rpc("phx_territory_pharmacies_to_match", {
    p_periods: periods,
    p_share: SALES_SHARE,
    p_limit: take + 200,
  });
  if (error) throw new Error(`list pharmacies: ${error.message}`);

  const work: Array<{ row: Candidate; searchText: string; centre: { latitude: number; longitude: number } }> = [];
  for (const row of (data ?? []) as Candidate[]) {
    if (work.length >= take) break;
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

  const tally: Record<PlaceMatchVerdict["status"], number> = { matched: 0, no_match: 0, ambiguous: 0, lookup_failed: 0 };
  const log: unknown[] = [];
  let next = 0;
  async function worker() {
    while (next < work.length) {
      const item = work[next++];
      const listings = await googlePlacesSearchAround(
        item.searchText,
        { lat: item.centre.latitude, lng: item.centre.longitude },
        { radiusMeters: MATCH_SEARCH_RADIUS_METERS, maxResultCount: MATCH_MAX_LISTINGS, timeoutMs: LOOKUP_TIMEOUT_MS },
      );
      const verdict = pickPlaceMatch({ pharmacyName: item.row.client_name ?? "", brickName: item.row.brick_name, brickCentre: item.centre, listings });
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
            `${listing.name} (${haversineKm({ latitude: listing.lat, longitude: listing.lng }, item.centre).toFixed(1)} km)`,
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
