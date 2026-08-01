/**
 * The CRM (iReports360) sync/write engine — the ONLY code that pulls from the live CRM API and
 * writes the mirror tables. Cron, weekly reconciliation, and manual backfill all funnel through
 * `syncIReports360Visits`. Relocated verbatim from visits-report/service.ts so the CRM module
 * owns the single live-pull path; behavior is unchanged.
 */

import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import {
  iReports360GetCheckins,
  iReports360GetVisits,
  iReports360Login,
  type IReports360Checkin,
  type IReports360Visit,
} from "@/lib/crm/client";
import { getIReports360Config, isIReports360Configured } from "@/lib/crm/config";
import { hasLocationIqKey, resolveCheckinAddress } from "@/lib/crm/checkin-geocode";
import {
  buildCrmIdentityMaps,
  getCrmIdentityResolutions,
  resolveEmployeeAttribution,
  resolveEmployeeHrId,
  type CrmIdentityMaps,
} from "@/lib/crm/identity";
import { CRM_CHECKINS_TABLE, CRM_SYNC_RUNS_TABLE, CRM_VISITS_TABLE } from "@/lib/crm/tables";
import { addDaysIso, cairoTodayIso, todayIso } from "@/lib/crm/dates";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { hasGoogleServerKey } from "@/lib/google-maps/server";
import type { VisitsSyncTrigger } from "@/lib/visits-report/types";

const visitsTable = CRM_VISITS_TABLE;
const checkinsTable = CRM_CHECKINS_TABLE;
const syncRunsTable = CRM_SYNC_RUNS_TABLE;
const upsertBatchSize = 500;
// At the (now-reverted, see runScheduledIReports360Sync's doc comment) 21-day lookback, a full
// run chunked into ~26 visits requests + ~25 checkins requests. Run one-at-a-time, each
// successive request measurably slows under sustained Supabase load (observed 9.9s -> 15s per
// chunk in production), and the cumulative wall-clock was the actual cause of the recurring
// "Supabase request timed out" cron failures — not per-row inserts, which were already batched.
// Bounded concurrency (not full parallelism) keeps this from also overwhelming Supabase's own
// connection pool. Kept even after the 10-day lookback revert: the sequential delete-
// reconciliation loop further down turned out to still be a second bottleneck on its own.
const upsertConcurrency = 4;
// Bounds how many NEW (never-before-resolved) check-in addresses one sync run will pay to
// reverse-geocode. The recurring cron re-scans a rolling window, so any backlog beyond this cap
// is simply picked up by a later run rather than risking this run's own maxDuration budget.
const maxNewCheckinGeocodesPerSync = 200;
const geocodeConcurrency = 4;

/** True for a well-formed YYYY-MM-DD date string — used to keep a visit with a missing/malformed
 * CRM visitDate from corrupting the NOT NULL `visit_date` column or aborting its whole chunk. */
export function isValidIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Last-wins dedup by a key — used before chunking visits/check-ins for upsert, so a CRM
 * response that (against its own contract) repeats an id within one page can never make a
 * single chunk's upsert throw ("ON CONFLICT DO UPDATE command cannot affect row a second time"). */
export function dedupeByKey<T>(rows: T[], keyOf: (row: T) => number | string): T[] {
  return Array.from(new Map(rows.map((row) => [keyOf(row), row])).values());
}

/** Splits `rows` into `chunkSize`-sized chunks and upserts them with up to `concurrency` chunk
 * requests in flight at once, instead of one-at-a-time — see upsertConcurrency's doc comment for
 * why sequential chunking alone was the cause of repeated cron timeouts. Returns the total row
 * count upserted; throws (aborting remaining chunks) on the first chunk error, same failure
 * behavior as the sequential loop it replaces. */
async function upsertRowsConcurrently<T extends Record<string, unknown>>(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  table: string,
  rows: T[],
  onConflict: string,
  chunkSize: number,
  concurrency: number,
): Promise<number> {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += chunkSize) chunks.push(rows.slice(index, index + chunkSize));
  let upserted = 0;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, chunks.length) }, async () => {
      while (cursor < chunks.length) {
        const chunk = chunks[cursor++];
        // The widening cast is required by postgrest-js >= 2.110, which wraps upsert's argument
        // in RejectExcessProperties<Row, T>. That is a conditional type, so against an unresolved
        // generic `T` it never reduces and NOTHING satisfies it — constraining T does not help;
        // only a concrete type does. No safety is lost: `from(table)` takes a runtime string, so
        // Row is already `any` here and the excess-property check has nothing to check against.
        const { error } = await supabase.from(table).upsert(chunk as Record<string, unknown>[], { onConflict });
        if (error) throw new Error(error.message);
        upserted += chunk.length;
      }
    }),
  );
  return upserted;
}

/** Normalizes the vendor's contactGrade (A+/A/B/C) — sent with inconsistent casing and stray
 * whitespace ("b", " A", "B   ") — to a clean uppercase/trimmed value. Empty string -> null, same
 * "blank means no signal" convention as every other optional CRM field. */
