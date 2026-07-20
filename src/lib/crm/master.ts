/**
 * CRM Master Data — the raw, exact mirror of iReports360 as pulled into Phoenix.
 *
 * Powers the CRM tab's "master table": every VISIT and every CHECK-IN the CRM sync stored,
 * with ALL columns and each record's full `raw_payload` (every field the CRM returned, even
 * ones without a dedicated column). This is the most literal "look at the actual CRM" view.
 *
 * Read-only and inside the CRM module, so it owns the raw table access directly (the single
 * door). Server-side paginated with an exact count, since the tables hold 90k+ rows.
 */

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { CRM_CHECKINS_TABLE, CRM_VISITS_TABLE } from "@/lib/crm/tables";
import { isCrmSchemaMissingError, isCrmVisitsSchemaReady } from "@/lib/crm/schema";
import { isIReports360Configured } from "@/lib/crm/config";
import { getLatestVisitsSyncRuns } from "@/lib/crm/admin";
import { CRM_RESIGNED_IN_LIST, CRM_DOUBLE_VISIT_TYPE_CODES, getEffectiveExcludedInList, queryCheckins, resolveVisitTime } from "@/lib/crm/reads";
import { indexCheckinsByAgentContactDay, pickCheckinForVisit } from "@/lib/crm/checkin-match";
import { canonicalHrIdKey } from "@/lib/hr-id";
import type { VisitsSyncRun } from "@/lib/visits-report/types";
import { CRM_MASTER_DATASETS, type CrmMasterDataset } from "@/lib/crm/master-datasets";

export { CRM_MASTER_DATASETS, type CrmMasterDataset };

/** Confidence labels for a detected triple visit — shared by the Triple Visits tab column and the
 * Double Visits "Triple?" flag so both read identically. */
const TRIPLE_CONFIRMED = "Confirmed — same doctor";
const TRIPLE_UNSPECIFIED = "Contact unspecified — same day";

/** DB view (migration crm_effective_visit_type_view) exposing has_checkin + effective_visit_type +
 * reclassified_no_checkin. Used only for the "Regular · No Check-in" tab's DB-level filter/count;
 * the other tabs read the base table and derive the flag in memory. */
const CRM_VISITS_EFFECTIVE_VIEW = "ireports360_visits_effective";

/** A visit-based dataset (everything except check-ins reads the visits table). */
function isVisitDataset(dataset: CrmMasterDataset): boolean {
  return dataset !== "checkins";
}

/** Fixed visit-type options for the Visit Type dropdown (a stable iReports360 enum). */
export const CRM_VISIT_TYPE_OPTIONS: readonly string[] = [
  "Regular Visit",
  "Campaign (Prospection)",
  "Meeting",
  "Group Meeting",
  "Conference",
  "Training",
  "Health Day",
  "Traveling",
  "Annual Vacation",
  "Unknown",
];

/** A displayed column: the raw DB key + a human label + a rendering hint + an optional
 * header tooltip.
 *  - `date`            → date only.
 *  - `datetime`        → a true UTC instant WE recorded (e.g. synced_at), converted to Cairo.
 *  - `datetime_local`  → a vendor timestamp that is already Cairo wall-clock but stored tagged
 *                        UTC (iReports360 sends zone-less local times); render the stored clock
 *                        as-is with NO timezone shift, otherwise it reads hours too late. */
export type CrmMasterColumn = {
  key: string;
  label: string;
  kind: "text" | "number" | "date" | "datetime" | "datetime_local" | "coord";
  note?: string;
};

/** Ordered columns shown for the visits dataset (every stored field except raw_payload, which is
 * shown per-row as the full JSON, and the internal uuid `id`). */
export const CRM_VISIT_COLUMNS: readonly CrmMasterColumn[] = [
  { key: "crm_visit_id", kind: "number", label: "CRM Visit ID" },
  { key: "visit_date", kind: "date", label: "Visit Date" },
  { key: "visit_time", kind: "datetime_local", label: "Visit Time", note: "The ONE authoritative visit time (Cairo), shown with its source badge: GPS = a real GPS check-in (on site). Logged = the rep's submission time only, which is often hours later or the next morning — treat as approximate. Never the empty midnight placeholder." },
  { key: "crm_save_date", kind: "datetime_local", label: "CRM Save Date", note: "When the agent saved/submitted this visit in the CRM (Cairo time). This is paperwork time, NOT proof of being on site — reps frequently batch-log visits later, even after midnight. Prefer the Visit Time column above." },
  { key: "ampm", kind: "text", label: "AM/PM" },
  { key: "agent_crm_id", kind: "number", label: "Agent CRM ID" },
  { key: "agent_hr_id", kind: "text", label: "Agent HR ID" },
  { key: "agent_name", kind: "text", label: "Agent Name" },
  { key: "line", kind: "text", label: "Line", note: "The agent's product line, from their Phoenix employee record. '—' when the agent isn't mapped to an employee." },
  { key: "hire_date", kind: "text", label: "Hiring Date", note: "The agent's hiring date (dd-Mon-yyyy), from their Phoenix employee record." },
  { key: "double_crm_id", kind: "number", label: "Double CRM ID" },
  { key: "double_hr_id", kind: "text", label: "Double HR ID" },
  { key: "double_name", kind: "text", label: "Double Name" },
  { key: "contact_crm_id", kind: "number", label: "Contact CRM ID" },
  { key: "contact_name", kind: "text", label: "Contact Name" },
  { key: "customer_name", kind: "text", label: "Customer Name" },
  { key: "visit_type", kind: "number", label: "Visit Type" },
  { key: "visit_type_description", kind: "text", label: "Visit Type Description" },
  { key: "effective_type", kind: "text", label: "Effective Type", note: "How the system counts this visit. A Regular visit with NO matching GPS check-in is counted as Campaign — always shown here (flagged), never silently recounted." },
  { key: "call_type", kind: "number", label: "Call Type" },
  { key: "attendance", kind: "number", label: "Attendance" },
  { key: "comment", kind: "text", label: "Comment" },
  { key: "checkin_id", kind: "number", label: "Check-in ID", note: "All 'Check-in …' columns come from the GPS check-in at the SAME contact (same rep, same day; nearest in time to CRM Save Date if the contact has several). Only Regular visits have a contact — Campaign/Meeting/Vacation/etc. correctly show — (no check-in)." },
  { key: "checkin_time", kind: "datetime_local", label: "Check-in Time" },
  { key: "checkin_agent_crm_id", kind: "number", label: "Check-in Agent CRM ID" },
  { key: "checkin_agent_hr_id", kind: "text", label: "Check-in Agent HR ID" },
  { key: "checkin_contact_id", kind: "number", label: "Check-in Contact ID" },
  { key: "checkin_contact_name", kind: "text", label: "Check-in Contact" },
  { key: "checkin_lat", kind: "coord", label: "Check-in Latitude" },
  { key: "checkin_lon", kind: "coord", label: "Check-in Longitude" },
  { key: "checkin_address", kind: "text", label: "Check-in Address" },
  { key: "checkin_synced_at", kind: "datetime", label: "Check-in Synced At" },
  { key: "synced_at", kind: "datetime", label: "Synced At", note: "When Phoenix pulled this record from the CRM into its mirror (Cairo time)." },
];

/** Ordered columns shown for the check-ins dataset. */
export const CRM_CHECKIN_COLUMNS: readonly CrmMasterColumn[] = [
  { key: "crm_checkin_id", kind: "number", label: "CRM Check-in ID" },
  { key: "check_date", kind: "datetime_local", label: "Check Date", note: "Real GPS check-in time from the agent's phone (Cairo time)." },
  { key: "agent_crm_id", kind: "number", label: "Agent CRM ID" },
  { key: "agent_hr_id", kind: "text", label: "Agent HR ID" },
  { key: "line", kind: "text", label: "Line", note: "The agent's product line, from their Phoenix employee record. '—' when the agent isn't mapped to an employee." },
  { key: "hire_date", kind: "text", label: "Hiring Date", note: "The agent's hiring date (dd-Mon-yyyy), from their Phoenix employee record." },
  { key: "contact_crm_id", kind: "number", label: "Contact CRM ID" },
  { key: "contact_name", kind: "text", label: "Contact Name" },
  { key: "lat", kind: "coord", label: "Latitude" },
  { key: "lon", kind: "coord", label: "Longitude" },
  { key: "address", kind: "text", label: "Address" },
  { key: "synced_at", kind: "datetime", label: "Synced At", note: "When Phoenix pulled this record from the CRM into its mirror (Cairo time)." },
];

