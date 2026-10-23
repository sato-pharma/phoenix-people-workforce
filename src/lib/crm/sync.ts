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
import { isPlausibleCheckinCoordinate, sanitizeCheckinCoordinates } from "@/lib/crm/checkin-coords";
import { hasLocationIqKey, resolveCheckinAddress } from "@/lib/crm/checkin-geocode";
import {
  blockReasonFor,
  buildCrmIdentityMaps,
  getCrmIdentityResolutions,
  isSettledUnmappedRow,
  recordsNoWorkToAttribute,
  resolveEmployeeAttribution,
  resolveEmployeeHrId,
  type CrmAttribution,
  type CrmIdentityMaps,
} from "@/lib/crm/identity";
import {
  CRM_CHECKINS_TABLE,
  CRM_SYNC_DELETIONS_TABLE,
  CRM_SYNC_RUNS_TABLE,
  CRM_VISITS_TABLE,
} from "@/lib/crm/tables";
import { staleReconcileIds } from "@/lib/crm/reconcile-guard";
import { addDaysIso, cairoTodayIso, todayIso } from "@/lib/crm/dates";
import { selectOrphanedMappedIdentities, selectUnmappedAgentAlerts } from "@/lib/crm/unmapped-alert";
import { selectUnrecognizedVisitTypeAlerts } from "@/lib/crm/unrecognized-visit-type-alert";
// The attendance module owns the strict whitelist this alert watches, and exports the derived set
// so nothing here restates the visit-type ruling. Only crm -> attendance import in this module;
// acyclic, because crm-day-maps reaches crm/reads and crm/reads never reaches crm/sync.
import { CRM_DAY_CLASSIFIED_VISIT_TYPES } from "@/lib/attendance/crm-day-maps";
import {
  notifyUnmappedCrmAgentActivity,
  notifyUnrecognizedCrmVisitTypes,
} from "@/lib/notifications/ireports360-sync-digest";
import { logError, logWarning } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { hasGoogleServerKey } from "@/lib/google-maps/server";
import type { VisitsSyncTrigger } from "@/lib/visits-report/types";

const visitsTable = CRM_VISITS_TABLE;
const checkinsTable = CRM_CHECKINS_TABLE;
const syncRunsTable = CRM_SYNC_RUNS_TABLE;
const upsertBatchSize = 500;

/** One archive row per id about to be deleted from the mirror. */
export type SyncDeletionRecord = {
  kind: "visit" | "checkin";
  record_id: number;
  record_date: string | null;
  synced_at: string | null;
  window_from: string;
  window_to: string;
  sync_run_id: string | null;
  trigger: VisitsSyncTrigger;
};

/**
 * Records what is about to be deleted, and THROWS if it cannot.
 *
 * Failing closed is the whole point. Production has no point-in-time recovery — 7 daily backups are
 * the entire recovery story — and before this existed a reconciliation delete left no id anywhere:
 * `ireports360_parity_windows` holds counts, the sync-run row holds `rows_deleted`. Five consecutive
 * nights in Sept/Oct 2026 removed 1,879 mirror visits that way. So an archive that fails is a reason
 * not to delete, never a warning to log past: the caller's `await` propagates, the run fails, and
 * the rows are still there to try again.
 */
export async function archiveSyncDeletions(
  // The narrowest shape this needs, rather than the full admin client, so a test can hand it a
  // three-line fake and prove the fail-closed behaviour without a database.
  supabase: {
    from: (table: string) => {
      insert: (rows: SyncDeletionRecord[]) => PromiseLike<{ error: { message: string } | null }>;
    };
  },
  rows: readonly SyncDeletionRecord[],
): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await supabase.from(CRM_SYNC_DELETIONS_TABLE).insert(rows as SyncDeletionRecord[]);
  if (error) {
    throw new Error(
      `Refusing to delete ${rows.length} mirror ${rows[0]?.kind ?? "row"}(s): the deletion archive write failed (${error.message}). ` +
        `An unrecorded delete is unrecoverable here — production has no PITR — so the rows were left in place.`,
    );
  }
}
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

/** Narrows the UPSERT set to `onlyIds` when the caller (the live poller) already knows which rows
 * changed — pass-through when `onlyIds` is absent, which is every scheduled/manual caller today.
 * SAFETY-CRITICAL SCOPE: this must only ever be applied to the upsert arrays, NEVER to the
 * deduped full-fetch arrays that drive delete-reconciliation below — reconciliation must always
 * see everything the fetch saw, or every unchanged row would read as "absent from the CRM" and be
 * deleted. Pure and exported for exactly that regression test. */