export function normalizeContactGrade(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase();
  return normalized ? normalized : null;
}

// VENDOR TIMESTAMP INVARIANT (load-bearing — do not "helpfully" convert): iReports360 sends
// `saveDate`/`checkDate`/`visitDate` as zone-less strings that are ALREADY Africa/Cairo wall-clock
// (e.g. "2026-07-16T18:13:18", no offset). They are stored verbatim into `timestamptz` columns, so
// they must be WRITTEN under a UTC DB session — then the stored instant reads back as the same
// Cairo wall-clock and every display renders it with timeZone:"UTC" (no shift). Never append a
// Cairo offset or run AT TIME ZONE on these — that double-shifts the clock 2–3h. `visit_date_time`
// is a 00:00 placeholder (no real time-of-day); the authoritative visit time is derived downstream
// by resolveVisitTime (crm/reads.ts): GPS check-in → save time → none, never visit_date_time.
export function rowFromVisit(visit: IReports360Visit, maps: CrmIdentityMaps) {
  const doubleCrmId = visit.doubleID && visit.doubleID !== 0 ? visit.doubleID : null;
  // The visit's own date drives the post-exit attribution guard (see resolveEmployeeAttribution):
  // a CRM slot reused for a departing rep's replacement must not keep stamping the leaver's hr id
  // onto the new rep's work, which is what made 190 live visits invisible platform-wide.
  const visitDay = (visit.visitDate ?? "").slice(0, 10) || null;
  return {
    agent_crm_id: visit.agentID,
    agent_hr_id: resolveEmployeeHrId(visit.agentID, visit.agentName, maps, visitDay),
    agent_name: visit.agentName,
    ampm: visit.ampm,
    attendance: visit.attendance,
    call_type: visit.callType,
    comment: visit.comment,
    contact_crm_id: visit.contactID,
    contact_name: visit.contactName,
    crm_contact_grade: normalizeContactGrade(visit.contactGrade),
    crm_region_id: visit.regionID,
    crm_region_name: visit.region,
    crm_save_date: visit.saveDate,
    crm_visit_id: visit.id,
    customer_name: visit.customerName,
    double_crm_id: doubleCrmId,
    double_hr_id: doubleCrmId ? resolveEmployeeHrId(doubleCrmId, visit.doubleName, maps, visitDay) : null,
    double_name: visit.doubleName,
    speciality: visit.speciality,
    raw_payload: visit as unknown as Record<string, unknown>,
    synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    // The vendor's own type contract declares visitDate required, but the sibling
    // field-workforce-compliance/ireports360-source.ts module defensively guards the exact same
    // field from the exact same API — matching that here rather than trusting the contract.
    visit_date: (visit.visitDate ?? "").slice(0, 10),
    visit_date_time: visit.visitDate,
    visit_type: visit.visitType,
    visit_type_description: visit.visitTypeDescription,
  };
}