/** Vacation / issue tabs reuse the visit fields WITHOUT the nearest-check-in block (those records
 * have no check-in). Derived so the base column set stays defined in one place. */
const CRM_VISIT_BASE_COLUMNS: readonly CrmMasterColumn[] = CRM_VISIT_COLUMNS.filter(
  (col) => !col.key.startsWith("checkin_"),
);

/** The "Triple?" flag shown on the Double Visits tab: set when a double visit is part of a triple
 * (a third person was also stacked on it that day), naming who the third person is. */
const CRM_TRIPLE_FLAG_COLUMN: CrmMasterColumn = {
  key: "triple_flag",
  kind: "text",
  label: "Triple?",
  note: "Flagged when this double visit is actually part of a TRIPLE — a third person was also stacked on the same contact/day. Shows who the third person is. '—' means a plain double visit.",
};

/** Double Visits tab = the visit columns with the "Triple?" flag inserted right after the double
 * visitor's name, so the triple signal sits next to the pair it describes. */
const CRM_DOUBLE_VISIT_COLUMNS: readonly CrmMasterColumn[] = CRM_VISIT_COLUMNS.flatMap((col) =>
  col.key === "double_name" ? [col, CRM_TRIPLE_FLAG_COLUMN] : [col],
);

/** Triple Visits tab columns: one row per detected triple — the rep→middle→top chain, the contact,
 * the two source visit IDs, and a confidence flag (same-doctor vs same-day-only). */
export const CRM_TRIPLE_COLUMNS: readonly CrmMasterColumn[] = [
  {
    key: "confidence",
    kind: "text",
    label: "Confidence",
    note: "Confirmed — same doctor: all three were logged at the SAME contact that day. Contact unspecified — same day: the accompaniment chain (rep←middle←top) is explicit and same-day, but no specific doctor was recorded (contact id 0).",
  },
  { key: "visit_date", kind: "date", label: "Date" },
  { key: "contact_crm_id", kind: "number", label: "Contact CRM ID" },
  { key: "contact_name", kind: "text", label: "Contact Name" },
  {
    key: "base_name",
    kind: "text",
    label: "Rep (base)",
    note: "The field rep at the bottom of the chain — logged the visit, accompanied by the middle manager.",
  },
  { key: "base_hr_id", kind: "text", label: "Rep HR ID" },
  {
    key: "line",
    kind: "text",
    label: "Rep Line",
    note: "The rep's product line, from their Phoenix employee record.",
  },
  {
    key: "hire_date",
    kind: "text",
    label: "Rep Hiring Date",
    note: "The rep's hiring date (dd-Mon-yyyy), from their Phoenix employee record.",
  },
  {
    key: "mid_name",
    kind: "text",
    label: "Middle Manager",
    note: "The bridge of the triple: accompanied the rep AND was themselves accompanied by the top manager.",
  },
  { key: "mid_hr_id", kind: "text", label: "Middle HR ID" },
  {
    key: "top_name",
    kind: "text",
    label: "Top Manager",
    note: "The most senior of the three — accompanied the middle manager.",
  },
  { key: "top_hr_id", kind: "text", label: "Top HR ID" },
  {
    key: "base_visit_id",
    kind: "number",
    label: "Rep Visit ID",
    note: "The rep's visit record (agent = rep, double = middle manager).",
  },
  {
    key: "bridge_visit_id",
    kind: "number",
    label: "Manager Visit ID",
    note: "The middle manager's visit record (agent = middle manager, double = top manager) — the bridge that links the chain.",
  },
];

/** Vacations tab = one row per vacation PERIOD (consecutive CRM vacation days grouped), not per day.
 * Vacation ID anchors the period (its earliest CRM visit id); Duration counts half-days as 0.5. */
export const CRM_VACATION_COLUMNS: readonly CrmMasterColumn[] = [
  { key: "vacation_id", kind: "number", label: "Vacation ID", note: "Identifies this vacation period — the earliest CRM visit id among its days." },
  { key: "from_date", kind: "date", label: "From" },
  { key: "to_date", kind: "date", label: "To" },
  { key: "duration", kind: "number", label: "Duration (days)", note: "Total days in the period. A half-day (AM or PM only) counts as 0.5, so a period can be 0.5, 1, 1.5, 2 …" },
  { key: "half_days", kind: "number", label: "Half Days", note: "How many of the days in this period were half-days (logged AM or PM only)." },
  { key: "national_holiday", kind: "text", label: "National Holiday", note: "Set when this leave falls on an official Egyptian holiday (by date) OR the comment names one (Eid, Revolution, Labour Day, Sinai Liberation, Coptic Christmas, official/رسمي…). These rows are tinted amber." },
  { key: "agent_crm_id", kind: "number", label: "Agent CRM ID" },
  { key: "agent_hr_id", kind: "text", label: "Agent HR ID" },
  { key: "agent_name", kind: "text", label: "Agent Name" },
  { key: "line", kind: "text", label: "Line", note: "The agent's product line, from their Phoenix employee record." },
  { key: "hire_date", kind: "text", label: "Hiring Date", note: "The agent's hiring date (dd-Mon-yyyy), from their Phoenix employee record." },
  { key: "visit_type_description", kind: "text", label: "Vacation Type" },
  { key: "comment", kind: "text", label: "Comment", note: "The leave note on the first day of the period (e.g. Annual Leave, Morning Excuse)." },
];

/** Columns shown for a given dataset/tab. */
function columnsForDataset(dataset: CrmMasterDataset): readonly CrmMasterColumn[] {
  if (dataset === "checkins") return CRM_CHECKIN_COLUMNS;
  if (dataset === "vacations") return CRM_VACATION_COLUMNS;
  if (dataset === "regular_no_checkin" || dataset === "regular_dv_no_checkin") return CRM_VISIT_BASE_COLUMNS;
  if (dataset === "triple_visits") return CRM_TRIPLE_COLUMNS;
  if (dataset === "double_visits") return CRM_DOUBLE_VISIT_COLUMNS;
  return CRM_VISIT_COLUMNS; // visits
}

const VISIT_SELECT =
  "id, crm_visit_id, agent_crm_id, agent_hr_id, agent_name, ampm, attendance, call_type, comment, " +
  "contact_crm_id, contact_name, crm_save_date, customer_name, double_crm_id, double_hr_id, double_name, " +
  "visit_date, visit_type, visit_type_description, synced_at, raw_payload";

const CHECKIN_SELECT =
  "id, crm_checkin_id, agent_crm_id, agent_hr_id, contact_crm_id, contact_name, lat, lon, address, " +
  "check_date, synced_at, raw_payload";

export type CrmMasterRow = Record<string, unknown> & { id: string; raw_payload: Record<string, unknown> | null };

/** Agent-mapping filter (visits): show all, only rows with a resolved agent_hr_id, or only unmapped. */
export type CrmMasterMappingStatus = "all" | "agent_mapped" | "agent_unmapped";

/** AM/PM filter (visits). */
export type CrmMasterAmpm = "all" | "AM" | "PM";