export function filterRowsToUpsert<T>(rows: T[], keyOf: (row: T) => number, onlyIds?: ReadonlySet<number>): T[] {
  if (!onlyIds) return rows;
  return rows.filter((row) => onlyIds.has(keyOf(row)));
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

/** Normalizes the vendor's ampm half-day marker to a clean uppercase/trimmed value. iReports360
 * has the same inconsistent-casing habit here as on contactGrade: measured on the live mirror
 * 2026-08-21, 97 of 122,814 rows carry "Pm" (58), "Am" (23) or "pm" (16) against 94,689 "PM" and
 * 25,229 "AM". Both readers take the value literally — the CRM master AM/PM filter does an exact
 * .eq("ampm", ...) so a mis-cased row is invisible to it, and the day-count logic in master.ts
 * treats any marker that is not exactly "AM"/"PM" as a FULL day, so a lone "Pm" scored a whole
 * day instead of half. Empty string -> null, the same "blank means no marker" convention every
 * other optional CRM field uses.
 *
 * An unrecognized value is uppercased and KEPT, never dropped: a marker we do not recognize is a
 * vendor change worth surfacing, and master.ts already counts anything non-AM/PM as a full day. */
export function normalizeAmpm(value: string | null | undefined): string | null {
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
    ampm: normalizeAmpm(visit.ampm),
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
  // A handset that briefly loses its fix can report a position on another continent, and check-in
  // matching keys on rep + contact + day rather than distance — so an impossible coordinate would
  // otherwise stand as GPS proof-of-presence for the visit. Reject it to nulls here, at the single
  // ingest point; `raw_payload` below still carries the vendor's original verbatim.
  const coords = sanitizeCheckinCoordinates(checkin.lat, checkin.lon, checkin.address);
  return {
    address: coords.address,
    agent_crm_id: checkin.agentID,
    // Check-ins have no agent display-name field (crm_id only) — the crm_username fallback
    // can't apply here, only the direct crm_id match. `checkDate` is the record's own date, so it
    // drives the post-exit guard exactly as a visit's date does.
    agent_hr_id: resolveEmployeeHrId(checkin.agentID, null, maps, (checkin.checkDate ?? "").slice(0, 10) || null),
    check_date: checkin.checkDate,
    contact_crm_id: checkin.contactID,
    contact_name: checkin.contactName,
    crm_checkin_id: checkin.id,
    lat: coords.lat,
    lon: coords.lon,
    raw_payload: checkin as unknown as Record<string, unknown>,
    synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export type VisitDraftRow = ReturnType<typeof rowFromVisit>;
export type CheckinDraftRow = ReturnType<typeof rowFromCheckin>;

/**
 * TWO DIFFERENT NULLS, AND ONLY ONE OF THEM MAY BE WRITTEN.
 *
 * `resolveEmployeeAttribution` returns a null `hrId` for two opposite reasons:
 *
 *   SILENT  — no tier matched at all (crm_id absent from the roster, no manual override, no unique
 *             crm_username). We simply do not know who this is. `blockedHrId` is null too.
 *   BLOCKED — a tier DID match, and the post-exit guard refused it because the CRM slot was handed
 *             to a replacement. `blockedHrId` names the employee who was refused.
 *
 * A BLOCKED null is a decision and must be written: it is what stopped a leaver's hr id being
 * stamped onto the new rep's work, the bug that made 190 live visits invisible. A SILENT null is
 * an absence of information, and writing it over an identity the mirror already resolved is pure
 * data loss — the upsert overwrites every column, exactly as it used to destroy check-in addresses
 * (see backfillMissingCheckinAddresses).
 *
 * That destruction is not hypothetical. Measured on production 2026-08-06: `agent_hr_id` was NULL
 * on 0% of visit rows for 2026-07-01..07-05 and on 5-9% every day from 07-06 onward, because the
 * rolling 10-day sync re-resolved identities that `employees.crm_id` no longer carried and wrote
 * the silent nulls back. Seven medical reps were then charged 14,629.01 EGP of "no CRM activity"
 * deductions for days on which they logged 8-22 real visits, because the deduction connectors match
 * on `agent_hr_id`.
 *
 * This is also why the tempting `coalesce(new.agent_hr_id, old.agent_hr_id)` DB trigger is WRONG:
 * Postgres cannot tell the two nulls apart, so it would permanently pin a handed-over slot's work
 * onto the leaver and silently undo the post-exit guard.
 */
export function isSilentAttribution(attribution: CrmAttribution): boolean {
  return attribution.hrId === null && attribution.blockedHrId === null;
}

/**
 * Pure decision core of the identity-preservation step — split out so it is unit-testable without
 * mocking Supabase, the same reasoning as selectCheckinsToGeocode above.
 *
 * Returns the key of every row that needs its stored identity looked up: one whose freshly-resolved
 * attribution is SILENT on at least one of its two identity columns. A row the resolver answered
 * (either with an hr id or with a deliberate block) needs nothing — the fresh answer is the truth.
 */
export function selectIdentitiesToPreserve<TRow>(
  rows: readonly TRow[],
  keyOf: (row: TRow) => number,
  attributionsOf: (row: TRow) => ReadonlyArray<CrmAttribution | null>,
): number[] {
  const keys: number[] = [];
  for (const row of rows) {
    if (attributionsOf(row).some((attribution) => attribution != null && isSilentAttribution(attribution))) {
      keys.push(keyOf(row));
    }
  }
  return keys;
}

/**
 * The fields countBlockedAttributions reads — a structural subset of IReports360Visit, so a test can
 * state a case as one literal instead of building a whole vendor record.
 */
export type BlockCountableVisit = {
  agentID: number | null;
  agentName: string | null;
  visitDate: string | null;
  visitType: number | null;
};

/** How many blocked attributions each end of the employment span produced on one sync run. */
export type BlockedAttributionCounts = { postExit: number; preHire: number };

/**
 * Pure decision core of the block DETECTION pass — split out for the same reason as
 * selectIdentitiesToPreserve above: the counting RULES are the part worth pinning, and pinning them
 * should not require Supabase or a live CRM fetch.
 *
 * Both counters mean one specific thing: "these rows need an identity override recorded", and a
 * non-zero count marks the sync degraded and pages a human. So a row only counts if an override
 * could actually change something about it. Three shapes cannot, and are skipped:
 *
 *   1. A REFUSED OVERRIDE (blockedByOverride). The slot already HAS a human's decision; it was
 *      refused only because this date falls outside that person's employment. Nothing is left to
 *      record. Measured in production 2026-08-28: 9 rows across 7 retired slots, 0 real visits.
 *   2. A row that records NO WORK — a public holiday or casual-leave marker. iReports360 sprays one
 *      across every account on the day, deactivated ones included, so a block on one says only that
 *      a dead slot still exists. See recordsNoWorkToAttribute for the measurement.
 *   3. A row the Unmapped Agents list treats as SETTLED (isSettledUnmappedRow): its label names a
 *      known employee and nobody it names was employed that day. The owner's date rule credits
 *      such a row to nobody, and no mapping could change that. This alarm tells a human to map the
 *      account on that list, so it must never fire for a row the list does not show.
 *
 * Skipping is safe against the one case that would matter — a CRM slot genuinely reused for a new
 * hire — because such a slot also produces real calls, and those still count.
 */
export function countBlockedAttributions(
  visits: readonly BlockCountableVisit[],
  maps: CrmIdentityMaps,
): BlockedAttributionCounts {
  let postExit = 0;
  let preHire = 0;
  for (const visit of visits) {
    const visitDay = (visit.visitDate ?? "").slice(0, 10) || null;
    const agent = resolveEmployeeAttribution(visit.agentID, visit.agentName, maps, visitDay);
    if (!agent.blockedHrId) continue;
    if (agent.blockedByOverride) continue;
    if (recordsNoWorkToAttribute(visit.visitType)) continue;
    const slot = { crmId: visit.agentID, label: visit.agentName, visitDate: visitDay, visitType: visit.visitType };
    if (isSettledUnmappedRow(slot, maps)) continue;
    if (blockReasonFor(agent.blockedHrId, visitDay, maps) === "pre_hire") preHire += 1;
    else postExit += 1;
  }
  return { postExit, preHire };
}

/**
 * Restores an identity the mirror already resolved onto a draft row whose fresh attribution came
 * back SILENT, so the upsert cannot null it out. See isSilentAttribution for why only the silent
 * case qualifies.
 *
 * Best-effort in the same shape as the address backfill: if the lookup fails we log and let the
 * upsert proceed, because refusing to sync at all would be a worse outcome than the sync we have
 * been running for weeks. The reconciliation check and assertCrmIdentityCoverage are what turn a
 * lookup outage into something a human hears about.
 *
 * Exported because the plan sync (plan-sync.ts) upserts whole rows too, and had the same silent-null
 * overwrite on `ireports360_plan_entries.agent_hr_id` until it started calling this.
 */
export async function preserveResolvedIdentities<TRow extends Record<string, unknown>>(input: {
  /** `of` returns null when the column does not apply to this row at all — a visit with no
   * `double_crm_id` has no second person, so its null `double_hr_id` is correct and must be kept. */
  attributions: ReadonlyArray<{ column: "agent_hr_id" | "double_hr_id"; of: (row: TRow) => CrmAttribution | null }>;
  keyColumn: string;
  keyOf: (row: TRow) => number;
  rows: TRow[];
  supabase: ReturnType<typeof getSupabaseAdmin>;
  table: string;
}): Promise<number> {
  const keys = selectIdentitiesToPreserve(input.rows, input.keyOf, (row) =>
    input.attributions.map((entry) => entry.of(row)),
  );
  if (keys.length === 0) return 0;

  const columns = input.attributions.map((entry) => entry.column);
  const storedByKey = new Map<number, Record<string, string | null>>();
  try {
    for (let from = 0; from < keys.length; from += 500) {
      const chunk = keys.slice(from, from + 500);
      const { data, error } = await input.supabase
        .from(input.table)
        .select([input.keyColumn, ...columns].join(", "))
        .in(input.keyColumn, chunk);
      if (error) throw new Error(error.message);
      // The select list is built at runtime from `columns`, so supabase-js cannot type the row —
      // it degrades to GenericStringError[]. Cast through unknown; the field reads below are all
      // defensive (Number.isFinite / typeof string) and never trust the shape.
      for (const stored of (data ?? []) as unknown as Array<Record<string, unknown>>) {
        const key = Number(stored[input.keyColumn]);
        if (!Number.isFinite(key)) continue;
        const entry: Record<string, string | null> = {};
        for (const column of columns) {
          const value = stored[column];
          entry[column] = typeof value === "string" && value.trim() ? value : null;
        }
        storedByKey.set(key, entry);
      }
    }
  } catch (error) {
    logError("CRM sync could not read stored identities; a resolved hr id may be overwritten", {
      labels: { event: "crm_sync_identity_preserve_lookup_failed", table: input.table },
      error,
    });
    return 0;
  }

  return applyPreservedIdentities(input.rows, storedByKey, input.keyOf, input.attributions);
}

/**
 * Pure restore step — mutates the draft rows in place and returns how many columns were rescued.
 * Split from the I/O above so the three cases that matter are unit-testable without Supabase:
 * a SILENT null is replaced by the stored identity, a BLOCKED null is left alone, and a freshly
 * resolved hr id always wins over whatever is stored.
 */
export function applyPreservedIdentities<TRow>(
  rows: readonly TRow[],
  storedByKey: ReadonlyMap<number, Record<string, string | null>>,
  keyOf: (row: TRow) => number,
  attributions: ReadonlyArray<{ column: "agent_hr_id" | "double_hr_id"; of: (row: TRow) => CrmAttribution | null }>,
): number {
  let restored = 0;
  for (const row of rows) {
    const stored = storedByKey.get(keyOf(row));
    if (!stored) continue;
    for (const entry of attributions) {
      const attribution = entry.of(row);
      if (attribution == null || !isSilentAttribution(attribution)) continue;
      const known = stored[entry.column];
      if (!known) continue;
      (row as Record<string, unknown>)[entry.column] = known;
      restored += 1;
    }
  }
  return restored;
}

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
/** A vendor fetch the live poller already performed for this exact window — passed in so the
 * engine can skip its own login+fetch (halving vendor traffic) and, crucially, so `capturedAt`
 * (taken BEFORE that fetch) drives the concurrent-sync deletion guard instead of a later
 * timestamp, keeping the guard strictly conservative.
 *
 * `checkins` is OPTIONAL and omitting it is not the same as passing `[]`. An empty array is a
 * positive claim that the vendor has no check-ins for this window, which reconciles every existing
 * one away; omitting it means "I did not fetch those", and the engine fetches them itself. The
 * parity sweep needs exactly that shape — it compares visit ids only — and until this was optional
 * it could not pass `prefetched` at all, so it re-fetched the whole window and deleted against a
 * second, later answer than the one it had measured. */
export type PrefetchedCrmWindow = {
  capturedAt: string;
  checkins?: IReports360Checkin[];
  visits: IReports360Visit[];
};

export async function syncIReports360Visits(input: {
  dateFrom: string;
  dateTo: string;
  trigger: VisitsSyncTrigger;
  /** See PrefetchedCrmWindow. Absent on every scheduled/manual caller — behavior is unchanged. */
  prefetched?: PrefetchedCrmWindow;
  /** When present, only these crm ids are UPSERTED (the live poller's changed-row delta). The
   * full fetch still drives reconciliation, invalid-date counting, and post-exit detection. */
  onlyUpsertIds?: { checkinIds: ReadonlySet<number>; visitIds: ReadonlySet<number> };
}): Promise<{
  /** Visits whose CRM slot resolved to someone who had not yet joined on the visit date, so the
   * pre-hire guard refused the attribution. This is the SAME account-handover as the post-exit
   * counter below, seen from the other side: the PREVIOUS occupant's history trying to attach to
   * the new joiner. >0 means those rows need an identity override pointing at whoever really did
   * the work — until then they are honestly unattributed rather than silently miscredited. */
  blockedPreHireAttributions: number;
  /** Visits whose CRM slot resolved to someone who had already left on the visit date, so the
   * post-exit guard refused the attribution. >0 means a slot was probably handed to a replacement
   * and needs an identity override — the recurrence signal for the invisible-work bug class. */
  blockedPostExitAttributions: number;
  /** True when the check-ins fetch or reconciliation failed. Distinguishes "no check-ins today"
   * from "the check-ins endpoint is broken", which used to look identical from outside. */
  checkinsFailed: boolean;
  checkinsFetched: number;
  checkinsUpserted: number;
  /** Identity columns this run restored from the mirror because the fresh attribution came back
   * SILENT. A steady non-zero count means the roster has stopped carrying someone's crm_id and the
   * sync is now the only thing holding their history together — repair the mapping rather than
   * relying on this. It is a rescue, not a resting state. */
  identitiesPreserved: number;
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
    // deletion set below, not treated as something the CRM deleted. When the live poller hands us
    // its own already-fetched window, its pre-fetch capture instant is the honest value here.
    const runStartedAt = input.prefetched?.capturedAt ?? new Date().toISOString();
    let checkinsFailed = false;
    let visits: IReports360Visit[];
    let checkins: IReports360Checkin[];
    const fetchCheckins = async (): Promise<IReports360Checkin[]> => {
      const config = getIReports360Config();
      const token = await iReports360Login(config);
      // Same posture as the paired fetch below: best-effort, never fails the run, never silent.
      return iReports360GetCheckins(config, token, input.dateFrom, input.dateTo).catch((error: unknown) => {
        checkinsFailed = true;
        logError("iReports360 check-ins fetch failed; visits still synced without the GPS overlay", {
          labels: { event: "crm_sync_checkins_fetch_failed", dateFrom: input.dateFrom, dateTo: input.dateTo },
          error,
        });
        return [] as IReports360Checkin[];
      });
    };
    if (input.prefetched) {
      visits = input.prefetched.visits;
      // An omitted `checkins` means the caller did not fetch them, so we must — see
      // PrefetchedCrmWindow. An explicitly empty array is a real "the vendor has none" answer and
      // is honoured as one.
      checkins = input.prefetched.checkins ?? (await fetchCheckins());
    } else {
      const config = getIReports360Config();
      const token = await iReports360Login(config);
      [visits, checkins] = await Promise.all([
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
    }

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
    // Counted apart by REASON (see blockReasonFor): a post-exit block is somebody's current work
    // going unattributed today and wants acting on now, while a pre-hire block is the previous
    // occupant's history detaching from a new joiner — a backfill to reconcile. One shared counter
    // would let a burst of old rows drown out a live problem.
    // Which blocks actually count, and why two shapes are skipped, is documented on the pure core.
    const { postExit: blockedPostExitAttributions, preHire: blockedPreHireAttributions } =
      countBlockedAttributions(visits, maps);

    // The upsert set may be narrowed to the live poller's changed-row delta; the deduped
    // full-fetch arrays above stay untouched because reconciliation below MUST see the whole
    // fetch (see filterRowsToUpsert's doc comment).
    const visitRowsForUpsert = filterRowsToUpsert(
      validVisitRows,
      (row) => row.crm_visit_id,
      input.onlyUpsertIds?.visitIds,
    );
    // Preserve identities the mirror already resolved, on the rows actually being written this run.
    // Without this the upsert writes a SILENT null over a good agent_hr_id every time the roster
    // stops carrying that person's crm_id — see isSilentAttribution.
    const visitIdentitiesRestored = await preserveResolvedIdentities({
      attributions: [
        {
          column: "agent_hr_id",
          of: (row) => resolveEmployeeAttribution(row.agent_crm_id, row.agent_name, maps, row.visit_date || null),
        },
        {
          column: "double_hr_id",
          of: (row) =>
            row.double_crm_id == null
              ? null
              : resolveEmployeeAttribution(row.double_crm_id, row.double_name, maps, row.visit_date || null),
        },
      ],
      keyColumn: "crm_visit_id",
      keyOf: (row) => row.crm_visit_id,
      rows: visitRowsForUpsert,
      supabase,
      table: visitsTable,
    });

    const visitsUpserted = await upsertRowsConcurrently(
      supabase,
      visitsTable,
      visitRowsForUpsert,
      "crm_visit_id",
      upsertBatchSize,
      upsertConcurrency,
    );

    const checkinRows = checkins.map((checkin) => rowFromCheckin(checkin, maps));
    // Never silent-drop: rowFromCheckin nulls an impossible coordinate, so without this the
    // rejection would leave no trace anywhere except a row that quietly lost its GPS. Counted and
    // logged so a handset that starts emitting garbage is visible instead of merely absent.
    const rejectedCheckinCoords = checkins.filter(
      (checkin) =>
        typeof checkin.lat === "number" &&
        typeof checkin.lon === "number" &&
        !isPlausibleCheckinCoordinate(checkin.lat, checkin.lon),
    );
    if (rejectedCheckinCoords.length > 0) {
      // WARNING, not ERROR, and deliberately so: nothing failed here — the row synced, only its
      // impossible GPS was dropped. It also must not page anyone, because the rolling window
      // re-syncs the same dates every few minutes, so one bad handset reading would otherwise
      // raise the same ERROR several thousand times before it aged out of the window.
      logWarning("iReports360 check-ins carried coordinates outside Egypt; GPS nulled, raw payload kept", {
        labels: {
          agentCrmIds: [...new Set(rejectedCheckinCoords.map((checkin) => checkin.agentID))].slice(0, 20).join(","),
          checkinIds: rejectedCheckinCoords.map((checkin) => checkin.id).slice(0, 20).join(","),
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
          event: "crm_sync_checkin_coords_rejected",
          rejected: rejectedCheckinCoords.length,
        },
      });
    }
    const dedupedCheckinRows = dedupeByKey(checkinRows, (row) => row.crm_checkin_id);
    const checkinRowsForUpsert = filterRowsToUpsert(
      dedupedCheckinRows,
      (row) => row.crm_checkin_id,
      input.onlyUpsertIds?.checkinIds,
    );
    // Address backfill only needs to consider rows actually being written this run.
    await backfillMissingCheckinAddresses(supabase, checkinRowsForUpsert);
    // Same preservation for check-ins. They carry no display name, so tier 3 can never rescue them
    // and a missing employees.crm_id is the ONLY thing standing between a resolved identity and a
    // silent null — which makes them the more fragile of the two tables, not the less.
    const checkinIdentitiesRestored = await preserveResolvedIdentities({
      attributions: [
        {
          column: "agent_hr_id",
          of: (row) =>
            resolveEmployeeAttribution(row.agent_crm_id, null, maps, (row.check_date ?? "").slice(0, 10) || null),
        },
      ],
      keyColumn: "crm_checkin_id",
      keyOf: (row) => row.crm_checkin_id,
      rows: checkinRowsForUpsert,
      supabase,
      table: checkinsTable,
    });
    const checkinsUpserted = await upsertRowsConcurrently(
      supabase,
      checkinsTable,
      checkinRowsForUpsert,
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
      // visit_date per row, for the deletion archive only — it never affects what is deleted.
      const visitDateById = new Map<number, string>();
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
          // visit_date rides along purely so the deletion archive can record WHEN each removed
          // visit was, which is what makes a wrong delete readable later without a restore.
          .select("crm_visit_id, synced_at, visit_date")
          .gte("visit_date", input.dateFrom)
          .lte("visit_date", input.dateTo)
          .order("crm_visit_id", { ascending: true })
          .limit(reconcilePageSize);
        if (cursor !== null) query = query.gt("crm_visit_id", cursor);
        const { data, error } = await query;
        if (error) throw new Error(error.message);
        const page = (data ?? []) as Array<{ crm_visit_id: number; synced_at: string | null; visit_date: string | null }>;
        if (page.length === 0) break;
        existingIds.push(...page.map((row) => row.crm_visit_id));
        for (const row of page) {
          if (row.synced_at) syncedAtById.set(row.crm_visit_id, row.synced_at);
          if (row.visit_date) visitDateById.set(row.crm_visit_id, row.visit_date);
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
      const staleIds = staleReconcileIds(existingIds, freshIds, syncedAtById, runStartedAt);
      if (existingIds.length > 0 && staleIds.length / existingIds.length > 0.5) {
        rowsSkippedReconcile = staleIds.length;
      } else {
        for (let index = 0; index < staleIds.length; index += upsertBatchSize) {
          const chunk = staleIds.slice(index, index + upsertBatchSize);
          // ARCHIVE FIRST, AND FAIL CLOSED. A delete that cannot be recorded does not happen: this
          // throws, which fails the run and leaves the rows in place, because an unrecorded delete
          // against a database with no point-in-time recovery is the one outcome with no way back.
          await archiveSyncDeletions(
            supabase,
            chunk.map((id) => ({
              kind: "visit" as const,
              record_id: id,
              record_date: visitDateById.get(id) ?? null,
              synced_at: syncedAtById.get(id) ?? null,
              window_from: input.dateFrom,
              window_to: input.dateTo,
              sync_run_id: runId,
              trigger: input.trigger,
            })),
          );
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
        // check_date per row, for the deletion archive only.
        const checkDateById = new Map<number, string>();
        // synced_at per row — the same concurrent-sync guard the visits reconcile has (audit F-07).
        const checkinSyncedAtById = new Map<number, string>();
        const reconcilePageSize = 5000;
        // Keyset for the same reason as the visits reconcile above — this list also drives deletes.
        let checkinCursor: number | null = null;
        for (;;) {
          let query = supabase
            .from(checkinsTable)
            // check_date rides along for the deletion archive, as visit_date does above.
            .select("crm_checkin_id, check_date, synced_at")
            .gte("check_date", `${input.dateFrom}T00:00:00`)
            .lte("check_date", `${input.dateTo}T23:59:59`)
            .order("crm_checkin_id", { ascending: true })
            .limit(reconcilePageSize);
          if (checkinCursor !== null) query = query.gt("crm_checkin_id", checkinCursor);
          const { data, error } = await query;
          if (error) throw new Error(error.message);
          const page = (data ?? []) as Array<{ crm_checkin_id: number; check_date: string | null; synced_at: string | null }>;
          if (page.length === 0) break;
          existingCheckinIds.push(...page.map((row) => row.crm_checkin_id));
          for (const row of page) {
            if (row.check_date) checkDateById.set(row.crm_checkin_id, row.check_date.slice(0, 10));
            if (row.synced_at) checkinSyncedAtById.set(row.crm_checkin_id, row.synced_at);
          }
          if (page.length < reconcilePageSize) break;
          const last = Number(page[page.length - 1]?.crm_checkin_id);
          if (!Number.isFinite(last)) break;
          checkinCursor = last;
        }
        // 🔴 THE SAME GUARD AS THE VISITS (audit F-07, 2026-10-23). This used to be "not in this
        // fetch" alone, so a check-in an OVERLAPPING run had just written was classified stale and
        // deleted — and a check-in can be what clears a half-day deduction. A row written at or after
        // this run's snapshot is never stale here either.
        const staleCheckinIds = staleReconcileIds(existingCheckinIds, freshCheckinIds, checkinSyncedAtById, runStartedAt);
        if (!(existingCheckinIds.length > 0 && staleCheckinIds.length / existingCheckinIds.length > 0.5)) {
          for (let index = 0; index < staleCheckinIds.length; index += upsertBatchSize) {
            const chunk = staleCheckinIds.slice(index, index + upsertBatchSize);
            // Archive first here too. This whole block is best-effort — a throw lands in the catch
            // below and never fails the run — so a failed archive costs the check-in reconciliation
            // for this window, not the sync, and the rows stay.
            await archiveSyncDeletions(
              supabase,
              chunk.map((id) => ({
                kind: "checkin" as const,
                record_id: id,
                record_date: checkDateById.get(id) ?? null,
                synced_at: checkinSyncedAtById.get(id) ?? null,
                window_from: input.dateFrom,
                window_to: input.dateTo,
                sync_run_id: runId,
                trigger: input.trigger,
              })),
            );
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
        // having written its rows perfectly well. The same ordering applies to the pre-hire counter
        // below (migration 20260828100000) for exactly the same reason.
        blocked_pre_hire_attributions: blockedPreHireAttributions,
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

    // Unmapped-agent tripwire (best-effort, never fails the run): any RECENT visit in this fetch
    // that resolved to no employee means someone's fieldwork is invisible right now. Detection
    // runs on the FULL deduped fetch — not the narrowed upsert set — so a live-poll delta tick
    // still sees an unmapped agent whose rows happened to be unchanged this tick. Also checks every
    // "mapped" override against the current roster (independent of this window's fetch) — a
    // resolution can go stale without ever producing an unresolved row, see
    // selectOrphanedMappedIdentities.
    try {
      const alerts = [
        ...selectUnmappedAgentAlerts({
          recentSinceIso: addDaysIso(cairoTodayIso(), -14),
          resolutions,
          rows: dedupedVisitRows.map((row) => ({
            agentCrmId: row.agent_crm_id,
            agentHrId: row.agent_hr_id,
            agentName: row.agent_name,
            visitDate: row.visit_date,
          })),
        }),
        // Cheap (iterates the already-loaded, small resolutions list — no extra query) and
        // deliberately unconditional on this window's fetch: an override going stale (its target
        // hr_id renamed/replaced/removed) is a standing fact about the mapping, not something tied
        // to today's visit volume — see selectOrphanedMappedIdentities.
        ...selectOrphanedMappedIdentities({
          asOfIso: cairoTodayIso(),
          resolutions,
          validHrIds: new Set(employees.map((employee) => employee.hrId.toLowerCase())),
        }),
      ];
      if (alerts.length > 0) {
        await notifyUnmappedCrmAgentActivity({ alerts, dateFrom: input.dateFrom, dateTo: input.dateTo, runId });
      }
    } catch (error) {
      logError("Unmapped CRM agent alerting failed; the sync itself succeeded", {
        labels: { event: "crm_unmapped_agent_alert_failed", dateFrom: input.dateFrom, dateTo: input.dateTo },
        error,
      });
    }

    // Unrecognized visit-type tripwire (best-effort, never fails the run). Deliberately its OWN
    // try/catch rather than sharing the block above: these are independent tripwires, and one
    // throwing must not silence the other. Runs on the same FULL deduped fetch for the same reason
    // — a delta tick whose rows were otherwise unchanged still carries the new code.
    //
    // Expected to find nothing. Every visit type production has ever produced is classified; this
    // fires only if iReports360 starts sending a code nobody has ruled on, which would otherwise
    // reach the attendance engine as a silent fall-through. See unrecognized-visit-type-alert.ts.
    try {
      const unrecognized = selectUnrecognizedVisitTypeAlerts({
        recentSinceIso: addDaysIso(cairoTodayIso(), -14),
        recognizedTypes: CRM_DAY_CLASSIFIED_VISIT_TYPES,
        rows: dedupedVisitRows.map((row) => ({
          agentCrmId: row.agent_crm_id,
          comment: row.comment,
          visitDate: row.visit_date,
          visitType: row.visit_type,
          visitTypeDescription: row.visit_type_description,
        })),
      });
      if (unrecognized.length > 0) {
        logWarning("iReports360 sent visit type(s) Phoenix has never classified", {
          labels: {
            event: "crm_unrecognized_visit_type",
            dateFrom: input.dateFrom,
            dateTo: input.dateTo,
            visitTypes: unrecognized.map((alert) => alert.visitType).join(","),
          },
        });
        await notifyUnrecognizedCrmVisitTypes({
          alerts: unrecognized,
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
          runId,
        });
      }
    } catch (error) {
      logError("Unrecognized CRM visit-type alerting failed; the sync itself succeeded", {
        labels: { event: "crm_unrecognized_visit_type_alert_failed", dateFrom: input.dateFrom, dateTo: input.dateTo },
        error,
      });
    }

    return {
      // Surfaced so callers/notifications can see them. These two are the write path's most
      // important safety signals and neither used to leave this function: rowsSkippedReconcile is
      // the "we refused to delete >50% of the window, so the fetch was probably truncated"
      // tripwire, and checkinsFailed distinguishes "no check-ins today" from "check-ins broke".
      // Both were only visible to someone who happened to open /admin/crm.
      blockedPreHireAttributions,
      blockedPostExitAttributions,
      checkinsFailed,
      checkinsFetched: checkins.length,
      checkinsUpserted,
      identitiesPreserved: visitIdentitiesRestored + checkinIdentitiesRestored,
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