function rowFromCheckin(checkin: IReports360Checkin, maps: CrmIdentityMaps) {
  return {
    address: checkin.address,
    agent_crm_id: checkin.agentID,
    // Check-ins have no agent display-name field (crm_id only) — the crm_username fallback
    // can't apply here, only the direct crm_id match. `checkDate` is the record's own date, so it
    // drives the post-exit guard exactly as a visit's date does.
    agent_hr_id: resolveEmployeeHrId(checkin.agentID, null, maps, (checkin.checkDate ?? "").slice(0, 10) || null),
    check_date: checkin.checkDate,
    contact_crm_id: checkin.contactID,
    contact_name: checkin.contactName,
    crm_checkin_id: checkin.id,
    lat: checkin.lat,
    lon: checkin.lon,
    raw_payload: checkin as unknown as Record<string, unknown>,
    synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export type CheckinDraftRow = ReturnType<typeof rowFromCheckin>;

/** True when a row has no usable address yet but has real coordinates to geocode from. */
function checkinNeedsAddress(row: CheckinDraftRow): boolean {
  return (
    (!row.address || !row.address.trim()) &&
    typeof row.lat === "number" &&
    Number.isFinite(row.lat) &&
    typeof row.lon === "number" &&
    Number.isFinite(row.lon)
  );
}

/**
 * Pure decision core of the address-backfill step — split out so it's unit-testable without
 * mocking Supabase or the Google Maps API (same reasoning as resolveWideReconciliationSlice
 * above). Mutates `address` in place on any row whose crm_checkin_id already resolved to a
 * known-good address on a prior sync (never re-bills Google for the same check-in twice).
 * Returns the remainder that still need a fresh geocode call, capped to `cap` — anything beyond
 * the cap is left for a later sync run rather than risking this run's own time budget.
 */
export function selectCheckinsToGeocode(
  rows: CheckinDraftRow[],
  existingAddressById: Map<number, string>,
  cap: number,
): CheckinDraftRow[] {
  const needsGeocode: CheckinDraftRow[] = [];
  for (const row of rows) {
    if (!checkinNeedsAddress(row)) continue;
    const known = existingAddressById.get(row.crm_checkin_id);
    if (known) row.address = known;
    else needsGeocode.push(row);
  }
  return needsGeocode.slice(0, cap);
}

/**
 * iReports360 frequently returns a check-in with real GPS coordinates but a blank `address` —
 * the vendor's own reverse-geocoding step is unreliable. Backfilling it here (the single sync
 * door) means every downstream reader gets it for free instead of each doing its own lookup.
 *
 * Looks up each crm_checkin_id missing an address against what's already stored (so a check-in
 * only ever gets geocoded once, ever — see selectCheckinsToGeocode), then runs a bounded-
 * concurrency batch of fresh Geocoding API calls for the rest, capped per run — LocationIQ first
 * (free tier), Google as a fallback (see resolveCheckinAddress in crm/checkin-geocode.ts). Any
 * failure mode (no key configured, lookup error, API error, over the cap) just leaves `address`
 * as whatever the vendor sent — best-effort, never fails the sync, matching check-ins' existing
 * posture (a GPS overlay, never required for the sync to succeed).
 */
async function backfillMissingCheckinAddresses(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  rows: CheckinDraftRow[],
): Promise<void> {
  const candidateIds = rows.filter(checkinNeedsAddress).map((row) => row.crm_checkin_id);
  if (candidateIds.length === 0) return;

  // Restoring an ALREADY-STORED address happens unconditionally, before (and independently of) any
  // geocoding. The vendor usually sends `address: null`, and the upsert overwrites every column —
  // so whenever this restore was skipped, the next sync destroyed addresses the mirror had already
  // paid Google/LocationIQ to resolve, right across the rolling window. It used to sit behind the
  // API-key check below, which meant a key rotation, expiry, or a plain misconfiguration silently
  // wiped them. This step is pure data preservation and needs no key at all.
  const existingById = new Map<number, string>();
  let existingLookupFailed = false;
  try {
    for (let from = 0; from < candidateIds.length; from += 500) {
      const chunk = candidateIds.slice(from, from + 500);
      const { data, error } = await supabase
        .from(checkinsTable)
        .select("crm_checkin_id, address")
        .in("crm_checkin_id", chunk);
      if (error) throw new Error(error.message);
      for (const existing of (data ?? []) as Array<{ address: string | null; crm_checkin_id: number }>) {
        if (existing.address && existing.address.trim()) existingById.set(existing.crm_checkin_id, existing.address);
      }
    }
  } catch (error) {
    // Best-effort, but no longer silent: if this lookup fails we cannot tell which rows already
    // have an address, so the upsert below may null some of them out. Worth a log line.
    existingLookupFailed = true;
    logError("CRM sync could not read existing check-in addresses; stored addresses may be overwritten", {
      labels: { event: "crm_sync_existing_address_lookup_failed" },
      error,
    });
  }

  // Restore known addresses onto the draft rows even when no geocoding key is configured.
  for (const row of rows) {
    if (!checkinNeedsAddress(row)) continue;
    const known = existingById.get(row.crm_checkin_id);
    if (known) row.address = known;
  }

  // Fresh geocoding is the optional part — it is what actually needs an API key.
  if (!hasLocationIqKey() && !hasGoogleServerKey()) return;
  if (existingLookupFailed) {
    // Without the existing-address map, selectCheckinsToGeocode cannot tell which rows are already
    // resolved and would burn the per-run cap re-geocoding them. Skip the fresh pass this run.
    return;
  }

  const toGeocode = selectCheckinsToGeocode(rows, existingById, maxNewCheckinGeocodesPerSync);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(geocodeConcurrency, toGeocode.length) }, async () => {
      while (cursor < toGeocode.length) {
        const row = toGeocode[cursor++];
        try {
          const label = await resolveCheckinAddress(row.lat as number, row.lon as number);
          if (label) row.address = label;
        } catch {
          // best-effort — leave this row's address as the vendor sent it (null)
        }
      }
    }),
  );
}

/**
 * Pulls every visit AND check-in iReports360 recorded in [dateFrom, dateTo] in one
 * authenticated session, and upserts them into ireports360_visits / ireports360_checkins,
 * keyed on the CRM's own crm_visit_id / crm_checkin_id — re-running over an overlapping range
 * (which the recurring cron does deliberately, to catch late CRM edits) is safe and
 * idempotent. Logs a row in ireports360_visits_sync_runs for every attempt, success or
 * failure, so sync freshness is visible instead of silent.
 */
