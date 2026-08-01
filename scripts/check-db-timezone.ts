// Asserts that timestamptz values come back from PostgREST in UTC.
//
// WHY THIS EXISTS. The entire CRM vendor-timestamp convention rests on this and nothing
// verified it. iReports360 sends zone-less Cairo WALL-CLOCK strings ("2026-07-14 09:30:00").
// The sync stores them verbatim in `timestamptz` columns, and every read formats them back
// with `timeZone: "UTC"` (see src/lib/crm/dates.ts and the visit-time helpers). That round
// trip is lossless ONLY while the database session hands the same wall-clock digits back —
// i.e. while the session TimeZone is UTC.
//
// If the session timezone were ever set to Africa/Cairo, Postgres would interpret each stored
// value as Cairo time and PostgREST would return it with a +02:00/+03:00 offset. The app,
// still formatting as UTC, would render every visit time shifted by 2-3 hours. Nothing would
// error: half-day AM/PM splits, the 8:30-12:01 compliance window, GPS-vs-save time tiering and
// the Cairo-day bucketing would all just quietly move. This is exactly the class of failure
// that looks like a data problem for weeks.
//
// Deliberately BEHAVIOURAL, not a `SHOW TimeZone` reading. What matters is not the server's
// configured default but what an actual PostgREST response carries — the same path the app
// uses. That also means this needs no new RPC or migration: it reads one existing row.
//
// Read-only: a single one-row SELECT.

import { createClient } from "@supabase/supabase-js";

/** Tables to probe, in order — the first one that yields a row wins. Each pairs a table with a
 * timestamptz column the CRM convention actually depends on. */
const PROBES: ReadonlyArray<{ column: string; table: string }> = [
  { column: "crm_save_date", table: "ireports360_visits" },
  { column: "check_date", table: "ireports360_checkins" },
  { column: "created_at", table: "audit_logs" },
];

/** A UTC timestamptz serialises with a `+00:00` offset (or a bare `Z`). Any other offset means
 * the session is NOT on UTC. PostgREST also emits `+00` on some versions, so accept that too. */
export function isUtcTimestamp(value: string): boolean {
  return /(?:Z|[+-]00(?::?00)?)$/.test(value.trim());
}

/** The offset suffix, for the failure message ("+02:00", "Z", or "none" for a naive string). */
export function offsetOf(value: string): string {
  const m = /(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(value.trim());
  return m ? m[1] : "none";
}

function projectRef(url: string | undefined): string {
  const m = /https:\/\/([a-z0-9]+)\.supabase\.co/i.exec(url ?? "");
  return m ? m[1] : "unknown";
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — cannot reach the target Supabase project.",
    );
  }
  const ref = projectRef(url);
  console.log(`[db-timezone] target project ref: ${ref}`);

  const supabase = createClient(url, key);

  for (const probe of PROBES) {
    const { data, error } = await supabase
      .from(probe.table)
      .select(probe.column)
      .not(probe.column, "is", null)
      .limit(1);
    // A missing table or a permission wrinkle is not this check's business — move to the next probe.
    if (error) {
      console.log(`[db-timezone] skipped ${probe.table}.${probe.column}: ${error.message}`);
      continue;
    }
    // Cast through unknown: the column name is dynamic, so the typed client can't narrow the row.
    const row = ((data ?? []) as unknown as Array<Record<string, unknown>>)[0];
    const value = row ? row[probe.column] : undefined;
    if (typeof value !== "string" || value === "") continue;

    if (isUtcTimestamp(value)) {
      console.log(`[db-timezone] OK — ${probe.table}.${probe.column} returned "${value}" (UTC) on ${ref}`);
      return;
    }

    console.error(
      `[db-timezone] ERROR — ${probe.table}.${probe.column} returned "${value}", offset ${offsetOf(value)}, not UTC on ${ref}. ` +
        "The CRM stores zone-less Cairo wall-clock times in timestamptz and reads them back formatted as UTC; " +
        "a non-UTC session shifts EVERY visit time by the offset with no error anywhere. " +
        "Fix the database session timezone before trusting any CRM time, AM/PM split, or compliance-window result.",
    );
    // process.exitCode, not process.exit(): exiting while the Supabase client's handles are still
    // being torn down aborts the process on Windows and replaces the real exit code with garbage.
    process.exitCode = 1;
    return;
  }

  // No probe produced a row. Do NOT pass silently — an unverifiable invariant is not a verified one.
  console.error(
    `[db-timezone] ERROR — no probe table on ${ref} yielded a non-null timestamp (tried ` +
      `${PROBES.map((p) => `${p.table}.${p.column}`).join(", ")}), so the UTC convention could not be verified. ` +
      "On an empty or skeleton database this is expected; treat it as 'not checked', never as 'passed'.",
  );
  process.exitCode = 1;
}

// Only run when invoked directly, so tests can import the pure helpers above.
if (process.argv[1] && /check-db-timezone\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error("[db-timezone] FAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