export type CrmMasterData = {
  agentHrId: string | null;
  ampm: CrmMasterAmpm;
  columns: readonly CrmMasterColumn[];
  configured: boolean;
  dataset: CrmMasterDataset;
  dateFrom: string | null;
  dateTo: string | null;
  halfDaysOnly: boolean;
  hireFrom: string | null;
  hireTo: string | null;
  latestSyncRuns: VisitsSyncRun[];
  line: string | null;
  lineOptions: readonly string[];
  mappingStatus: CrmMasterMappingStatus;
  minDuration: number | null;
  page: number;
  pageSize: number;
  pageSizeOptions: readonly number[];
  rows: CrmMasterRow[];
  schemaReady: boolean;
  search: string | null;
  totalCount: number;
  /** True when a computed tab (triples/vacations) hit its 60k in-memory row cap and may be missing
   * rows — the UI shows a "first N" banner. Absent/false for the uncapped (paginated + counted)
   * datasets. */
  truncated?: boolean;
  visitType: string | null;
  visitTypeOptions: readonly string[];
};

export type CrmMasterFilter = {
  agentHrId?: string | null;
  ampm?: CrmMasterAmpm | null;
  dataset?: CrmMasterDataset;
  dateFrom?: string | null;
  dateTo?: string | null;
  halfDaysOnly?: boolean | null;
  hireFrom?: string | null;
  hireTo?: string | null;
  line?: string | null;
  mappingStatus?: CrmMasterMappingStatus | null;
  minDuration?: number | null;
  page?: number;
  pageSize?: number;
  search?: string | null;
  visitType?: string | null;
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
export const CRM_MASTER_PAGE_SIZE_OPTIONS = [50, 100, 200] as const;

/* eslint-disable @typescript-eslint/no-explicit-any -- structural PostgREST builder (too deep to
   thread through a helper — same pattern as crm/reads.ts). */
type MasterQuery = {
  eq: (...args: any[]) => MasterQuery;
  gte: (...args: any[]) => MasterQuery;
  ilike: (...args: any[]) => MasterQuery;
  is: (...args: any[]) => MasterQuery;
  lte: (...args: any[]) => MasterQuery;
  in: (...args: any[]) => MasterQuery;
  neq: (...args: any[]) => MasterQuery;
  not: (...args: any[]) => MasterQuery;
  or: (...args: any[]) => MasterQuery;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Escapes a free-text search term for a PostgREST `or(...ilike...)` expression. */
function sanitizeSearch(term: string): string {
  return term.replace(/[%,()]/g, " ").trim();
}

type CheckinLite = {
  address: string | null;
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  check_date: string | null;
  contact_crm_id: number | null;
  contact_name: string | null;
  crm_checkin_id: number | null;
  lat: number | null;
  lon: number | null;
  synced_at: string | null;
};

/** The nearest-check-in fields merged onto each visit row (all null when there's no match) —
 * the full set of check-in columns, mirroring the Check-ins dataset. */
const CHECKIN_MERGE_KEYS = [
  "checkin_id",
  "checkin_time",
  "checkin_agent_crm_id",
  "checkin_agent_hr_id",
  "checkin_contact_id",
  "checkin_contact_name",
  "checkin_lat",
  "checkin_lon",
  "checkin_address",
  "checkin_synced_at",
] as const;

/**
 * Attach each visit's GPS check-in: matched by same rep + SAME contact + same day — a check-in
 * belongs to the regular visit at that contact — and when one contact has >1 check-in that day, the
 * one nearest in time to the visit's crm_save_date. Only REGULAR visits carry a contact, so
 * non-regular visits (Campaign, Meeting, Vacation, …) correctly get no check-in. Time is only a
 * tiebreaker, anchored on crm_save_date (the real submit time); both it and check_date are
 * Cairo-local so the gap is consistent. Mutates rows in place; best-effort (leaves nulls on failure
 * or no same-contact match). Only the current page of visits is correlated.
 */
/** Human label for the visit_time_source text column (the master renders raw values, no enum kind). */
function visitTimeSourceLabel(source: "gps_checkin" | "save_time" | "none"): string | null {
  return source === "gps_checkin" ? "GPS check-in" : source === "save_time" ? "Logged/save" : null;
}

async function attachNearestCheckins(rows: CrmMasterRow[]): Promise<void> {
  for (const row of rows) {
    for (const key of CHECKIN_MERGE_KEYS) row[key] = null;
    // Save-tier visit time up front (no check-in correlated yet); upgraded to the GPS tier below
    // for any row that matches a check-in. Always set, even on the early-return path.
    const saveTier = resolveVisitTime({
      nearestCheckinTime: null,
      crmSaveDate: typeof row.crm_save_date === "string" ? row.crm_save_date : null,
    });
    row.visit_time = saveTier.time;
    row.visit_time_source = visitTimeSourceLabel(saveTier.source);
  }
  const agentIds = Array.from(
    new Set(rows.map((r) => r.agent_crm_id).filter((v): v is number => typeof v === "number")),
  );
  const days = rows
    .map((r) => (typeof r.visit_date === "string" ? r.visit_date.slice(0, 10) : null))
    .filter((v): v is string => Boolean(v));
  if (agentIds.length === 0 || days.length === 0) return;
  const from = days.reduce((a, b) => (a < b ? a : b));
  const to = days.reduce((a, b) => (a > b ? a : b));

  // Full keyset scan via queryCheckins — complete check-in coverage for the page's agents + dates
  // (no silent 20k cap). Best-effort overlay: any failure leaves the check-in columns null.
  let data: CheckinLite[];
  try {
    data = await queryCheckins<CheckinLite>({
      agentCrmIds: agentIds,
      dateFrom: from,
      dateTo: to,
      columns: "crm_checkin_id, check_date, agent_crm_id, agent_hr_id, contact_crm_id, contact_name, lat, lon, address, synced_at",
    });
  } catch {
    return;
  }

  // Same agent + CONTACT + day matcher as the Visits Report (crm/checkin-match.ts), tie broken by
  // crm_save_date — so a given visit resolves to the SAME check-in on both surfaces.
  const index = indexCheckinsByAgentContactDay(data);
  for (const row of rows) {
    const best = pickCheckinForVisit(
      {
        agentCrmId: typeof row.agent_crm_id === "number" ? row.agent_crm_id : null,
        contactCrmId: typeof row.contact_crm_id === "number" ? row.contact_crm_id : null,
        visitDay: typeof row.visit_date === "string" ? row.visit_date.slice(0, 10) : null,
        crmSaveDate: typeof row.crm_save_date === "string" ? row.crm_save_date : null,
      },
      index,
    );
    if (!best) continue;
    row.checkin_id = best.crm_checkin_id;
    row.checkin_time = best.check_date;
    // A matched GPS check-in is the real on-site time — upgrade the canonical visit time from the
    // save tier to the GPS tier (the rep's save time is often hours later, even the next morning).
    const gpsTier = resolveVisitTime({
      nearestCheckinTime: best.check_date,
      crmSaveDate: typeof row.crm_save_date === "string" ? row.crm_save_date : null,
    });
    row.visit_time = gpsTier.time;
    row.visit_time_source = visitTimeSourceLabel(gpsTier.source);
    row.checkin_agent_crm_id = best.agent_crm_id;
    row.checkin_agent_hr_id = best.agent_hr_id;
    row.checkin_contact_id = best.contact_crm_id;
    row.checkin_contact_name = best.contact_name;
    row.checkin_lat = best.lat;
    row.checkin_lon = best.lon;
    row.checkin_address = best.address;
    row.checkin_synced_at = best.synced_at;
  }
}

/** Effective visit type: a Regular visit (0) with NO matched GPS check-in is COUNTED as Campaign,
 * but ALWAYS flagged here — never a silent recount. For regular_no_checkin every row is reclassified
 * (the tab filters to it); for visits/double it's derived from the in-memory check-in correlation
 * (checkin_id null). Datasets that don't correlate (vacations, triples) keep the raw type. */
function attachEffectiveType(dataset: CrmMasterDataset, rows: CrmMasterRow[]): void {
  const knowsCheckin =
    dataset === "visits" ||
    dataset === "double_visits" ||
    dataset === "regular_no_checkin" ||
    dataset === "regular_dv_no_checkin";
  const alwaysReclassified = dataset === "regular_no_checkin" || dataset === "regular_dv_no_checkin";
  for (const row of rows) {
    const isRegular = row.visit_type === 0;
    const reclassified = alwaysReclassified ? true : knowsCheckin && isRegular && row.checkin_id == null;
    row.effective_type = reclassified
      ? "Campaign — reclassified (Regular, no check-in)"
      : (typeof row.visit_type_description === "string" && row.visit_type_description) || String(row.visit_type ?? "—");
  }
}

/** Lightweight double-visit row used to detect triples. */
type TripleDvRow = {
  crm_visit_id: number | null;
  visit_date: string | null;
  agent_crm_id: number | null;
  agent_name: string | null;
  agent_hr_id: string | null;
  double_crm_id: number | null;
  double_name: string | null;
  double_hr_id: string | null;
  contact_crm_id: number | null;
  contact_name: string | null;
};

/**
 * Detect TRIPLE visits over a date range. A triple is the rare chain where a manager M is the
 * `double` (partner) on a rep R's visit AND the `agent` on M's own visit whose `double` is a higher
 * manager T — so three people (R → M → T) were stacked at one contact/day. In mirror terms: two
 * double-visit rows in the SAME (contact, day) where rowA.double_crm_id == rowB.agent_crm_id (M is
 * the bridge), with R, M, T all distinct. Confidence: "confirmed" when the shared contact is a real
 * doctor (contact_crm_id ≠ 0), "unspecified" when contact is 0 (chain is explicit and same-day but
 * no doctor was recorded). Resigned agents are excluded (same rule as every CRM tab). Returns the
 * per-triple rows (for the Triple Visits tab) plus a visit-id → third-person map (for the Double
 * Visits "Triple?" flag). Bounded to 50k double-visit rows in range (ample; prod has ~dozens).
 */
async function computeTriplesInRange(range: {
  dateFrom: string | null;
  dateTo: string | null;
}): Promise<{ rows: CrmMasterRow[]; byVisitId: Map<number, { third: string; unspecified: boolean }>; truncated: boolean }> {
  const supabase = getSupabaseAdmin();
  const excludedInList = await getEffectiveExcludedInList();
  // Walk pages of double-visit rows (PostgREST caps a single request's row count, so a lone
  // .limit() would silently truncate and miss triples) — same paging pattern as the export.
  const PAGE = 1000;
  const MAX_ROWS = 60000;
  const dv: TripleDvRow[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const base = supabase
      .from(CRM_VISITS_TABLE)
      .select(
        "crm_visit_id, visit_date, agent_crm_id, agent_name, agent_hr_id, double_crm_id, double_name, double_hr_id, contact_crm_id, contact_name",
      )
      .not("double_crm_id", "is", null)
      .neq("double_crm_id", 0)
      .in("visit_type", [...CRM_DOUBLE_VISIT_TYPE_CODES]);
    let q = base as unknown as MasterQuery;
    if (excludedInList) {
      q = q.not("agent_crm_id", "in", excludedInList);
    }
    if (range.dateFrom) q = q.gte("visit_date", range.dateFrom);
    if (range.dateTo) q = q.lte("visit_date", range.dateTo);
    const { data, error } = await (q as unknown as typeof base)
      .order("visit_date", { ascending: false })
      .order("crm_visit_id", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error || !data) {
      if (dv.length === 0) return { rows: [], byVisitId: new Map(), truncated: false };
      break;
    }
    const pageRows = data as unknown as TripleDvRow[];
    dv.push(...pageRows);
    if (pageRows.length < PAGE) break;
  }

  // Group double-visit rows by (contact, day). contact 0 groups all unspecified-contact rows of the day.
  const groups = new Map<string, TripleDvRow[]>();
  for (const r of dv) {
    if (r.agent_crm_id == null || r.double_crm_id == null || !r.visit_date) continue;
    const contactKey = r.contact_crm_id ?? 0;
    const day = String(r.visit_date).slice(0, 10);
    const key = `${contactKey}|${day}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const seen = new Set<string>();
  const rows: CrmMasterRow[] = [];
  const byVisitId = new Map<number, { third: string; unspecified: boolean }>();
  const noteVisit = (id: unknown, third: string, unspecified: boolean) => {
    if (typeof id !== "number") return;
    const prev = byVisitId.get(id);
    // Prefer a confirmed-contact label over an unspecified one if a visit is in several triples.
    if (!prev || (prev.unspecified && !unspecified)) byVisitId.set(id, { third, unspecified });
  };

  for (const list of groups.values()) {
    // Index rows in this group by agent so we can find the bridge (rowA.double == rowB.agent).
    const byAgent = new Map<number, TripleDvRow[]>();
    for (const r of list) {
      const a = r.agent_crm_id as number;
      const l = byAgent.get(a);
      if (l) l.push(r);
      else byAgent.set(a, [r]);
    }
    for (const a of list) {
      const baseAgent = a.agent_crm_id as number;
      const mid = a.double_crm_id as number;
      if (baseAgent === mid) continue; // a row's own agent ≠ its double
      const bridges = byAgent.get(mid);
      if (!bridges) continue;
      for (const b of bridges) {
        const top = b.double_crm_id as number;
        if (top === mid) continue; // bridge row's agent ≠ its double
        if (top === baseAgent) continue; // base ≠ top → three distinct people
        const contactKey = a.contact_crm_id ?? 0;
        const day = String(a.visit_date).slice(0, 10);
        const dedupe = `${day}|${contactKey}|${baseAgent}|${mid}|${top}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const unspecified = contactKey === 0;
        const confidence = unspecified ? TRIPLE_UNSPECIFIED : TRIPLE_CONFIRMED;
        rows.push({
          id: dedupe,
          confidence,
          visit_date: a.visit_date,
          contact_crm_id: a.contact_crm_id,
          contact_name: a.contact_name,
          base_name: a.agent_name,
          base_hr_id: a.agent_hr_id,
          mid_name: a.double_name, // == b.agent_name
          mid_hr_id: a.double_hr_id,
          top_name: b.double_name,
          top_hr_id: b.double_hr_id,
          base_visit_id: a.crm_visit_id,
          bridge_visit_id: b.crm_visit_id,
          raw_payload: { base_visit_id: a.crm_visit_id, bridge_visit_id: b.crm_visit_id, confidence },
        } as CrmMasterRow);
        // Flag both source visits on the Double Visits tab with the OTHER person in the triple.
        noteVisit(a.crm_visit_id, b.double_name || `#${top}`, unspecified);
        noteVisit(b.crm_visit_id, a.agent_name || `#${baseAgent}`, unspecified);
      }
    }
  }

  rows.sort((x, y) => String(y.visit_date).localeCompare(String(x.visit_date)));
  // `dv` reaches MAX_ROWS only when the cap is hit (a short page breaks the loop first), so this is
  // the honest "we may have missed some double-visit rows → some triples may be absent" signal.
  return { rows, byVisitId, truncated: dv.length >= MAX_ROWS };
}