export async function syncIReports360Visits(input: {
  dateFrom: string;
  dateTo: string;
  trigger: VisitsSyncTrigger;
}): Promise<{
  /** Visits whose CRM slot resolved to someone who had already left on the visit date, so the
   * post-exit guard refused the attribution. >0 means a slot was probably handed to a replacement
   * and needs an identity override — the recurrence signal for the invisible-work bug class. */
  blockedPostExitAttributions: number;
  /** True when the check-ins fetch or reconciliation failed. Distinguishes "no check-ins today"
   * from "the check-ins endpoint is broken", which used to look identical from outside. */
  checkinsFailed: boolean;
  checkinsFetched: number;
  checkinsUpserted: number;
  rowsDeleted: number;
  rowsFetched: number;
  rowsSkippedInvalidDate: number;
  /** >0 means the reconciliation REFUSED to delete because the fetch looked truncated (it would
   * have removed more than half the window). The single most important write-path warning. */
  rowsSkippedReconcile: number;
  rowsUpserted: number;
  runId: string;
}> {
  if (!isIReports360Configured()) {
    throw new Error("iReports360 is not configured (missing IREPORTS360_BASE_URL/USERNAME/PASSWORD).");
  }
  // Raise timeout — batched upserts into large visit/checkin tables can legitimately exceed the default 15s.
  const supabase = getSupabaseAdmin({ requestTimeoutMs: 60_000 });
  const { data: runRow, error: runError } = await supabase
    .from(syncRunsTable)
    .insert({ date_from: input.dateFrom, date_to: input.dateTo, status: "running", trigger: input.trigger })
    .select("id")
    .single();
  if (runError || !runRow) throw new Error(runError?.message ?? "Failed to start a sync run record.");
  const runId = runRow.id as string;

  try {
    // Taken BEFORE the vendor fetch: it is the instant this run's view of the CRM was captured.
    // Any mirror row synced at/after this is newer than our snapshot and must be excluded from the
    // deletion set below, not treated as something the CRM deleted.
    const runStartedAt = new Date().toISOString();
    const config = getIReports360Config();
    const token = await iReports360Login(config);
    let checkinsFailed = false;
    const [visits, checkins] = await Promise.all([
      iReports360GetVisits(config, token, input.dateFrom, input.dateTo),
      // GPS check-ins are a best-effort overlay for visits, never required for the sync to
      // succeed — a check-ins API problem must not fail the whole run (same rule already
      // applied to the single-rep FWC drill-down this pattern is mirrored from). But it must not
      // be SILENT either: this used to swallow the error with no log and no counter, so a
      // permanently-broken /checkins endpoint (auth scope, rename, 500) would stop check-in
      // syncing forever while every run still reported success. Every visit's time then silently
      // degrades from the GPS tier to the save tier (see resolveVisitTime) with no visible change
      // of state. Now logged and flagged so "0 check-ins" can be told apart from "check-ins broke".
      iReports360GetCheckins(config, token, input.dateFrom, input.dateTo).catch((error: unknown) => {
        checkinsFailed = true;
        logError("iReports360 check-ins fetch failed; visits still synced without the GPS overlay", {
          labels: { event: "crm_sync_checkins_fetch_failed", dateFrom: input.dateFrom, dateTo: input.dateTo },
          error,
        });
        return [] as IReports360Checkin[];
      }),
    ]);

    const [employees, resolutions] = await Promise.all([
      getEmployeeDirectoryRows({ includeInactive: true }),
      getCrmIdentityResolutions(),
    ]);
    const maps = buildCrmIdentityMaps(employees, resolutions);

    // Dedupe by the CRM's own stable id (last-wins) BEFORE chunking — if the API ever returns
    // two records sharing an id in one response, a raw chunked upsert would throw ("ON CONFLICT
    // DO UPDATE command cannot affect row a second time"). Built from the FULL fetch (including
    // rows an invalid visit_date will exclude from the actual upsert below) so every crm_visit_id
    // this fetch ever saw still counts as "present" for the reconciliation delete further down —
    // a single malformed date must never look like a CRM deletion of an otherwise-good visit.
    const visitRows = visits.map((visit) => rowFromVisit(visit, maps));
    const dedupedVisitRows = dedupeByKey(visitRows, (row) => row.crm_visit_id);
    const validVisitRows = dedupedVisitRows.filter((row) => isValidIsoDate(row.visit_date));
    const rowsSkippedInvalidDate = dedupedVisitRows.length - validVisitRows.length;

    // DETECTION. How many visits the post-exit guard refused to attribute — i.e. the CRM slot still
    // resolves to someone who had already left on the day the work happened. Almost always means the
    // slot was handed to a replacement and needs an identity override. Counted in a second pure pass
    // (map lookups only, no I/O) rather than widening rowFromVisit's return, which IS the upsert row
    // shape and would try to write a non-existent column. A steady non-zero count here is the signal
    // that used to be missing entirely — the previous behaviour silently filed the new rep's work
    // under the leaver, where the departed-agent exclusion then hid it from every surface.
    const blockedPostExitAttributions = visits.reduce((count, visit) => {
      const visitDay = (visit.visitDate ?? "").slice(0, 10) || null;
      const agent = resolveEmployeeAttribution(visit.agentID, visit.agentName, maps, visitDay);
      return count + (agent.blockedHrId ? 1 : 0);
    }, 0);

    const visitsUpserted = await upsertRowsConcurrently(
      supabase,
      visitsTable,
      validVisitRows,
      "crm_visit_id",
      upsertBatchSize,
      upsertConcurrency,
    );

    const checkinRows = checkins.map((checkin) => rowFromCheckin(checkin, maps));
    const dedupedCheckinRows = dedupeByKey(checkinRows, (row) => row.crm_checkin_id);
    await backfillMissingCheckinAddresses(supabase, dedupedCheckinRows);
    const checkinsUpserted = await upsertRowsConcurrently(
      supabase,
      checkinsTable,
      dedupedCheckinRows,
      "crm_checkin_id",
      upsertBatchSize,
      upsertConcurrency,
    );

    // Reconcile deletions strictly within [input.dateFrom, input.dateTo]: after a successful,
    // non-empty fetch, any crm_visit_id that exists in the mirror for this window but was NOT
    // seen in this fetch at all was voided/deleted in the CRM — remove it. Never runs on an
    // empty fetch (that would treat "we got nothing back" as "nothing exists"). A partial or
    // truncated CRM response looks identical to real deletions, so this is capped at 50% of the
    // window's existing rows as a sanity check rather than ever wiping most of a window blind.
    let rowsDeleted = 0;
    let rowsSkippedReconcile = 0;
    if (dedupedVisitRows.length > 0) {
      const freshIds = new Set(dedupedVisitRows.map((row) => row.crm_visit_id));
      const existingIds: number[] = [];
      // synced_at per row, so a row written by a CONCURRENT sync after this run took its snapshot
      // can be protected from deletion below.
      const syncedAtById = new Map<number, string>();
      const reconcilePageSize = 5000;
      // KEYSET, NOT OFFSET. This paged with `.range()` and no `.order()`; Postgres gives no stable
      // row order without ORDER BY, so pages could repeat rows and skip others. That is bad here in
      // BOTH directions: a skipped id is never considered for deletion (a voided visit lingers in
      // the mirror), and a repeated id inflates existingIds.length — which is the denominator of the
      // 50% sanity cap below, so a genuinely truncated CRM response becomes MORE likely to slip past
      // the guard and delete real rows. Same fault class as the crosswalk loader (PR #1446).
      let cursor: number | null = null;
      for (;;) {
        let query = supabase
          .from(visitsTable)
          .select("crm_visit_id, synced_at")
          .gte("visit_date", input.dateFrom)
          .lte("visit_date", input.dateTo)
          .order("crm_visit_id", { ascending: true })
          .limit(reconcilePageSize);
        if (cursor !== null) query = query.gt("crm_visit_id", cursor);
        const { data, error } = await query;
        if (error) throw new Error(error.message);
        const page = (data ?? []) as Array<{ crm_visit_id: number; synced_at: string | null }>;
        if (page.length === 0) break;
        existingIds.push(...page.map((row) => row.crm_visit_id));
        for (const row of page) {
          if (row.synced_at) syncedAtById.set(row.crm_visit_id, row.synced_at);
        }
        if (page.length < reconcilePageSize) break;
        const last = Number(page[page.length - 1]?.crm_visit_id);
        if (!Number.isFinite(last)) break; // no usable cursor — stop rather than loop forever
        cursor = last;
      }
      // A row is stale only if this fetch didn't see it AND it was already in the mirror when this
      // run took its snapshot. The second half closes a real race: `freshIds` comes from a fetch at
      // T0, but `existingIds` is read minutes later, so any row a CONCURRENT sync inserted in
      // between (the 9:07 daily run overlapping the 9:16 live run, or a manual backfill) is absent
      // from freshIds and was therefore classified stale and DELETED — a genuine visit, removed
      // seconds after being synced, on a board managers read live. Rows written at/after T0 are now
      // structurally immune. Note this filters only the STALE set, never `existingIds` itself,
      // which stays the full window so the 50%-truncation guard below keeps its real denominator.
      const staleIds = existingIds.filter((id) => {
        if (freshIds.has(id)) return false;
        const syncedAt = syncedAtById.get(id);
        return !syncedAt || syncedAt < runStartedAt;
      });
      if (existingIds.length > 0 && staleIds.length / existingIds.length > 0.5) {
        rowsSkippedReconcile = staleIds.length;
      } else {
        for (let index = 0; index < staleIds.length; index += upsertBatchSize) {
          const chunk = staleIds.slice(index, index + upsertBatchSize);
          const { error } = await supabase.from(visitsTable).delete().in("crm_visit_id", chunk);
          if (error) throw new Error(error.message);
          rowsDeleted += chunk.length;
        }
      }
    }

    // Check-in reconciliation mirrors the visits one above, scoped by check_date instead of
    // visit_date — but stays best-effort (never fails the run), matching the check-ins fetch's
    // own posture a few lines up: GPS check-ins are a nice-to-have overlay, never required.
    try {
      if (dedupedCheckinRows.length > 0) {
        const freshCheckinIds = new Set(dedupedCheckinRows.map((row) => row.crm_checkin_id));
        const existingCheckinIds: number[] = [];
        const reconcilePageSize = 5000;
        // Keyset for the same reason as the visits reconcile above — this list also drives deletes.
        let checkinCursor: number | null = null;
        for (;;) {
          let query = supabase
            .from(checkinsTable)
            .select("crm_checkin_id")
            .gte("check_date", `${input.dateFrom}T00:00:00`)
            .lte("check_date", `${input.dateTo}T23:59:59`)
            .order("crm_checkin_id", { ascending: true })
            .limit(reconcilePageSize);
          if (checkinCursor !== null) query = query.gt("crm_checkin_id", checkinCursor);
          const { data, error } = await query;
          if (error) throw new Error(error.message);
          const page = (data ?? []) as Array<{ crm_checkin_id: number }>;
          if (page.length === 0) break;
          existingCheckinIds.push(...page.map((row) => row.crm_checkin_id));
          if (page.length < reconcilePageSize) break;
          const last = Number(page[page.length - 1]?.crm_checkin_id);
          if (!Number.isFinite(last)) break;
          checkinCursor = last;
        }
        const staleCheckinIds = existingCheckinIds.filter((id) => !freshCheckinIds.has(id));
        if (!(existingCheckinIds.length > 0 && staleCheckinIds.length / existingCheckinIds.length > 0.5)) {
          for (let index = 0; index < staleCheckinIds.length; index += upsertBatchSize) {
            const chunk = staleCheckinIds.slice(index, index + upsertBatchSize);
            const { error } = await supabase.from(checkinsTable).delete().in("crm_checkin_id", chunk);
            if (error) throw new Error(error.message);
          }
        }
      }
    } catch (error) {
      // Best-effort — a check-ins reconciliation problem must never fail an otherwise-successful
      // sync — but it is no longer silent (this was a bare `catch {}` with no logging at all).
      checkinsFailed = true;
      logError("iReports360 check-in reconciliation failed; visits sync was unaffected", {
        labels: { event: "crm_sync_checkin_reconcile_failed", dateFrom: input.dateFrom, dateTo: input.dateTo },
        error,
      });
    }

    await supabase
      .from(syncRunsTable)
      .update({
        // RECORDED, not just notified. This is the recurrence signal for the invisible-work bug
        // class — a CRM account handed to a replacement keeps stamping the leaver's hr id, and the
        // departed-agent exclusion then hides the new rep's work entirely. It previously existed
        // only in the Telegram / in-app digest, so confirming the guard's behaviour meant catching
        // a notification at the moment a sync ran, which is not a check anyone actually performs.
        // Persisting makes it queryable and trendable.
        //
        // Requires migration 20260801130000, which MUST be applied first: this update is what marks
        // a run "success", so writing an absent column would make every sync look failed while
        // having written its rows perfectly well.
        blocked_post_exit_attributions: blockedPostExitAttributions,
        completed_at: new Date().toISOString(),
        rows_deleted: rowsDeleted,
        rows_fetched: visits.length,
        rows_skipped_invalid_date: rowsSkippedInvalidDate,
        rows_skipped_reconcile: rowsSkippedReconcile,
        rows_upserted: visitsUpserted,
        status: "success",
      })
      .eq("id", runId);

    // Field Workforce Compliance no longer caches a snapshot to refresh here — it always
    // reads this same mirror live on every view (see live-snapshots.ts), so a sync landing
    // new visit rows is immediately reflected with no separate refresh step needed.

    return {
      // Surfaced so callers/notifications can see them. These two are the write path's most
      // important safety signals and neither used to leave this function: rowsSkippedReconcile is
      // the "we refused to delete >50% of the window, so the fetch was probably truncated"
      // tripwire, and checkinsFailed distinguishes "no check-ins today" from "check-ins broke".
      // Both were only visible to someone who happened to open /admin/crm.
      blockedPostExitAttributions,
      checkinsFailed,
      checkinsFetched: checkins.length,
      checkinsUpserted,
      rowsDeleted,
      rowsFetched: visits.length,
      rowsSkippedInvalidDate,
      rowsSkippedReconcile,
      rowsUpserted: visitsUpserted,
      runId,
    };
  } catch (error) {
    await supabase
      .from(syncRunsTable)
      .update({
        completed_at: new Date().toISOString(),
        error_message: error instanceof Error ? error.message : String(error),
        status: "failed",
      })
      .eq("id", runId);
    throw error;
  }
}

