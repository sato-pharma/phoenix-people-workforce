/**
 * One-off backfill: reverse-geocodes ireports360_checkins rows that have real GPS coordinates but
 * no address, for a chosen date range. The vendor's own reverse-geocoding rarely succeeds (~83% of
 * all check-ins are missing an address despite 100% having coordinates, confirmed 2026-07-21). The
 * retired iReports360 sync (removed 6 November 2026) trickle-fixed new check-ins as they arrived;
 * this script is for a deliberate, one-time catch-up over a chosen historical window, run outside any cron's
 * time/cost budget and only when explicitly triggered.
 *
 * Idempotent and safe to re-run/resume: only ever selects rows still missing an address (fetched
 * once into memory up front, then processed), and writes each row's result back to Supabase as
 * soon as it resolves — an interrupted run leaves already-fixed rows fixed and just re-selects
 * whatever's still missing next time, no bookkeeping needed.
 *
 * Usage (from the repo root, with a populated .env.local — this hits PRODUCTION Supabase):
 *   node --env-file=.env.local --experimental-strip-types \
 *     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
 *     scripts/backfill-checkin-addresses.ts <dateFrom YYYY-MM-DD> [dateTo YYYY-MM-DD]
 */
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { hasGoogleServerKey } from "@/lib/google-maps/server";
import { hasLocationIqKey, resolveCheckinAddress } from "@/lib/crm/checkin-geocode";
import { cairoTodayIso } from "@/lib/crm/dates";
import { CRM_CHECKINS_TABLE } from "@/lib/crm/tables";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "backfill-checkin-addresses",
  entry: import.meta.url,
  known: [],
});

const dateFrom = process.argv[2];
// Africa/Cairo, not UTC. This defaults the INCLUSIVE upper bound of a `check_date` window, and
// check_date is the agent's phone clock in Cairo time (crm/master.ts). A UTC "today" runs a day
// behind for the ~3 hours after Cairo midnight, silently trimming the newest day off the window
// the operator asked for. (Harmless to re-run — the script only ever selects rows still missing
// an address — but the run would report a smaller catch-up than it was asked to do.)
const dateTo = process.argv[3] ?? cairoTodayIso();

if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
  console.error("Usage: backfill-checkin-addresses <dateFrom YYYY-MM-DD> [dateTo YYYY-MM-DD]");
  process.exit(1);
}
if (!hasLocationIqKey() && !hasGoogleServerKey()) {
  console.error("[backfill] Neither LOCATIONIQ_API_KEY nor GOOGLE_MAPS_SERVER_KEY is configured in this environment — nothing to do.");
  process.exit(1);
}

const fetchPageSize = 1000;
const concurrency = 6;
const progressEvery = 200;

type CheckinRow = { address: string | null; id: string; lat: number | null; lon: number | null };

async function fetchCandidates(supabase: ReturnType<typeof getSupabaseAdmin>): Promise<CheckinRow[]> {
  const all: CheckinRow[] = [];
  for (let from = 0; ; from += fetchPageSize) {
    const { data, error } = await supabase
      .from(CRM_CHECKINS_TABLE)
      .select("id, lat, lon, address")
      .gte("check_date", `${dateFrom}T00:00:00`)
      .lte("check_date", `${dateTo}T23:59:59`)
      .not("lat", "is", null)
      .not("lon", "is", null)
      .or("address.is.null,address.eq.")
      .range(from, from + fetchPageSize - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as CheckinRow[];
    all.push(...page);
    if (page.length < fetchPageSize) break;
  }
  return all;
}

async function main() {
  const supabase = getSupabaseAdmin();
  console.log(`[backfill] scanning ireports360_checkins for ${dateFrom} .. ${dateTo} with coords but no address ...`);
  const candidates = await fetchCandidates(supabase);
  console.log(`[backfill] found ${candidates.length} rows to geocode.`);
  if (candidates.length === 0) return;

  let fixed = 0;
  let failed = 0;
  let processed = 0;
  let cursor = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
      while (cursor < candidates.length) {
        const row = candidates[cursor++];
        try {
          const label = await resolveCheckinAddress(row.lat as number, row.lon as number);
          if (label) {
            const { error } = await supabase.from(CRM_CHECKINS_TABLE).update({ address: label }).eq("id", row.id);
            if (error) throw new Error(error.message);
            fixed += 1;
          } else {
            failed += 1;
          }
        } catch (err) {
          failed += 1;
          console.error(`[backfill] row ${row.id} failed:`, err instanceof Error ? err.message : err);
        }
        processed += 1;
        if (processed % progressEvery === 0 || processed === candidates.length) {
          console.log(`[backfill] progress: ${processed}/${candidates.length} (fixed=${fixed}, failed=${failed})`);
        }
      }
    }),
  );

  console.log(`[backfill] done. total=${candidates.length} fixed=${fixed} failed=${failed}`);
}

await main();