/** Double Visits tab: set `triple_flag` from the triple membership map (naming the third person). */
function attachTripleFlag(
  rows: CrmMasterRow[],
  byVisitId: Map<number, { third: string; unspecified: boolean }>,
): void {
  for (const row of rows) {
    const id = typeof row.crm_visit_id === "number" ? row.crm_visit_id : null;
    const hit = id != null ? byVisitId.get(id) : undefined;
    row.triple_flag = hit
      ? `Triple — also ${hit.third}${hit.unspecified ? " (contact unspecified)" : ""}`
      : "—";
  }
}

const MONTHS_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Format a plain date (YYYY-MM-DD) as "05-Mar-2026". Parses the string directly (no Date/timezone
 * so it never drifts a day). Returns null on empty/malformed input. */
function formatDmy(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr));
  if (!m) return null;
  const monthIdx = Number(m[2]) - 1;
  if (monthIdx < 0 || monthIdx > 11) return null;
  return `${m[3]}-${MONTHS_ABBR[monthIdx]}-${m[1]}`;
}

/** Per-agent metadata resolved from the employee roster for the CRM tabs' "Line" + "Hiring Date"
 * columns: normalized-HR-ID → { line name, hire date pre-formatted dd-Mon-yyyy }. */
type AgentMeta = { line: string | null; hireDate: string | null };

