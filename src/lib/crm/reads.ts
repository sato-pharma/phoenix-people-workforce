/**
 * The single read API for CRM (iReports360) mirror data. Every module that needs visit or
 * check-in data calls these functions instead of running its own `.from("ireports360_*")`
 * query — that is the "one door" contract the CRM module enforces.
 *
 * Rows come back carrying the sync-time-resolved `agent_hr_id` / `double_hr_id`; callers map
 * them to their own domain shapes. Reads that project a subset of columns pass their own row
 * type as the generic (the `CrmVisitRow` / `CrmCheckinRow` defaults describe a `select("*")`).
 */

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getEmployeeDirectoryRows, isActiveLifecycleStatus } from "@/lib/employees/employee-directory";
import { indexCheckinsByAgentContactDay, pickCheckinForVisit } from "@/lib/crm/checkin-match";
import { CRM_CHECKINS_TABLE, CRM_VISITS_TABLE } from "@/lib/crm/tables";
import { isCrmSchemaMissingError, isCrmVisitsSchemaReady } from "@/lib/crm/schema";
import { getLatestVisitsSyncRuns } from "@/lib/crm/admin";
import { isIReports360Configured } from "@/lib/crm/config";
import { addDaysIso, hasRealVendorTime, todayIso } from "@/lib/crm/dates";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import type { CrmCheckinRow, CrmVisitRow } from "@/lib/crm/types";
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