/**
 * The recurring cron's window: always re-pulls the last N days so late CRM edits get caught.
 *
 * 2026-07-08: reverted 21 -> 10 (the pre-#796 value) after 2 consecutive
 * "ireports360-visits-sync" timeout check-ins (09:00 and 12:00 UTC), each exceeding the 300s
 * maxDuration ceiling. The 21-day window (plus the delete-reconciliation #796 added on top of
 * it) pushed the CRM fetch + upsert + reconcile wall-clock past what even the already-parallelized
 * upsert path (#896) could recover. Safe to shorten: the weekly wide-reconciliation cron
 * (0 4 * * 0, 120-day rotating window) already exists specifically to catch a visit CRM-edited
 * longer ago than this window covers — an edit 10-21 days old is now caught within a week
 * instead of same-day, not lost.
 */
export async function runScheduledIReports360Sync(lookbackDays = 10) {
  const dateTo = todayIso();
  const dateFrom = addDaysIso(dateTo, -lookbackDays);
  return syncIReports360Visits({ dateFrom, dateTo, trigger: "cron" });
}

/**
 * "Live" first-visit sync: unlike the recurring cron's 10-day rolling pull, this is scoped to
 * TODAY only (Cairo calendar day) — cheap enough to run every ~15 min through the 8:30 AM-12:01 PM
 * morning compliance window (see isWithinLiveSyncWindow in crm/dates.ts) without repeatedly
 * re-fetching/re-upserting the trailing 9 days the regular 3x/day cron already covers. Feeds the
 * exact same ireports360_visits mirror the NSM "CRM First Visit" board reads (see
 * employee-portal/nsm-crm-compliance.ts) — a visit+checkin submitted on the CRM shows up there
 * within one tick instead of waiting for the next of the 3 fixed daily syncs.
 */