/** Build the normalized-HR-ID → {line, hireDate} map from the employee roster (small: ~160 rows, so
 * one unpaginated read is safe). Degrades to an empty map on any error (cells then show "—").
 * Employees/lines are core tables outside the CRM mirror. */
async function loadAgentMetaByHrId(): Promise<Map<string, AgentMeta>> {
  const supabase = getSupabaseAdmin();
  const [linesRes, empRes] = await Promise.all([
    supabase.from("lines").select("id, name"),
    supabase.from("employees").select("hr_id, line_id, hire_date").limit(5000),
  ]);
  if (linesRes.error || empRes.error) return new Map();
  const lineNameById = new Map<number, string>();
  for (const l of (linesRes.data ?? []) as Array<{ id: number | null; name: string | null }>) {
    if (l.id != null && l.name) lineNameById.set(l.id, l.name);
  }
  const byHrId = new Map<string, AgentMeta>();
  for (const e of (empRes.data ?? []) as Array<{ hr_id: string | null; line_id: number | null; hire_date: string | null }>) {
    const key = canonicalHrIdKey(e.hr_id);
    if (!key) continue;
    byHrId.set(key, {
      line: e.line_id != null ? lineNameById.get(e.line_id) ?? null : null,
      hireDate: formatDmy(e.hire_date),
    });
  }
  return byHrId;
}

/** Set each row's `line` + `hire_date` from the resolved HR ID in `hrIdField` (the agent for most
 * tabs, the rep for triples), using the roster meta map. Unknown HR ids leave both null → "—". */
function attachAgentMeta(rows: CrmMasterRow[], metaByHrId: Map<string, AgentMeta>, hrIdField: string): void {
  for (const row of rows) {
    const raw = typeof row[hrIdField] === "string" ? (row[hrIdField] as string) : null;
    const meta = raw ? metaByHrId.get(canonicalHrIdKey(raw) ?? "") : undefined;
    row.line = meta?.line ?? null;
    row.hire_date = meta?.hireDate ?? null;
  }
}

/** Distinct product-line names for the "Line" filter dropdown (small `lines` table). */
async function loadLineOptions(): Promise<string[]> {
  const { data, error } = await getSupabaseAdmin().from("lines").select("name").order("name", { ascending: true });
  if (error || !data) return [];
  const names = (data as Array<{ name: string | null }>).map((r) => r.name).filter((v): v is string => Boolean(v && v.trim()));
  return Array.from(new Set(names));
}

/** Resolve the employee HR ids matching the Line and/or Hiring-date-range filters. Returns null when
 * neither is active (no restriction). Returns raw hr_id strings (for the mirror `agent_hr_id` `.in`)
 * plus canonical keys (for in-memory filtering of the computed tabs). An active filter that matches no
 * employee returns empty sets → callers show zero rows. */
async function resolveAllowedHrIds(opts: {
  line: string | null;
  hireFrom: string | null;
  hireTo: string | null;
}): Promise<{ hrIds: string[]; keys: Set<string> } | null> {
  if (!opts.line && !opts.hireFrom && !opts.hireTo) return null;
  const supabase = getSupabaseAdmin();
  const empty = { hrIds: [] as string[], keys: new Set<string>() };

  let lineIds: number[] | null = null;
  if (opts.line) {
    const { data: lineRows } = await supabase.from("lines").select("id").ilike("name", opts.line);
    lineIds = ((lineRows ?? []) as Array<{ id: number | null }>).map((l) => l.id).filter((v): v is number => typeof v === "number");
    if (lineIds.length === 0) return empty; // unknown line → nobody matches
  }

  /* eslint-disable @typescript-eslint/no-explicit-any -- conditional builder chain, same pattern as elsewhere. */
  let query: any = supabase.from("employees").select("hr_id");
  if (lineIds) query = query.in("line_id", lineIds);
  if (opts.hireFrom) query = query.gte("hire_date", opts.hireFrom);
  if (opts.hireTo) query = query.lte("hire_date", opts.hireTo);
  const { data, error } = await query.limit(5000);
  /* eslint-enable @typescript-eslint/no-explicit-any */
  if (error || !data) return empty;

  const hrIds: string[] = [];
  const keys = new Set<string>();
  for (const e of data as Array<{ hr_id: string | null }>) {
    if (!e.hr_id) continue;
    hrIds.push(e.hr_id);
    const k = canonicalHrIdKey(e.hr_id);
    if (k) keys.add(k);
  }
  return { hrIds, keys };
}

/** In-memory filters for the computed tabs (vacations, triples) — their rows aren't produced by the
 * DB query path, so the advanced filters are applied here: agent-HR-id substring, free-text search,
 * a line/hiring-date allow-set (by hr id), and (vacations) minimum Duration + half-days-only.
 * `hrIdField` names the row's owning-agent hr id (agent_hr_id for vacations, base_hr_id for triples). */
function filterComputedRows(
  rows: CrmMasterRow[],
  opts: {
    agentHrId: string | null;
    allowed: Set<string> | null;
    halfDaysOnly: boolean;
    hrIdField: string;
    minDuration: number | null;
    search: string | null;
  },
): CrmMasterRow[] {
  const agentNeedle = opts.agentHrId ? opts.agentHrId.trim().toLowerCase() : null;
  const searchNeedle = opts.search ? opts.search.trim().toLowerCase() : null;
  return rows.filter((row) => {
    const hrRaw = typeof row[opts.hrIdField] === "string" ? (row[opts.hrIdField] as string) : null;
    if (opts.allowed) {
      const k = canonicalHrIdKey(hrRaw);
      if (!k || !opts.allowed.has(k)) return false;
    }
    if (agentNeedle && !(hrRaw && hrRaw.toLowerCase().includes(agentNeedle))) return false;
    if (searchNeedle) {
      const hay = [row.agent_name, row.base_name, row.mid_name, row.top_name, row.contact_name, row.comment]
        .filter((v): v is string => typeof v === "string")
        .join(" ")
        .toLowerCase();
      if (!hay.includes(searchNeedle)) return false;
    }
    if (opts.minDuration != null && !(typeof row.duration === "number" && row.duration >= opts.minDuration)) return false;
    if (opts.halfDaysOnly && !(typeof row.half_days === "number" && row.half_days > 0)) return false;
    return true;
  });
}

/** A vacation day-row from the mirror, used to group vacation periods. */
type VacationDayRow = {
  crm_visit_id: number | null;
  visit_date: string | null;
  ampm: string | null;
  agent_crm_id: number | null;
  agent_name: string | null;
  agent_hr_id: string | null;
  visit_type_description: string | null;
  comment: string | null;
};

/** True when `cur` (YYYY-MM-DD) is exactly the calendar day after `prev`. */
function isNextCalendarDay(prev: string, cur: string): boolean {
  const p = Date.parse(`${prev}T00:00:00Z`);
  const c = Date.parse(`${cur}T00:00:00Z`);
  return Number.isFinite(p) && Number.isFinite(c) && c - p === 86_400_000;
}

/** Official Egyptian public holidays for 2026 (YYYY-MM-DD → name), for flagging "national vacations"
 * by date. Gregorian-fixed dates are firm; the Islamic/Coptic ones (Eid, Hijri New Year, Sham
 * El-Nessim, Mawlid) shift by moon/calendar and are best-effort — edit here if the observed dates
 * differ. Comment-based detection (below) catches the actually-logged holidays regardless of date. */
