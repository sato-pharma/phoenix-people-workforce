// Daily warm-up of the outstation destination geocode cache.
//
// resolveDestinationCoords() caches every distinct destination string the
// Outstation Expense Command Center maps. Without a warm-up, the FIRST request
// of the day that includes a never-seen destination pays the geocode latency
// (one Google API round-trip per uncached string). This runs once a day from
// the existing 04:00 UTC daily cron, lists every distinct destination string
// currently in the data, and asks resolveDestinationCoords to cache anything
// new. Already-cached strings are no-ops (single SELECT), so it's cheap and
// idempotent. No new Vercel cron.

import { resolveDestinationCoords } from "@/lib/outstation/destination-geocode";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const PAGE_SIZE = 1000; // PostgREST default cap

export type GeocodeWarmupResult =
  | { ok: true; distinctDestinations: number; cached: number }
  | { ok: false; distinctDestinations: 0; cached: 0; error: string };

async function listDistinctDestinations(): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const seen = new Set<string>();

  // 1. Historical outstation_expenses rows — to_location is the precise destination,
  //    location is the fallback when the upload didn't separate from/to.
  try {
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from("outstation_expenses")
        .select("to_location, location")
        // A total order: an unordered offset walk can drop one row and repeat another between pages.
        .order("id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) break;
      const rows = (data ?? []) as Array<{ to_location?: string | null; location?: string | null }>;
      rows.forEach((row) => {
        const value = (row.to_location ?? row.location ?? "").toString().trim();
        if (value) seen.add(value);
      });
      if (rows.length < PAGE_SIZE) break;
    }
  } catch {
    // Table missing — fall through to requests.
  }

  // 2. Live outstation requests carry their own to_label.
  try {
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from("outstation_expense_requests")
        .select("to_label")
        .order("id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) break;
      const rows = (data ?? []) as Array<{ to_label?: string | null }>;
      rows.forEach((row) => {
        const value = (row.to_label ?? "").toString().trim();
        if (value) seen.add(value);
      });
      if (rows.length < PAGE_SIZE) break;
    }
  } catch {
    // Table missing — return what we have from outstation_expenses.
  }

  return Array.from(seen);
}

/** Top-level entry — wired into the daily-cron Promise.all. */
export async function runOutstationGeocodeWarmup(): Promise<GeocodeWarmupResult> {
  try {
    const destinations = await listDistinctDestinations();
    if (destinations.length === 0) {
      return { ok: true, distinctDestinations: 0, cached: 0 };
    }
    const coords = await resolveDestinationCoords(destinations);
    return { ok: true, distinctDestinations: destinations.length, cached: coords.size };
  } catch (error) {
    return {
      ok: false,
      distinctDestinations: 0,
      cached: 0,
      error: error instanceof Error ? error.message : "Outstation geocode warm-up failed.",
    };
  }
}