export async function runLiveIReports360Sync() {
  const date = cairoTodayIso();
  return syncIReports360Visits({ dateFrom: date, dateTo: date, trigger: "cron" });
}

/**
 * Weekly wide reconciliation: the daily cron's rolling window only catches a visit CRM-edited
 * or re-saved within its own lookback — a visit saved long after its own visitDate, older than
 * that window, is otherwise never re-synced. iReports360's /visits endpoint only supports a
 * visitDate range (no "saved since" filter exists), so periodically re-scanning a much wider
 * window is the only way to catch this. Reuses syncIReports360Visits exactly like the daily
 * cron and manual backfill do — same idempotent upsert, and (since delete-reconciliation lives
 * inside syncIReports360Visits scoped to whatever window is passed in) the same
 * delete-reconciliation, but bounded to THIS call's own much wider [dateFrom, dateTo] — never
 * the daily cron's narrower one.
 *
 * 2026-07-06: the 2026-07-05 04:00 UTC run (cron job "ireports360-visits-reconcile") was
 * killed mid-run over a single 120-day window and left its ireports360_visits_sync_runs row
 * stuck at status="running" for ~17h (manually resolved to "failed"). Root cause: this now
 * layers delete-reconciliation + check-in reconciliation + an FWC snapshot refresh on top of the
 * fetch/upsert, and doing all of that over the full 120 days in one run risked exceeding even the
 * route's maxDuration (bumped 180->300 the same day) — a 44-day range under the lighter
 * pre-delete-reconciliation pipeline already took ~435s. Fix: split the 120-day window into 4
 * stateless 30-day slices (see resolveWideReconciliationSlice) so each weekly run's workload — and
 * therefore its timeout risk — stays roughly constant regardless of window size. Full 120-day
 * coverage now happens over a rolling ~4-week cycle instead of every single week; a rep who edits
 * a visit 90-120 days after its original date is caught within 4 weeks, not immediately, which is
 * an acceptable trade for a run that reliably finishes instead of one that reliably risks timing out.
 */