const NATIONAL_HOLIDAYS_2026: ReadonlyMap<string, string> = new Map([
  ["2026-01-07", "Coptic Christmas"],
  ["2026-01-25", "25 January Revolution / Police Day"],
  ["2026-03-20", "Eid al-Fitr"],
  ["2026-03-21", "Eid al-Fitr"],
  ["2026-03-22", "Eid al-Fitr"],
  ["2026-04-13", "Sham El-Nessim"],
  ["2026-04-25", "Sinai Liberation Day"],
  ["2026-05-01", "Labour Day"],
  ["2026-05-27", "Eid al-Adha"],
  ["2026-05-28", "Eid al-Adha"],
  ["2026-05-29", "Eid al-Adha"],
  ["2026-05-30", "Eid al-Adha"],
  ["2026-06-17", "Islamic New Year"],
  ["2026-06-18", "Islamic New Year"],
  ["2026-06-30", "30 June Revolution"],
  ["2026-07-23", "23 July Revolution"],
  ["2026-08-26", "Prophet's Birthday"],
  ["2026-10-06", "Armed Forces Day"],
]);

/** Comment fragments (Arabic is case-insensitive; English lowercased) that mark an official/national
 * holiday in a leave note — how agents actually log them ("اجازة رسمي", "عيد العمال", "Eid vacation",
 * "عيد تحرير سيناء", "ثورة ٣٠ يونيو", "Holiday"). */
const NATIONAL_HOLIDAY_KEYWORDS: readonly string[] = [
  "رسمي", "عيد", "ثورة", "تحرير", "الهجرية", "المسيح", "النسيم", "مولد", "القوات المسلحة",
  "official holiday", "national holiday", "national vacation", "public holiday", "holiday", "eid",
  "feast", "revolution", "liberation", "labour day", "labor day", "christmas", "sinai", "mawlid", "sham el",
];

/** Flag a vacation period as a national/official holiday if ANY of its days falls on an official
 * holiday date OR its comment names one. Returns the holiday name (date match preferred) or null. */
function detectNationalHoliday(run: VacationDayRow[]): string | null {
  let byDate: string | null = null;
  let byComment = false;
  for (const r of run) {
    const named = NATIONAL_HOLIDAYS_2026.get(String(r.visit_date).slice(0, 10));
    if (named && !byDate) byDate = named;
    const c = (r.comment ?? "").toLowerCase();
    if (c && NATIONAL_HOLIDAY_KEYWORDS.some((kw) => c.includes(kw))) byComment = true;
  }
  return byDate ?? (byComment ? "National Holiday" : null);
}

/** Build one vacation-period row from a run of consecutive day-rows (same agent, sorted by date).
 * Duration sums each day (0.5 for an AM/PM half-day, else 1). Vacation ID = earliest CRM visit id. */
function buildVacationPeriod(run: VacationDayRow[]): CrmMasterRow {
  const first = run[0];
  const dates = run.map((r) => String(r.visit_date).slice(0, 10));
  const fromDate = dates.reduce((a, b) => (a < b ? a : b));
  const toDate = dates.reduce((a, b) => (a > b ? a : b));
  let duration = 0;
  let halfDays = 0;
  for (const r of run) {
    const isHalf = r.ampm === "AM" || r.ampm === "PM";
    duration += isHalf ? 0.5 : 1;
    if (isHalf) halfDays += 1;
  }
  const ids = run.map((r) => r.crm_visit_id).filter((v): v is number => typeof v === "number");
  return {
    id: `vac-${first.agent_crm_id}-${fromDate}-${toDate}`,
    vacation_id: ids.length ? Math.min(...ids) : null,
    from_date: fromDate,
    to_date: toDate,
    duration,
    half_days: halfDays,
    agent_crm_id: first.agent_crm_id,
    agent_hr_id: first.agent_hr_id,
    agent_name: first.agent_name,
    visit_type_description: first.visit_type_description,
    comment: first.comment,
    national_holiday: detectNationalHoliday(run),
    raw_payload: {
      visit_ids: ids,
      days: run.map((r) => ({ date: String(r.visit_date).slice(0, 10), ampm: r.ampm || "full", crm_visit_id: r.crm_visit_id })),
    },
  } as CrmMasterRow;
}

/**
 * Group CRM vacation day-rows (visit_type_description ILIKE '%vacation%') into vacation PERIODS: one
 * row per run of consecutive calendar days for the same agent (a gap starts a new period; two rows on
 * the same date — an AM + a PM half — stay in the same run). Resigned agents excluded. Duration counts
 * half-days as 0.5. Walks paginated rows (PostgREST caps a single request). Newest period first.
 *
 * SCOPE — this is the RAW CRM vacation view and is DELIBERATELY broader than the Company Vacation
 * Report (src/lib/vacation/company-vacation-report.ts). This tab matches ANY vacation-worded
 * description (ILIKE '%vacation%'). The Company Vacation Report is narrower: only Annual Vacation
 * (visit_type = -4, NOT Health Day -15), and it drops public-holiday / excuse-labeled /
 * proven-worked days and merges in HR-approved leave. BOTH honor the CRM's own AM/PM half-day
 * marking (ampm → 0.5 day). So this raw tab still shows more/other rows than that de-noised,
 * advisory report — they answer different questions and are kept in sync by intent, never by
 * forcing the numbers to match.
 */
async function computeVacationPeriods(range: { dateFrom: string | null; dateTo: string | null }): Promise<{ periods: CrmMasterRow[]; truncated: boolean }> {
  const supabase = getSupabaseAdmin();
  const excludedInList = await getEffectiveExcludedInList();
  const PAGE = 1000;
  const MAX_ROWS = 60000;
  const days: VacationDayRow[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const base = supabase
      .from(CRM_VISITS_TABLE)
      .select("crm_visit_id, visit_date, ampm, agent_crm_id, agent_name, agent_hr_id, visit_type_description, comment")
      .ilike("visit_type_description", "%vacation%");
    let q = base as unknown as MasterQuery;
    if (excludedInList) {
      q = q.not("agent_crm_id", "in", excludedInList);
    }
    if (range.dateFrom) q = q.gte("visit_date", range.dateFrom);
    if (range.dateTo) q = q.lte("visit_date", range.dateTo);
    const { data, error } = await (q as unknown as typeof base)
      .order("agent_crm_id", { ascending: true })
      .order("visit_date", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error || !data) {
      if (days.length === 0) return { periods: [], truncated: false };
      break;
    }
    const rows = data as unknown as VacationDayRow[];
    days.push(...rows);
    if (rows.length < PAGE) break;
  }

  // Group by agent, then split each agent's (date-sorted) days into consecutive-day runs.
  const byAgent = new Map<number, VacationDayRow[]>();
  for (const d of days) {
    if (d.agent_crm_id == null || !d.visit_date) continue;
    const list = byAgent.get(d.agent_crm_id);
    if (list) list.push(d);
    else byAgent.set(d.agent_crm_id, [d]);
  }

  const periods: CrmMasterRow[] = [];
  for (const list of byAgent.values()) {
    list.sort((a, b) => String(a.visit_date).localeCompare(String(b.visit_date)));
    let run: VacationDayRow[] = [];
    for (const d of list) {
      if (run.length === 0) {
        run = [d];
        continue;
      }
      const prev = String(run[run.length - 1].visit_date).slice(0, 10);
      const cur = String(d.visit_date).slice(0, 10);
      if (cur === prev || isNextCalendarDay(prev, cur)) {
        run.push(d);
      } else {
        periods.push(buildVacationPeriod(run));
        run = [d];
      }
    }
    if (run.length > 0) periods.push(buildVacationPeriod(run));
  }

  periods.sort((x, y) => String(y.from_date).localeCompare(String(x.from_date)));
  return { periods, truncated: days.length >= MAX_ROWS };
}

/** Normalize the requested dataset to a known value. */
function normalizeDataset(value: CrmMasterDataset | undefined): CrmMasterDataset {
  return value && CRM_MASTER_DATASETS.some((d) => d.id === value) ? value : "visits";
}