/** Pure predicate: is this row a real double visit (a genuine partner on a fieldwork type)? */
export function isCrmDoubleVisitRow(row: {
  double_crm_id: number | null | undefined;
  visit_type: number | null | undefined;
}): boolean {
  return (
    row.double_crm_id != null &&
    row.double_crm_id !== 0 &&
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
  832, 851, 1024, 1035, 1071, 1102, 1134, 1146, 1148, 1152, 1156, 1158, 1159, 1163, 1166, 1221,
  1222, 1236, 1246, 1247, 1249, 1272, 1280, 1284, 1286, 1288, 1295, 1303, 1304, 1330, 1345, 1351,
  1354, 1357, 1367, 1368, 1369, 1370, 1371, 1372, 1373, 1374, 1376, 1377, 1378, 1381, 1382, 1389,
  1395, 1396, 1402, 1407, 1409, 1437, 1476, 1478, 1486, 1492, 1493, 1504, 1508, 1510, 1511,
  1512, 1514, 1515, 1516, 1518, 1519, 1521, 1522, 1523, 1524, 1528,
  // Owner-excluded 2026-07-17 (not necessarily resigned): Ahmed Amer 667, Adel.Sayed 1436,
  // CEO 1474, George.Rafaat (Sharkia 1/C) 1500. (Mahmoud.Gamal 1272 already listed above.)
  667, 1436, 1474, 1500,
  // 2026-07-18: crm_id 1477 REMOVED — it is a reused CRM agent slot now resolving to ACTIVE
  // employee B-164 (Nasr City / P); keeping it here was hiding an active rep's data. The live
  // status union will not re-hide an active employee.
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
const EXCLUDED_AGENTS_TTL_MS = 5 * 60_000;
type EffectiveExclusion = { ids: number[]; inList: string };
let excludedAgentsCache: (EffectiveExclusion & { at: number }) | null = null;
let excludedAgentsInFlight: Promise<EffectiveExclusion> | null = null;

/**
 * Distinct agent_crm_ids in the visits mirror whose sync-resolved `agent_hr_id` belongs to one of
 * `departedHrIds`. Visits alone are complete — every departed agent that has check-ins also has
 * visits (verified against production), so the check-ins table need not be scanned. Raw keyset scan
 * that deliberately does NOT apply the resigned exclusion (it is computing part of it).
 */
async function scanDepartedAgentCrmIds(departedHrIds: readonly string[]): Promise<number[]> {
  const keys = expandHrIdFilterValues(departedHrIds);
  if (keys.length === 0) return [];
  const supabase = getSupabaseAdmin();
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
    for (const row of page) if (row.agent_crm_id != null) ids.add(Number(row.agent_crm_id));
    if (page.length < pageSize) break;
    cursor = page[page.length - 1].id;
  }
  return Array.from(ids);
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
    if (departedHrIds.length > 0) liveIds = await scanDepartedAgentCrmIds(departedHrIds);
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
  /** Restrict to these resolved agent hr ids (`agent_hr_id IN`). Empty array → no rows. Matched
   * CASE-INSENSITIVELY — the door sprays every casing/alias variant (`expandHrIdFilterValues`), so
   * pass ids in any casing and do NOT pre-expand. */
  agentHrIds?: readonly string[];
  /** Case-insensitive exact match on a single resolved agent hr id (`agent_hr_id ILIKE`). For
   * per-employee reads (e.g. probation SFE evidence) where the caller's hr-id casing may differ
   * from the mirror's stored casing. Combine with a date range, not with `agentHrIds`. */
  agentHrIdILike?: string;
  /** Restrict to these resolved DOUBLE-visitor hr ids (`double_hr_id IN`). Empty array → no rows.
   * Matched case-insensitively (see `agentHrIds`). For "double visits conducted by this manager"
   * reads (e.g. Employee 360 leadership activity). */
  doubleHrIds?: readonly string[];
  /** Restrict to these visit types (`visit_type IN`). */
  visitTypes?: readonly number[];
  /** Keep only rows with a real double partner (`double_crm_id` present and ≠ 0). */
  doubleOnly?: boolean;
  /** Require a resolved `agent_hr_id` (NOT NULL). */
  requireAgentHrId?: boolean;
  /** Require a resolved `double_hr_id` (NOT NULL). */
  requireDoubleHrId?: boolean;
};

/* eslint-disable @typescript-eslint/no-explicit-any -- structural PostgREST builder shape; the
   real type is too deep to thread through a helper (see visits-report/service.ts precedent). */
type VisitFilterableQuery = {
  eq: (...args: any[]) => VisitFilterableQuery;
  gte: (...args: any[]) => VisitFilterableQuery;
  lte: (...args: any[]) => VisitFilterableQuery;
  ilike: (...args: any[]) => VisitFilterableQuery;
  in: (...args: any[]) => VisitFilterableQuery;
  is: (...args: any[]) => VisitFilterableQuery;
  neq: (...args: any[]) => VisitFilterableQuery;
  not: (...args: any[]) => VisitFilterableQuery;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

function applyVisitFilter(
  query: VisitFilterableQuery,
  filter: CrmVisitFilter,
  excludedInList: string = CRM_RESIGNED_IN_LIST,
): VisitFilterableQuery {
  let result = query;
  // Resigned/departed agents are invisible across every CRM read (single source). `excludedInList`
  // is the effective (static ∪ live) list; it defaults to the static safety-net for any caller that
  // has not resolved the live set.
  if (excludedInList) result = result.not("agent_crm_id", "in", excludedInList);
  if (filter.dateFrom) result = result.gte("visit_date", filter.dateFrom);
  if (filter.dateTo) result = result.lte("visit_date", filter.dateTo);
  if (filter.agentHrIds && filter.agentHrIds.length > 0) result = result.in("agent_hr_id", expandHrIdFilterValues(filter.agentHrIds));
  if (filter.agentHrIdILike) result = result.ilike("agent_hr_id", filter.agentHrIdILike);
  if (filter.doubleHrIds && filter.doubleHrIds.length > 0) result = result.in("double_hr_id", expandHrIdFilterValues(filter.doubleHrIds));
  if (filter.visitTypes && filter.visitTypes.length > 0) result = result.in("visit_type", [...filter.visitTypes]);
  if (filter.doubleOnly) result = result.not("double_crm_id", "is", null).neq("double_crm_id", 0);
  if (filter.requireAgentHrId) result = result.not("agent_hr_id", "is", null);
  if (filter.requireDoubleHrId) result = result.not("double_hr_id", "is", null);
  return result;
}

/** Ensure the `id` column is present in a projection (needed for keyset pagination). */
export function withIdColumn(columns: string): string {
  if (columns.trim() === "*") return columns;
  const parts = columns.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.includes("id") ? parts.join(", ") : ["id", ...parts].join(", ");
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
    /** Opt-in: collapse iReports360 burst-duplicate double-visit submissions (the same read-time
     * dedup {@link getDoubleVisitRows} applies — see {@link collapseDuplicateVisitSubmissions}).
     * Off by default so raw-mirror browsers are unaffected. When on, the duplicate-detection columns
     * are added to the projection automatically and single-agent visits pass through unchanged, so a
     * caller that SUMS/COUNTS visit rows gets the deduplicated total without re-deriving the dedup. */
    collapseDoubleVisits?: boolean;
  },
): Promise<T[]> {
  if (options.agentHrIds && options.agentHrIds.length === 0) return [];
  if (options.doubleHrIds && options.doubleHrIds.length === 0) return [];
  const supabase = getSupabaseAdmin();
  const excludedInList = options.includeResignedAgents ? "" : await getEffectiveExcludedInList();
  // When collapsing, widen the projection so the duplicate-detection fingerprint columns are present
  // even if the caller only asked for a subset (otherwise the collapse silently no-ops).
  const requestedColumns = options.collapseDoubleVisits ? withDuplicateDetectionColumns(options.columns ?? "*") : options.columns;
  const projection = withIdColumn(requestedColumns ?? "*");
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const rows: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    let query = supabase.from(CRM_VISITS_TABLE).select(projection);
    query = applyVisitFilter(query as unknown as VisitFilterableQuery, options, excludedInList) as unknown as typeof query;
    query = query.order("id", { ascending: true }).limit(pageSize);
    if (cursor) query = query.gt("id", cursor);
    const { data, error } = await query;
    if (error) {
      if (isCrmSchemaMissingError(error)) return [];
      throw new Error(error.message);
    }
    const page = (data ?? []) as unknown as Array<T & { id: string }>;
    rows.push(...page);
    if (page.length < pageSize) break;
    cursor = page[page.length - 1].id;
  }
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
  if (options.agentHrIds && options.agentHrIds.length === 0) return [];
  if (options.doubleHrIds && options.doubleHrIds.length === 0) return [];
  const supabase = getSupabaseAdmin();
  const excludedInList = await getEffectiveExcludedInList();
  // See queryVisits: widen the projection so the collapse fingerprint columns are present.
  const limitedColumns = options.collapseDoubleVisits ? (withDuplicateDetectionColumns(options.columns ?? "*") ?? "*") : (options.columns ?? "*");
  let query = supabase.from(CRM_VISITS_TABLE).select(limitedColumns);
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
 * Full scan of double-visit rows (real partner on a fieldwork visit type). The canonical
 * double-visit predicate shared by Double-Visit Analytics, probation DV, the portal, and
 * probation feedback — so those consumers can never disagree about what counts as a double
 * visit. `visitTypes` defaults to {@link CRM_DOUBLE_VISIT_TYPE_CODES}.
 *
 * Also the single point every one of those consumers gets duplicate collapse for free: results
 * run through {@link collapseDuplicateVisitSubmissions} before returning, so a rep re-saving the
 * same contact-day stop counts once here everywhere this door is used, instead of each consumer
 * re-deriving its own dedup rule.
 */
export async function getDoubleVisitRows<T = CrmVisitRow>(
  options: Omit<CrmVisitFilter, "doubleOnly"> & { columns?: string; includeResignedAgents?: boolean; pageSize?: number },
): Promise<T[]> {
  const rows = await queryVisits<T & DuplicateVisitDetectionRow>({
    ...options,
    columns: withDuplicateDetectionColumns(options.columns),
    doubleOnly: true,
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
  /** Inclusive `check_date` lower bound as a date (YYYY-MM-DD); expanded to `T00:00:00`. */
  dateFrom?: string;
  /** Inclusive `check_date` upper bound as a date (YYYY-MM-DD); expanded to `T23:59:59`. */
  dateTo?: string;
};

/* eslint-disable @typescript-eslint/no-explicit-any -- see VisitFilterableQuery note. */
type CheckinFilterableQuery = {
  gte: (...args: any[]) => CheckinFilterableQuery;
  lte: (...args: any[]) => CheckinFilterableQuery;
  ilike: (...args: any[]) => CheckinFilterableQuery;
  in: (...args: any[]) => CheckinFilterableQuery;
  not: (...args: any[]) => CheckinFilterableQuery;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

function applyCheckinFilter(
  query: CheckinFilterableQuery,
  filter: CrmCheckinFilter,
  excludedInList: string = CRM_RESIGNED_IN_LIST,
): CheckinFilterableQuery {
  let result = query;
  // Resigned/departed agents are invisible across every CRM read (single source). See applyVisitFilter.
  if (excludedInList) result = result.not("agent_crm_id", "in", excludedInList);
  if (filter.agentCrmIds && filter.agentCrmIds.length > 0) result = result.in("agent_crm_id", [...filter.agentCrmIds]);
  if (filter.agentHrIds && filter.agentHrIds.length > 0) result = result.in("agent_hr_id", expandHrIdFilterValues(filter.agentHrIds));
  if (filter.agentHrIdILike) result = result.ilike("agent_hr_id", filter.agentHrIdILike);
  if (filter.dateFrom) result = result.gte("check_date", `${filter.dateFrom}T00:00:00`);
  if (filter.dateTo) result = result.lte("check_date", `${filter.dateTo}T23:59:59`);
  return result;
}

/**
 * Reads `ireports360_checkins` rows matching `filter`.
 *
 * - With an explicit `limit`: a single ordered, bounded fetch (e.g. "nearest few check-ins").
 * - Without `limit`: a full-coverage scan, keyset-paginated by `check_date`. `check_date` (not
 *   the random uuid `id`) is part of the `(agent_crm_id, check_date)` composite index this table
 *   has, so ordering by it keeps each page an index range-scan rather than a full sort — 130ms
 *   vs 12.8s on a real 30-day/112-agent production query. `check_date` is NOT unique, so the
 *   cursor is `.gte` + an id de-dupe rather than `.gt`: this docstring previously claimed
 *   duplicate timestamps were "never observed in production", but production actually has 1,797
 *   timestamps shared by 2+ rows (up to 20 on one), so a `.gt()` cursor landing mid-group silently
 *   dropped the remainder — which then reads downstream as "this visit has no check-in".
 *
 * Returns `[]` (never throws) when the mirror schema is missing.
 */
export async function queryCheckins<T = CrmCheckinRow>(
  options: CrmCheckinFilter & { columns?: string; orderBy?: string; ascending?: boolean; limit?: number; pageSize?: number },
): Promise<T[]> {
  if (options.agentCrmIds && options.agentCrmIds.length === 0) return [];
  if (options.agentHrIds && options.agentHrIds.length === 0) return [];
  const supabase = getSupabaseAdmin();
  const excludedInList = await getEffectiveExcludedInList();

  if (options.limit != null) {
    let query = supabase.from(CRM_CHECKINS_TABLE).select(options.columns ?? "*");
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
  const rows: T[] = [];
  const seenIds = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    let query = supabase.from(CRM_CHECKINS_TABLE).select(projection);
    query = applyCheckinFilter(query as unknown as CheckinFilterableQuery, options, excludedInList) as unknown as typeof query;
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
      if (isCrmSchemaMissingError(error)) return [];
      throw new Error(error.message);
    }
    const page = (data ?? []) as unknown as Array<T & { check_date: string; id: string }>;
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
  "double_hr_id, double_name, visit_date, visit_date_time, visit_type, visit_type_description";

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
    id: row.id as string,
    nearestCheckinAddress: null,
    nearestCheckinTime: null,
    visitDate: row.visit_date as string,
    visitDateTime: (row.visit_date_time as string | null) ?? null,
    visitTime: resolved.time,
    visitTimeSource: resolved.source,
    visitType: row.visit_type == null ? null : Number(row.visit_type),
    visitTypeDescription: (row.visit_type_description as string | null) ?? null,
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
  if (excludedInList) result = result.not("agent_crm_id", "in", excludedInList);
  if (filters.agentName) result = result.eq("agent_name", filters.agentName);
  if (filters.ampm) result = result.eq("ampm", filters.ampm);
  if (filters.visitType) result = result.eq("visit_type_description", filters.visitType);
  const term = filters.search?.trim();
  if (term) {
    const escaped = term.replace(/[%,()]/g, " ").trim();
    if (escaped) {
      result = result.or(
        `agent_name.ilike.%${escaped}%,double_name.ilike.%${escaped}%,contact_name.ilike.%${escaped}%,comment.ilike.%${escaped}%`,
      );
    }
  }
  if (filters.mappingStatus === "agent_unmapped") result = result.is("agent_hr_id", null);
  else if (filters.mappingStatus === "double_unmapped") result = result.is("double_hr_id", null);
  else if (filters.mappingStatus === "either_unmapped") result = result.or("agent_hr_id.is.null,double_hr_id.is.null");
  else if (filters.mappingStatus === "fully_mapped") {
    result = result.not("agent_hr_id", "is", null).or("double_crm_id.is.null,double_hr_id.not.is.null");
  }
  return result;
}

type NearestCheckinRow = { agent_crm_id: number | null; contact_crm_id: number | null; check_date: string; address: string | null };

/**
 * Best-effort GPS check-in correlation via the shared CRM matcher (see crm/checkin-match.ts): for
 * each visit, the same-agent + same-real-contact + same-day check-in nearest `crm_save_date`. The
 * Visits Report and the CRM master tab use the SAME matcher, so a given visit resolves to the same
 * check-in in both. Never anchored on the `visit_date_time` midnight placeholder. Regular visits
 * only — Campaign/Meeting/Vacation rows carry no real contact and genuinely have no check-in.
 */
async function attachNearestCheckins(rows: VisitsReportRow[], dateFrom: string, dateTo: string): Promise<VisitsReportRow[]> {
  if (rows.length === 0) return rows;
  const agentIds = Array.from(new Set(rows.map((row) => row.agentCrmId)));
  // Full keyset scan via queryCheckins — every check-in for these agents in the window, so the
  // nearest-check-in correlation is complete (no silent 20k cap).
  const checkinRows = await queryCheckins<NearestCheckinRow>({
    agentCrmIds: agentIds,
    dateFrom,
    dateTo,
    columns: "agent_crm_id, contact_crm_id, check_date, address",
  });

  const index = indexCheckinsByAgentContactDay(checkinRows);
  return rows.map((row) => {
    const match = pickCheckinForVisit(
      { agentCrmId: row.agentCrmId, contactCrmId: row.contactCrmId, visitDay: row.visitDate, crmSaveDate: row.crmSaveDate },
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
      .from(CRM_VISITS_TABLE)
      .select("id, agent_name")
      .not("agent_crm_id", "in", excludedInList)
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

async function getDistinctVisitTypes(dateFrom: string, dateTo: string): Promise<string[]> {
  // Full keyset scan (order by `id`) — every distinct visit-type label in the window, GUARANTEED
  // complete (no silent cap). Distinct cardinality is tiny (~10), so this is a bounded one-pass scan.
  const supabase = getSupabaseAdmin();
  const excludedInList = await getEffectiveExcludedInList();
  const types = new Set<string>();
  const pageSize = 2000;
  let cursor: string | null = null;
  for (;;) {
    let query = supabase
      .from(CRM_VISITS_TABLE)
      .select("id, visit_type_description")
      .not("agent_crm_id", "in", excludedInList)
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
    const page = (data ?? []) as Array<{ id: string; visit_type_description: string | null }>;
    for (const row of page) if (row.visit_type_description) types.add(row.visit_type_description);
    if (page.length < pageSize) break;
    cursor = page[page.length - 1].id;
  }
  return Array.from(types).sort();
}

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
  const baseQuery = supabase.from(CRM_VISITS_TABLE).select(visitReportColumns, { count: "exact" });
  const filteredQuery = (applyVisitsReportFilters(baseQuery as unknown as ReportFilterableQuery, { ...input, dateFrom, dateTo }, excludedInList) as unknown as typeof baseQuery)
    .order("visit_date", { ascending: false })
    .order("crm_visit_id", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);

  const [{ data, error, count }, latestSyncRuns, agents, visitTypes] = await Promise.all([
    filteredQuery,
    getLatestVisitsSyncRuns(10),
    getDistinctAgentNames(dateFrom, dateTo),
    getDistinctVisitTypes(dateFrom, dateTo),
  ]);
  if (error) throw new Error(error.message);

  const rawRows = ((data ?? []) as unknown as Record<string, unknown>[]).map(mapVisitRow);
  const rows = await attachNearestCheckins(rawRows, dateFrom, dateTo);

  return {
    configured,
    dateFrom,
    dateTo,
    filters: { agents, visitTypes },
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
  const baseQuery = supabase.from(CRM_VISITS_TABLE).select(visitReportColumns, { count: "exact" });
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
      .from(CRM_VISITS_TABLE)
      .select("id, agent_name")
      .not("agent_crm_id", "in", excludedInList)
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
  const baseQuery = supabase.from(CRM_VISITS_TABLE).select(options.columns, { count: "exact" });
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
 * rides along). Returns `[]` if the schema is missing.
 */
async function keysetScanVisitsForRange<T>(options: {
  dateFrom: string;
  dateTo: string;
  columns: string;
  excludedInList: string | null;
}): Promise<T[]> {
  const supabase = getSupabaseAdmin();
  const projection = withIdColumn(options.columns);
  const rows: T[] = [];
  let cursor: string | null = null;
  try {
    for (;;) {
      let query = supabase.from(CRM_VISITS_TABLE).select(projection);
      if (options.excludedInList) query = query.not("agent_crm_id", "in", options.excludedInList);
      query = query
        .gte("visit_date", options.dateFrom)
        .lte("visit_date", options.dateTo)
        .order("id", { ascending: true })
        .limit(DEFAULT_PAGE_SIZE);
      if (cursor) query = query.gt("id", cursor);
      const { data, error } = await query;
      if (error) {
        if (isCrmSchemaMissingError(error)) return [];
        throw new Error(error.message);
      }
      const page = (data ?? []) as unknown as Array<T & { id: string }>;
      rows.push(...page);
      if (page.length < DEFAULT_PAGE_SIZE) break;
      cursor = page[page.length - 1].id;
    }
    return rows;
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
      .from(CRM_VISITS_TABLE)
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