export const WIDE_RECONCILIATION_TOTAL_DAYS = 120;
export const WIDE_RECONCILIATION_SLICE_DAYS = 30;

/** Standard ISO-8601 week number (1-53), UTC-based — used only as a stateless rotation key, not
 * for calendar display, so its exact numbering convention doesn't matter as long as it's stable. */
function isoWeekNumber(date: Date): number {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = (target.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  target.setUTCDate(target.getUTCDate() - dayNumber + 3); // nearest Thursday
  const firstThursday = target.getTime();
  target.setUTCMonth(0, 1);
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay()) + 7) % 7);
  }
  return 1 + Math.round((firstThursday - target.getTime()) / 604_800_000);
}

/** Which 30-day slice of the trailing 120-day window this week's reconciliation should cover — a
 * pure function of `now` (deterministically unit-testable without mocking the clock). Slice 0 is
 * the most recent 30 days, slice 3 the oldest; which slice runs is `isoWeekNumber(now) % 4`, so it
 * cycles through all 4 slices every 4 weeks with no persisted state. */
export function resolveWideReconciliationSlice(now: Date) {
  const sliceCount = Math.ceil(WIDE_RECONCILIATION_TOTAL_DAYS / WIDE_RECONCILIATION_SLICE_DAYS);
  const sliceIndex = isoWeekNumber(now) % sliceCount;
  const today = now.toISOString().slice(0, 10);
  const dateTo = addDaysIso(today, -sliceIndex * WIDE_RECONCILIATION_SLICE_DAYS);
  const dateFrom = addDaysIso(dateTo, -WIDE_RECONCILIATION_SLICE_DAYS);
  return { dateFrom, dateTo, sliceIndex };
}