/** Apply date + advanced + dataset-scope filters. Shared by the paginated view and the export. */
function applyMasterFilters(
  query: MasterQuery,
  opts: {
    agentHrId: string | null;
    allowedHrIds: string[] | null;
    ampm: CrmMasterAmpm;
    dataset: CrmMasterDataset;
    dateFrom: string | null;
    dateTo: string | null;
    mappingStatus: CrmMasterMappingStatus;
    search: string | null;
    visitType: string | null;
  },
  excludedInList: string = CRM_RESIGNED_IN_LIST,
): MasterQuery {
  const { agentHrId, allowedHrIds, ampm, dataset, dateFrom, dateTo, mappingStatus, search, visitType } = opts;
  const isCheckins = dataset === "checkins";
  const isVisits = isVisitDataset(dataset);
  const dateColumn = isCheckins ? "check_date" : "visit_date";

  let q = query;
  // Resigned/departed agents (owner-flagged + live status) are invisible across every CRM tab —
  // visits + check-ins alike. `excludedInList` is the effective (static ∪ live) list; defaults to
  // the static safety-net.
  if (excludedInList) {
    q = q.not("agent_crm_id", "in", excludedInList);
  }
  // Line / hiring-date filters resolve to a set of employee hr ids; empty set → match nobody.
  if (allowedHrIds) {
    q = q.in("agent_hr_id", allowedHrIds.length > 0 ? allowedHrIds : ["__no_match__"]);
  }
  if (dateFrom) q = q.gte(dateColumn, isCheckins ? `${dateFrom}T00:00:00` : dateFrom);
  if (dateTo) q = q.lte(dateColumn, isCheckins ? `${dateTo}T23:59:59` : dateTo);

  // Dataset scope.
  // Canonical double-visit = real partner on a fieldwork visit type (Regular 0 / Campaign -8),
  // the same predicate DV Analytics / probation / the portal use — so the DV tab count matches them
  // (a partnered Meeting/Conference is joint-attendance bookkeeping, not a double visit).
  if (dataset === "double_visits") {
    q = q.not("double_crm_id", "is", null).neq("double_crm_id", 0).in("visit_type", [...CRM_DOUBLE_VISIT_TYPE_CODES]);
  }
  if (dataset === "vacations") q = q.ilike("visit_type_description", "%vacation%");
  if (dataset === "regular_no_checkin") q = q.eq("reclassified_no_checkin", true);
  if (dataset === "regular_dv_no_checkin") {
    q = q.eq("reclassified_no_checkin", true).not("double_crm_id", "is", null).neq("double_crm_id", 0);
  }

  // Advanced filters. agent_hr_id exists on both tables; the rest are visits-only columns.
  if (agentHrId) {
    const escaped = sanitizeSearch(agentHrId);
    if (escaped) q = q.ilike("agent_hr_id", `%${escaped}%`);
  }
  if (isVisits && ampm !== "all") q = q.eq("ampm", ampm);
  if (isVisits && visitType) {
    const escaped = sanitizeSearch(visitType);
    if (escaped) q = q.ilike("visit_type_description", `%${escaped}%`);
  }
  if (isVisits && mappingStatus === "agent_mapped") q = q.not("agent_hr_id", "is", null);
  if (isVisits && mappingStatus === "agent_unmapped") q = q.is("agent_hr_id", null);
  if (search) {
    const escaped = sanitizeSearch(search);
    if (escaped) {
      const orExpr = isCheckins
        ? `agent_hr_id.ilike.%${escaped}%,contact_name.ilike.%${escaped}%,address.ilike.%${escaped}%`
        : `agent_name.ilike.%${escaped}%,double_name.ilike.%${escaped}%,contact_name.ilike.%${escaped}%,customer_name.ilike.%${escaped}%,agent_hr_id.ilike.%${escaped}%,comment.ilike.%${escaped}%`;
      q = q.or(orExpr);
    }
  }
  return q;
}

/** Merge derived columns onto rows (nearest check-in for visit datasets, triple flag for double
 * visits). `range` scopes the triple detection to the same dates. */
async function attachDerived(
  dataset: CrmMasterDataset,
  rows: CrmMasterRow[],
  range: { dateFrom: string | null; dateTo: string | null },
): Promise<void> {
  if (dataset === "visits" || dataset === "double_visits") await attachNearestCheckins(rows);
  if (dataset === "double_visits") {
    // Flag the double visits that are actually part of a triple (third person stacked that day).
    const { byVisitId } = await computeTriplesInRange(range);
    attachTripleFlag(rows, byVisitId);
  }
  if (isVisitDataset(dataset)) attachEffectiveType(dataset, rows);
  // "Line" + "Hiring Date" columns on every tab — the agent's roster metadata.
  attachAgentMeta(rows, await loadAgentMetaByHrId(), "agent_hr_id");
}

/**
 * Paginated master view of one CRM dataset (visits or check-ins). Returns every stored column
 * plus the full `raw_payload` for each row, ordered newest-first, with an exact total count.
 * Degrades to an empty result (never throws) when the mirror schema isn't present yet.
 */
