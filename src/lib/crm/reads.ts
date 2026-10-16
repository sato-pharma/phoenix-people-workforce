/**
 * The single read API for CRM (iReports360) mirror data. Every module that needs visit or
 * check-in data calls these functions instead of running its own `.from("ireports360_*")`
 * query — that is the "one door" contract the CRM module enforces.
 *
 * Rows come back carrying the sync-time-resolved `agent_hr_id` / `double_hr_id`; callers map
 * them to their own domain shapes. Reads that project a subset of columns pass their own row
 * type as the generic (the `CrmVisitRow` / `CrmCheckinRow` defaults describe a `select("*")`).
 */

import { getSupabaseAdmin, rpcAll, toQueryError } from "@/lib/supabase/server";
import { getEmployeeDirectoryRows, isActiveLifecycleStatus } from "@/lib/employees/employee-directory";
import { indexCheckinsByAgentContactDay, pickCheckinForVisit } from "@/lib/crm/checkin-match";
// The doors read the UNIFIED VIEWS: iReports360 rows, and — for a team that works in Phoenix CRM, from
// its start — that team's own Phoenix visits instead of its reps' vendor rows (phoenix-team-starts.ts).
// CRM_VISITS_TABLE stays for the two IDENTITY reads only — who a CRM id belonged to is a fact about the
// vendor's records, not about visits in general.
import { CRM_CHECKINS_UNIFIED_VIEW, CRM_VISITS_TABLE, CRM_VISITS_UNIFIED_VIEW } from "@/lib/crm/tables";
// The one test for "this row is Phoenix CRM's own". src/lib/crm/phoenix-team-starts.ts says why the
// unified view carries Phoenix rows (owner, 2026-10-02: a started team's visits, from its start).
import { IREPORTS360_VISIT_SOURCE, isPhoenixNativeVisitRow } from "@/lib/crm/phoenix-team-starts";
import { isCrmSchemaMissingError, isCrmVisitsSchemaReady } from "@/lib/crm/schema";
import { CRM_VISIT_TYPE_FILTER_CODES, CRM_VISIT_TYPE_OPTIONS, resolveVisitTypeLabel } from "@/lib/crm/visit-types";
import { getLatestVisitsSyncRuns } from "@/lib/crm/admin";
import { isIReports360Configured } from "@/lib/crm/config";
import { addDaysIso, hasRealVendorTime, todayIso } from "@/lib/crm/dates";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { getOrLoadShared, sharedReadKey } from "@/lib/cache/shared-read";
import { CRM_CHECKIN_WINDOWS, CRM_VISIT_WINDOWS } from "@/lib/crm/shared-windows";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CrmCheckinRow, CrmVisitRow } from "@/lib/crm/types";
import { ilikeAnyFilter } from "@/lib/supabase/search-filter";
import type {
  VisitsReportData,
  VisitsReportExportResult,
  VisitsReportFilterInput,
  VisitsReportRow,
  VisitTimeSource,
} from "@/lib/visits-report/types";

export type { CrmCheckinRow, CrmVisitRow } from "@/lib/crm/types";

/** Fieldwork visit-type codes that can count as a double visit: Regular (0) and
 * Campaign/Prospection (-8). The single definition shared by Double-Visit Analytics, probation
 * DV detection, the employee portal, and probation feedback. */
export const CRM_DOUBLE_VISIT_TYPE_CODES = [0, -8] as const;

/** Pure predicate: is this row a real double visit (a genuine partner on a fieldwork type)?
 *
 * A partner is a real `double_crm_id` (never 0). On a Phoenix native row — `source` 'phoenix', or the
 * negative `crm_visit_id` the unified view gives it — a confirmed partner hired after the CRM cutover
 * has no CRM id, so his resolved `double_hr_id` counts too. On a vendor row it never does: a stray
 * resolved hr id beside a null or 0 partner is not a double visit (employee-360 audit finding A). A
 * caller that selects neither column keeps the vendor rule. */
export function isCrmDoubleVisitRow(row: {
  crm_visit_id?: number | null;
  double_crm_id: number | null | undefined;
  double_hr_id?: string | null;
  source?: string | null;
  visit_type: number | null | undefined;
}): boolean {
  const isNative = isPhoenixNativeVisitRow(row);
  const hasPartner =
    (row.double_crm_id != null && row.double_crm_id !== 0) ||
    (isNative && String(row.double_hr_id ?? "").trim().length > 0);
  return (
    hasPartner &&
    row.visit_type != null &&
    (CRM_DOUBLE_VISIT_TYPE_CODES as readonly number[]).includes(row.visit_type)
  );
}

/** STATIC resigned/owner-excluded CRM agents (their iReports360 agent_crm_ids) — the hand-maintained
 * safety-net. Most entries are CRM territory/bucket placeholders or owner-excluded agents that
 * resolve to NO employee, so a live employment-status join can never see them; this list stays as
 * the permanent floor. The EFFECTIVE exclusion applied by every read is this list UNIONed with the
 * live departed-agent set — see {@link getEffectiveExcludedAgentCrmIds}. Single source; the other CRM
 * modules import from here. Resolved from the owner's display-name lists (see memory
 * crm-resigned-agents-exclusion-list). */
export const CRM_RESIGNED_AGENT_CRM_IDS: readonly number[] = [
  832, 851, 1024, 1035, 1071, 1134, 1146, 1148, 1152, 1156, 1158, 1159, 1163, 1221,
  1222, 1236, 1246, 1249, 1272, 1280, 1284, 1286, 1288, 1295, 1303, 1304, 1330, 1345, 1351,
  1354, 1357, 1368, 1369, 1370, 1371, 1372, 1373, 1374, 1376, 1377, 1378, 1381, 1382, 1389,
  1396, 1402, 1407, 1409, 1437, 1476, 1478, 1486, 1492, 1493, 1504, 1508, 1510, 1511,
  1512, 1514, 1515, 1516, 1518, 1519, 1522, 1524, 1528,
  // Owner-excluded 2026-07-17 (not necessarily resigned): Ahmed Amer 667, Adel.Sayed 1436,
  // CEO 1474, George.Rafaat (Sharkia 1/C) 1500. (Mahmoud.Gamal 1272 already listed above.)
  667, 1436, 1474, 1500,
  // 2026-07-18: crm_id 1477 REMOVED — it is a reused CRM agent slot now resolving to ACTIVE
  // employee B-164 (Nasr City / P); keeping it here was hiding an active rep's data. The live
  // status union will not re-hide an active employee.
  // 2026-08-04: crm_id 1102 REMOVED (owner decision, mapping sheet) — reused slot now carrying
  // Gannatallah Amer (B-165, Imbaba); keeping it here hid a working rep's visits since April.
  // Same failure class as 1477. NOTE: she stays hidden by the LIVE departed-agent union until her
  // roster row leaves employment_status "historical_payroll_record".
  // 2026-08-04: crm_id 1395 (Mohamed.Raafat, Helwan-Maadi) and 1521 (Adel.Srour, Down-town)
  // REMOVED — both are reused slots now carrying a working rep the owner confirmed is real. This
  // list is a HARD FLOOR: it outranks employment status, so leaving an id here keeps that person's
  // fieldwork invisible no matter what the roster says. Removing them is what lets the roster row
  // the owner is about to add actually take effect; until it exists their visits show as unmapped,
  // which is the honest state and what the unmapped-agent alert reports.
  // 2026-08-05: crm_id 1247 REMOVED (owner confirmed) — reused slot now carrying AI-0005 (Mahmoud
  // Abdelreheem, Medical Representative, Cairo West / A, hired 2026-08-01); keeping it here hid 22
  // of his visits logged the same day this was found. Same failure class as 1477/1102/1395/1521 —
  // found by auditing the rest of this list for active employees after fixing the live-tier
  // equivalent of this bug (see resolveLiveDepartedExclusion below).
  // 2026-08-21: crm_id 1523 REMOVED (owner confirmed) — reused slot now carrying AI-0011 (Mohamed
  // Khaled, Medical Representative, ACTIVE). It sat in the RESIGNED block above, not the
  // owner-excluded block, so it was a leaver's id rather than a deliberate carve-out. Production
  // the day it was found: 113 August visits (112 of them campaign, type -8) and 21 planned
  // contacts, all invisible — including to the Field Workforce Compliance matrix that feeds
  // automated payroll's no-activity deduction detector, so an ACTIVE rep was a candidate for a
  // no-activity deduction against real salary. Sixth of this failure class after
  // 1477/1102/1395/1521/1247. The live union will NOT re-hide him: resolveLiveDepartedExclusion
  // drops the scanned id because employees.crm_id '1523' now belongs to an active employee —
  // exactly the 1399/AI-0006 case its test pins. Found via the Rep Doctor Lists board (#2260),
  // which showed him at 0% adherence; the audit that followed re-checked EVERY id in this list
  // against live employment status and this was the only wrong one. 1436 (Adel El Sayed,
  // Financial Advisor, 0 visits) is a deliberate owner exclusion and deliberately stays.
  // 2026-09-03: crm_id 1367 REMOVED (owner confirmed) — a dormant placeholder slot (only
  // auto-generated holiday markers, 2026-01-06 to 2026-08-27, under the vendor's own bucket label
  // "Others ( Eagles DM )") that started carrying B-1's (Nosiba Salah Hussenin Moussa, ACTIVE
  // Medical Representative, Minia 1) real fieldwork from 2026-08-29 — the exact day her own
  // long-standing account (crm_id 1147) logged its last activity. Confirmed, not just inferred
  // from timing: 6 of the individual doctor/pharmacy contact_crm_ids visited under 1367 are the
  // literal same contacts 1147 had visited before, including Minia University Hospital, and every
  // 1367 visit falls within 1147's own district set (Maghagha/Bani Mazar/El Menia/Samalout/Matai).
  // Unlike 1477/1102/1395/1521/1247/1523, this id was never resolvable purely via
  // employees.crm_id (that column already holds her own 1147) — it needed a manual identity
  // mapping too (ireports360_crm_identity_resolutions, crm_id 1367 -> B-1), applied alongside
  // this removal. Since this id was a genuinely dormant slot rather than a leaver's, its entire
  // history (including the pre-08-29 holiday markers, retroactively relabeled "Nosiba.Salah" by
  // the vendor) is real — there is no other occupant's work to protect from misattribution here,
  // unlike the label-scoped multi-occupant handovers (1102/1395/1399). Seventh of this failure
  // class after 1477/1102/1395/1521/1247/1523.
  // 2026-09-13: crm_id 1166 REMOVED (owner decision, CRM decisions workbook) — a leaver's Qalyubia
  // slot (manual resolution "( Qal / E )", status resigned) now carrying AI-0018 (Samah Ashraf,
  // Medical Representative, ACTIVE, hired 2026-09-02), whose employees.crm_id is 1166. From 5 Sep
  // to 12 Sep she logged 39 visits there, all invisible — to Field Workforce Compliance and the
  // no-activity deduction detector as well. The previous occupant's rows stay unattributed: the
  // pre-hire guard refuses every row dated before her hire. Eighth of this failure class.
];

/** PostgREST `in` list literal for the STATIC resigned ids, e.g. "(832,851,...)". Used as the
 * fail-safe default in the filter helpers below; for the effective (static ∪ live) list prefer
 * {@link getEffectiveExcludedInList}. */
export const CRM_RESIGNED_IN_LIST = `(${CRM_RESIGNED_AGENT_CRM_IDS.join(",")})`;

// ── Live departed-agent exclusion (unioned with the static safety-net above) ─────────────────
// On top of the static list we UNION a live signal: any CRM agent whose sync-resolved agent_hr_id
// belongs to an employee who is no longer active (employment_status ∉ {active, on_leave}). That
// auto-hides a rep the moment HR flips their status — no code edit or deploy — while the static
// list stays the permanent safety-net for the unresolvable placeholder/owner-excluded agents the
// live join can never catch. Fail-safe: any error computing the live set falls back to the static
// list alone (over-hide, never under-hide). Cached ~5 min; employment-status changes are rare.
//
// HANDED-OVER SLOTS MUST NOT STAY EXCLUDED. The scan above is unscoped by date, so a departed
// employee's own OLD rows on a crm_id permanently mark that crm_id as "departed" even after the
// slot is legitimately reassigned to a new, currently active employee — exactly the resignation
// flow's own rule (see resignations/service.ts: a leaver's employees.crm_id is cleared "so the
// replacement hire can inherit it", owner rule 2026-08-05). Without this carve-out, the successor's
// OWN current visits vanish from every company-wide read the moment they inherit the slot — portal,
// admin reports, Double Visit Analytics, AND the Field Workforce Compliance matrix that feeds
// automated payroll's no-activity deduction detector. Verified in production 2026-08-05: crm_id
// 1399 (B-97's slot from 2026-01-01 to her 2026-06-28 resignation) was reassigned to AI-0006
// (hired 2026-08-02) — all 23 of his visits were excluded because B-97's 1,229 historical rows on
// the same crm_id kept it in the live set. Mirrors the reasoning already applied BY HAND to the
// static list for slots 1102/1395/1477/1521 ("reused slot now resolving to an ACTIVE employee;
// keeping it here was hiding an active rep's data") — this makes the live tier self-heal the same
// way instead of requiring a manual removal for every future handover. Deliberately does NOT touch
// the static list itself: some of its entries are owner-excluded ACTIVE employees on purpose (e.g.
// the CEO), and that decision must never be silently reversed just because they are still employed.
const EXCLUDED_AGENTS_TTL_MS = 5 * 60_000;
type EffectiveExclusion = { ids: number[]; inList: string };
let excludedAgentsCache: (EffectiveExclusion & { at: number }) | null = null;
let excludedAgentsInFlight: Promise<EffectiveExclusion> | null = null;

/** Server-side DISTINCT over the visits mirror (supabase/migrations/…_crm_agent_crm_ids_for_hr_ids).
 * PostgREST has no DISTINCT, so the one-statement answer has to be an RPC. */
const CRM_AGENT_CRM_IDS_RPC = "phx_crm_agent_crm_ids_for_hr_ids";

/**
 * True when an error means "this database has no such FUNCTION" — the distinct-scan migration has
 * not been applied here yet (a fresh clone, staging before it lands, a rollback).
 *
 * MUST be tested BEFORE {@link isCrmSchemaMissingError}. PostgREST reports a missing function as
 * PGRST202 "Could not find the function public.… in the schema cache", and the phrase "schema
 * cache" also matches the mirror-missing pattern — so checking in the other order would read a
 * missing FUNCTION as a missing MIRROR and degrade to an EMPTY live exclusion, silently resurfacing
 * every departed rep across Double Visit Analytics, Field Workforce Compliance and the payroll
 * no-activity detector. Exported so that ordering is pinned by a test, not by reading order.
 */
export function isMissingCrmRpcError(error: unknown): boolean {
  if (!error) return false;
  const shape = error as { code?: string | null; message?: string | null };
  const code = String(shape.code ?? "");
  if (code === "PGRST202" || code === "42883") return true;
  const message = String(shape.message ?? (error instanceof Error ? error.message : ""));
  return /could not find the function|function .*does not exist/i.test(message);
}

/** Fold scanned rows into the distinct crm_id set. Shared by the RPC and the page-walk fallback so
 * the two paths cannot drift apart. The `Number.isFinite` guard is the only addition to the
 * original `ids.add(Number(row.agent_crm_id))`: `agent_crm_id` is `bigint NOT NULL` in production,
 * so it can only ever reject a value a looser clone produced — and a NaN in the exclusion set would
 * poison every `.not("agent_crm_id", "in", …)` filter built from it. */
function collectAgentCrmIds(
  rows: ReadonlyArray<{ agent_crm_id: number | string | null }>,
  into: Set<number>,
): Set<number> {
  for (const row of rows) {
    if (row.agent_crm_id == null) continue;
    const id = Number(row.agent_crm_id);
    if (Number.isFinite(id)) into.add(id);
  }
  return into;
}