export async function runWideIReports360Reconciliation(now: Date = new Date()) {
  const { dateFrom, dateTo } = resolveWideReconciliationSlice(now);
  return syncIReports360Visits({ dateFrom, dateTo, trigger: "cron" });
}

// maxDuration is 300s on both the sync and reconcile crons; 15 minutes gives a 3x margin before
// treating a "running" row as dead rather than merely slow.
const staleSyncRunThresholdMinutes = 15;

/**
 * Reaps sync_runs rows the platform killed mid-flight before their own try/catch (in
 * syncIReports360Visits) could mark them "failed" — see the 2026-07-06 doc comment above on
 * runWideIReports360Reconciliation: the 2026-07-05 04:00 UTC run was killed by Vercel's
 * maxDuration and sat at status="running" for ~17h until manually corrected, because nothing
 * periodically checked for stuck rows. Mirrors reapStaleProcessingOutboxRows in
 * notifications/email.ts. Never throws — a reaper failure must never break the cron that calls it.
 */
export async function reapStaleIReports360SyncRuns(): Promise<number> {
  try {
    const supabase = getSupabaseAdmin();
    const threshold = new Date();
    threshold.setMinutes(threshold.getMinutes() - staleSyncRunThresholdMinutes);

    const { data, error } = await supabase
      .from(syncRunsTable)
      .update({
        completed_at: new Date().toISOString(),
        error_message: "Reaped: run exceeded its expected duration, likely killed by the platform's execution timeout before its own catch block could run.",
        status: "failed",
      })
      .eq("status", "running")
      .lt("started_at", threshold.toISOString())
      .select("id");

    if (error) throw new Error(error.message);
    return data?.length ?? 0;
  } catch (error) {
    logError("Failed to reap stale iReports360 sync runs", {
      labels: { event: "crm_sync_reap_stale_runs_failed" },
      error,
    });
    return 0;
  }
}

/**
 * One-time (or periodic) retroactive fix: re-resolves agent_hr_id/double_hr_id for rows that
 * are currently unmapped, using the crm_username fallback against the already-stored
 * agent_name/double_name text — no CRM re-fetch needed. Safe to re-run any time crm_username
 * data changes on the employee roster.
 *
 * Fetches every currently-unmapped row FIRST (fixed offsets), then applies all updates
 * afterward — updating rows while paginating the same WHERE clause the updates narrow would
 * shift offsets mid-scan and silently skip rows.
 */
export async function remapUnmatchedHrIds(): Promise<{ agentFixed: number; checked: number; doubleFixed: number }> {
  const supabase = getSupabaseAdmin();
  const [employees, resolutions] = await Promise.all([
    getEmployeeDirectoryRows({ includeInactive: true }),
    getCrmIdentityResolutions(),
  ]);
  const maps = buildCrmIdentityMaps(employees, resolutions);

  type UnmappedRow = {
    agent_crm_id: number;
    agent_hr_id: string | null;
    agent_name: string | null;
    double_crm_id: number | null;
    double_hr_id: string | null;
    double_name: string | null;
    id: string;
    visit_date: string;
  };
  const pageSize = 1000;
  const allRows: UnmappedRow[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(visitsTable)
      .select("id, agent_crm_id, agent_hr_id, agent_name, double_crm_id, double_hr_id, double_name, visit_date")
      .or("agent_hr_id.is.null,double_hr_id.is.null")
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as UnmappedRow[];
    allRows.push(...page);
    if (page.length < pageSize) break;
  }

  let agentFixed = 0;
  let doubleFixed = 0;
  for (const row of allRows) {
    const patch: { agent_hr_id?: string; double_hr_id?: string } = {};
    if (!row.agent_hr_id) {
      const resolved = resolveEmployeeHrId(row.agent_crm_id, row.agent_name, maps, row.visit_date);
      if (resolved) {
        patch.agent_hr_id = resolved;
        agentFixed += 1;
      }
    }
    if (row.double_crm_id != null && !row.double_hr_id) {
      const resolved = resolveEmployeeHrId(row.double_crm_id, row.double_name, maps, row.visit_date);
      if (resolved) {
        patch.double_hr_id = resolved;
        doubleFixed += 1;
      }
    }
    if (Object.keys(patch).length > 0) {
      const { error } = await supabase.from(visitsTable).update(patch).eq("id", row.id);
      if (error) throw new Error(error.message);
    }
  }

  return { agentFixed, checked: allRows.length, doubleFixed };
}