export async function getCrmMasterData(input: CrmMasterFilter = {}): Promise<CrmMasterData> {
  const dataset = normalizeDataset(input.dataset);
  const isCheckins = dataset === "checkins";
  const page = Math.max(1, input.page ?? 1);
  const requested = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const pageSize = (CRM_MASTER_PAGE_SIZE_OPTIONS as readonly number[]).includes(requested)
    ? requested
    : Math.min(MAX_PAGE_SIZE, Math.max(10, requested));
  const dateFrom = input.dateFrom || null;
  const dateTo = input.dateTo || null;
  const search = input.search?.trim() || null;
  const agentHrId = input.agentHrId?.trim() || null;
  const ampm: CrmMasterAmpm = input.ampm === "AM" || input.ampm === "PM" ? input.ampm : "all";
  const visitType = input.visitType?.trim() || null;
  const line = input.line?.trim() || null;
  const hireFrom = input.hireFrom || null;
  const hireTo = input.hireTo || null;
  const minDuration = typeof input.minDuration === "number" && input.minDuration > 0 ? input.minDuration : null;
  const halfDaysOnly = input.halfDaysOnly === true;
  const mappingStatus: CrmMasterMappingStatus =
    input.mappingStatus === "agent_mapped" || input.mappingStatus === "agent_unmapped" ? input.mappingStatus : "all";
  const configured = isIReports360Configured();

  const columns = columnsForDataset(dataset);

  // Line / hiring-date resolve to an employee-hr-id allow-set (applied to every tab); load the line
  // options for the dropdown alongside it.
  const [allowed, lineOptions] = await Promise.all([
    resolveAllowedHrIds({ line, hireFrom, hireTo }),
    loadLineOptions(),
  ]);
  const filterOpts = {
    agentHrId,
    allowedHrIds: allowed ? allowed.hrIds : null,
    ampm,
    dataset,
    dateFrom,
    dateTo,
    mappingStatus,
    search,
    visitType,
  };
  // For the computed tabs (vacations, triples), the advanced filters run in memory over the rows.
  const computedFilter = {
    agentHrId,
    allowed: allowed ? allowed.keys : null,
    halfDaysOnly,
    minDuration,
    search,
  };

  // Fields echoed back so the UI can seed its filter inputs.
  const echo = {
    agentHrId,
    ampm,
    columns,
    configured,
    dataset,
    dateFrom,
    dateTo,
    halfDaysOnly,
    hireFrom,
    hireTo,
    line,
    lineOptions,
    mappingStatus,
    minDuration,
    page,
    pageSize,
    pageSizeOptions: CRM_MASTER_PAGE_SIZE_OPTIONS,
    search,
    visitType,
    visitTypeOptions: CRM_VISIT_TYPE_OPTIONS,
  };

  const empty = (schemaReady: boolean): CrmMasterData => ({
    ...echo,
    latestSyncRuns: [],
    rows: [],
    schemaReady,
    totalCount: 0,
  });

  if (!(await isCrmVisitsSchemaReady())) return empty(false);

  // Triple visits are a derived analytic (a self-join across visit rows), not a single-table filter:
  // detect them in memory over the date range, then paginate the computed result.
  if (dataset === "triple_visits") {
    const [{ rows: allTriples, truncated }, latestSyncRuns, agentMeta] = await Promise.all([
      computeTriplesInRange({ dateFrom, dateTo }),
      getLatestVisitsSyncRuns(6),
      loadAgentMetaByHrId(),
    ]);
    // Advanced filters apply to the rep (base) of each triple; Duration/half are vacation-only.
    const filtered = filterComputedRows(allTriples, { ...computedFilter, halfDaysOnly: false, hrIdField: "base_hr_id", minDuration: null });
    const start = (page - 1) * pageSize;
    const pageRows = filtered.slice(start, start + pageSize);
    attachAgentMeta(pageRows, agentMeta, "base_hr_id"); // triples show the rep's line + hiring date
    return {
      ...echo,
      latestSyncRuns,
      rows: pageRows,
      schemaReady: true,
      totalCount: filtered.length,
      truncated,
    };
  }

  // Vacations are grouped into periods (consecutive days), not shown per day — compute + paginate.
  if (dataset === "vacations") {
    const [{ periods: allPeriods, truncated }, latestSyncRuns, agentMeta] = await Promise.all([
      computeVacationPeriods({ dateFrom, dateTo }),
      getLatestVisitsSyncRuns(6),
      loadAgentMetaByHrId(),
    ]);
    const filtered = filterComputedRows(allPeriods, { ...computedFilter, hrIdField: "agent_hr_id" });
    const start = (page - 1) * pageSize;
    const pageRows = filtered.slice(start, start + pageSize);
    attachAgentMeta(pageRows, agentMeta, "agent_hr_id");
    return {
      ...echo,
      latestSyncRuns,
      rows: pageRows,
      schemaReady: true,
      totalCount: filtered.length,
      truncated,
    };
  }

  const supabase = getSupabaseAdmin();
  const table = dataset === "regular_no_checkin" || dataset === "regular_dv_no_checkin" ? CRM_VISITS_EFFECTIVE_VIEW : isCheckins ? CRM_CHECKINS_TABLE : CRM_VISITS_TABLE;
  const dateColumn = isCheckins ? "check_date" : "visit_date";
  const idColumn = isCheckins ? "crm_checkin_id" : "crm_visit_id";
  const select = isCheckins ? CHECKIN_SELECT : VISIT_SELECT;

  const excludedInList = await getEffectiveExcludedInList();
  const base = supabase.from(table).select(select, { count: "exact" });
  const filtered = applyMasterFilters(base as unknown as MasterQuery, filterOpts, excludedInList);
  const ordered = (filtered as unknown as typeof base)
    .order(dateColumn, { ascending: false })
    .order(idColumn, { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);

  const [{ data, error, count }, latestSyncRuns] = await Promise.all([ordered, getLatestVisitsSyncRuns(6)]);
  if (error) {
    if (isCrmSchemaMissingError(error)) return empty(false);
    throw new Error(error.message);
  }

  const rows = (data ?? []) as unknown as CrmMasterRow[];
  await attachDerived(dataset, rows, { dateFrom, dateTo });

  return { ...echo, latestSyncRuns, rows, schemaReady: true, totalCount: count ?? 0 };
}

/**
 * All matching rows for a dataset + filters, UNPAGINATED (capped at 50k) — powers the XLSX export.
 * Runs the same filters and derived columns as the paginated view; walks pages internally.
 */
export async function getCrmMasterExportRows(
  input: CrmMasterFilter = {},
): Promise<{ columns: readonly CrmMasterColumn[]; dataset: CrmMasterDataset; rows: CrmMasterRow[]; truncated: boolean }> {
  const dataset = normalizeDataset(input.dataset);
  const isCheckins = dataset === "checkins";
  const columns = columnsForDataset(dataset);
  const agentHrId = input.agentHrId?.trim() || null;
  const search = input.search?.trim() || null;
  const line = input.line?.trim() || null;
  const hireFrom = input.hireFrom || null;
  const hireTo = input.hireTo || null;
  const minDuration = typeof input.minDuration === "number" && input.minDuration > 0 ? input.minDuration : null;
  const halfDaysOnly = input.halfDaysOnly === true;

  const emptyResult = { columns, dataset, rows: [] as CrmMasterRow[], truncated: false };
  if (!(await isCrmVisitsSchemaReady())) return emptyResult;

  const allowed = await resolveAllowedHrIds({ line, hireFrom, hireTo });
  const filterOpts = {
    agentHrId,
    allowedHrIds: allowed ? allowed.hrIds : null,
    ampm: (input.ampm === "AM" || input.ampm === "PM" ? input.ampm : "all") as CrmMasterAmpm,
    dataset,
    dateFrom: input.dateFrom || null,
    dateTo: input.dateTo || null,
    mappingStatus: (input.mappingStatus === "agent_mapped" || input.mappingStatus === "agent_unmapped"
      ? input.mappingStatus
      : "all") as CrmMasterMappingStatus,
    search,
    visitType: input.visitType?.trim() || null,
  };
  const computedFilter = { agentHrId, allowed: allowed ? allowed.keys : null, halfDaysOnly, minDuration, search };

  // Triple visits: computed in memory (self-join), so export all detected triples for the range.
  if (dataset === "triple_visits") {
    const [{ rows: allTriples, truncated }, agentMeta] = await Promise.all([
      computeTriplesInRange({ dateFrom: filterOpts.dateFrom, dateTo: filterOpts.dateTo }),
      loadAgentMetaByHrId(),
    ]);
    const rows = filterComputedRows(allTriples, { ...computedFilter, halfDaysOnly: false, hrIdField: "base_hr_id", minDuration: null });
    attachAgentMeta(rows, agentMeta, "base_hr_id");
    return { columns, dataset, rows, truncated };
  }

  // Vacations: grouped into periods, so export all periods for the range.
  if (dataset === "vacations") {
    const [{ periods: allPeriods, truncated }, agentMeta] = await Promise.all([
      computeVacationPeriods({ dateFrom: filterOpts.dateFrom, dateTo: filterOpts.dateTo }),
      loadAgentMetaByHrId(),
    ]);
    const rows = filterComputedRows(allPeriods, { ...computedFilter, hrIdField: "agent_hr_id" });
    attachAgentMeta(rows, agentMeta, "agent_hr_id");
    return { columns, dataset, rows, truncated };
  }

  const supabase = getSupabaseAdmin();
  const table = dataset === "regular_no_checkin" || dataset === "regular_dv_no_checkin" ? CRM_VISITS_EFFECTIVE_VIEW : isCheckins ? CRM_CHECKINS_TABLE : CRM_VISITS_TABLE;
  const dateColumn = isCheckins ? "check_date" : "visit_date";
  const idColumn = isCheckins ? "crm_checkin_id" : "crm_visit_id";
  const select = isCheckins ? CHECKIN_SELECT : VISIT_SELECT;

  const excludedInList = await getEffectiveExcludedInList();
  const PAGE = 1000;
  const MAX_ROWS = 50000;
  const rows: CrmMasterRow[] = [];
  let truncated = false;
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const base = supabase.from(table).select(select);
    const filtered = applyMasterFilters(base as unknown as MasterQuery, filterOpts, excludedInList);
    const { data, error } = await (filtered as unknown as typeof base)
      .order(dateColumn, { ascending: false })
      .order(idColumn, { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) {
      if (isCrmSchemaMissingError(error)) return emptyResult;
      throw new Error(error.message);
    }
    const pageRows = (data ?? []) as unknown as CrmMasterRow[];
    rows.push(...pageRows);
    if (pageRows.length < PAGE) break;
    if (rows.length >= MAX_ROWS) {
      truncated = true;
      break;
    }
  }

  await attachDerived(dataset, rows, { dateFrom: filterOpts.dateFrom, dateTo: filterOpts.dateTo });
  return { columns, dataset, rows, truncated };
}