/**
 * The ORIGINAL keyset page walk, kept as the fallback for a database that does not have
 * {@link CRM_AGENT_CRM_IDS_RPC} yet. Same result, one round trip per 2,000 matched rows instead of
 * one in total — so an unmigrated environment stays correct (never silently empty) and only pays
 * the old cost.
 */
async function pageWalkDepartedAgentCrmIds(keys: string[], supabase: SupabaseClient): Promise<number[]> {
  const ids = new Set<number>();
  const pageSize = 2000;
  let cursor: string | null = null;
  for (;;) {
    let query = supabase
      .from(CRM_VISITS_TABLE)
      .select("id, agent_crm_id")
      .in("agent_hr_id", keys)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (cursor) query = query.gt("id", cursor);
    const { data, error } = await query;
    if (error) {
      if (isCrmSchemaMissingError(error)) break;
      throw new Error(error.message);
    }
    const page = (data ?? []) as Array<{ id: string; agent_crm_id: number | null }>;
    collectAgentCrmIds(page, ids);
    if (page.length < pageSize) break;
    cursor = page[page.length - 1].id;
  }
  return Array.from(ids);
}

/**
 * Distinct agent_crm_ids in the visits mirror whose sync-resolved `agent_hr_id` belongs to one of
 * `departedHrIds`. Visits alone are complete — every departed agent that has check-ins also has
 * visits (verified against production), so the check-ins table need not be scanned. Raw scan that
 * deliberately does NOT apply the resigned exclusion (it is computing part of it) and does NOT
 * apply the handed-over-slot carve-out — {@link resolveLiveDepartedExclusion} still runs on the
 * result.
 *
 * The scan is unscoped by date ON PURPOSE (a departed rep's OLD rows are exactly what mark their
 * crm_id), so the matched row set only ever grows: it used to be paged 2,000 rows at a time, which
 * on 2026-08-09 meant 8 sequential Railway-sfo → Supabase-eu-central-1 round trips reading 15,492
 * rows and 1,944 ms to produce 23 integers, on every cold cache, for every consumer of
 * {@link getEffectiveExcludedInList}. Postgres answers it in one statement. `rpcAll` rather than a
 * bare `.rpc()`: PostgREST caps every response at db-max-rows (1,000) with no error, and a silently
 * truncated exclusion list under-hides departed reps — it costs no extra round trip when uncapped
 * (the exact count rides back on the same response).
 *
 * `client` is injectable for tests only; production always uses the shared admin client.
 */
export async function scanDepartedAgentCrmIds(
  departedHrIds: readonly string[],
  client?: SupabaseClient,
): Promise<number[]> {
  const keys = expandHrIdFilterValues(departedHrIds);
  if (keys.length === 0) return [];
  const supabase = client ?? getSupabaseAdmin();
  try {
    const rows = await rpcAll<{ agent_crm_id: number | string | null }>(
      supabase,
      CRM_AGENT_CRM_IDS_RPC,
      { p_agent_hr_ids: keys },
      ["agent_crm_id"],
    );
    return Array.from(collectAgentCrmIds(rows, new Set<number>()));
  } catch (error) {
    if (isMissingCrmRpcError(error)) return pageWalkDepartedAgentCrmIds(keys, supabase);
    if (isCrmSchemaMissingError(error)) return [];
    // toQueryError, not `new Error(String(error))`: supabase-js reports network-level failures as a
    // plain { message, code } object, and stringifying one yields "[object Object]" — which lands in
    // the caller's crm_live_departed_exclusion_failed log with the real cause erased.
    throw toQueryError(error);
  }
}

/**
 * Pure: drops any scanned "departed" crm_id that a currently ACTIVE/on_leave employee now owns
 * (`employees.crm_id`) — a handed-over CRM slot. Split out from {@link computeEffectiveExclusion}
 * so the handover carve-out is provable without mocking Supabase (same rationale as every other
 * pure-core extraction in this module, e.g. `selectUnmappedAgentAlerts`). Only ever REMOVES ids
 * from the live-scanned set; the hand-maintained static list is a separate, untouched input to the
 * final union, so an owner-excluded active employee (the CEO, etc.) stays excluded regardless.
 */
export function resolveLiveDepartedExclusion(input: {
  scannedCrmIds: readonly number[];
  activeEmployeeCrmIds: ReadonlySet<string>;
}): number[] {
  return input.scannedCrmIds.filter((id) => !input.activeEmployeeCrmIds.has(String(id)));
}

/** Compute the effective exclusion (static ∪ live departed). Never throws: a failure in the live
 * tier is logged and degrades to the static list alone. */
async function computeEffectiveExclusion(): Promise<EffectiveExclusion> {
  let liveIds: number[] = [];
  try {
    const employees = await getEmployeeDirectoryRows({ includeInactive: true });
    const departedHrIds = employees
      .filter((employee) => !isActiveLifecycleStatus(employee.employmentStatus))
      .map((employee) => employee.hrId)
      .filter((hrId): hrId is string => Boolean(hrId));
    if (departedHrIds.length > 0) {
      const scannedCrmIds = await scanDepartedAgentCrmIds(departedHrIds);
      const activeEmployeeCrmIds = new Set(
        employees
          .filter((employee) => isActiveLifecycleStatus(employee.employmentStatus) && employee.crmId)
          .map((employee) => String(employee.crmId)),
      );
      liveIds = resolveLiveDepartedExclusion({ scannedCrmIds, activeEmployeeCrmIds });
    }
  } catch (error) {
    // Best-effort live tier; the static safety-net still applies (fail-safe over-hide).
    logError("Live departed-agent CRM exclusion failed; using static list only", {
      labels: { event: "crm_live_departed_exclusion_failed" },
      error,
    });
  }
  const ids = Array.from(new Set<number>([...CRM_RESIGNED_AGENT_CRM_IDS, ...liveIds])).sort((a, b) => a - b);
  return { ids, inList: ids.length > 0 ? `(${ids.join(",")})` : "" };
}

/** Cached accessor for the effective exclusion; refreshes at most once per
 * {@link EXCLUDED_AGENTS_TTL_MS} and dedupes concurrent refreshes. Always resolves (never below the
 * static list). */
async function getEffectiveExclusion(): Promise<EffectiveExclusion> {
  const cached = excludedAgentsCache;
  if (cached && Date.now() - cached.at < EXCLUDED_AGENTS_TTL_MS) return cached;
  if (excludedAgentsInFlight) return excludedAgentsInFlight;
  excludedAgentsInFlight = computeEffectiveExclusion()
    .then((result) => {
      excludedAgentsCache = { ...result, at: Date.now() };
      return result;
    })
    .finally(() => {
      excludedAgentsInFlight = null;
    });
  return excludedAgentsInFlight;
}

/** The PostgREST `in` list literal for the EFFECTIVE exclusion (static ∪ live departed). Consumers
 * that build their own ireports360 queries use it in `.not("agent_crm_id", "in", …)`. */
export async function getEffectiveExcludedInList(): Promise<string> {
  return (await getEffectiveExclusion()).inList;
}

/** The EFFECTIVE excluded agent_crm_ids (static safety-net ∪ live departed agents). */
export async function getEffectiveExcludedAgentCrmIds(): Promise<number[]> {
  return (await getEffectiveExclusion()).ids;
}

const DEFAULT_PAGE_SIZE = 1000;

// ── Company-wide date-range scans read one calendar day at a time ─────────────────────────────
// A keyset page is `<filter> ORDER BY id LIMIT 1000`. When the filter is a wide date window with
// nobody named in it, Postgres cannot stop early: it reads EVERY row in the window through the date
// index and sorts it to hand back the first 1,000, and the next page does the same again. The
// unified views make that certain — their cutover clause (`visit_date < COALESCE((SELECT cutover…),
// 'infinity')`) knocks the planner's estimate for any date window down to its 0.5% default (673 rows
// estimated against 36,167 real ones for July–August), so an ordered plan never looks worth it, and
// the generic plan a PostgREST prepared statement falls back to estimates `$1`/`$2` ranges the same
// way. Production: the Business Review's July–August visit read re-read all 36,167 rows on each of
// its 37 pages and was cancelled at the 8-second statement timeout (14 Sep 17:16, 16 Sep 14:08 Cairo).
//
// So a company-wide window is read in two steps. First one UNORDERED page of the whole window: with
// no sort Postgres stops at the page limit, so the probe is cheap on a dense window, and on a sparse
// one (a leave type, double visits only) a short probe already holds every row — it is put in the
// single scan's order and returned, one request as before. Only a full probe goes on to read one day
// per request, which bounds every request to a single day's rows whatever plan Postgres picks. The
// days are disjoint and cover the window, so their union is exactly the rows the single scan
// returned, handed back in its order (id for visits; check_date then id for check-ins). Reads that
// name people — an agent, a double-visitor, a contact, a participant, a GPS box — already return few
// rows through their own indexes and keep one scan.

/** Longest window read day by day; a longer one keeps the single keyset scan. */
const DAY_SLICE_MAX_DAYS = 400;
/** Day requests in flight at once for one read. */
const DAY_SLICE_CONCURRENCY = 4;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A YYYY-MM-DD string naming a real calendar day. JavaScript rolls 2026-02-30 over into March and
 * makes 2026-13-01 an Invalid Date (whose toISOString throws), so both are checked by round trip. */
function isCalendarDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Every calendar day from `dateFrom` through `dateTo` inclusive, as YYYY-MM-DD — the requests a
 * company-wide range scan is split into. `null` (keep the single scan) when either bound is missing
 * or not a real calendar date, the window is inverted or one day long, or it spans more than
 * {@link DAY_SLICE_MAX_DAYS} days. Pure, exported for its unit test.
 */
export function dayScanSlices(dateFrom: string | null | undefined, dateTo: string | null | undefined): string[] | null {
  if (!dateFrom || !dateTo || !isCalendarDay(dateFrom) || !isCalendarDay(dateTo)) return null;
  if (dateFrom >= dateTo) return null;
  const days: string[] = [];
  for (let day = dateFrom; day <= dateTo; day = addDaysIso(day, 1)) {
    days.push(day);
    if (days.length > DAY_SLICE_MAX_DAYS) return null;
  }
  return days;
}

/** True when a visit read names the people or contacts it is about (see the note above).
 * Pure, exported for its unit test. */
export function visitFilterNamesPeople(filter: CrmVisitFilter): boolean {
  return (
    (filter.agentCrmIds?.length ?? 0) > 0 ||
    (filter.agentHrIds?.length ?? 0) > 0 ||
    Boolean(filter.agentHrIdILike) ||
    (filter.doubleHrIds?.length ?? 0) > 0 ||
    (filter.contactCrmIds?.length ?? 0) > 0 ||
    filter.participantCrmIds != null ||
    filter.participantHrIds != null ||
    filter.agentCrmOrHrIds != null
  );
}

/** The check-in twin of {@link visitFilterNamesPeople}; a GPS box counts as naming a place.
 * Pure, exported for its unit test. */
export function checkinFilterNamesPeople(filter: CrmCheckinFilter): boolean {
  return (
    (filter.agentCrmIds?.length ?? 0) > 0 ||
    (filter.agentHrIds?.length ?? 0) > 0 ||
    Boolean(filter.agentHrIdILike) ||
    filter.agentCrmOrHrIds != null ||
    filter.bounds != null
  );
}

/** `order by id` for the canonical lowercase uuid text PostgREST returns: Postgres compares a uuid
 * byte by byte, and fixed-width lowercase hex with hyphens in fixed places sorts the same way under
 * plain code-unit comparison. Pure, exported for its unit test. */
export function compareUuidText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `order by check_date, id` for check-in rows as PostgREST returns them. Every timestamp in one
 * response carries the session's one UTC offset and Postgres's own ISO form (fraction digits only
 * when non-zero, trailing zeros trimmed), so plain text order is time order: a whole second's `+`
 * sorts before the `.` of a fraction in that second, and fraction digits compare left to right.
 * Pure, exported for its unit test. */
export function compareCheckinScanOrder(a: { check_date: string; id: string }, b: { check_date: string; id: string }): number {
  if (a.check_date !== b.check_date) return a.check_date < b.check_date ? -1 : 1;
  return compareUuidText(a.id, b.id);
}

/**
 * The window's days in runs of up to `runDays` consecutive entries, in order — the requests of a
 * sliced read whose days each hold few rows. Every day lands in exactly one run, so the runs still
 * cover the window once each. Anything but a whole number above 1 keeps one day per request. Pure,
 * exported for its unit test.
 */
export function dayScanRuns(days: readonly string[], runDays: number | undefined): string[][] {
  const size = typeof runDays === "number" && Number.isInteger(runDays) && runDays > 1 ? runDays : 1;
  const runs: string[][] = [];
  for (let index = 0; index < days.length; index += size) runs.push(days.slice(index, index + size));
  return runs;
}

// ── A dashboard may reuse a company window up to a minute old ────────────────────────────────
// The owner's choice (2026-10-16): a dashboard's company-wide window may be served from a copy up to
// 60 s old, and a Phoenix CRM visit captured by this process refreshes it at once. OPT-IN per read
// (`reuseRecentWindow`), and only a display reader opts in — a read that decides money, a deduction,
// an approval or a notification always reads live. Only the company-window path is shared: a read
// that names people is a handful of indexed requests already. The key carries every input that
// changes the rows (the whole options object, the projection, the page size and the exclusion list).
// The namespace names and the refresh live in `shared-windows.ts`, so a write path need not import the door.
const CRM_WINDOW_SHARED_LIMITS = { maxEntries: 8, maxRowsTotal: 100_000 };

/** `read` through the shared copy when `key` is set (the caller opted in), else straight through. */
async function readWindowMaybeShared<Row extends object>(
  namespace: string,
  key: string | null,
  read: () => Promise<Row[] | null>,
): Promise<Row[] | null> {
  if (key === null) return read();
  return (await getOrLoadShared(namespace, key, read, CRM_WINDOW_SHARED_LIMITS)).rows;
}

/** Runs `read` for every day, {@link DAY_SLICE_CONCURRENCY} at a time, results kept in day order. */
async function readDaySlices<S, R>(days: readonly S[], read: (day: S) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(days.length);
  let next = 0;
  const worker = async () => {
    while (next < days.length) {
      const index = next;
      next += 1;
      results[index] = await read(days[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(DAY_SLICE_CONCURRENCY, days.length) }, worker));
  return results;
}

/**
 * The company-wide window read (see the note above): an unordered probe page, then — only when it
 * comes back full — one scan per day. `null` when any request found the mirror schema missing.
 * `order` puts a short probe in the single scan's order; `sortDays` re-sorts the joined days (visits,
 * whose id order crosses days) or leaves them end to end (check-ins, already in check_date order).
 * A slice is one day, or one run of days ({@link dayScanRuns}) for a read that asked for runs.
 * Takes its requests as functions, so it is exported for its unit test.
 */
export async function readCompanyWindow<Row, Slice = string>(options: {
  days: readonly Slice[];
  pageSize: number;
  probe: () => Promise<Row[] | null>;
  scanDay: (day: Slice) => Promise<Row[] | null>;
  order: (a: Row, b: Row) => number;
  sortDays: boolean;
}): Promise<Row[] | null> {
  const probe = await options.probe();
  if (probe === null) return null;
  if (probe.length < options.pageSize) return probe.sort(options.order);
  const slices = await readDaySlices(options.days, options.scanDay);
  if (slices.some((slice) => slice === null)) return null;
  const rows = (slices as Row[][]).flat();
  return options.sortDays ? rows.sort(options.order) : rows;
}

/**
 * Expand hr-id filter values so a case-SENSITIVE PostgREST `.in("agent_hr_id"/"double_hr_id", …)`
 * matches regardless of the caller's casing. The mirror stores whatever casing the employee roster
 * uses (asserted UPPERCASE but NOT enforced anywhere in the write path), so we spray every
 * casing/alias variant via the shared `hrIdLookupKeys` helper. This is the SINGLE place the door's
 * hr-id list filters become case-insensitive — callers pass ids in any casing and must not
 * pre-expand. Cheap: the hr-id lists here are per-employee / per-cohort (never company-wide). */
export function expandHrIdFilterValues(ids: readonly string[]): string[] {
  return Array.from(new Set(ids.flatMap((id) => hrIdLookupKeys(id))));
}

/** Shared visit filters, applied identically across every read. */
export type CrmVisitFilter = {
  /** Inclusive `visit_date` lower bound (YYYY-MM-DD). */
  dateFrom?: string;
  /** Inclusive `visit_date` upper bound (YYYY-MM-DD). */
  dateTo?: string;
  /**
   * Restrict to these CRM agent ids (`agent_crm_id IN`). Empty array → no rows. The check-in door
   * has carried this filter since it was written; this is the visits twin of it.
   *
   * The hr-id filters below are the usual door. Use this one when the visits are being joined to
   * another CRM mirror keyed on `agent_crm_id` — the PLAN mirror is, so narrowing one half of that
   * join by hr id and the other by CRM id can pair up two different people. Same identity on both
   * sides, no mapping step, and no exposure to the mixed-case hr ids that make a naive match
   * under-return elsewhere in this system.
   */
  agentCrmIds?: readonly number[];
  /** Restrict to these resolved agent hr ids (`agent_hr_id IN`). Empty array → no rows. Matched
   * CASE-INSENSITIVELY — the door sprays every casing/alias variant (`expandHrIdFilterValues`), so
   * pass ids in any casing and do NOT pre-expand. */
  agentHrIds?: readonly string[];
  /** Case-insensitive exact match on a single resolved agent hr id (`agent_hr_id ILIKE`). For
   * per-employee reads (e.g. probation SFE evidence) where the caller's hr-id casing may differ
   * from the mirror's stored casing. Combine with a date range, not with `agentHrIds`. */
  agentHrIdILike?: string;
  /** Restrict to these resolved partner hr ids, in EITHER slot (`double_hr_id IN … OR double2_hr_id
   * IN …`). Empty array → no rows. Matched case-insensitively (see `agentHrIds`). For "double visits
   * conducted by this manager" reads (e.g. Employee 360 leadership activity) — and slot 2 is in it
   * because a senior manager or a product manager on a chain stands there, and asking slot 1 alone
   * answered zero for them. */
  doubleHrIds?: readonly string[];
  /** Restrict to these visit types (`visit_type IN`). */
  visitTypes?: readonly number[];
  /** Keep only rows with a real double partner (`double_crm_id` present and ≠ 0). */
  doubleOnly?: boolean;
  /** Require a resolved `agent_hr_id` (NOT NULL). */
  requireAgentHrId?: boolean;
  /** Require a resolved `double_hr_id` (NOT NULL). */
  requireDoubleHrId?: boolean;
  /** Restrict to these CRM contact ids (`contact_crm_id IN`). Empty array → no rows. For
   * contact-centric reads (e.g. "what speciality does the CRM record for these doctors"), where
   * the subject of the question is the contact rather than the agent. */
  contactCrmIds?: readonly number[];
  /**
   * Restrict to these visit days (`visit_date IN`). Empty array → no rows. For a reader that has
   * already found the few days that concern it and needs EVERY row of those days, whoever they name:
   * the private calendar's double visits, where a chain visit is resolved from its whole day. Names
   * nobody, so a window read this way is still the company window — the unordered probe, then one
   * request per listed day inside the window — and comes back in the single scan's id order.
   */
  visitDates?: readonly string[];
  /**
   * Restrict to visits these CRM ids took part in, as EITHER the submitting agent OR the
   * double-visit partner (`agent_crm_id IN ids OR double_crm_id IN ids`). Empty array, or no finite
   * id in it → no rows (fails closed, never widens to every row). For person-centric workload reads
   * where a manager's fieldwork is recorded on the rep's visit as the double-visitor (outstation
   * workload evidence, the manager partner roll-up).
   */
  participantCrmIds?: readonly number[];
  /**
   * The hr-id twin of `participantCrmIds`: visits these people took part in as EITHER the agent OR
   * the double-visit partner (`agent_hr_id IN ids OR double_hr_id IN ids`), matched
   * case-insensitively like `agentHrIds`. For a rep hired after the CRM cutover, who has no CRM id
   * and so can never be found by `participantCrmIds`. Supplied together with `participantCrmIds`
   * the two are UNIONED into one `or` — a visit matching either list is returned. Empty (or all
   * blank) with no usable `participantCrmIds` beside it → no rows.
   */
  participantHrIds?: readonly string[];
  /** Require a `double_crm_id` (NOT NULL only). Unlike `doubleOnly` it keeps the vendor's `0`
   * sentinel, for callers that already discard it themselves. */
  requireDoubleCrmId?: boolean;
  /**
   * Restrict to visits these people SUBMITTED, found by EITHER id (`agent_crm_id IN crmIds OR
   * agent_hr_id IN hrIds`, every casing variant of the hr ids) — the visits twin of the check-in
   * door's filter of the same name, sharing its expression builder. For a reader that must reach a
   * few reps whose vendor rows carry only a CRM id and whose native rows only an hr id, in ONE read
   * and in the single scan's id order. Unlike the participant filters it never matches the
   * double-visit partner. Nothing usable on either side → no rows (fails closed). Not to be combined
   * with `doubleOnly` or the participant filters, which bring their own `or`.
   */
  agentCrmOrHrIds?: { crmIds?: readonly number[]; hrIds?: readonly string[] };
};

/**
 * PostgREST `or` expression for {@link CrmVisitFilter.participantCrmIds}: agent OR EITHER person
 * beside him in the id list. Non-finite ids are dropped and duplicates collapsed; returns `null` when
 * nothing usable is left, which the door treats as "no rows". Pure, exported for its unit test.
 *
 * Slot 2 is here because a chain visit's second person is as much a participant as its first. Until
 * 2026-10-07 the view had no second slot at all, so a senior manager or a product manager on a chain
 * was unreachable by every participant read — the manager partner roll-up and the outstation workload
 * evidence among them.
 */
export function buildParticipantCrmIdOrFilter(ids: readonly number[]): string | null {
  const clean = Array.from(new Set(ids.map((id) => Number(id)).filter((id) => Number.isFinite(id))));
  if (clean.length === 0) return null;
  const list = clean.join(",");
  return `agent_crm_id.in.(${list}),double_crm_id.in.(${list}),double2_crm_id.in.(${list})`;
}

/** A PostgREST `in` list of text values, double-quoted so an hr id carrying a comma, a dot or a
 * parenthesis can never be read as list syntax. */
function quotedInList(values: readonly string[]): string {
  return values.map((value) => `"${value.replace(/(["\\])/g, "\\$1")}"`).join(",");
}

/** Every casing/alias variant of the non-blank ids — {@link expandHrIdFilterValues}, blanks dropped. */
function usableHrIdFilterValues(ids: readonly string[]): string[] {
  return expandHrIdFilterValues(ids.map((id) => String(id ?? "").trim()).filter((id) => id.length > 0)).filter(
    (value) => value.length > 0,
  );
}

/**
 * PostgREST `or` expression for {@link CrmVisitFilter.participantHrIds}: agent OR EITHER person beside
 * him, hr id in the list, every casing variant included. `null` when no usable id is left.
 * Pure, exported for its unit test.
 *
 * The hr half is the ONLY way slot 2 can be matched for a product manager or a senior with no CRM
 * account of his own, which is the ordinary case for a head-office manager.
 */
export function buildParticipantHrIdOrFilter(ids: readonly string[]): string | null {
  const values = usableHrIdFilterValues(ids);
  if (values.length === 0) return null;
  const list = quotedInList(values);
  return `agent_hr_id.in.(${list}),double_hr_id.in.(${list}),double2_hr_id.in.(${list})`;
}

/**
 * The one participant `or` the door applies: the CRM-id half, the hr-id half, or both joined into a
 * single expression so they UNION. With only `participantCrmIds` supplied this is exactly
 * {@link buildParticipantCrmIdOrFilter}, so every caller that predates the hr half reads the same
 * rows as before. `null` means "no rows".
 */
export function buildParticipantOrFilter(filter: Pick<CrmVisitFilter, "participantCrmIds" | "participantHrIds">): string | null {
  const parts = [
    filter.participantCrmIds != null ? buildParticipantCrmIdOrFilter(filter.participantCrmIds) : null,
    filter.participantHrIds != null ? buildParticipantHrIdOrFilter(filter.participantHrIds) : null,
  ].filter((part): part is string => part != null);
  return parts.length > 0 ? parts.join(",") : null;
}

/** True when a participant filter was supplied but can match nobody. */
function participantFilterMatchesNobody(filter: CrmVisitFilter): boolean {
  return (
    (filter.participantCrmIds != null || filter.participantHrIds != null) && buildParticipantOrFilter(filter) === null
  );
}

/**
 * The one PostgREST test for "this row carries a REAL double-visit partner", shared by the
 * `doubleOnly` filter and the departed-partner rescue ({@link scanVisitsForRangeCreditingPartners}).
 *
 * A real partner is a partner crm id that is not the `0` sentinel, OR — on a Phoenix native row only
 * — a resolved partner hr id. The hr half exists for the CRM cutover: a native double visit with a
 * partner who has no CRM id carries `double_hr_id` and a NULL `double_crm_id`, and the crm-only test
 * dropped every one of them from Double Visit Analytics. It is limited to `source = phoenix` because
 * a vendor row can carry a stray resolved hr id beside a null or 0 partner, which is not a double
 * visit (employee-360 audit finding A; the same rule as {@link isCrmDoubleVisitRow}).
 */
export const REAL_DOUBLE_PARTNER_OR_FILTER =
  "and(source.eq.phoenix,double_hr_id.not.is.null),and(double_crm_id.not.is.null,double_crm_id.neq.0)";

/* eslint-disable @typescript-eslint/no-explicit-any -- structural PostgREST builder shape; the
   real type is too deep to thread through a helper (see visits-report/service.ts precedent). */
export type VisitFilterableQuery = {
  eq: (...args: any[]) => VisitFilterableQuery;
  gte: (...args: any[]) => VisitFilterableQuery;
  lte: (...args: any[]) => VisitFilterableQuery;
  ilike: (...args: any[]) => VisitFilterableQuery;
  in: (...args: any[]) => VisitFilterableQuery;
  is: (...args: any[]) => VisitFilterableQuery;
  neq: (...args: any[]) => VisitFilterableQuery;
  not: (...args: any[]) => VisitFilterableQuery;
  or: (...args: any[]) => VisitFilterableQuery;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Exported for its unit test only (tests/crm-participant-filter.test.ts) — callers use the doors. */
export function applyVisitFilter(
  query: VisitFilterableQuery,
  filter: CrmVisitFilter,
  excludedInList: string = CRM_RESIGNED_IN_LIST,
): VisitFilterableQuery {
  let result = query;
  // Resigned/departed agents are invisible across every CRM read (single source). `excludedInList`
  // is the effective (static ∪ live) list; it defaults to the static safety-net for any caller that
  // has not resolved the live set.
  if (excludedInList) result = result.not("exclusion_crm_id", "in", excludedInList);
  if (filter.agentCrmIds && filter.agentCrmIds.length > 0) result = result.in("agent_crm_id", [...filter.agentCrmIds]);
  if (filter.dateFrom) result = result.gte("visit_date", filter.dateFrom);
  if (filter.dateTo) result = result.lte("visit_date", filter.dateTo);
  if (filter.agentHrIds && filter.agentHrIds.length > 0) result = result.in("agent_hr_id", expandHrIdFilterValues(filter.agentHrIds));
  if (filter.agentHrIdILike) result = result.ilike("agent_hr_id", filter.agentHrIdILike);
  // EITHER slot, because "the double visits this manager was on" means every visit he was on. A senior
  // manager or a product manager on a chain stands in slot 2, and matching slot 1 alone hid him —
  // which is why Rasha Sabry Khalifa and Hany Saad Omar read as zero October visits before 2026-10-07.
  if (filter.doubleHrIds && filter.doubleHrIds.length > 0) {
    const partnerIds = quotedInList(expandHrIdFilterValues(filter.doubleHrIds));
    result = result.or(`double_hr_id.in.(${partnerIds}),double2_hr_id.in.(${partnerIds})`);
  }
  if (filter.visitTypes && filter.visitTypes.length > 0) result = result.in("visit_type", [...filter.visitTypes]);
  // See REAL_DOUBLE_PARTNER_OR_FILTER for why a stray `double_hr_id` on a vendor row is not a partner.
  //
  // Slot 2 needs NO arm of its own here, and must not be given one: the view fills slot 1 from
  // coalesce(manager, product_manager, senior), so slot 2 can never carry somebody while slot 1 is
  // empty. Every visit with a second person already matches on its first. The same reasoning covers
  // `requireDoubleHrId` below.
  if (filter.doubleOnly) {
    result = result.or(REAL_DOUBLE_PARTNER_OR_FILTER);
  }
  if (filter.requireAgentHrId) result = result.not("agent_hr_id", "is", null);
  if (filter.requireDoubleHrId) result = result.not("double_hr_id", "is", null);
  if (filter.contactCrmIds && filter.contactCrmIds.length > 0) result = result.in("contact_crm_id", [...filter.contactCrmIds]);
  if (filter.visitDates && filter.visitDates.length > 0) result = result.in("visit_date", [...filter.visitDates]);
  if (filter.requireDoubleCrmId) result = result.not("double_crm_id", "is", null);
  if (filter.participantCrmIds != null || filter.participantHrIds != null) {
    const participantOr = buildParticipantOrFilter(filter);
    // Fail CLOSED: a supplied-but-unusable id list must never silently drop the filter and widen
    // the read to every row. The doors short-circuit this case before querying; this is the backstop.
    result = participantOr ? result.or(participantOr) : result.in("agent_crm_id", []);
  }
  if (filter.agentCrmOrHrIds) {
    const identityOr = buildAgentCrmOrHrIdOrFilter(filter.agentCrmOrHrIds);
    // Fail CLOSED, exactly as the check-in door does: never widen to every visit.
    result = identityOr ? result.or(identityOr) : result.in("agent_crm_id", []);
  }
  return result;
}

/** Ensure the `id` column is present in a projection (needed for keyset pagination). */
export function withIdColumn(columns: string): string {
  if (columns.trim() === "*") return columns;
  const parts = columns.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.includes("id") ? parts.join(", ") : ["id", ...parts].join(", ");
}

/** Ensure `exclusion_crm_id` is present — it is how {@link markPartnerCreditOnlyRows} tells whose
 * row it is, whatever the caller asked for. Same "widen internally, extra columns ride along"
 * pattern as {@link withIdColumn}. */
export function withExclusionCrmIdColumn(columns: string): string {
  if (columns.trim() === "*") return columns;
  const parts = columns.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.includes("exclusion_crm_id") ? parts.join(", ") : [...parts, "exclusion_crm_id"].join(", ");
}

/**
 * Marker {@link scanVisitsForRangeCreditingPartners} and `queryVisits`'
 * `creditDepartedAgentPartners` put on a rescued row: its AGENT is departed and excluded, so ONLY
 * the row's double-visit partner may be credited from it. The same pass nulls `agent_hr_id`, so a
 * consumer that credits by hr id is already correct without reading this flag; it exists for the one
 * consumer (the FWC matrix builder) that can resolve a person from `agent_crm_id` instead.
 */
export type PartnerCreditOnlyRow = { partner_credit_only?: boolean };

/**
 * Anonymise the AGENT side of every row logged by a departed/excluded agent, in place.
 *
 * `agent_crm_id` is deliberately LEFT INTACT: it is the key
 * {@link collapseDuplicateVisitSubmissions} groups a re-saved stop by, so nulling it would stop the
 * duplicate collapse working on these rows and inflate the partner's visit count. Exported for its
 * unit test; callers use the doors.
 */
export function markPartnerCreditOnlyRows(rows: readonly unknown[], excludedCrmIds: readonly number[]): void {
  if (rows.length === 0 || excludedCrmIds.length === 0) return;
  const excluded = new Set(excludedCrmIds.map((id) => Number(id)));
  for (const row of rows) {
    const fields = row as PartnerCreditOnlyRow & { agent_hr_id?: string | null; exclusion_crm_id?: number | null };
    if (fields.exclusion_crm_id == null || !excluded.has(Number(fields.exclusion_crm_id))) continue;
    fields.partner_credit_only = true;
    if ("agent_hr_id" in fields) fields.agent_hr_id = null;
  }
}

// ── Duplicate visit submission collapse ───────────────────────────────────────────────────────
// iReports360's mobile client saves the SAME real-world stop as 2+ separate CRM records, each
// with its own genuine crm_visit_id — a client-side artifact, not a Phoenix sync defect. Every
// consumer that SUMS or COUNTS visit rows (Double Visit Analytics KPIs/summaries/trends, Field
// Workforce Compliance day cells, probation DV credit, the rep-day drill-down) is inflated by it.
//
// THE DUPLICATE KEY IS THE CONTACT. Owner's standing domain rule (2026-08-01): a rep never
// visits the same contact twice in a day — nor even in a week. So two rows for one rep, one
// contact, one day, one visit type are the same real stop; two rows naming DIFFERENT contacts
// are two real visits, however alike they otherwise look.
//
// This previously fingerprinted duplicates by IDENTICAL COMMENT TEXT (rep + partner + day +
// AM/PM + comment) and never looked at contact_crm_id at all. Reps type one generic comment for
// every doctor ("اخدت وعد بالكتابه" — "took a promise to prescribe"), so an ordinary day of
// fieldwork collapsed into a single row. Measured in production (July 2026): of 119 groups the
// comment rule matched, only 21 shared a contact — the other 98 spanned different doctors, so
// 166 of the 199 rows it dropped each month were REAL visits. Worked case: rep B-124 with DSM
// B-118 on 2026-07-13 logged nine different doctors between 11:54 and 15:40 and the comment rule
// kept one. Save-time corroborates independently: true duplicates land a median 0.5 min apart,
// the misclassified groups 12.7 min apart and up to 15 hours. Comment text must never group rows.
//
// Scope note: this applies to EVERY visit, not just double visits — a rep logging one contact
// twice alone is the same artifact. But ONLY to regular customer visits (visit_type 0): on every
// other type the contact id is a shared sentinel that identifies nothing, so keying on it would
// fold a whole day of campaign work into one row. See isRegularCustomerVisit for the measured
// evidence. Rows without a contact_crm_id are never grouped either.

/** Row shape {@link collapseDuplicateVisitSubmissions} needs — every field optional so it
 * structurally accepts any consumer's own row type that happens to carry these columns. */
type DuplicateVisitDetectionRow = {
  agent_crm_id?: number | null;
  contact_crm_id?: number | null;
  crm_save_date?: string | null;
  crm_visit_id?: number | null;
  double_crm_id?: number | null;
  visit_date?: string | null;
  visit_type?: number | null;
};

const DUPLICATE_DETECTION_COLUMNS = [
  "crm_visit_id",
  "agent_crm_id",
  "contact_crm_id",
  "double_crm_id",
  "visit_date",
  "visit_type",
  "crm_save_date",
] as const;

/** Ensures the columns {@link collapseDuplicateVisitSubmissions} needs are present in a
 * caller's requested projection — same "widen internally, extra columns just ride along" pattern
 * as {@link withIdColumn}, since {@link getDoubleVisitRows} always applies the collapse regardless
 * of which columns the caller actually wants back. */
function withDuplicateDetectionColumns(columns: string | undefined): string | undefined {
  if (!columns || columns.trim() === "*") return columns;
  const parts = columns.split(",").map((part) => part.trim()).filter(Boolean);
  const missing = DUPLICATE_DETECTION_COLUMNS.filter((column) => !parts.includes(column));
  return missing.length === 0 ? columns : [...parts, ...missing].join(", ");
}

/** True when this row carries a real double-visit partner (a manager riding along), as opposed
 * to a solo visit. `0` is the vendor's "no partner" sentinel alongside null. */
function hasDoublePartner(row: DuplicateVisitDetectionRow): boolean {
  return row.double_crm_id != null && row.double_crm_id !== 0;
}

/**
 * Regular customer visit — the ONLY visit type whose `contact_crm_id` is a real contact.
 *
 * Verified in production (July 2026): type 0 carries 7,364 distinct contact ids across 14,097
 * rows and is 100% contact_name-populated, while EVERY other type (campaign -8, meeting -11,
 * vacation -4, …) shares one single sentinel contact id and is 0% named. So for a non-regular row
 * `contact_crm_id` identifies nothing, and keying the collapse on it would fold a whole day into
 * one row. Real example: rep Hayam.Eladel's 2026-07-30 prospection campaign visited six different
 * pharmacies — ص الهادي, ص القاضي, ص الملكه والامير, ص نانسي, ص محمود فوزي, ص هدي — each named in
 * the COMMENT, all sharing the sentinel contact. Collapsing those would repeat the very mistake
 * the comment-based rule made, mirrored.
 */
function isRegularCustomerVisit(row: DuplicateVisitDetectionRow): boolean {
  return row.visit_type === 0;
}

/**
 * Groups rows as the same real-world stop: one rep, one contact, one day. Per the owner's rule
 * (see the module note) a rep never visits the same contact twice in a day, so any repeat of that
 * tuple is a re-save rather than a second visit.
 *
 * Returns null — never grouped — for a row missing the rep, contact, or date that identifies the
 * stop, and for any non-regular visit type, whose contact id is a shared sentinel rather than a
 * real contact (see {@link isRegularCustomerVisit}). `visit_type` stays in the key so the
 * regular-visit space can never merge with anything else. The double partner is deliberately NOT
 * in the key — one contact logged once solo and once with a manager is still one visit (see
 * {@link prefersOverForDuplicate} for how the ride-along credit is kept).
 */
function duplicateSubmissionGroupKey(row: DuplicateVisitDetectionRow): string | null {
  if (row.agent_crm_id == null || row.contact_crm_id == null || !row.visit_date) return null;
  if (!isRegularCustomerVisit(row)) return null;
  return `${row.agent_crm_id}|${row.contact_crm_id}|${row.visit_date}|${row.visit_type ?? ""}`;
}

/**
 * True when `candidate` should be kept over `current` as the survivor of a duplicate group.
 *
 * A row carrying a double partner always wins: when one real stop was saved both solo and as a
 * ride-along, dropping the ride-along row would silently erase the manager's coaching credit for
 * that day (Double Visit Analytics, probation DV, and the Team Calendar's "DV" marker all read
 * it) while the visit count stayed the same. Otherwise the earliest submission wins — it is the
 * real first save — falling back to the lower `crm_visit_id`, issued in submission order by the
 * CRM, when save times tie or aren't in this caller's column projection.
 */
function prefersOverForDuplicate(candidate: DuplicateVisitDetectionRow, current: DuplicateVisitDetectionRow): boolean {
  const candidateDouble = hasDoublePartner(candidate);
  const currentDouble = hasDoublePartner(current);
  if (candidateDouble !== currentDouble) return candidateDouble;

  const candidateSave = candidate.crm_save_date ?? "";
  const currentSave = current.crm_save_date ?? "";
  if (candidateSave && currentSave && candidateSave !== currentSave) return candidateSave < currentSave;
  if (candidateSave && !currentSave) return true;
  if (!candidateSave && currentSave) return false;
  return (candidate.crm_visit_id ?? Infinity) < (current.crm_visit_id ?? Infinity);
}

/**
 * Collapses duplicate visit submissions (see the module note above) down to one row per real
 * stop — one rep, one contact, one day, one visit type — keeping the earliest save and preferring
 * a ride-along row so coaching credit survives. A READ-TIME collapse only: the raw
 * `ireports360_visits` mirror is never mutated, so the CRM Master "exact mirror" browser and any
 * audit trail stay untouched; only the counts fed by this function's callers (Double Visit
 * Analytics, Field Workforce Compliance, probation DV, the rep-day drill-down) see the
 * deduplicated total. Rows naming different contacts are different real visits and are always
 * kept, as is any row without a contact to key on — both returned unchanged, in original order.
 */
export function collapseDuplicateVisitSubmissions<T extends DuplicateVisitDetectionRow>(rows: readonly T[]): T[] {
  const bestByKey = new Map<string, T>();
  for (const row of rows) {
    const key = duplicateSubmissionGroupKey(row);
    if (!key) continue;
    const current = bestByKey.get(key);
    if (!current || prefersOverForDuplicate(row, current)) bestByKey.set(key, row);
  }
  if (bestByKey.size === 0) return rows as T[];
  return rows.filter((row) => {
    const key = duplicateSubmissionGroupKey(row);
    return !key || bestByKey.get(key) === row;
  });
}

/** The live iReports360 client's camel-case visit fields that identify one real stop — the same
 * dimensions as {@link DuplicateVisitDetectionRow}, under their {@link IReports360Visit}-shape
 * names. */
type DuplicateVisitDetectionLiveShapeVisit = {
  agentID?: number | null;
  contactID?: number | null;
  doubleID?: number | null;
  id?: number | null;
  saveDate?: string | null;
  visitDate?: string | null;
  visitType?: number | null;
};

/**
 * {@link collapseDuplicateVisitSubmissions} for visits already mapped onto the live client's
 * camel-case shape (IReports360Visit) instead of mirror-row snake_case — the rep-day drill-down
 * handles both its live and mirror sources in that shape. A thin field-name adapter around the
 * same canonical collapse, so the drill-down can never disagree with the aggregates that link to
 * it (FWC day cells, Team Calendar counts, DV analytics) about which rows are duplicates.
 * `visitDate` is truncated to its day so the live API's datetime form groups identically to the
 * mirror's pure DATE.
 */
export function collapseDuplicateVisitSubmissionsLiveShape<T extends DuplicateVisitDetectionLiveShapeVisit>(
  visits: readonly T[],
): T[] {
  const adapted = visits.map((visit) => ({
    agent_crm_id: visit.agentID ?? null,
    contact_crm_id: visit.contactID ?? null,
    crm_save_date: visit.saveDate ?? null,
    crm_visit_id: visit.id ?? null,
    double_crm_id: visit.doubleID ?? null,
    visit_date: (visit.visitDate ?? "").slice(0, 10) || null,
    visit_type: visit.visitType ?? null,
    visit,
  }));
  return collapseDuplicateVisitSubmissions(adapted).map((entry) => entry.visit);
}

/** Ensure the `check_date` column is present (needed for check_date-keyset pagination). */
function withCheckDateColumn(columns: string): string {
  if (columns.trim() === "*") return columns;
  const parts = columns.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.includes("check_date") ? parts.join(", ") : ["check_date", ...parts].join(", ");
}

/**
 * Full keyset scan (order by `id` asc) of every `ireports360_visits` row matching `filter`.
 * Keyset (not OFFSET) pagination keeps cost linear even when the filter is weakly selective —
 * the same reason visits-report's own scans switched off `.range()`. Returns `[]` (never
 * throws) when the mirror schema isn't present yet. Callers re-sort in memory if they need a
 * display order.
 */
export async function queryVisits<T = CrmVisitRow>(
  options: CrmVisitFilter & {
    columns?: string;
    pageSize?: number;
    /** Explicit, default-false opt-out of the resigned-agent exclusion. Only for a
     * caller that will independently re-derive the display name/area from the raw
     * `agent_name`/`double_name` string rather than trust the resolved employee —
     * a resolved agent_hr_id pointing at a resigned employee is frequently just a
     * stale mapping (the CRM account gets reused for that person's replacement
     * instead of a fresh one — see memory crm-resigned-slot-reused-for-new-hire).
     * Every other reader must leave this off so departed-agent data stays invisible
     * everywhere coverage/scoring/reporting depends on that exclusion.
     */
    includeResignedAgents?: boolean;
    /**
     * Opt-in, for a read whose SUBJECT is the people named on the DOUBLE side: keep a row whose
     * agent has departed, and null that row's `agent_hr_id` (plus set `partner_credit_only`) so the
     * departed agent is credited nothing while the partner keeps the day.
     *
     * The {@link scanVisitsForRangeCreditingPartners} rule at a bounded read: a manager's fieldwork
     * is logged on the REP's row as its double, so excluding the rep's rows the day he resigns
     * erases the manager's working day with them and bills him for it (owner report 2026-10-07).
     * Only for a caller that gates each credited person against its own wanted set — a departed
     * agent's row is still here, it is merely anonymous on the agent side.
     */
    creditDepartedAgentPartners?: boolean;
    /** Opt-in: collapse iReports360 burst-duplicate double-visit submissions (the same read-time
     * dedup {@link getDoubleVisitRows} applies — see {@link collapseDuplicateVisitSubmissions}).
     * Off by default so raw-mirror browsers are unaffected. When on, the duplicate-detection columns
     * are added to the projection automatically and single-agent visits pass through unchanged, so a
     * caller that SUMS/COUNTS visit rows gets the deduplicated total without re-deriving the dedup. */
    collapseDoubleVisits?: boolean;
    /** Days per request when a company window is read day by day (default 1). For a SPARSE filter,
     * whose day holds a small fraction of a page: one request per run of days instead of one per
     * day, and the same rows in the same order, because the runs cover the window once each
     * ({@link dayScanRuns}). A dense read must keep 1 — a run's every page re-reads the whole run. */
    sliceDays?: number;
    /** Opt-in, DISPLAY readers only: a company-wide window may be served from a copy up to a minute
     * old (see "A dashboard may reuse a company window" above). Never for a read that decides money, a
     * deduction, an approval or a notification. A read that names people is unaffected. */
    reuseRecentWindow?: boolean;
  },
): Promise<T[]> {
  if (options.agentCrmIds && options.agentCrmIds.length === 0) return [];
  if (options.agentHrIds && options.agentHrIds.length === 0) return [];
  if (options.doubleHrIds && options.doubleHrIds.length === 0) return [];
  if (options.contactCrmIds && options.contactCrmIds.length === 0) return [];
  if (options.visitDates && options.visitDates.length === 0) return [];
  if (participantFilterMatchesNobody(options)) return [];
  if (options.agentCrmOrHrIds && buildAgentCrmOrHrIdOrFilter(options.agentCrmOrHrIds) === null) return [];
  const supabase = getSupabaseAdmin();
  // `creditDepartedAgentPartners` lifts the exclusion the same way `includeResignedAgents` does; the
  // difference is what happens to the rows it lets through — they come back anonymous on the agent
  // side (see the option, and the marking pass after the scan).
  const excludedCrmIds =
    options.creditDepartedAgentPartners && !options.includeResignedAgents
      ? await getEffectiveExcludedAgentCrmIds()
      : [];
  const excludedInList =
    options.includeResignedAgents || options.creditDepartedAgentPartners ? "" : await getEffectiveExcludedInList();
  // When collapsing, widen the projection so the duplicate-detection fingerprint columns are present
  // even if the caller only asked for a subset (otherwise the collapse silently no-ops).
  const requestedColumns = options.collapseDoubleVisits ? withDuplicateDetectionColumns(options.columns ?? "*") : options.columns;
  // The marking pass needs to know whose row it is, whatever the caller projected.
  const projection = withIdColumn(
    excludedCrmIds.length > 0 ? withExclusionCrmIdColumn(requestedColumns ?? "*") : (requestedColumns ?? "*"),
  );
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  type Row = T & { id: string };
  const filtered = () => {
    const query = supabase.from(CRM_VISITS_UNIFIED_VIEW).select(projection);
    return applyVisitFilter(query as unknown as VisitFilterableQuery, options, excludedInList) as unknown as typeof query;
  };
  /** One keyset scan (order by id) of the filter, narrowed to one run of `visit_date`s when `run` is
   * set: a lone day by equality, as every day was read before runs existed, and a longer run by its
   * first and last day. `null` when the mirror schema is missing. */
  const scan = async (run: readonly string[] | null): Promise<Row[] | null> => {
    const scanned: Row[] = [];
    let cursor: string | null = null;
    for (;;) {
      let query = filtered();
      if (run && run.length === 1) query = query.eq("visit_date", run[0]);
      else if (run) query = query.gte("visit_date", run[0]).lte("visit_date", run[run.length - 1]);
      query = query.order("id", { ascending: true }).limit(pageSize);
      if (cursor) query = query.gt("id", cursor);
      const { data, error } = await query;
      if (error) {
        if (isCrmSchemaMissingError(error)) return null;
        throw new Error(error.message);
      }
      const page = (data ?? []) as unknown as Row[];
      scanned.push(...page);
      if (page.length < pageSize) break;
      cursor = page[page.length - 1].id;
    }
    return scanned;
  };
  // A company-wide window is probed, then read day by day when dense (see "Company-wide date-range
  // scans" above), and comes back in the single scan's id order either way.
  const windowDays = visitFilterNamesPeople(options) ? null : dayScanSlices(options.dateFrom, options.dateTo);
  // A read limited to listed days (`visitDates`) requests those days of the window and no others.
  const listedDays = options.visitDates ? new Set(options.visitDates) : null;
  const days = windowDays && listedDays ? windowDays.filter((day) => listedDays.has(day)) : windowDays;
  const sharedKey = options.reuseRecentWindow ? sharedReadKey({ excludedInList, options, pageSize, projection }) : null;
  const rows: Row[] | null = days
    ? await readWindowMaybeShared<Row>(CRM_VISIT_WINDOWS, sharedKey, () => readCompanyWindow<Row, readonly string[]>({
        // A run of listed days is a contiguous stretch of the sorted list, so any listed day between
        // its first and last is in it; the `visit_date IN` filter keeps every unlisted day out.
        days: dayScanRuns(days, options.sliceDays),
        pageSize,
        probe: async () => {
          const { data, error } = await filtered().limit(pageSize);
          if (error) {
            if (isCrmSchemaMissingError(error)) return null;
            throw new Error(error.message);
          }
          return (data ?? []) as unknown as Row[];
        },
        scanDay: scan,
        order: (a, b) => compareUuidText(a.id, b.id),
        sortDays: true,
      }))
    : await scan(null);
  if (rows === null) return [];
  if (excludedCrmIds.length > 0) markPartnerCreditOnlyRows(rows, excludedCrmIds);
  return options.collapseDoubleVisits
    ? (collapseDuplicateVisitSubmissions(rows as unknown as DuplicateVisitDetectionRow[]) as unknown as T[])
    : rows;
}

/**
 * Bounded, DB-ordered single fetch — for "latest N" style reads that need a real order + hard
 * cap rather than a full scan. Returns `[]` (never throws) when the mirror schema is missing.
 */
export async function queryVisitsLimited<T = CrmVisitRow>(
  options: CrmVisitFilter & { columns?: string; orderBy?: string; ascending?: boolean; limit: number; collapseDoubleVisits?: boolean },
): Promise<T[]> {
  if (options.agentCrmIds && options.agentCrmIds.length === 0) return [];
  if (options.agentHrIds && options.agentHrIds.length === 0) return [];
  if (options.doubleHrIds && options.doubleHrIds.length === 0) return [];
  if (options.contactCrmIds && options.contactCrmIds.length === 0) return [];
  if (options.visitDates && options.visitDates.length === 0) return [];
  if (participantFilterMatchesNobody(options)) return [];
  if (options.agentCrmOrHrIds && buildAgentCrmOrHrIdOrFilter(options.agentCrmOrHrIds) === null) return [];
  const supabase = getSupabaseAdmin();
  const excludedInList = await getEffectiveExcludedInList();
  // See queryVisits: widen the projection so the collapse fingerprint columns are present.
  const limitedColumns = options.collapseDoubleVisits ? (withDuplicateDetectionColumns(options.columns ?? "*") ?? "*") : (options.columns ?? "*");
  let query = supabase.from(CRM_VISITS_UNIFIED_VIEW).select(limitedColumns);
  query = applyVisitFilter(query as unknown as VisitFilterableQuery, options, excludedInList) as unknown as typeof query;
  query = query
    .order(options.orderBy ?? "visit_date", { ascending: options.ascending ?? false })
    .limit(options.limit);
  const { data, error } = await query;
  if (error) {
    if (isCrmSchemaMissingError(error)) return [];
    throw new Error(error.message);
  }
  const limitedRows = (data ?? []) as unknown as T[];
  return options.collapseDoubleVisits
    ? (collapseDuplicateVisitSubmissions(limitedRows as unknown as DuplicateVisitDetectionRow[]) as unknown as T[])
    : limitedRows;
}

/**
 * Days per request for a company window of double visits.
 *
 * 🔴 WHY (2026-10-02, "speed up the slowest portal page"). A district manager's and an NSM's portal
 * landing reads every double visit since January for its focus panel: about 275 one-day requests,
 * four at a time, 4.0–4.9 s of a 4.3–4.9 s landing (measured on production that night). A
 * double-visit day holds about a hundred rows (2,220 in September 2026), a tenth of a page, so a week
 * is about 700 rows and still one page: the same window in about 40 requests, and the same rows in
 * the same order, because the weeks cover it once each. Any other visit read keeps one day per
 * request — a dense day can hold a thousand rows, and a run's every page re-reads the whole run.
 */
export const DOUBLE_VISIT_SLICE_DAYS = 7;

/**
 * Full scan of double-visit rows (real partner on a fieldwork visit type). The canonical
 * double-visit predicate shared by Double-Visit Analytics, probation DV, the portal, and
 * probation feedback — so those consumers can never disagree about what counts as a double
 * visit. `visitTypes` defaults to {@link CRM_DOUBLE_VISIT_TYPE_CODES}.
 *
 * Also the single point every one of those consumers gets duplicate collapse for free: results
 * run through {@link collapseDuplicateVisitSubmissions} before returning, so a rep re-saving the
 * same contact-day stop counts once here everywhere this door is used, instead of each consumer
 * re-deriving its own dedup rule.
 *
 * A company window is read a WEEK per request ({@link DOUBLE_VISIT_SLICE_DAYS}), not a day.
 */
export async function getDoubleVisitRows<T = CrmVisitRow>(
  options: Omit<CrmVisitFilter, "doubleOnly"> & { columns?: string; includeResignedAgents?: boolean; pageSize?: number; sliceDays?: number },
): Promise<T[]> {
  const rows = await queryVisits<T & DuplicateVisitDetectionRow>({
    ...options,
    columns: withDuplicateDetectionColumns(options.columns),
    doubleOnly: true,
    sliceDays: options.sliceDays ?? DOUBLE_VISIT_SLICE_DAYS,
    visitTypes: options.visitTypes ?? CRM_DOUBLE_VISIT_TYPE_CODES,
  });
  return collapseDuplicateVisitSubmissions(rows) as unknown as T[];
}

/** Shared check-in filters. */
export type CrmCheckinFilter = {
  /** Restrict to these CRM agent ids (`agent_crm_id IN`). Empty array → no rows. */
  agentCrmIds?: readonly number[];
  /** Restrict to these resolved agent hr ids (`agent_hr_id IN`). Empty array → no rows. Matched
   * case-insensitively (see the visit-filter `agentHrIds` note). */
  agentHrIds?: readonly string[];
  /** Case-insensitive exact match on the resolved agent hr id (`agent_hr_id ILIKE`) — see the
   * visit-filter note. */
  agentHrIdILike?: string;
  /**
   * Check-ins by EITHER a CRM id OR an hr id (`agent_crm_id IN crmIds OR agent_hr_id IN hrIds`), the
   * hr half matched case-insensitively. For a set of agents where some have a CRM id and some — reps
   * hired after the CRM cutover — have only an hr id: `agentCrmIds` and `agentHrIds` together would
   * AND, and find nobody. No usable id in either list → no rows.
   */
  agentCrmOrHrIds?: { crmIds?: readonly number[]; hrIds?: readonly string[] };
  /** Inclusive `check_date` lower bound as a date (YYYY-MM-DD); expanded to `T00:00:00`. */
  dateFrom?: string;
  /** Inclusive `check_date` upper bound as a date (YYYY-MM-DD); expanded to `T23:59:59`. */
  dateTo?: string;
  /** Restrict to check-ins whose GPS falls inside this latitude/longitude window. The database has
   * no PostGIS and no earthdistance (checked 2026-08-21), so a true radius query is impossible in
   * SQL; a box prefilter here plus an exact haversine in the caller is the available shape. Pass a
   * box that FULLY CONTAINS the circle you want — the caller discards the corners. */
  bounds?: { maxLatitude: number; maxLongitude: number; minLatitude: number; minLongitude: number };
  /** Require a resolved `contact_crm_id` (NOT NULL) — for contact-centric proximity reads. */
  requireContactCrmId?: boolean;
};

/* eslint-disable @typescript-eslint/no-explicit-any -- see VisitFilterableQuery note. */
type CheckinFilterableQuery = {
  gte: (...args: any[]) => CheckinFilterableQuery;
  lte: (...args: any[]) => CheckinFilterableQuery;
  ilike: (...args: any[]) => CheckinFilterableQuery;
  in: (...args: any[]) => CheckinFilterableQuery;
  not: (...args: any[]) => CheckinFilterableQuery;
  or: (...args: any[]) => CheckinFilterableQuery;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/** PostgREST `or` expression for {@link CrmCheckinFilter.agentCrmOrHrIds}; `null` means no rows.
 * Pure, exported for its unit test. */
export function buildAgentCrmOrHrIdOrFilter(ids: { crmIds?: readonly number[]; hrIds?: readonly string[] }): string | null {
  const crmIds = Array.from(new Set((ids.crmIds ?? []).map((id) => Number(id)).filter((id) => Number.isFinite(id))));
  const hrValues = usableHrIdFilterValues(ids.hrIds ?? []);
  const parts: string[] = [];
  if (crmIds.length > 0) parts.push(`agent_crm_id.in.(${crmIds.join(",")})`);
  if (hrValues.length > 0) parts.push(`agent_hr_id.in.(${quotedInList(hrValues)})`);
  return parts.length > 0 ? parts.join(",") : null;
}

/** Exported for its unit test only — callers use {@link queryCheckins}. */
export function applyCheckinFilter(
  query: CheckinFilterableQuery,
  filter: CrmCheckinFilter,
  excludedInList: string = CRM_RESIGNED_IN_LIST,
): CheckinFilterableQuery {
  let result = query;
  // Resigned/departed agents are invisible across every CRM read (single source). See applyVisitFilter.
  if (excludedInList) result = result.not("exclusion_crm_id", "in", excludedInList);
  if (filter.agentCrmIds && filter.agentCrmIds.length > 0) result = result.in("agent_crm_id", [...filter.agentCrmIds]);
  if (filter.agentHrIds && filter.agentHrIds.length > 0) result = result.in("agent_hr_id", expandHrIdFilterValues(filter.agentHrIds));
  if (filter.agentHrIdILike) result = result.ilike("agent_hr_id", filter.agentHrIdILike);
  if (filter.agentCrmOrHrIds) {
    const identityOr = buildAgentCrmOrHrIdOrFilter(filter.agentCrmOrHrIds);
    // Fail CLOSED, as the visit door's participant filter does: never widen to every check-in.
    result = identityOr ? result.or(identityOr) : result.in("agent_crm_id", []);
  }
  if (filter.dateFrom) result = result.gte("check_date", `${filter.dateFrom}T00:00:00`);
  if (filter.dateTo) result = result.lte("check_date", `${filter.dateTo}T23:59:59`);
  if (filter.bounds) {
    result = result
      .gte("lat", filter.bounds.minLatitude)
      .lte("lat", filter.bounds.maxLatitude)
      .gte("lon", filter.bounds.minLongitude)
      .lte("lon", filter.bounds.maxLongitude);
  }
  if (filter.requireContactCrmId) result = result.not("contact_crm_id", "is", null);
  return result;
}

/**
 * Reads `ireports360_checkins` rows matching `filter`.
 *
 * - With an explicit `limit`: a single ordered, bounded fetch (e.g. "nearest few check-ins").
 * - Without `limit`: a full-coverage scan, keyset-paginated by `check_date`. `check_date` (not
 *   the random uuid `id`) leads or follows every check-in index — `(agent_crm_id, check_date)`,
 *   `(agent_hr_id, check_date)` and `(check_date)` — so ordering by it keeps each page an index
 *   range-scan rather than a full sort — 130ms vs 12.8s on a real 30-day/112-agent production
 *   query. A company-wide window (nobody named, no GPS box) is read one calendar day at a time,
 *   each day through `(check_date)`. `check_date` is NOT unique, so the
 *   cursor is `.gte` + an id de-dupe rather than `.gt`: this docstring previously claimed
 *   duplicate timestamps were "never observed in production", but production actually has 1,797
 *   timestamps shared by 2+ rows (up to 20 on one), so a `.gt()` cursor landing mid-group silently
 *   dropped the remainder — which then reads downstream as "this visit has no check-in".
 *
 * Returns `[]` (never throws) when the mirror schema is missing.
 */
export async function queryCheckins<T = CrmCheckinRow>(
  options: CrmCheckinFilter & {
    columns?: string;
    orderBy?: string;
    ascending?: boolean;
    limit?: number;
    pageSize?: number;
    /** Explicit, default-false opt-out of the resigned-agent exclusion — the check-in twin of the
     * {@link queryVisits} option, and subject to the same condition: only for a caller that never
     * displays or trusts the resolved agent. The legitimate case is a CONTACT-centric read, where
     * the agent is merely who happened to record the point and the subject is the doctor. Measured
     * on production 2026-08-21: excluding those agents removes 6,431 of 105,413 GPS check-ins and
     * takes 1,100 of 15,125 contacts to zero — doctors who exist, at real coordinates, whose only
     * check-in came from a rep who has since left. Every agent-centric reader
     * (coverage, scoring, reporting) must leave this off. */
    includeResignedAgents?: boolean;
    /**
     * Also read each countable Phoenix CRM visit of a started team, from the team's start, as that
     * day's check-in — its capture time and its position, nothing else (owner, 2026-10-02: "each
     * visit's silent location counts as a check-in on the SFE and manager screens. Never on the rep's
     * own screens"). OFF unless the caller asks, and only a reader no rep can reach may ask: which do,
     * and why each is no rep's, is listed in src/lib/crm/phoenix-team-starts.ts. Every other reader reads
     * iReports360 check-ins only, exactly as before.
     */
    includePhoenixVisits?: boolean;
    /** Opt-in, DISPLAY readers only — the check-in twin of the {@link queryVisits} option. */
    reuseRecentWindow?: boolean;
  },
): Promise<T[]> {
  if (options.agentCrmIds && options.agentCrmIds.length === 0) return [];
  if (options.agentHrIds && options.agentHrIds.length === 0) return [];
  if (options.agentCrmOrHrIds && buildAgentCrmOrHrIdOrFilter(options.agentCrmOrHrIds) === null) return [];
  const supabase = getSupabaseAdmin();
  const excludedInList = options.includeResignedAgents ? "" : await getEffectiveExcludedInList();

  if (options.limit != null) {
    let query = supabase.from(CRM_CHECKINS_UNIFIED_VIEW).select(options.columns ?? "*");
    if (!options.includePhoenixVisits) query = query.eq("source", IREPORTS360_VISIT_SOURCE);
    query = applyCheckinFilter(query as unknown as CheckinFilterableQuery, options, excludedInList) as unknown as typeof query;
    query = query.order(options.orderBy ?? "check_date", { ascending: options.ascending ?? true }).limit(options.limit);
    const { data, error } = await query;
    if (error) {
      if (isCrmSchemaMissingError(error)) return [];
      throw new Error(error.message);
    }
    return (data ?? []) as unknown as T[];
  }

  const projection = withIdColumn(withCheckDateColumn(options.columns ?? "*"));
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  type Row = T & { check_date: string; id: string };
  const filtered = () => {
    const base = supabase.from(CRM_CHECKINS_UNIFIED_VIEW).select(projection);
    // iReports360 check-ins only, unless the caller asked for the Phoenix ones too (see the option).
    const query = options.includePhoenixVisits ? base : base.eq("source", IREPORTS360_VISIT_SOURCE);
    return applyCheckinFilter(query as unknown as CheckinFilterableQuery, options, excludedInList) as unknown as typeof query;
  };
  /** One keyset scan of the filter, narrowed to the half-open day [day 00:00, next day 00:00) when
   * `day` is set. `null` when the mirror schema is missing. */
  const scan = async (day: string | null): Promise<Row[] | null> => {
    const rows: Row[] = [];
    const seenIds = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
      let query = filtered();
      // Inside the caller's own bounds, so the days partition exactly the rows the whole window holds.
      if (day) query = query.gte("check_date", `${day}T00:00:00`).lt("check_date", `${addDaysIso(day, 1)}T00:00:00`);
      // Secondary sort on the unique `id` makes the order within one timestamp deterministic.
      query = query.order("check_date", { ascending: true }).order("id", { ascending: true }).limit(pageSize);
      // `.gte` (NOT `.gt`) so a page boundary landing inside a group of rows that share a timestamp
      // cannot skip the rest of that group — `check_date` is NOT unique: production has 1,797
      // timestamps shared by 2+ check-ins, up to 20 rows on a single one, which disproves the
      // "never observed in production" assumption this loop used to rely on. The re-read overlap is
      // removed by the `seenIds` de-dupe below, so callers still get each row exactly once.
      if (cursor) query = query.gte("check_date", cursor);
      const { data, error } = await query;
      if (error) {
        if (isCrmSchemaMissingError(error)) return null;
        throw new Error(error.message);
      }
      const page = (data ?? []) as unknown as Row[];
      let added = 0;
      for (const row of page) {
        if (seenIds.has(row.id)) continue;
        seenIds.add(row.id);
        rows.push(row);
        added += 1;
      }
      if (page.length < pageSize) break;
      // Pathological guard: a full page whose rows were ALL already seen means more than `pageSize`
      // check-ins share one timestamp, so the `.gte` cursor cannot advance. Stop rather than loop
      // forever (max observed in production is 20 rows on one timestamp, vs a 1000-row page).
      if (added === 0) break;
      cursor = page[page.length - 1].check_date;
    }
    return rows;
  };
  // A company-wide window is probed, then read day by day when dense (see "Company-wide date-range
  // scans" above). The days are disjoint and in calendar order, each sorted by (check_date, id), so
  // joining them end to end IS the single scan's order — no re-sort, and no id can be in two days.
  const days = checkinFilterNamesPeople(options) ? null : dayScanSlices(options.dateFrom, options.dateTo);
  const sharedKey = options.reuseRecentWindow ? sharedReadKey({ excludedInList, options, pageSize, projection }) : null;
  const rows: Row[] | null = days
    ? await readWindowMaybeShared<Row>(CRM_CHECKIN_WINDOWS, sharedKey, () => readCompanyWindow<Row>({
        days,
        pageSize,
        probe: async () => {
          const { data, error } = await filtered().limit(pageSize);
          if (error) {
            if (isCrmSchemaMissingError(error)) return null;
            throw new Error(error.message);
          }
          return (data ?? []) as unknown as Row[];
        },
        scanDay: scan,
        order: compareCheckinScanOrder,
        sortDays: false,
      }))
    : await scan(null);
  return rows ?? [];
}

// ── Visits Report view (paginated table + export) ─────────────────────────────────
// The Super-Admin "raw CRM visits" browser and its export. Relocated verbatim from
// visits-report/service.ts; behavior unchanged.

const MAX_EXPORT_ROWS = 20000;

/**
 * Columns getVisitsReportData / getVisitsReportExportRows actually need — kept in sync with
 * mapVisitRow below. Excludes raw_payload, synced_at, and updated_at, which together are the
 * majority of each row's byte size (raw_payload alone averages ~62% of a row) and are never read
 * by either caller; select("*") was pulling all of it on every paginated report/export request.
 */
const visitReportColumns =
  "id, agent_crm_id, agent_hr_id, agent_name, ampm, attendance, call_type, comment, " +
  "contact_crm_id, contact_name, crm_save_date, crm_visit_id, customer_name, double_crm_id, " +
  "double_hr_id, double_name, double2_crm_id, double2_hr_id, double2_name, " +
  "visit_date, visit_date_time, visit_type, visit_type_description";

export function mapVisitRow(row: Record<string, unknown>): VisitsReportRow {
  const crmSaveDate = (row.crm_save_date as string | null) ?? null;
  // Save-time tier only — no GPS check-in has been correlated yet; attachNearestCheckins upgrades
  // visitTime to the GPS check-in when one is matched.
  const resolved = resolveVisitTime({ nearestCheckinTime: null, crmSaveDate });
  return {
    agentCrmId: Number(row.agent_crm_id),
    agentHrId: (row.agent_hr_id as string | null) ?? null,
    agentName: (row.agent_name as string | null) ?? null,
    ampm: (row.ampm as string | null) ?? null,
    attendance: row.attendance == null ? null : Number(row.attendance),
    callType: row.call_type == null ? null : Number(row.call_type),
    comment: (row.comment as string | null) ?? null,
    contactCrmId: row.contact_crm_id == null ? null : Number(row.contact_crm_id),
    contactName: (row.contact_name as string | null) ?? null,
    crmSaveDate,
    crmVisitId: Number(row.crm_visit_id),
    customerName: (row.customer_name as string | null) ?? null,
    doubleCrmId: row.double_crm_id == null ? null : Number(row.double_crm_id),
    doubleHrId: (row.double_hr_id as string | null) ?? null,
    doubleName: (row.double_name as string | null) ?? null,
    // The chain's other person. Null on every vendor row, which carries one partner column.
    double2CrmId: row.double2_crm_id == null ? null : Number(row.double2_crm_id),
    double2HrId: (row.double2_hr_id as string | null) ?? null,
    double2Name: (row.double2_name as string | null) ?? null,
    id: row.id as string,
    nearestCheckinAddress: null,
    nearestCheckinTime: null,
    visitDate: row.visit_date as string,
    visitDateTime: (row.visit_date_time as string | null) ?? null,
    visitTime: resolved.time,
    visitTimeSource: resolved.source,
    visitType: row.visit_type == null ? null : Number(row.visit_type),
    // Resolved, never the raw vendor string. The vendor stores the literal "Unknown" for eight
    // distinct codes (-30, -21, -20, -19, -16, -7, -6, -5), so the raw column cannot tell Public
    // Holiday from Admin Work — 3,077 rows since January on production, measured 2026-09-21.
    // Resolving HERE covers getVisitsReportData and getVisitsReportExportRows from one place —
    // both re-export mapVisitRow through visits-report/service.ts — which is what keeps the screen
    // and the download reading the same word for the same row. The Visit Type FILTER is separate:
    // it selects on the numeric column via CRM_VISIT_TYPE_FILTER_CODES, precisely because the
    // stored text cannot tell these codes apart.
    visitTypeDescription: resolveVisitTypeLabel(
      row.visit_type == null ? null : Number(row.visit_type),
      (row.visit_type_description as string | null) ?? null,
      (row.comment as string | null) ?? null,
    ),
  };
}

export type { VisitTimeSource } from "@/lib/visits-report/types";
export type ResolvedVisitTime = { time: string | null; source: VisitTimeSource };

/**
 * Re-exported from crm/dates.ts, which is now its home so crm/checkin-match.ts can share the same
 * rule (reads.ts imports checkin-match.ts, so checkin-match.ts cannot import from here). Every
 * existing `import { hasRealVendorTime } from "@/lib/crm/reads"` keeps working unchanged.
 */
export { hasRealVendorTime };

/**
 * THE single authoritative "visit time" for a mirror visit row — used by every surface that shows
 * a visit's time, so no two screens disagree. iReports360 records no on-site visit time
 * (`visit_date_time` is a midnight placeholder on ~100% of rows), so the canonical waterfall is:
 *   1. the matched GPS check-in time (`nearestCheckinTime`) — closest to real on-site presence;
 *   2. else the rep's save/submission time (`crmSaveDate`), when it carries a real clock;
 *   3. else none.
 * It NEVER falls back to `visit_date_time`. The GPS tier only applies once `nearestCheckinTime`
 * has been populated by {@link attachNearestCheckins} (or an equivalent pickCheckinForVisit call);
 * callers that do not correlate check-ins simply resolve to the save-time tier.
 */
export function resolveVisitTime(row: {
  nearestCheckinTime?: string | null;
  crmSaveDate?: string | null;
}): ResolvedVisitTime {
  if (hasRealVendorTime(row.nearestCheckinTime)) return { time: row.nearestCheckinTime, source: "gps_checkin" };
  if (hasRealVendorTime(row.crmSaveDate)) return { time: row.crmSaveDate, source: "save_time" };
  return { time: null, source: "none" };
}

/** Applies the shared filter set (date range, agent, search, visit type, AM/PM, mapping
 * status) to a base ireports360_visits query — used identically by the paginated report view
 * and the unpaginated export, so the two can never silently disagree on what "matches". */
/* eslint-disable @typescript-eslint/no-explicit-any -- structural shape only, needs to accept
   Supabase's actual (much more specific) PostgrestFilterBuilder method signatures. */
type ReportFilterableQuery = {
  eq: (...args: any[]) => ReportFilterableQuery;
  gte: (...args: any[]) => ReportFilterableQuery;
  ilike: (...args: any[]) => ReportFilterableQuery;
  in: (...args: any[]) => ReportFilterableQuery;
  is: (...args: any[]) => ReportFilterableQuery;
  lte: (...args: any[]) => ReportFilterableQuery;
  not: (...args: any[]) => ReportFilterableQuery;
  or: (...args: any[]) => ReportFilterableQuery;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

function applyVisitsReportFilters(
  query: ReportFilterableQuery,
  filters: VisitsReportFilterInput & { dateFrom: string; dateTo: string },
  excludedInList: string = CRM_RESIGNED_IN_LIST,
): ReportFilterableQuery {
  let result: ReportFilterableQuery = query.gte("visit_date", filters.dateFrom).lte("visit_date", filters.dateTo);
  // Resigned/departed agents are invisible across every CRM read — the Visits Report is no exception,
  // so its totals reconcile with DV Analytics, FWC, probation, and the CRM master tab. `excludedInList`
  // is the effective (static ∪ live) list.
  if (excludedInList) result = result.not("exclusion_crm_id", "in", excludedInList);
  if (filters.agentName) result = result.eq("agent_name", filters.agentName);
  if (filters.ampm) result = result.eq("ampm", filters.ampm);
  if (filters.visitType) {
    // Filter by CODE where the label is one of the resolved names, by stored description otherwise
    // — the same two-branch rule the CRM master tab has used since it retired "Unknown"
    // (`master.ts`). The vendor writes the literal "Unknown" for eight different codes, so an
    // `.eq("visit_type_description", …)` on a resolved name matches nothing: picking "Public
    // Holiday" here returned an empty report while 156 such rows sat in the window (2026-08-27).
    const codes = CRM_VISIT_TYPE_FILTER_CODES.get(filters.visitType);
    result = codes
      ? result.in("visit_type", codes)
      : result.eq("visit_type_description", filters.visitType);
  }
  const term = filters.search?.trim();
  if (term) {
    const orExpr = ilikeAnyFilter(["agent_name", "double_name", "contact_name", "comment"], term);
    if (orExpr) result = result.or(orExpr);
  }
  if (filters.mappingStatus === "agent_unmapped") result = result.is("agent_hr_id", null);
  else if (filters.mappingStatus === "double_unmapped") result = result.is("double_hr_id", null);
  else if (filters.mappingStatus === "either_unmapped") result = result.or("agent_hr_id.is.null,double_hr_id.is.null");
  else if (filters.mappingStatus === "fully_mapped") {
    result = result.not("agent_hr_id", "is", null).or("double_crm_id.is.null,double_hr_id.not.is.null");
  }
  return result;
}

type NearestCheckinRow = {
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  contact_crm_id: number | null;
  check_date: string;
  address: string | null;
};

/**
 * Best-effort GPS check-in correlation via the shared CRM matcher (see crm/checkin-match.ts): for
 * each visit, the same-agent + same-real-contact + same-day check-in nearest `crm_save_date`. The
 * Visits Report and the CRM master tab use the SAME matcher, so a given visit resolves to the same
 * check-in in both. Never anchored on the `visit_date_time` midnight placeholder. Regular visits
 * only — Campaign/Meeting/Vacation rows carry no real contact and genuinely have no check-in.
 */
async function attachNearestCheckins(rows: VisitsReportRow[], dateFrom: string, dateTo: string): Promise<VisitsReportRow[]> {
  if (rows.length === 0) return rows;
  // `mapVisitRow` turns a NULL `agent_crm_id` into 0 (`Number(null)`), and 0 is no agent. A rep
  // hired after the CRM cutover has no CRM id, so his check-ins are found by hr id instead.
  const crmOf = (row: VisitsReportRow): number | null =>
    Number.isFinite(row.agentCrmId) && row.agentCrmId !== 0 ? row.agentCrmId : null;
  const agentIds = Array.from(new Set(rows.map(crmOf).filter((id): id is number => id != null)));
  const agentHrIds = Array.from(
    new Set(rows.filter((row) => crmOf(row) == null && row.agentHrId).map((row) => String(row.agentHrId))),
  );
  // Full keyset scan via queryCheckins — every check-in for these agents in the window, so the
  // nearest-check-in correlation is complete (no silent 20k cap).
  const checkinRows = await queryCheckins<NearestCheckinRow>({
    agentCrmOrHrIds: { crmIds: agentIds, hrIds: agentHrIds },
    dateFrom,
    dateTo,
    columns: "agent_crm_id, agent_hr_id, contact_crm_id, check_date, address",
  });

  const index = indexCheckinsByAgentContactDay(checkinRows);
  return rows.map((row) => {
    const match = pickCheckinForVisit(
      {
        agentCrmId: crmOf(row),
        agentHrId: row.agentHrId,
        contactCrmId: row.contactCrmId,
        visitDay: row.visitDate,
        crmSaveDate: row.crmSaveDate,
      },
      index,
    );
    if (!match) return row;
    // A matched GPS check-in is the real on-site time — upgrade visitTime from the save-time tier
    // to the GPS tier (a rep often logs/saves hours later, even the next morning).
    const resolved = resolveVisitTime({ nearestCheckinTime: match.check_date, crmSaveDate: row.crmSaveDate });
    return {
      ...row,
      nearestCheckinAddress: match.address,
      nearestCheckinTime: match.check_date,
      visitTime: resolved.time,
      visitTimeSource: resolved.source,
    };
  });
}

/**
 * Every distinct agent_name in [dateFrom, dateTo] — feeds the Agent filter dropdown. Paginates
 * by keyset (`id > cursor`), not a flat `.limit()`: a typical date range has far more rows than
 * any reasonable single-request cap, and a flat limit would silently sample an arbitrary subset
 * of rows rather than actually covering every distinct name (confirmed in practice — an agent
 * with 400+ visits across a 4-month range was simply absent from the dropdown because none of
 * their rows landed in the first 5000 scanned). Cardinality of distinct names is small (low
 * hundreds), so this is a bounded, one-pass scan of the row set, not the results.
 */
async function getDistinctAgentNames(dateFrom: string, dateTo: string): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const excludedInList = await getEffectiveExcludedInList();
  const names = new Set<string>();
  const pageSize = 2000;
  let cursor: string | null = null;
  for (;;) {
    let query = supabase
      .from(CRM_VISITS_UNIFIED_VIEW)
      .select("id, agent_name")
      .not("exclusion_crm_id", "in", excludedInList)
      .gte("visit_date", dateFrom)
      .lte("visit_date", dateTo)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (cursor) query = query.gt("id", cursor);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const page = (data ?? []) as Array<{ agent_name: string | null; id: string }>;
    for (const row of page) {
      if (row.agent_name) names.add(row.agent_name);
    }
    if (page.length < pageSize) break;
    cursor = page[page.length - 1].id;
  }
  return Array.from(names).sort();
}

/**
 * The Visit Type dropdown is the STATIC resolved vocabulary, not whatever the window happens to
 * hold.
 *
 * It used to be a full keyset scan of every visit in the range, building the list from the stored
 * `visit_type_description`. That offered the reader the literal "Unknown" — the vendor's one name
 * for eight different codes — as if it were a kind of visit, and it could never offer the real
 * names behind it. `CRM_VISIT_TYPE_OPTIONS` is the same list the CRM master tab shows, so the two
 * screens now agree, and the scan is gone with it.
 */
const VISITS_REPORT_TYPE_OPTIONS: string[] = [...CRM_VISIT_TYPE_OPTIONS];

export async function getVisitsReportData(
  input: VisitsReportFilterInput & { page?: number; pageSize?: number },
): Promise<VisitsReportData> {
  const today = todayIso();
  const dateFrom = input.dateFrom || addDaysIso(today, -30);
  const dateTo = input.dateTo || today;
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(500, Math.max(10, input.pageSize ?? 100));
  const configured = isIReports360Configured();

  if (!(await isCrmVisitsSchemaReady())) {
    return {
      configured,
      dateFrom,
      dateTo,
      filters: { agents: [], visitTypes: [] },
      latestSyncRuns: [],
      page,
      pageSize,
      rows: [],
      schemaReady: false,
      totalCount: 0,
    };
  }

  const supabase = getSupabaseAdmin();
  const excludedInList = await getEffectiveExcludedInList();
  const baseQuery = supabase.from(CRM_VISITS_UNIFIED_VIEW).select(visitReportColumns, { count: "exact" });
  const filteredQuery = (applyVisitsReportFilters(baseQuery as unknown as ReportFilterableQuery, { ...input, dateFrom, dateTo }, excludedInList) as unknown as typeof baseQuery)
    .order("visit_date", { ascending: false })
    .order("crm_visit_id", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);

  const [{ data, error, count }, latestSyncRuns, agents] = await Promise.all([
    filteredQuery,
    getLatestVisitsSyncRuns(10),
    getDistinctAgentNames(dateFrom, dateTo),
  ]);
  if (error) throw new Error(error.message);

  const rawRows = ((data ?? []) as unknown as Record<string, unknown>[]).map(mapVisitRow);
  const rows = await attachNearestCheckins(rawRows, dateFrom, dateTo);

  return {
    configured,
    dateFrom,
    dateTo,
    filters: { agents, visitTypes: VISITS_REPORT_TYPE_OPTIONS },
    latestSyncRuns,
    page,
    pageSize,
    rows,
    schemaReady: true,
    totalCount: count ?? rows.length,
  };
}

/** Same filter logic as getVisitsReportData but unpaginated, capped at MAX_EXPORT_ROWS —
 * never silently drops data past the cap without saying so via `truncated`. */
export async function getVisitsReportExportRows(input: VisitsReportFilterInput): Promise<VisitsReportExportResult> {
  const today = todayIso();
  const dateFrom = input.dateFrom || addDaysIso(today, -30);
  const dateTo = input.dateTo || today;

  if (!(await isCrmVisitsSchemaReady())) {
    return { rows: [], totalCount: 0, truncated: false };
  }

  const supabase = getSupabaseAdmin();
  const excludedInList = await getEffectiveExcludedInList();
  const baseQuery = supabase.from(CRM_VISITS_UNIFIED_VIEW).select(visitReportColumns, { count: "exact" });
  const filteredQuery = (applyVisitsReportFilters(baseQuery as unknown as ReportFilterableQuery, { ...input, dateFrom, dateTo }, excludedInList) as unknown as typeof baseQuery)
    .order("visit_date", { ascending: false })
    .order("crm_visit_id", { ascending: false })
    .range(0, MAX_EXPORT_ROWS - 1);

  const { data, error, count } = await filteredQuery;
  if (error) throw new Error(error.message);

  const rawRows = ((data ?? []) as unknown as Record<string, unknown>[]).map(mapVisitRow);
  const rows = await attachNearestCheckins(rawRows, dateFrom, dateTo);
  const totalCount = count ?? rows.length;

  return { rows, totalCount, truncated: totalCount > rows.length };
}

// ── Consumer-specific read primitives ─────────────────────────────────────────────
// Purpose-built reads that keep a consumer's exact query semantics (and its performance
// tuning) inside the CRM module, so no module runs its own `.from("ireports360_*")`.

/**
 * Distinct agent names in [dateFrom, dateTo], resigned/excluded agents removed — feeds the CRM
 * Integrity agent-filter dropdown. Full keyset scan (order by `id`), so it returns EVERY distinct
 * name in the window with no silent cap. Distinct-name cardinality is small (low hundreds), so this
 * is a bounded one-pass scan of the row set. Returns `[]` if the schema is missing.
 */
export async function getVisitAgentNames(dateFrom: string, dateTo: string): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const excludedInList = await getEffectiveExcludedInList();
  const names = new Set<string>();
  const pageSize = 2000;
  let cursor: string | null = null;
  for (;;) {
    let query = supabase
      .from(CRM_VISITS_UNIFIED_VIEW)
      .select("id, agent_name")
      .not("exclusion_crm_id", "in", excludedInList)
      .gte("visit_date", dateFrom)
      .lte("visit_date", dateTo)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (cursor) query = query.gt("id", cursor);
    const { data, error } = await query;
    if (error) {
      if (isCrmSchemaMissingError(error)) return [];
      throw new Error(error.message);
    }
    const page = (data ?? []) as Array<{ id: string; agent_name: string | null }>;
    for (const row of page) if (row.agent_name) names.add(row.agent_name);
    if (page.length < pageSize) break;
    cursor = page[page.length - 1].id;
  }
  return Array.from(names).sort();
}

/* eslint-disable @typescript-eslint/no-explicit-any -- structural PostgREST builder shape (see
   VisitFilterableQuery note); the paginated builder mixes filter + transform methods. */
type PagedVisitQuery = {
  eq: (...args: any[]) => PagedVisitQuery;
  order: (...args: any[]) => PagedVisitQuery;
  range: (from: number, to: number) => Promise<{ data: any; error: { message: string } | null; count: number | null }>;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * One page of visits plus the exact total match count — for table UIs (e.g. CRM Integrity) that
 * render "page N of M". Applies the shared resigned exclusion + date range, an optional exact
 * `agent_name` match, the caller's order chain, and a `.range()` window. Returns `{ rows, count }`
 * (empty + 0 when the schema is missing).
 */
export async function queryVisitsPage<T = CrmVisitRow>(options: {
  dateFrom: string;
  dateTo: string;
  agentName?: string | null;
  columns: string;
  orderBy: ReadonlyArray<{ column: string; ascending: boolean }>;
  page: number;
  pageSize: number;
}): Promise<{ rows: T[]; count: number }> {
  const supabase = getSupabaseAdmin();
  const excludedInList = await getEffectiveExcludedInList();
  const baseQuery = supabase.from(CRM_VISITS_UNIFIED_VIEW).select(options.columns, { count: "exact" });
  let query = applyVisitFilter(baseQuery as unknown as VisitFilterableQuery, {
    dateFrom: options.dateFrom,
    dateTo: options.dateTo,
  }, excludedInList) as unknown as PagedVisitQuery;
  if (options.agentName) query = query.eq("agent_name", options.agentName);
  for (const order of options.orderBy) query = query.order(order.column, { ascending: order.ascending });
  const from = (options.page - 1) * options.pageSize;
  const { data, error, count } = await query.range(from, options.page * options.pageSize - 1);
  if (error) {
    if (isCrmSchemaMissingError(error)) return { rows: [], count: 0 };
    throw new Error(error.message);
  }
  return { rows: (data ?? []) as unknown as T[], count: count ?? 0 };
}

/**
 * Shared keyset-by-`id` full scan for the two range scanners below (with / without the resigned
 * exclusion). Keyset — NOT OFFSET — pagination: each page is a small bounded
 * `.gt("id", cursor).order("id").limit(pageSize)` query, which is both REPRODUCIBLE and insert-safe.
 * This replaced an unordered `.range()` (OFFSET) scan that had two problems the FWC monthly-matrix
 * build (~90k rows) is exposed to: (1) a large OFFSET degrades and can hit the Postgres statement
 * timeout even on an index-only scan (it still walks+discards `offset` entries), and (2) with no
 * `ORDER BY`, page boundaries aren't stable, so a sync writing mid-scan can skip or duplicate rows.
 * `id` is added to the projection for the cursor even when the caller didn't ask for it (it just
 * rides along). A window of two days or more is read one day at a time and merged back into id
 * order (see "Company-wide date-range scans" above). Returns `[]` if the schema is missing.
 */
async function keysetScanVisitsForRange<T>(options: {
  dateFrom: string;
  dateTo: string;
  columns: string;
  excludedInList: string | null;
  /** The INVERSE of `excludedInList`: keep ONLY rows whose agent is one of these crm ids. For the
   * partner rescue in {@link scanVisitsForRangeCreditingPartners}; never set beside `excludedInList`. */
  onlyExcludedCrmIds?: readonly number[] | null;
  /** Keep only rows carrying a real double-visit partner ({@link REAL_DOUBLE_PARTNER_OR_FILTER}). */
  requireRealDoublePartner?: boolean;
}): Promise<T[]> {
  const supabase = getSupabaseAdmin();
  const projection = withIdColumn(options.columns);
  type Row = T & { id: string };
  const windowed = () => {
    let query = supabase.from(CRM_VISITS_UNIFIED_VIEW).select(projection);
    if (options.excludedInList) query = query.not("exclusion_crm_id", "in", options.excludedInList);
    if (options.onlyExcludedCrmIds) query = query.in("exclusion_crm_id", [...options.onlyExcludedCrmIds]);
    if (options.requireRealDoublePartner) query = query.or(REAL_DOUBLE_PARTNER_OR_FILTER);
    return query.gte("visit_date", options.dateFrom).lte("visit_date", options.dateTo);
  };
  /** One keyset scan of the window, narrowed to one `visit_date` when `day` is set. `null` when the
   * mirror schema is missing. */
  const scan = async (day: string | null): Promise<Row[] | null> => {
    const scanned: Row[] = [];
    let cursor: string | null = null;
    for (;;) {
      let query = windowed();
      if (day) query = query.eq("visit_date", day);
      query = query.order("id", { ascending: true }).limit(DEFAULT_PAGE_SIZE);
      if (cursor) query = query.gt("id", cursor);
      const { data, error } = await query;
      if (error) {
        if (isCrmSchemaMissingError(error)) return null;
        throw new Error(error.message);
      }
      const page = (data ?? []) as unknown as Row[];
      scanned.push(...page);
      if (page.length < DEFAULT_PAGE_SIZE) break;
      cursor = page[page.length - 1].id;
    }
    return scanned;
  };
  try {
    const days = dayScanSlices(options.dateFrom, options.dateTo);
    const rows: Row[] | null = days
      ? await readCompanyWindow<Row>({
          days,
          pageSize: DEFAULT_PAGE_SIZE,
          probe: async () => {
            const { data, error } = await windowed().limit(DEFAULT_PAGE_SIZE);
            if (error) {
              if (isCrmSchemaMissingError(error)) return null;
              throw new Error(error.message);
            }
            return (data ?? []) as unknown as Row[];
          },
          scanDay: scan,
          order: (a, b) => compareUuidText(a.id, b.id),
          sortDays: true,
        })
      : await scan(null);
    return (rows ?? []) as unknown as T[];
  } catch (error) {
    if (isCrmSchemaMissingError(error)) return [];
    throw error;
  }
}

/**
 * Full keyset scan of every visit in [dateFrom, dateTo], resigned/excluded agents removed. See
 * {@link keysetScanVisitsForRange} for why this is keyset (not OFFSET) — the Field Workforce
 * Compliance monthly-matrix build depends on it staying under the Postgres statement timeout.
 * Returns `[]` if the schema is missing.
 */
export async function scanVisitsForRange<T = CrmVisitRow>(options: {
  dateFrom: string;
  dateTo: string;
  columns: string;
}): Promise<T[]> {
  const excludedInList = await getEffectiveExcludedInList();
  return keysetScanVisitsForRange<T>({ ...options, excludedInList });
}

/**
 * Same full scan as {@link scanVisitsForRange}, but WITHOUT the live departed-agent exclusion.
 * That exclusion exists to hide a resigned rep's visits from company-wide/live views (dashboards,
 * the FWC monthly matrix) — but a caller that is deliberately looking up one specific person's OWN
 * visit history BECAUSE they resigned (e.g. computing a leaver's final-month CRM no-activity/leave
 * days for payroll) must never have that person's own activity hidden from them for the very reason
 * it's being asked about. Narrow, intentional carve-out — every company-wide/live read must keep
 * using {@link scanVisitsForRange}. Returns `[]` if the schema is missing.
 */
export async function scanVisitsForRangeIncludingDeparted<T = CrmVisitRow>(options: {
  dateFrom: string;
  dateTo: string;
  columns: string;
}): Promise<T[]> {
  return keysetScanVisitsForRange<T>({ ...options, excludedInList: null });
}

/**
 * {@link scanVisitsForRange} plus the DOUBLE-VISIT ROWS A DEPARTED AGENT LOGGED, with the departed
 * agent's own identity stripped so only the partner can be credited.
 *
 * WHY (owner report, 2026-10-07; measured the same day). A manager's fieldwork is recorded on the
 * REP's visit row, as `double_hr_id` — the manager logs nothing himself. The exclusion that hides a
 * resigned rep's visits from live views is keyed on `exclusion_crm_id`, which the unified view
 * defines as `agent_crm_id`: the person who LOGGED the row. So the day a rep resigned, every double
 * visit his manager did with him disappeared from the Field Workforce Compliance matrix, and the
 * manager's own working day read as "no CRM activity" — a deduction. It is RETROACTIVE: the day was
 * correct until the resignation, which then rewrote it. Measured on production: 213 manager-days
 * since June lost their only evidence this way, and 37 of them were charged — among them Salim Salim
 * Abdo Ibrahim Gomaa, deducted for 7 and 13 September, each a day he spent on 9 double visits with
 * Aml Mohamed Mohamed Eid elmashad, whose last working day was 17 September: she was still employed
 * on both days and her later resignation erased his evidence.
 *
 * WHAT IT DOES. Two scans: the normal excluded one, plus a narrow rescue of rows whose agent IS
 * excluded and which carry a real partner ({@link REAL_DOUBLE_PARTNER_OR_FILTER}). A rescued row
 * comes back with `partner_credit_only` set and its `agent_hr_id` nulled, so the departed rep gains
 * no activity of his own — the exclusion keeps doing exactly what it exists for — while the partner
 * who was genuinely in the field keeps his day. A row naming no partner is still dropped, and a
 * departed rep's solo visits stay invisible.
 *
 * A consumer that resolves a person from `agent_crm_id` (only the FWC matrix builder does) must read
 * `partner_credit_only` and skip the agent side; one that credits by hr id alone is already right.
 * Why the crm id is left intact: {@link markPartnerCreditOnlyRows}.
 *
 * Use this for any read that decides whether somebody WORKED (no-activity deductions, the
 * compliance matrix). A read that reports a rep's own numbers keeps using {@link scanVisitsForRange}.
 */
export async function scanVisitsForRangeCreditingPartners<T = CrmVisitRow>(options: {
  dateFrom: string;
  dateTo: string;
  columns: string;
}): Promise<Array<T & PartnerCreditOnlyRow>> {
  const [excludedInList, excludedCrmIds] = await Promise.all([
    getEffectiveExcludedInList(),
    getEffectiveExcludedAgentCrmIds(),
  ]);
  const visible = await keysetScanVisitsForRange<T & PartnerCreditOnlyRow>({ ...options, excludedInList });
  if (excludedCrmIds.length === 0) return visible;
  const rescued = await keysetScanVisitsForRange<T & PartnerCreditOnlyRow>({
    ...options,
    columns: withExclusionCrmIdColumn(options.columns),
    excludedInList: null,
    onlyExcludedCrmIds: excludedCrmIds,
    requireRealDoublePartner: true,
  });
  markPartnerCreditOnlyRows(rescued, excludedCrmIds);
  if (rescued.length === 0) return visible;
  // Merged back into the single scan's `id` order. Both halves are already id-ascending, and every
  // consumer's day label (`describeCrmDay`, `dayCellValue`'s first match) is documented as
  // order-dependent-but-display-only, so appending at the end would quietly change what a mixed day
  // says about itself. Keyset scans always carry `id` (withIdColumn), rescued or not.
  type Keyed = T & PartnerCreditOnlyRow & { id?: string };
  return [...visible, ...rescued].sort((a, b) =>
    compareUuidText((a as Keyed).id ?? "", (b as Keyed).id ?? ""),
  );
}

/**
 * Presence check for the probation "CRM-unmapped" badge: of the given resolved hr ids, which
 * actually appear as an `agent_hr_id` on at least one visit. Returns the distinct raw
 * `agent_hr_id` values found (callers canonicalize).
 *
 * Deliberately does NOT apply the resigned/owner-excluded filter — this asks "does the CRM feed
 * know this person at all", so an excluded-but-present agent must still count as mapped rather than
 * be mislabeled a data gap. Full keyset scan (no silent 1000-row cap): a rep with any visit is
 * mapped, so wider coverage only ever removes false "unmapped" flags, never adds them. Returns `[]`
 * if the schema is missing.
 *
 * `notAfterDate` (YYYY-MM-DD, inclusive) bounds the question to "did CRM know this person BY then".
 * Omit it for the live "is this person mapped today" reading, which is what a badge wants. A caller
 * deciding something about a CLOSED period must pass the end of that period, otherwise onboarding
 * somebody months later silently rewrites the past: the DSM no-record connector skips a manager
 * whose team is not fully mapped, so an unbounded check would make an old month become chargeable
 * the moment the missing rep is finally coded onto CRM — retroactively billing the manager for
 * exactly the gap that had protected them.
 */
export async function getMappedAgentHrIds(
  hrIds: readonly string[],
  options: { notAfterDate?: string } = {},
): Promise<string[]> {
  if (hrIds.length === 0) return [];
  const supabase = getSupabaseAdmin();
  const present = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    let query = supabase
      .from(CRM_VISITS_UNIFIED_VIEW)
      .select("id, agent_hr_id")
      .in("agent_hr_id", expandHrIdFilterValues(hrIds))
      .order("id", { ascending: true })
      .limit(DEFAULT_PAGE_SIZE);
    if (options.notAfterDate) query = query.lte("visit_date", options.notAfterDate);
    if (cursor) query = query.gt("id", cursor);
    const { data, error } = await query;
    if (error) {
      if (isCrmSchemaMissingError(error)) return [];
      throw new Error(error.message);
    }
    const page = (data ?? []) as Array<{ id: string; agent_hr_id: string | null }>;
    for (const row of page) {
      if (row.agent_hr_id) present.add(row.agent_hr_id);
    }
    if (page.length < DEFAULT_PAGE_SIZE) break;
    cursor = page[page.length - 1].id;
  }
  return Array.from(present);
}

/** The `(hr id, crm id)` pairs a mirror row carries, both sides of a double visit. */
export type CrmAgentIdentityRow = {
  agent_hr_id: string | null;
  agent_crm_id: string | null;
  double_hr_id: string | null;
  double_crm_id: string | null;
};

/** Cap for one identity lookup. Generous: a single rep's own history runs to a
 * few thousand rows, and the read is bounded to a handful of hr ids. */
const IDENTITY_ROW_LIMIT = 2000;

/**
 * The identity pairs the feed itself carries for these hr ids, newest first, read
 * from visits strictly BEFORE `beforeDate`. Callers interpret the pairs — this
 * returns rows, not a verdict.
 *
 * Answers "what crm id did iReports360 know this person by", which is recoverable
 * from history even when the employee record no longer says: on resignation the CRM
 * account is deactivated and `employees.crm_id` is cleared, while the mirror keeps
 * every row that person ever generated.
 *
 * Deliberately WITHOUT the departed-agent exclusion, for the same reason as
 * {@link scanVisitsForRangeIncludingDeparted}: every caller asks this about somebody
 * BECAUSE they resigned, so applying the exclusion would hide precisely the person
 * being looked up. Safe as a carve-out because it reads history only, and only
 * identity columns — never the period under judgement, and never anything that could
 * add a departed agent's activity to a coverage, scoring, or reporting read.
 *
 * Queries `agent_hr_id` and `double_hr_id` separately rather than as one `.or()`:
 * a district manager appears on the mirror as the double and never as the agent, so
 * an agent-only filter leaves every manager unrecoverable — and a hand-built `.or()`
 * string is the shape that silently returns nothing instead of erroring. Both legs
 * expand mixed-case hr ids ({@link expandHrIdFilterValues}), without which a plain
 * `.in` under-returns. Returns `[]` if the mirror schema is missing.
 */
export async function getAgentCrmIdentityRows(
  hrIds: readonly string[],
  options: { beforeDate?: string; limit?: number } = {},
): Promise<CrmAgentIdentityRow[]> {
  if (hrIds.length === 0) return [];
  const supabase = getSupabaseAdmin();
  const filterValues = expandHrIdFilterValues(hrIds);
  const limit = options.limit ?? IDENTITY_ROW_LIMIT;
  const rows: CrmAgentIdentityRow[] = [];
  for (const column of ["agent_hr_id", "double_hr_id"] as const) {
    let query = supabase
      .from(CRM_VISITS_TABLE)
      .select("agent_hr_id, agent_crm_id, double_hr_id, double_crm_id")
      .in(column, filterValues);
    if (options.beforeDate) query = query.lt("visit_date", options.beforeDate);
    const { data, error } = await query.order("visit_date", { ascending: false }).limit(limit);
    if (error) {
      if (isCrmSchemaMissingError(error)) return [];
      throw new Error(error.message);
    }
    rows.push(...((data ?? []) as unknown as CrmAgentIdentityRow[]));
  }
  return rows;
}

/** How many visits iReports360 holds on a contact, and the last one's date. */
export type CrmContactVisitHistory = {
  visits: number;
  lastVisitedOn: string | null;
  /**
   * The days of its visits on or after `daysSince`, newest first — present only when the caller asked
   * for them (Phoenix CRM's planner reads the weekdays a customer is usually seen on). Absent otherwise,
   * so the List's answer, which goes to the phone whole, carries no more than it always did.
   */
  days?: string[];
};

/**
 * 🔴 WHAT A REP HAS ALREADY DONE WITH A DOCTOR, per contact (owner, 2026-09-30, reading Phoenix CRM's
 * List): "the phrase 'no visits saved here yet' is totally wrong — of course this rep visited this
 * doctor on iReports360 before. Either you grab the visit history or remove the line."
 *
 * A carried-over customer has NO Phoenix visits by definition — his Phoenix history starts at
 * validation — so the List was reporting a count that could only ever read "never", directly under a
 * line naming last week's visit. This is the number that makes that row true.
 *
 * IT LIVES HERE BECAUSE THIS IS THE DOOR. `crm-single-source.test.ts` keeps every visits-mirror read
 * inside `reads.ts` or a short list of visits machinery, and its caller (`shared-customers.ts`) is
 * neither — putting the query there and allow-listing the file would have widened the strict list to
 * make a red test green, which is the shape the guard exists to catch.
 *
 * 🔴 NOT the check-ins. A GPS check-in is a PARTIAL feed — some real visits carry none — so counting
 * those would understate a rep's work, and the standing rule is never to score a rep on them.
 *
 * `daysSince` (owner, 2026-10-02 — Phoenix CRM's planner): the SAME read also hands back each
 * contact's visit days on or after that day, so the planner learns which weekdays a customer not
 * validated yet is usually seen on without a second trip to the mirror. Nothing else changes: the
 * count and the last day are the ones the List has always shown.
 *
 * 🔴 iREPORTS360 ROWS ONLY (`source = 'ireports360'`). Since 2026-10-02 the unified view also carries a
 * started Phoenix CRM team's own visits (src/lib/crm/phoenix-team-starts.ts), and those are the very
 * visits the List already counts as "saved here" — reading them as iReports360 history too would count
 * every one of them twice on the rep's own screen.
 */
export async function readContactVisitHistory(
  contactCrmIds: readonly number[],
  options: { daysSince?: string } = {},
): Promise<Map<number, CrmContactVisitHistory>> {
  const daysSince = options.daysSince ?? null;
  const ids = [...new Set(contactCrmIds)].filter((id) => Number.isFinite(id));
  if (ids.length === 0) return new Map<number, CrmContactVisitHistory>();
  // 🔴 COUNTED IN THE DATABASE, ONE ROW PER CONTACT (2026-10-16 Phoenix CRM performance audit). The
  // List and the planner need one count, one date and one list of days per contact, and this used to
  // carry every visit of every contact to the app — 50 contacts a request, a page of 1,000 at a time by
  // OFFSET over the union view, which rebuilt every earlier page for each new one. The function runs the
  // same filter over the same view (iReports360 rows only) and the fold below in SQL; until it is
  // applied here, the page walk answers exactly as before.
  try {
    return await readContactVisitHistoryCounted(ids, daysSince);
  } catch (error) {
    if (!isMissingCrmRpcError(error)) {
      // A missing mirror costs this one line, as it always did.
      if (isCrmSchemaMissingError(error)) return new Map<number, CrmContactVisitHistory>();
      throw toQueryError(error);
    }
  }
  return readContactVisitHistoryPaged(ids, daysSince);
}

/** Server-side count over the visits door's iReports360 rows (…20261016180202). */
const CRM_CONTACT_VISIT_HISTORY_RPC = "phx_crm_contact_visit_history";

/**
 * Contacts per call. One row per contact comes back, so 500 stays well under PostgREST's 1,000-row cap
 * and the ids travel in the request body, never the URL.
 */
const CONTACT_HISTORY_RPC_CHUNK = 500;

async function readContactVisitHistoryCounted(ids: readonly number[], daysSince: string | null): Promise<Map<number, CrmContactVisitHistory>> {
  const supabase = getSupabaseAdmin();
  type CountedRow = { contact_crm_id: number | string | null; visits: number | string | null; last_visited_on: string | null; days: string[] | null };
  const chunks = Array.from({ length: Math.ceil(ids.length / CONTACT_HISTORY_RPC_CHUNK) }, (_unused, index) =>
    ids.slice(index * CONTACT_HISTORY_RPC_CHUNK, (index + 1) * CONTACT_HISTORY_RPC_CHUNK),
  );
  const answers = await mapWithConcurrency(chunks, 4, async (chunk) => {
    const { data, error } = await supabase.rpc(CRM_CONTACT_VISIT_HISTORY_RPC, { p_contact_crm_ids: chunk, p_days_since: daysSince });
    if (error) throw error;
    return (data ?? []) as CountedRow[];
  });
  const byContact = new Map<number, CrmContactVisitHistory>();
  for (const rows of answers) {
    for (const row of rows) {
      if (row.contact_crm_id == null) continue;
      // The same object, in the same key order, the page walk builds: `days` only when asked for and found.
      const found: CrmContactVisitHistory = { lastVisitedOn: row.last_visited_on, visits: Number(row.visits ?? 0) };
      if (daysSince !== null && Array.isArray(row.days) && row.days.length > 0) found.days = row.days;
      byContact.set(Number(row.contact_crm_id), found);
    }
  }
  return byContact;
}

/** The page walk the count replaced — kept for a database the function has not reached yet. */
async function readContactVisitHistoryPaged(ids: readonly number[], daysSince: string | null): Promise<Map<number, CrmContactVisitHistory>> {
  const byContact = new Map<number, CrmContactVisitHistory>();
  const supabase = getSupabaseAdmin();
  const CHUNK = 50;
  const PAGE = 1000;
  // Chunks read at once — the Reps List's own figure.
  const CHUNK_CONCURRENCY = 4;
  type HistoryRow = { contact_crm_id: number | null; visit_date: string | null };
  // One chunk's pages, in order; a failed page hands back the pages before it WITH its error.
  const readChunk = async (chunk: number[]): Promise<{ error: { message: string } | null; rows: HistoryRow[] }> => {
    const rows: HistoryRow[] = [];
    for (let page = 0; ; page += 1) {
      const { data, error } = await supabase
        .from(CRM_VISITS_UNIFIED_VIEW)
        .select("contact_crm_id, visit_date")
        .eq("source", IREPORTS360_VISIT_SOURCE)
        .in("contact_crm_id", chunk)
        .order("visit_date", { ascending: false })
        .range(page * PAGE, page * PAGE + PAGE - 1);
      if (error) return { error, rows };
      const pageRows = (data ?? []) as HistoryRow[];
      rows.push(...pageRows);
      if (pageRows.length < PAGE) return { error: null, rows };
    }
  };
  // 🔴 A FEW CHUNKS AT ONCE, FOLDED IN CHUNK ORDER (2026-10-01, "slow to transfer between page and
  // page", Phoenix CRM first). Every page of every chunk used to wait on the one before it, before the
  // List could paint; folded in order once they are in, the counts and dates are the ones the serial
  // loop gave, and the first failure ends the read exactly where it ended before.
  const chunks = Array.from({ length: Math.ceil(ids.length / CHUNK) }, (_unused, index) => ids.slice(index * CHUNK, (index + 1) * CHUNK));
  const answers = await mapWithConcurrency(chunks, CHUNK_CONCURRENCY, readChunk);
  for (const { error, rows } of answers) {
    for (const row of rows) {
      if (row.contact_crm_id == null) continue;
      let found = byContact.get(row.contact_crm_id);
      // Ordered newest first, so the first date seen for a contact is the latest one.
      if (found) {
        found.visits += 1;
        found.lastVisitedOn ??= row.visit_date;
      } else {
        found = { lastVisitedOn: row.visit_date, visits: 1 };
        byContact.set(row.contact_crm_id, found);
      }
      if (daysSince !== null && row.visit_date && row.visit_date >= daysSince) (found.days ??= []).push(row.visit_date);
    }
    if (error) {
      // A missing mirror costs this one line. It must never fall back to the Phoenix count, which
      // is the wrong number for exactly the rows that ask for this.
      if (isCrmSchemaMissingError(error)) return byContact;
      throw new Error(error.message);
    }
  }
  return byContact;
}
