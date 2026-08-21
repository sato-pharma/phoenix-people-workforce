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
import {
  CRM_CHECKINS_TABLE,
  CRM_CUSTOMER_BRICK_RESOLUTIONS_TABLE,
  CRM_REGION_BRICK_RESOLUTIONS_TABLE,
  CRM_VISITS_TABLE,
} from "@/lib/crm/tables";
import { addDaysIso } from "@/lib/crm/dates";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { isCrmSchemaMissingError, isCrmVisitsSchemaReady } from "@/lib/crm/schema";
import { isIReports360Configured } from "@/lib/crm/config";
import { getLatestVisitsSyncRuns } from "@/lib/crm/admin";
import { CRM_RESIGNED_IN_LIST, CRM_DOUBLE_VISIT_TYPE_CODES, expandHrIdFilterValues, getEffectiveExcludedInList, queryCheckins, resolveVisitTime } from "@/lib/crm/reads";
import { indexCheckinsByAgentContactDay, pickCheckinForVisit } from "@/lib/crm/checkin-match";
import { canonicalHrIdKey } from "@/lib/hr-id";
import {
  intersectHrIdAllowLists,
  intersectHrIdKeySets,
  type CrmViewerScope,
} from "@/lib/crm/viewer-scope";
import type { VisitsSyncRun } from "@/lib/visits-report/types";
import { brickMatchConfidence, loadBrickCentroids, resolveBrickForPoint } from "@/lib/crm/brick-geo";
import { logError } from "@/lib/observability/log";
import {
  CRM_MASTER_DATASETS,
  CRM_MASTER_SUPPORTED_FILTERS,
  crmMasterSupportsFilter,
  type CrmMasterDataset,
  type CrmMasterFilterKey,
} from "@/lib/crm/master-datasets";

export { CRM_MASTER_DATASETS, CRM_MASTER_SUPPORTED_FILTERS, crmMasterSupportsFilter, type CrmMasterDataset, type CrmMasterFilterKey };

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
  {
    key: "recognition_score",
    kind: "text",
    label: "Recognized",
    note: "How completely Phoenix resolved this row: 100% = agent (and double partner, if any) mapped to a real employee, the visit target identified, and — for Regular visits — the CRM region resolved to a Phoenix brick. 75%/50% = missing one/two of those checks. Blank = mostly unresolved, worth investigating (hover the badge for exactly what's missing).",
  },
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
  { key: "crm_region_id", kind: "number", label: "CRM Region ID", note: "iReports360's own locality id for the visited contact (vendor field: regionID, added 2026-07-22). Finer-grained than Phoenix's own geography — one Phoenix brick/area typically covers several of these. Null on non-customer visit types (campaign/meeting/leave)." },
  { key: "crm_region_name", kind: "text", label: "CRM Region Name", note: "iReports360's display name for the CRM Region ID (vendor field: region)." },
  { key: "phx_brick_id", kind: "text", label: "PHX Mapped Brick ID", note: "The real Phoenix brick (source_of_sales_bricks) an admin has mapped this CRM region to — see the Region Mapping tab. '—' until resolved." },
  { key: "phx_area_id", kind: "text", label: "PHX Area ID", note: "The mapped brick's Phoenix area code (source_of_sales_bricks.area_code)." },
  { key: "phx_region_id", kind: "text", label: "PHX Region ID", note: "The mapped brick's Phoenix region code (source_of_sales_bricks.region_code)." },
  { key: "speciality", kind: "text", label: "Speciality", note: "The visited contact's medical specialty from iReports360 (vendor field: speciality, added 2026-07-22). Null on non-customer visit types." },
  { key: "crm_contact_grade", kind: "text", label: "Grade", note: "The visited contact's (doctor/hospital/pharmacy) commercial potential grade from iReports360 (vendor field: contactGrade, added 2026-07-24) — A+/A highest potential down to C lowest. Normalized to uppercase/trimmed at sync time (the vendor sends inconsistent casing/whitespace). Null on non-customer visit types." },
  { key: "visit_type", kind: "number", label: "Visit Type" },
  { key: "visit_type_description", kind: "text", label: "Visit Type Description" },
  { key: "effective_type", kind: "text", label: "Effective Type", note: "How the system counts this visit. A Regular visit with NO matching GPS check-in is counted as Campaign — always shown here (flagged), never silently recounted." },
  { key: "call_type", kind: "number", label: "Call Type" },
  // DELIBERATELY NOT A COLUMN: the vendor's `attendance` field. iReports360 documents it as
  // "1=present, 0=absent", but it is a dead field — measured across the whole production mirror
  // on 2026-08-21, all 122,814 visits since January carry either 0 (120,922) or NULL (1,892) and
  // NOT ONE row has ever been 1. A column with zero variance is not data, it is a wall of noise
  // that reads to anyone opening the export as "every rep was absent on every visit all year".
  // It is still fetched from the API and still stored (see sync.ts), so nothing is lost and the
  // column can come straight back the day the vendor starts populating it — but until it varies
  // it does not belong in front of a human. Real attendance here means "did the rep check in on
  // a customer" and is derived from the GPS check-in (see sfe-field-analytics.ts and the
  // `effective_type` column below), never from this field.
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
  {
    key: "geo_brick",
    kind: "text",
    label: "Brick (GPS)",
    note: "The Phoenix brick this visit physically happened in, resolved from the matched GPS check-in's coordinates by nearest brick centre — NOT from the CRM region or any address text. Blank when the visit has no matching check-in (only Regular visits carry a contact) — that is exactly the set the 'Regular · No Check-in' tab lists. Read together with the Confidence column.",
  },
  { key: "geo_area", kind: "text", label: "Area (GPS)", note: "The area of the GPS-resolved brick." },
  { key: "geo_region", kind: "text", label: "Region (GPS)", note: "The region of the GPS-resolved brick." },
  {
    key: "geo_confidence",
    kind: "text",
    label: "Confidence / Note",
    note: "How far the matched check-in is from the centre of the brick it resolved to. High (≤1km) = inside/next to that brick. Good (≤3km). Review (≤10km) = verify before relying on it. Weak (>10km) = the nearest known brick centre is far away, treat the brick as a hint. '—' means this visit had no matching GPS check-in to resolve from.",
  },
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
  {
    key: "geo_brick",
    kind: "text",
    label: "Brick (GPS)",
    note: "The Phoenix brick this check-in physically happened in, resolved from its GPS coordinates by nearest brick centre (source_of_sales_bricks + their geocoded centroids) — NOT from the address text. Only active bricks are ever proposed. Always read it together with the Confidence column: a nearest-centroid match is exact in dense areas and approximate where brick centres are far apart.",
  },
  { key: "geo_area", kind: "text", label: "Area (GPS)", note: "The area of the GPS-resolved brick." },
  { key: "geo_region", kind: "text", label: "Region (GPS)", note: "The region of the GPS-resolved brick." },
  {
    key: "geo_confidence",
    kind: "text",
    label: "Confidence / Note",
    note: "How far this check-in is from the centre of the brick it was matched to. High (≤1km) = inside/next to that brick. Good (≤3km). Review (≤10km) = verify before relying on it. Weak (>10km) = the nearest known brick centre is far away, so treat the brick as a hint only. '—' means the check-in has no usable coordinates, or no brick centroids are available yet.",
  },
  { key: "synced_at", kind: "datetime", label: "Synced At", note: "When Phoenix pulled this record from the CRM into its mirror (Cairo time)." },
];

/** Vacation / issue tabs reuse the visit fields WITHOUT the nearest-check-in block (those records
 * have no check-in). Derived so the base column set stays defined in one place. */
const CRM_VISIT_BASE_COLUMNS: readonly CrmMasterColumn[] = CRM_VISIT_COLUMNS.filter(
  // Also drops the geo_* columns: those are derived FROM the matched check-in, so on the
  // "No Check-in" tabs (whose whole definition is having none) they could only ever be empty.
  (col) => !col.key.startsWith("checkin_") && !col.key.startsWith("geo_"),
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
  "id, crm_visit_id, agent_crm_id, agent_hr_id, agent_name, ampm, call_type, comment, " +
  "contact_crm_id, contact_name, crm_contact_grade, crm_region_id, crm_region_name, crm_save_date, " +
  "customer_name, double_crm_id, double_hr_id, double_name, speciality, visit_date, visit_type, " +
  "visit_type_description, synced_at, raw_payload";

const CHECKIN_SELECT =
  "id, crm_checkin_id, agent_crm_id, agent_hr_id, contact_crm_id, contact_name, lat, lon, address, " +
  "check_date, synced_at, raw_payload";

export type CrmMasterRow = Record<string, unknown> & { id: string; raw_payload: Record<string, unknown> | null };

/** Drops `raw_payload` from a select list. Used by the export, which never renders it — see the
 * comment at its call site for why that matters at scale. Splits on commas rather than doing a
 * string replace so it can't be broken by a whitespace change in the constants. */
function withoutRawPayload(select: string): string {
  return select
    .split(",")
    .map((column) => column.trim())
    .filter((column) => column && column !== "raw_payload")
    .join(", ");
}

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
  lt: (...args: any[]) => MasterQuery;
  lte: (...args: any[]) => MasterQuery;
  in: (...args: any[]) => MasterQuery;
  neq: (...args: any[]) => MasterQuery;
  not: (...args: any[]) => MasterQuery;
  or: (...args: any[]) => MasterQuery;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Ascending comparator for ISO date / timestamp strings.
 *
 * Deliberately NOT `localeCompare`: these are machine strings (`2026-07-31`, `2026-07-31T08:14:00`),
 * and localeCompare sorts them under whatever locale + ICU data the runtime happens to carry —
 * hyphens and digits are exactly the characters locale collation treats as variable-weight, so the
 * ordering is environment-dependent for values where plain lexicographic order is both correct and
 * total. Every caller here sorts ISO strings, so compare them as strings.
 */
function compareIso(left: unknown, right: unknown): number {
  const a = String(left ?? "");
  const b = String(right ?? "");
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Escapes a free-text search term for a PostgREST `or(...ilike...)` expression.
 *
 * `*` is stripped alongside `%`: PostgREST translates `*` in an `ilike` pattern to SQL's `%`, so a
 * user typing a bare `*` (or a product code like "B*12") silently became a wildcard and matched
 * every row — the opposite of narrowing. `,` and `()` are structural in an `or(...)` expression and
 * would otherwise let a search term break out of its own predicate. */
function sanitizeSearch(term: string): string {
  return term.replace(/[%*,()]/g, " ").trim();
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
  // GPS-derived geography of the matched check-in (see attachNearestCheckins): null for a visit
  // with no matching check-in, which is the honest answer — that visit has no verified location.
  "geo_brick",
  "geo_area",
  "geo_region",
  "geo_confidence",
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

/** Columns attachNearestCheckins needs from ireports360_checkins — shared by the per-page fetch
 * (paginated master view) and the whole-export preload (streaming export; see
 * preloadCheckinsIndexForExport). */
const NEAREST_CHECKIN_COLUMNS =
  "crm_checkin_id, check_date, agent_crm_id, agent_hr_id, contact_crm_id, contact_name, lat, lon, address, synced_at";

/**
 * Pre-loads EVERY check-in for the export's own date range (or the whole table, if unfiltered) ONCE
 * and indexes it by agent+contact+day, so attachNearestCheckins never re-queries per page. The
 * naive per-page approach — filtering by that page's own (often 80-90) agent ids via `.in(...)`
 * combined with a date range — doesn't hit this table's `(agent_crm_id, check_date)` composite index
 * cleanly (same query shape the queryCheckins docstring already measured at up to 12.8s for a single
 * 30-day/112-agent call); multiplied across ~20-100+ export pages that's the several-MINUTE export
 * duration behind the 2026-07-29 incident (a real-world request that slow gets its connection cut
 * before the workbook's closing zip bytes are written, producing a corrupted .xlsx). Fetching the
 * full range ONCE lets queryCheckins use its own efficient no-agent-filter, keyset-by-check_date scan
 * instead. Checkins are a bounded table (~91k rows total as of 2026-07), so holding the whole result
 * in memory once is trivial next to the per-cell-styling memory blowup the streaming rewrite already
 * fixed — an entirely different order of magnitude.
 */
async function preloadCheckinsIndexForExport(range: { dateFrom: string | null; dateTo: string | null }): Promise<Map<string, CheckinLite[]>> {
  try {
    const data = await queryCheckins<CheckinLite>({
      dateFrom: range.dateFrom ?? undefined,
      dateTo: range.dateTo ?? undefined,
      columns: NEAREST_CHECKIN_COLUMNS,
    });
    return indexCheckinsByAgentContactDay(data);
  } catch (error) {
    // DELIBERATELY NOT SWALLOWED (it used to return an empty Map). An empty index makes every
    // Regular visit look like it has no check-in, and attachEffectiveType then RECLASSIFIES all of
    // them as "Campaign — reclassified". In a downloadable workbook that is a permanent artifact
    // stating, with total confidence, that an entire team did zero verified regular visits — a
    // classification manufactured out of an infrastructure error. A failed export the user retries
    // is strictly better than a plausible, wrong one they act on.
    //
    // Safe to throw here: this runs during resource setup BEFORE the generator yields its first
    // page, so no workbook bytes have been written yet and the request fails cleanly rather than
    // truncating mid-stream (the corrupted-.xlsx failure mode of the 2026-07-29 incident).
    throw new Error(
      `CRM export aborted: the check-in correlation data could not be loaded, so Regular visits cannot be verified. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Returns whether the check-in correlation actually RAN. `false` means the check-in read failed and
 * every row's `checkin_id` is null for that reason alone — not because those visits have no
 * check-in. attachEffectiveType must not reclassify on a `false`; see the degradation rule there.
 */
async function attachNearestCheckins(rows: CrmMasterRow[], preloadedIndex?: Map<string, CheckinLite[]>): Promise<boolean> {
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

  let index: Map<string, CheckinLite[]>;
  if (preloadedIndex) {
    index = preloadedIndex;
  } else {
    // No pre-built index (the paginated master table view — one page at a time, so the per-call
    // cost this function's own docstring warns about never gets multiplied): fall back to the
    // original per-call scoped fetch.
    const agentIds = Array.from(
      new Set(rows.map((r) => r.agent_crm_id).filter((v): v is number => typeof v === "number")),
    );
    const days = rows
      .map((r) => (typeof r.visit_date === "string" ? r.visit_date.slice(0, 10) : null))
      .filter((v): v is string => Boolean(v));
    // Nothing correlatable on this page (no agent ids or no dates) — not a failure: no check-in
    // could match these rows anyway, so the "no check-in" answer is genuine and reclassifying is
    // correct. Distinct from the catch below, which is a failure.
    if (agentIds.length === 0 || days.length === 0) return true;
    const from = days.reduce((a, b) => (a < b ? a : b));
    const to = days.reduce((a, b) => (a > b ? a : b));
    let data: CheckinLite[];
    try {
      data = await queryCheckins<CheckinLite>({ agentCrmIds: agentIds, dateFrom: from, dateTo: to, columns: NEAREST_CHECKIN_COLUMNS });
    } catch (error) {
      // The paginated table view degrades rather than throwing (unlike the export above): the page
      // still renders with the GPS/geography overlay columns blank, which is honestly "unknown".
      // But it reports the failure so attachEffectiveType leaves the visit TYPE alone instead of
      // relabelling the whole page Campaign.
      logError("CRM master: check-in correlation failed; visit types left unreclassified", {
        error,
        labels: { event: "crm_master_checkin_correlation_failed" },
      });
      return false;
    }
    index = indexCheckinsByAgentContactDay(data);
  }

  // Brick centroids for the GPS-geography columns below (cached; empty list = columns stay null).
  const centroids = await loadBrickCentroids();

  // Same agent + CONTACT + day matcher as the Visits Report (crm/checkin-match.ts), tie broken by
  // crm_save_date — so a given visit resolves to the SAME check-in on both surfaces.
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
    // The matched check-in is this visit's only GPS-verified position, so it is also the only
    // trustworthy source for the visit's real geography — resolve it to a Phoenix brick. Visits
    // without a matching check-in keep null here rather than borrowing geography they can't prove.
    const geo = centroids.length > 0 ? resolveBrickForPoint(best.lat, best.lon, centroids) : null;
    if (geo) {
      row.geo_brick = [geo.brickId, geo.brickName].filter(Boolean).join(" · ");
      row.geo_area = geo.areaName;
      row.geo_region = geo.regionName;
      row.geo_confidence = brickMatchConfidence(geo.distanceKm);
    }
  }
  return true;
}

/** Set the "Logged/save" visit time from crm_save_date only (no check-in query) — for the two
 * No-Check-in tabs, whose rows have no matching GPS check-in by definition. `visit_time` is a
 * DERIVED field (not in VISIT_SELECT), so without this those tabs rendered a blank Visit Time even
 * though a real save-time is available; the neighbouring CRM Save Date column was already populated,
 * making the gap visibly inconsistent. */
function attachSaveTierVisitTime(rows: CrmMasterRow[]): void {
  for (const row of rows) {
    const saveTier = resolveVisitTime({
      nearestCheckinTime: null,
      crmSaveDate: typeof row.crm_save_date === "string" ? row.crm_save_date : null,
    });
    row.visit_time = saveTier.time;
    row.visit_time_source = visitTimeSourceLabel(saveTier.source);
  }
}

/** Effective visit type: a Regular visit (0) with NO matched GPS check-in is COUNTED as Campaign,
 * but ALWAYS flagged here — never a silent recount. For regular_no_checkin every row is reclassified
 * (the tab filters to it); for visits/double it's derived from the in-memory check-in correlation
 * (checkin_id null). Datasets that don't correlate (vacations, triples) keep the raw type.
 *
 * DEGRADATION RULE (the module-wide one): a cosmetic OVERLAY may fall back to null — a blank
 * Check-in Address or GPS brick reads as "unknown", which is honest. A CLASSIFICATION may not. When
 * `checkinCorrelationAvailable` is false the check-in read FAILED, so every `checkin_id` is null for
 * that reason alone; reclassifying then would turn an infrastructure error into the confident,
 * wrong statement that a whole team did no verified regular visits. Keep the raw vendor type
 * instead — the one value we still actually know.
 *
 * `checkinCorrelationAvailable` is REQUIRED, deliberately not defaulted. A `= true` default fails
 * OPEN, which is precisely backwards for a rule about classifications: a future caller that simply
 * forgot the argument would silently get the pre-fix behaviour back — an outage relabelling a whole
 * team's Regular visits as Campaign, reintroduced by omission rather than by decision. Required
 * means the type checker names every call site instead of trusting nobody forgets.
 *
 * Exported for the behavioural test in tests/crm-degradation-policy.test.ts. */
export function attachEffectiveType(
  dataset: CrmMasterDataset,
  rows: CrmMasterRow[],
  checkinCorrelationAvailable: boolean,
): void {
  const knowsCheckin =
    (dataset === "visits" && checkinCorrelationAvailable) ||
    (dataset === "double_visits" && checkinCorrelationAvailable) ||
    dataset === "regular_no_checkin" ||
    dataset === "regular_dv_no_checkin";
  // The two No-Check-in tabs are filtered at the DB by the `reclassified_no_checkin` column, so they
  // never depended on the in-memory correlation and stay correct even when it fails.
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
type TriplesResult = {
  rows: CrmMasterRow[];
  byVisitId: Map<number, { third: string; unspecified: boolean }>;
  truncated: boolean;
};

/**
 * Short-TTL memo for {@link computeTriplesUncached}, keyed by the date range.
 *
 * The Double Visits tab passes NO precomputed resources on the view path, so every page render —
 * and every Next/Prev click — re-ran the full self-join below: up to 60 sequential 1000-row pages,
 * over the ENTIRE mirror history, because both entry pages default the date range to null. All of
 * that to populate one flag column for the ~50 rows actually on screen. The export path already
 * did this correctly by computing once and passing it via `resources`; the view path now gets the
 * same benefit. Same cache-with-TTL shape as getEffectiveExclusion in crm/reads.ts.
 */
const TRIPLES_CACHE_TTL_MS = 60_000;
const TRIPLES_CACHE_MAX = 20;
const triplesCache = new Map<string, { at: number; value: TriplesResult }>();

async function computeTriplesInRange(range: {
  dateFrom: string | null;
  dateTo: string | null;
}): Promise<TriplesResult> {
  const key = `${range.dateFrom ?? ""}|${range.dateTo ?? ""}`;
  const cached = triplesCache.get(key);
  if (cached && Date.now() - cached.at < TRIPLES_CACHE_TTL_MS) return cached.value;
  const value = await computeTriplesUncached(range);
  // Bounded: distinct date ranges are few in practice, but never let this grow without limit.
  if (triplesCache.size >= TRIPLES_CACHE_MAX) triplesCache.clear();
  triplesCache.set(key, { at: Date.now(), value });
  return value;
}

async function computeTriplesUncached(range: {
  dateFrom: string | null;
  dateTo: string | null;
}): Promise<TriplesResult> {
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

  rows.sort((x, y) => compareIso(y.visit_date, x.visit_date));
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

/** One CRM region's resolved Phoenix brick mapping (joined against the real brick master). */
type BrickMapping = { areaId: string | null; brickId: string; regionId: string | null };

/** Builds crm_region_id -> {brickId, areaId, regionId} from every "mapped" resolution, joined
 * against source_of_sales_bricks for the brick's real area_code/region_code — the same master
 * validated against the owner's manually-mapped xlsx (2026-07-22). Small table (bounded by
 * distinct CRM region count, ~300), so one unpaginated read is safe. Degrades to an empty map on
 * any error (cells then show "—") — this is a display overlay, never load-bearing for the sync. */
async function loadBrickMappingByRegionId(): Promise<Map<number, BrickMapping>> {
  const supabase = getSupabaseAdmin();
  const map = new Map<number, BrickMapping>();
  try {
    const { data: resolutions, error: resolutionsError } = await supabase
      .from(CRM_REGION_BRICK_RESOLUTIONS_TABLE)
      .select("crm_region_id, brick_id")
      .eq("status", "mapped")
      .not("brick_id", "is", null);
    if (resolutionsError) return map;
    const rows = (resolutions ?? []) as Array<{ brick_id: string | null; crm_region_id: number }>;
    if (rows.length === 0) return map;

    const brickIds = Array.from(new Set(rows.map((r) => r.brick_id).filter((v): v is string => Boolean(v))));
    const { data: bricks, error: bricksError } = await supabase
      .from("source_of_sales_bricks")
      .select("brick_id, area_code, region_code")
      .in("brick_id", brickIds);
    if (bricksError) return map;
    const brickById = new Map(
      ((bricks ?? []) as Array<{ area_code: string | null; brick_id: string; region_code: string | null }>).map(
        (b) => [b.brick_id, b],
      ),
    );

    for (const row of rows) {
      if (!row.brick_id) continue;
      const brick = brickById.get(row.brick_id);
      map.set(row.crm_region_id, {
        areaId: brick?.area_code ?? null,
        brickId: row.brick_id,
        regionId: brick?.region_code ?? null,
      });
    }
  } catch {
    return map;
  }
  return map;
}

/** Builds crm_contact_id -> {brickId, areaId, regionId} from every "mapped" CUSTOMER resolution.
 * Same shape as {@link loadBrickMappingByRegionId}, but per individual customer, which is strictly
 * more precise than the region-level mapping (a CRM region spans many bricks). Degrades to an empty
 * map on any error — display overlay only, never load-bearing. */
async function loadBrickMappingByContactId(): Promise<Map<number, BrickMapping>> {
  const supabase = getSupabaseAdmin();
  const map = new Map<number, BrickMapping>();
  try {
    // Paginated with an EXPLICIT order: this table is one row per resolved CRM contact and the
    // migration sizes it at ~12.5k, so a single unpaginated read would silently stop at
    // PostgREST's 1,000-row cap and quietly re-show already-mapped customers as unmapped. Offset
    // paging is only exact when the order is stable.
    //
    // The order is now the `tiebreakColumn` ARGUMENT rather than an `.order()` inside the builder.
    // Same query, but the guarantee moves somewhere it can be enforced: the builder is an opaque
    // callback, so fetchAllRows cannot verify an order hidden inside it — which is how this class of
    // bug reached production three times. crm_contact_id is unique here, so the order is total.
    const resolutions = await fetchAllRows<{ brick_id: string | null; crm_contact_id: number }>(
      () =>
        supabase
          .from(CRM_CUSTOMER_BRICK_RESOLUTIONS_TABLE)
          .select("crm_contact_id, brick_id")
          .eq("status", "mapped")
          .not("brick_id", "is", null),
      "crm_contact_id",
    );
    if (resolutions.length === 0) return map;

    const brickIds = Array.from(new Set(resolutions.map((r) => r.brick_id).filter((v): v is string => Boolean(v))));
    const brickById = new Map<string, { area_code: string | null; brick_id: string; region_code: string | null }>();
    // Chunked: the contact mapping can cover thousands of distinct bricks, and PostgREST folds an
    // `.in()` list into the request URL, which overflows past a few hundred values.
    for (let i = 0; i < brickIds.length; i += 200) {
      const { data: bricks, error: bricksError } = await supabase
        .from("source_of_sales_bricks")
        .select("brick_id, area_code, region_code")
        .in("brick_id", brickIds.slice(i, i + 200));
      if (bricksError) return map;
      for (const b of (bricks ?? []) as Array<{ area_code: string | null; brick_id: string; region_code: string | null }>) {
        brickById.set(b.brick_id, b);
      }
    }

    for (const row of resolutions) {
      if (!row.brick_id) continue;
      const brick = brickById.get(row.brick_id);
      map.set(row.crm_contact_id, {
        areaId: brick?.area_code ?? null,
        brickId: row.brick_id,
        regionId: brick?.region_code ?? null,
      });
    }
  } catch {
    return map;
  }
  return map;
}

/** Sets each visit row's phx_brick_id/phx_area_id/phx_region_id.
 *
 * Prefers the CUSTOMER-level mapping (by crm_contact_id) and falls back to the REGION-level one,
 * which is what both the customer-mapping migration and customer-brick.ts always promised
 * ("downstream readers prefer it and fall back to the region mapping") but nothing actually did:
 * this function only ever read the region map, so every customer mapping an admin resolved — the
 * finest geography available, across ~12.7k mappable contacts — had literally no effect on any
 * displayed brick, and Regular visits were additionally docked 25% of their recognition score for
 * a missing brick that had in fact been mapped.
 *
 * Unmapped/unset contacts and regions correctly show "—" throughout (crm_contact_grade comes
 * straight from the SELECT now — see VISIT_SELECT — so it needs no synthesized placeholder here). */
function attachBrickMapping(
  rows: CrmMasterRow[],
  mapByRegionId: Map<number, BrickMapping>,
  mapByContactId: Map<number, BrickMapping> = new Map(),
): void {
  for (const row of rows) {
    const contactId = typeof row.contact_crm_id === "number" && row.contact_crm_id !== 0 ? row.contact_crm_id : null;
    const regionId = typeof row.crm_region_id === "number" ? row.crm_region_id : null;
    const mapping =
      (contactId != null ? mapByContactId.get(contactId) : undefined) ??
      (regionId != null ? mapByRegionId.get(regionId) : undefined);
    row.phx_brick_id = mapping?.brickId ?? null;
    row.phx_area_id = mapping?.areaId ?? null;
    row.phx_region_id = mapping?.regionId ?? null;
  }
}

/**
 * Check-ins only: resolve each row's GPS coordinates to the nearest Phoenix brick, filling the
 * Brick/Area/Region (GPS) columns plus the human "Confidence / Note" distance label. A check-in is
 * the one CRM record that always has real coordinates but carries no Phoenix geography of its own,
 * so this is derived here rather than stored. Best-effort: with no centroids (or no coordinates on a
 * row) the columns stay null and render "—" — never a fabricated brick.
 */
async function attachGeoBrick(rows: CrmMasterRow[]): Promise<void> {
  const centroids = await loadBrickCentroids();
  for (const row of rows) {
    const lat = typeof row.lat === "number" ? row.lat : null;
    const lon = typeof row.lon === "number" ? row.lon : null;
    const hit = centroids.length > 0 ? resolveBrickForPoint(lat, lon, centroids) : null;
    row.geo_brick = hit ? [hit.brickId, hit.brickName].filter(Boolean).join(" · ") : null;
    row.geo_area = hit?.areaName ?? null;
    row.geo_region = hit?.regionName ?? null;
    row.geo_confidence = hit ? brickMatchConfidence(hit.distanceKm) : null;
  }
}

/** Non-empty (post-trim) string check — the recurring "is this field actually filled in" test
 * used all over the recognition score below. */
function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Recognition score: how completely Phoenix could resolve THIS row's identity/data, as a percent
 * of 4 equally-weighted checks — 100 / 75 / 50 / null (below 50%, shown blank so it stands out).
 * A check that structurally doesn't apply to this row (no double partner; a non-Regular visit
 * type, which the vendor never sends region/speciality for) is NOT held against the row — it
 * auto-passes, so a plain Campaign visit with everything resolvable actually resolved still reads
 * 100%, instead of every non-Regular visit being capped below it by construction.
 *
 * 1. Agent identity  — agent_hr_id resolved to a real Phoenix employee.
 * 2. Double identity — only when double_crm_id is set: double_hr_id resolved too.
 * 3. Visit target    — contact_name, customer_name, or comment names who/where was visited.
 * 4. Geography       — only for Regular visits (visit_type 0): the CRM region has been mapped to
 *    a real Phoenix brick (phx_brick_id — attachBrickMapping must run first, see attachDerived's
 *    call order). Deliberately NOT satisfied by crm_region_name alone — that's a raw vendor
 *    pass-through field present on nearly every Regular visit regardless of Phoenix's own mapping
 *    state, so falling back to it would silently mark an unmapped CRM region (see the Region
 *    Mapping tab) as "recognized" — exactly the gap this column exists to surface.
 *
 * Also sets `recognition_missing`: a human-readable list of the failed checks, for the column's
 * hover tooltip — so a low score is immediately actionable, not just a mystery number.
 */
function attachRecognitionScore(rows: CrmMasterRow[]): void {
  for (const row of rows) {
    const missing: string[] = [];
    let passed = 0;

    if (hasText(row.agent_hr_id)) passed += 1;
    else missing.push("agent identity");

    const hasDouble = typeof row.double_crm_id === "number" && row.double_crm_id !== 0;
    if (!hasDouble || hasText(row.double_hr_id)) passed += 1;
    else missing.push("double partner identity");

    if (hasText(row.contact_name) || hasText(row.customer_name) || hasText(row.comment)) passed += 1;
    else missing.push("visit target (contact/customer)");

    const isRegular = row.visit_type === 0;
    if (!isRegular || hasText(row.phx_brick_id)) passed += 1;
    else missing.push("CRM region mapped to a Phoenix brick");

    const pct = (passed / 4) * 100;
    row.recognition_score = pct >= 100 ? 100 : pct >= 75 ? 75 : pct >= 50 ? 50 : null;
    row.recognition_missing = missing.join(", ") || null;
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
 * `hrIdField` names the row's owning-agent hr id (agent_hr_id for vacations, base_hr_id for triples)
 * and is what the Line/Hiring-Date allow-set filter is scoped to (deliberately: those filters mean
 * "the REP is in this line / hired in this range", not any of the three triple positions).
 * `agentHrIdFields` is the (possibly wider) set of hr-id columns the free-text Agent HR ID box
 * searches — defaults to just `hrIdField` — so on the triples tab, searching one employee's hr id
 * finds every triple they appear in (rep, middle manager, OR top manager), not only as the base rep. */
function filterComputedRows(
  rows: CrmMasterRow[],
  opts: {
    agentHrId: string | null;
    agentHrIdFields?: readonly string[];
    allowed: Set<string> | null;
    halfDaysOnly: boolean;
    hrIdField: string;
    minDuration: number | null;
    search: string | null;
  },
): CrmMasterRow[] {
  const agentNeedle = opts.agentHrId ? opts.agentHrId.trim().toLowerCase() : null;
  const searchNeedle = opts.search ? opts.search.trim().toLowerCase() : null;
  const agentHrIdFields = opts.agentHrIdFields ?? [opts.hrIdField];
  return rows.filter((row) => {
    const hrRaw = typeof row[opts.hrIdField] === "string" ? (row[opts.hrIdField] as string) : null;
    if (opts.allowed) {
      const k = canonicalHrIdKey(hrRaw);
      if (!k || !opts.allowed.has(k)) return false;
    }
    if (agentNeedle) {
      const matchesAny = agentHrIdFields.some((field) => {
        const raw = typeof row[field] === "string" ? (row[field] as string) : null;
        return raw != null && raw.toLowerCase().includes(agentNeedle);
      });
      if (!matchesAny) return false;
    }
    if (searchNeedle) {
      // HR ids are part of the haystack because the search box's own placeholder promises them
      // ("Agent, double, contact, customer, comment, HR ID…") and the DB-backed tabs deliver on it
      // (applyMasterFilters ORs agent_hr_id / double_hr_id into the search). The computed tabs
      // searched names only, so typing a valid HR ID on Vacations or Triple Visits returned an empty
      // table — indistinguishable from "this rep took no leave".
      const hay = [
        row.agent_name,
        row.base_name,
        row.mid_name,
        row.top_name,
        row.contact_name,
        row.comment,
        ...agentHrIdFields.map((field) => row[field]),
      ]
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
export type VacationDayRow = {
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
 * Duration sums each calendar DATE (not each row — see the collapse below): a date with any
 * full-day marker is 1, otherwise 0.5 per distinct half marker capped at 1. Vacation ID = earliest
 * CRM visit id. Exported for `tests/crm-vacation-duration.test.ts`; not used outside this module. */
export function buildVacationPeriod(run: VacationDayRow[]): CrmMasterRow {
  const first = run[0];
  const dates = run.map((r) => String(r.visit_date).slice(0, 10));
  const fromDate = dates.reduce((a, b) => (a < b ? a : b));
  const toDate = dates.reduce((a, b) => (a > b ? a : b));
  // Collapse per calendar DATE before summing. The mirror really does carry duplicate rows for the
  // same agent/date/AM-PM (39 such groups, 50 extra rows in production), and summing per ROW
  // double-counted them — a single AM half-day logged twice read as a full day. Rule per date:
  // any full-day marker => 1 day; otherwise 0.5 per DISTINCT half marker, capped at 1 (so a real
  // AM + PM pair is still a full day, while AM + AM is still a half). half_days then counts DATES
  // that resolved to half a day, which is what that column's own description promises.
  const markersByDate = new Map<string, Set<string>>();
  for (const r of run) {
    const date = String(r.visit_date).slice(0, 10);
    const marker = r.ampm === "AM" || r.ampm === "PM" ? r.ampm : "FULL";
    const markers = markersByDate.get(date);
    if (markers) markers.add(marker);
    else markersByDate.set(date, new Set([marker]));
  }
  let duration = 0;
  let halfDays = 0;
  for (const markers of markersByDate.values()) {
    const dayDuration = markers.has("FULL") ? 1 : Math.min(1, 0.5 * markers.size);
    duration += dayDuration;
    if (dayDuration === 0.5) halfDays += 1;
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
  // Widen the day fetch so a period straddling the filter boundary is grouped from ALL of its days
  // (see the comment on the gte/lte below). 31 days comfortably covers any realistic continuous
  // leave run; a longer one would still be clipped, which is the same behaviour as before.
  const BOUNDARY_MARGIN_DAYS = 31;
  const fetchFrom = range.dateFrom ? addDaysIso(range.dateFrom, -BOUNDARY_MARGIN_DAYS) : null;
  const fetchTo = range.dateTo ? addDaysIso(range.dateTo, BOUNDARY_MARGIN_DAYS) : null;
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
    // Fetch a MARGIN either side of the requested window. A vacation period is grouped from a run
    // of consecutive days, so clipping the day rows at the filter boundary rebuilt a period from
    // only its in-range half: a 28-Jun→3-Jul leave viewed with dateFrom=2026-07-01 reported
    // Duration 3 instead of 6, and vacation_id (min visit id of the run) changed with the window,
    // so the same real period could not be cross-referenced between two views. Periods that do not
    // actually intersect the requested window are dropped after grouping, below.
    if (fetchFrom) q = q.gte("visit_date", fetchFrom);
    if (fetchTo) q = q.lte("visit_date", fetchTo);
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
    list.sort((a, b) => compareIso(a.visit_date, b.visit_date));
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

  // Keep only periods that genuinely overlap the requested window — the margin rows above exist to
  // complete a straddling run's Duration, not to add periods the user did not ask for.
  const inWindow = periods.filter((period) => {
    if (range.dateFrom && String(period.to_date) < range.dateFrom) return false;
    if (range.dateTo && String(period.from_date) > range.dateTo) return false;
    return true;
  });

  inWindow.sort((x, y) => compareIso(y.from_date, x.from_date));
  return { periods: inWindow, truncated: days.length >= MAX_ROWS };
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
    // Match agent_hr_id case-insensitively / alias-aware — the mirror stores whatever casing the
    // roster used (asserted UPPERCASE but not enforced in the write path), so a raw exact `.in()`
    // silently drops a scoped manager's rows whose casing diverges (under-complete view + export).
    // Same expansion every other CRM door read applies, per the CrmViewerScope contract.
    const expandedAllowed = expandHrIdFilterValues(allowedHrIds);
    q = q.in("agent_hr_id", expandedAllowed.length > 0 ? expandedAllowed : ["__no_match__"]);
  }
  if (dateFrom) q = q.gte(dateColumn, isCheckins ? `${dateFrom}T00:00:00` : dateFrom);
  // Check-ins carry a timestamp, so the upper bound is a HALF-OPEN `< next-day 00:00:00` rather than
  // `<= 23:59:59`: the latter silently dropped anything in the final second of the day
  // (23:59:59.001-23:59:59.999). Rare, but it made the last day of a range quietly under-report and
  // the same range return different counts depending on sub-second precision. Visits key on a plain
  // date column, where an inclusive `lte` is exactly right.
  if (dateTo) q = isCheckins ? q.lt(dateColumn, `${addDaysIso(dateTo, 1)}T00:00:00`) : q.lte(dateColumn, dateTo);

  // Dataset scope.
  // Canonical double-visit = real partner on a fieldwork visit type (Regular 0 / Campaign -8),
  // the same predicate DV Analytics / probation / the portal use — so the DV tab count matches them
  // (a partnered Meeting/Conference is joint-attendance bookkeeping, not a double visit).
  if (dataset === "double_visits") {
    q = q.not("double_crm_id", "is", null).neq("double_crm_id", 0).in("visit_type", [...CRM_DOUBLE_VISIT_TYPE_CODES]);
  }
  // UNREACHABLE TODAY — deliberately kept. Both callers (the paginated list and the streaming
  // export) return from their own `dataset === "vacations"` branch, which groups day-rows into
  // periods in memory, well before reaching this builder. Kept rather than deleted because deleting
  // it would fail OPEN: a future caller that did reach here would silently get EVERY visit type
  // instead of vacations. Read it as a safety net, not as how the Vacations tab is filtered.
  if (dataset === "vacations") q = q.ilike("visit_type_description", "%vacation%");
  if (dataset === "regular_no_checkin") q = q.eq("reclassified_no_checkin", true);
  if (dataset === "regular_dv_no_checkin") {
    q = q.eq("reclassified_no_checkin", true).not("double_crm_id", "is", null).neq("double_crm_id", 0);
  }

  // Advanced filters. agent_hr_id exists on both tables; double_hr_id is visits-only. Match
  // either so filtering by one employee surfaces EVERY record they appear in — as the primary
  // agent OR as the double/accompanying partner. Managers/Training staff frequently have no
  // primary-agent visits of their own at all (their whole CRM footprint is double-visit rides
  // along a rep's route), so an agent_hr_id-only filter silently showed zero rows for them —
  // including on the Double Visits tab, whose entire purpose is this exact record type.
  if (agentHrId) {
    const escaped = sanitizeSearch(agentHrId);
    if (escaped) {
      q = isVisits
        ? q.or(`agent_hr_id.ilike.%${escaped}%,double_hr_id.ilike.%${escaped}%`)
        : q.ilike("agent_hr_id", `%${escaped}%`);
    }
  }
  if (isVisits && ampm !== "all") q = q.eq("ampm", ampm);
  if (isVisits && visitType) {
    // Exact match on the stored description. The dropdown offers the stable vendor enum
    // (CRM_VISIT_TYPE_OPTIONS), which maps 1:1 to the descriptions actually present, so an exact
    // match always resolves. Deliberately NOT sanitizeSearch()+ilike: that stripped parentheses,
    // turning "Campaign (Prospection)" into the pattern "%Campaign  Prospection%" which matched 0 of
    // ~29k rows. sanitizeSearch stays only on the free-text search box (paren-harmless there).
    q = q.eq("visit_type_description", visitType);
  }
  if (isVisits && mappingStatus === "agent_mapped") q = q.not("agent_hr_id", "is", null);
  if (isVisits && mappingStatus === "agent_unmapped") q = q.is("agent_hr_id", null);
  if (search) {
    const escaped = sanitizeSearch(search);
    if (escaped) {
      const orExpr = isCheckins
        ? `agent_hr_id.ilike.%${escaped}%,contact_name.ilike.%${escaped}%,address.ilike.%${escaped}%`
        // Includes double_hr_id so the unified Search box fully covers what the separate "Agent HR
        // ID" box used to (it matched agent_hr_id OR double_hr_id) — the redesign folds them into one.
        : `agent_name.ilike.%${escaped}%,double_name.ilike.%${escaped}%,contact_name.ilike.%${escaped}%,customer_name.ilike.%${escaped}%,agent_hr_id.ilike.%${escaped}%,double_hr_id.ilike.%${escaped}%,comment.ilike.%${escaped}%`;
      q = q.or(orExpr);
    }
  }
  return q;
}

/** Pre-loaded overlays that attachDerived would otherwise fetch itself. The streaming export loads
 * them ONCE and hands the same instances to every page, so exporting tens of thousands of rows
 * doesn't re-run the roster read / brick-mapping read / triple self-join per 1000-row page. The
 * paginated view passes nothing (one page → one load), so its behaviour is unchanged. */
type DeriveResources = {
  agentMeta?: Map<string, AgentMeta>;
  brickMapping?: Map<number, BrickMapping>;
  /** Customer-level (crm_contact_id) brick mapping — preferred over the region-level one. */
  brickMappingByContact?: Map<number, BrickMapping>;
  triples?: Map<number, { third: string; unspecified: boolean }>;
  checkinsIndex?: Map<string, CheckinLite[]>;
};

/** Merge derived columns onto rows (nearest check-in for visit datasets, triple flag for double
 * visits). `range` scopes the triple detection to the same dates. Pass `resources` to reuse
 * pre-loaded overlays across many pages (see streamCrmMasterExportPages). */
async function attachDerived(
  dataset: CrmMasterDataset,
  rows: CrmMasterRow[],
  range: { dateFrom: string | null; dateTo: string | null },
  resources?: DeriveResources,
): Promise<void> {
  // Check-ins carry real GPS but no Phoenix geography — resolve their brick/area/region from the
  // coordinates (see attachGeoBrick). Visit datasets get their geography from the CRM region instead
  // (attachBrickMapping below), so this is deliberately check-ins-only.
  if (dataset === "checkins") await attachGeoBrick(rows);
  // False = the check-in read failed, so `checkin_id` is null everywhere for that reason alone.
  // Threaded into attachEffectiveType below so a failure can't manufacture a reclassification.
  let checkinCorrelationAvailable = true;
  if (dataset === "visits" || dataset === "double_visits") {
    checkinCorrelationAvailable = await attachNearestCheckins(rows, resources?.checkinsIndex);
  }
  // The two No-Check-in tabs never correlate a check-in (they're defined by NOT having one), so seed
  // the Logged/save visit time directly — otherwise the Visit Time column renders blank for them.
  else if (dataset === "regular_no_checkin" || dataset === "regular_dv_no_checkin") attachSaveTierVisitTime(rows);
  if (dataset === "double_visits") {
    // Flag the double visits that are actually part of a triple (third person stacked that day).
    const byVisitId = resources?.triples ?? (await computeTriplesInRange(range)).byVisitId;
    attachTripleFlag(rows, byVisitId);
  }
  if (isVisitDataset(dataset)) attachEffectiveType(dataset, rows, checkinCorrelationAvailable);
  // "Line" + "Hiring Date" columns on every tab — the agent's roster metadata.
  attachAgentMeta(rows, resources?.agentMeta ?? (await loadAgentMetaByHrId()), "agent_hr_id");
  // PHX Brick/Area/Region ID + Grade — visit-only (checkins/vacations/triples don't carry a
  // crm_region_id), and only meaningful for the raw visits/regular-no-checkin tabs, which is what
  // isVisitDataset already scopes to.
  if (isVisitDataset(dataset)) {
    const [byRegion, byContact] = await Promise.all([
      resources?.brickMapping ? Promise.resolve(resources.brickMapping) : loadBrickMappingByRegionId(),
      resources?.brickMappingByContact ? Promise.resolve(resources.brickMappingByContact) : loadBrickMappingByContactId(),
    ]);
    attachBrickMapping(rows, byRegion, byContact);
  }
  // Recognition score reads phx_brick_id, so it must run after attachBrickMapping above.
  if (isVisitDataset(dataset)) attachRecognitionScore(rows);
}

/**
 * Paginated master view of one CRM dataset (visits or check-ins). Returns every stored column
 * plus the full `raw_payload` for each row, ordered newest-first, with an exact total count.
 * Degrades to an empty result (never throws) when the mirror schema isn't present yet.
 */
/**
 * `scope` is REQUIRED, and company-wide access must be spelled out as CRM_SCOPE_ALL.
 *
 * It is not optional-defaulting-to-unrestricted on purpose: this function feeds a company-wide
 * 108k-row mirror, so a future caller that forgot an optional scope would silently expose everyone.
 * Required turns that mistake into a compile error. See src/lib/crm/viewer-scope.ts.
 */
export async function getCrmMasterData(input: CrmMasterFilter, scope: CrmViewerScope): Promise<CrmMasterData> {
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
  const [allowed, allLineOptions] = await Promise.all([
    resolveAllowedHrIds({ line, hireFrom, hireTo }),
    loadLineOptions(),
  ]);
  // loadLineOptions() returns EVERY line including Head Office. A scoped viewer must only be offered
  // the lines their own scope covers, so the dropdown cannot advertise data they can't reach.
  const lineOptions =
    scope.kind === "company" || !scope.lineNames
      ? allLineOptions
      : allLineOptions.filter((option) => {
          const label = String(option ?? "").trim().toLowerCase();
          return scope.lineNames!.some((name) => name.trim().toLowerCase() === label);
        });
  // The viewer scope and the Line/Hiring-date filter BOTH resolve to an hr-id allow-set and both land
  // in the SAME `allowedHrIds` slot. They must be INTERSECTED, not one overwriting the other —
  // otherwise a District Manager who picks "Line: Pedia" would see all of Pedia. Intersecting makes
  // the UI filter narrow the scope; it can never widen it.
  const scopeHrIds = scope.kind === "company" ? null : [...scope.hrIds];
  const scopeKeys = scope.kind === "company" ? null : scope.keys;
  const filterOpts = {
    agentHrId,
    allowedHrIds: intersectHrIdAllowLists(scopeHrIds, allowed ? allowed.hrIds : null),
    ampm,
    dataset,
    dateFrom,
    dateTo,
    // `agent_unmapped` selects rows where agent_hr_id IS NULL, which can never be in an allow-set —
    // a scoped viewer would always get zero and it would just look broken. Force it off for them
    // (the portal UI also hides the control, but this is the enforcing half).
    mappingStatus: scope.kind === "company" ? mappingStatus : mappingStatus === "agent_unmapped" ? "all" : mappingStatus,
    search,
    visitType,
  };
  // For the computed tabs (vacations, triples), the advanced filters run in memory over the rows.
  const computedFilter = {
    agentHrId,
    allowed: intersectHrIdKeySets(scopeKeys, allowed ? allowed.keys : null),
    halfDaysOnly,
    minDuration,
    search,
  };

  // Fields echoed back so the UI can seed its filter inputs — and, via `activeChips`, to state
  // which filters are currently applied. A filter this dataset does NOT honour is echoed back
  // CLEARED (see CRM_MASTER_SUPPORTED_FILTERS): a lingering `?ampm=AM` carried over from another
  // tab would otherwise render an "AM/PM: AM" chip on the Vacations tab, asserting a narrowing that
  // never happened. Clearing here fixes the chip and the seeded control in one place, on the server,
  // rather than trusting every UI branch to re-derive the same rule.
  const supports = (key: CrmMasterFilterKey) => crmMasterSupportsFilter(dataset, key);
  const echo = {
    agentHrId,
    ampm: supports("ampm") ? ampm : ("all" as CrmMasterAmpm),
    columns,
    configured,
    dataset,
    dateFrom,
    dateTo,
    halfDaysOnly: supports("halfDaysOnly") ? halfDaysOnly : false,
    hireFrom,
    hireTo,
    line,
    lineOptions,
    mappingStatus: supports("mappingStatus") ? mappingStatus : ("all" as CrmMasterMappingStatus),
    minDuration: supports("minDuration") ? minDuration : null,
    page,
    pageSize,
    pageSizeOptions: CRM_MASTER_PAGE_SIZE_OPTIONS,
    search,
    visitType: supports("visitType") ? visitType : null,
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
    const filtered = filterComputedRows(allTriples, { ...computedFilter, agentHrIdFields: ["base_hr_id", "mid_hr_id", "top_hr_id"], halfDaysOnly: false, hrIdField: "base_hr_id", minDuration: null });
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

/** Column set for a dataset's export sheet — resolved from the dataset alone (no I/O), so the export
 * route can build its header + sheet name up front, before the row stream begins. */
export function crmMasterExportColumns(input: CrmMasterFilter = {}): readonly CrmMasterColumn[] {
  return columnsForDataset(normalizeDataset(input.dataset));
}

/** Human sheet/file label for a dataset (e.g. "Regular · No Check-in") — used to name the export. */
export function crmMasterExportLabel(input: CrmMasterFilter = {}): string {
  const dataset = normalizeDataset(input.dataset);
  return CRM_MASTER_DATASETS.find((tab) => tab.id === dataset)?.label ?? dataset;
}

/**
 * Streams EVERY matching row for a dataset + filters as derived pages — no row cap. Same filters and
 * derived columns as the paginated master view, but yielded page-by-page so the export route can
 * write them straight into a streaming workbook and never hold the whole result set (nor a fully
 * styled in-memory workbook) at once. This replaces the old "fetch up to 20k rows into one array,
 * POST them back, style every cell in a single in-memory pass" export, which OOM'd/hung the 1Gi
 * instance past ~20–50k rows and surfaced to the user as "Export failed". Yields nothing (never
 * throws) when the mirror schema isn't present yet.
 */
/** Streaming export. `scope` is REQUIRED for the same fail-closed reason as getCrmMasterData. */
export async function* streamCrmMasterExportPages(
  input: CrmMasterFilter,
  scope: CrmViewerScope,
): AsyncGenerator<CrmMasterRow[], void, unknown> {
  const dataset = normalizeDataset(input.dataset);
  const isCheckins = dataset === "checkins";
  const agentHrId = input.agentHrId?.trim() || null;
  const search = input.search?.trim() || null;
  const line = input.line?.trim() || null;
  const hireFrom = input.hireFrom || null;
  const hireTo = input.hireTo || null;
  const minDuration = typeof input.minDuration === "number" && input.minDuration > 0 ? input.minDuration : null;
  const halfDaysOnly = input.halfDaysOnly === true;

  if (!(await isCrmVisitsSchemaReady())) return;

  const allowed = await resolveAllowedHrIds({ line, hireFrom, hireTo });
  // Same intersection as getCrmMasterData: the viewer scope and the Line/Hiring filter share one
  // slot, so a scoped export can never be widened by a UI filter. Resolved ONCE here, before the
  // page loop — never per page.
  const scopeHrIds = scope.kind === "company" ? null : [...scope.hrIds];
  const scopeKeys = scope.kind === "company" ? null : scope.keys;
  const rawMappingStatus = (input.mappingStatus === "agent_mapped" || input.mappingStatus === "agent_unmapped"
    ? input.mappingStatus
    : "all") as CrmMasterMappingStatus;
  const filterOpts = {
    agentHrId,
    allowedHrIds: intersectHrIdAllowLists(scopeHrIds, allowed ? allowed.hrIds : null),
    ampm: (input.ampm === "AM" || input.ampm === "PM" ? input.ampm : "all") as CrmMasterAmpm,
    dataset,
    dateFrom: input.dateFrom || null,
    dateTo: input.dateTo || null,
    mappingStatus:
      scope.kind === "company" ? rawMappingStatus : rawMappingStatus === "agent_unmapped" ? "all" : rawMappingStatus,
    search,
    visitType: input.visitType?.trim() || null,
  };
  const computedFilter = {
    agentHrId,
    allowed: intersectHrIdKeySets(scopeKeys, allowed ? allowed.keys : null),
    halfDaysOnly,
    minDuration,
    search,
  };
  const range = { dateFrom: filterOpts.dateFrom, dateTo: filterOpts.dateTo };

  // Rows handed to the workbook writer per flush — bounded memory regardless of total export size.
  const CHUNK = 2000;

  // Triple visits: computed in memory (self-join). Compute once, then emit in chunks.
  if (dataset === "triple_visits") {
    const [{ rows: allTriples }, agentMeta] = await Promise.all([computeTriplesInRange(range), loadAgentMetaByHrId()]);
    const rows = filterComputedRows(allTriples, {
      ...computedFilter,
      agentHrIdFields: ["base_hr_id", "mid_hr_id", "top_hr_id"],
      halfDaysOnly: false,
      hrIdField: "base_hr_id",
      minDuration: null,
    });
    attachAgentMeta(rows, agentMeta, "base_hr_id");
    for (let i = 0; i < rows.length; i += CHUNK) yield rows.slice(i, i + CHUNK);
    return;
  }

  // Vacations: grouped into periods. Compute once, then emit in chunks.
  if (dataset === "vacations") {
    const [{ periods: allPeriods }, agentMeta] = await Promise.all([computeVacationPeriods(range), loadAgentMetaByHrId()]);
    const rows = filterComputedRows(allPeriods, { ...computedFilter, hrIdField: "agent_hr_id" });
    attachAgentMeta(rows, agentMeta, "agent_hr_id");
    for (let i = 0; i < rows.length; i += CHUNK) yield rows.slice(i, i + CHUNK);
    return;
  }

  // DB-backed datasets — walk every page (NO cap) and derive per page. Pre-load the derive overlays
  // ONCE so a large export doesn't re-query the roster / brick map / triple self-join / check-ins
  // per page — the check-ins preload in particular is what fixes the 2026-07-29 incident (see
  // preloadCheckinsIndexForExport): re-querying it once per page multiplied a query shape that
  // doesn't hit this table's index well into a multi-minute export that got its connection cut
  // before finishing, producing a corrupted .xlsx.
  const needsCheckins = dataset === "visits" || dataset === "double_visits";
  const [agentMeta, brickMapping, brickMappingByContact, checkinsIndex] = await Promise.all([
    loadAgentMetaByHrId(),
    isVisitDataset(dataset) ? loadBrickMappingByRegionId() : Promise.resolve(new Map<number, BrickMapping>()),
    isVisitDataset(dataset) ? loadBrickMappingByContactId() : Promise.resolve(new Map<number, BrickMapping>()),
    needsCheckins ? preloadCheckinsIndexForExport(range) : Promise.resolve(new Map<string, CheckinLite[]>()),
  ]);
  const triples = dataset === "double_visits" ? (await computeTriplesInRange(range)).byVisitId : undefined;
  const resources: DeriveResources = { agentMeta, brickMapping, brickMappingByContact, triples, checkinsIndex };

  const supabase = getSupabaseAdmin();
  const table =
    dataset === "regular_no_checkin" || dataset === "regular_dv_no_checkin"
      ? CRM_VISITS_EFFECTIVE_VIEW
      : isCheckins
        ? CRM_CHECKINS_TABLE
        : CRM_VISITS_TABLE;
  const dateColumn = isCheckins ? "check_date" : "visit_date";
  const idColumn = isCheckins ? "crm_checkin_id" : "crm_visit_id";
  // The export never renders raw_payload: its column set comes from crmMasterExportColumns, which
  // has no such column, and renderExportCell only ever reads row[col.key]. No attach* helper reads
  // it either. But it is ~62% of a row's bytes (measured when it was removed from the Visits
  // Report for exactly this reason), so a full-mirror export was serializing, transferring and
  // JSON.parsing tens of MB of unused JSON per page, ~22 pages over — pure waste on the very code
  // path that produced the 2026-07-29 corrupted workbook. The paginated on-screen view keeps it,
  // because that one really does render a JSON expander.
  const select = withoutRawPayload(isCheckins ? CHECKIN_SELECT : VISIT_SELECT);
  const excludedInList = await getEffectiveExcludedInList();

  // 5000, not the master view's usual 1000: fewer outer round trips for the same total row count.
  // Confirmed empirically (2026-07-29 incident) that PostgREST honours a 5000-row .range() with no
  // silent cap — `.range(0, 4999)` returns exactly 5000 rows on this project, not truncated to some
  // smaller default. The real fix for that incident's multi-minute export duration was eliminating
  // the per-page check-ins correlation query (see preloadCheckinsIndexForExport above) — this PAGE
  // size increase is a smaller, secondary win on top of that for the base fetch itself.
  const PAGE = 5000;
  // Pure runaway stop (NOT a product cap): far above the whole mirror (~108k visits today), so every
  // real filtered export streams in full. Guards against an infinite loop if a query somehow returned
  // full pages forever.
  const MAX_EXPORT_ROWS = 1_000_000;
  for (let from = 0; from < MAX_EXPORT_ROWS; from += PAGE) {
    const base = supabase.from(table).select(select);
    const filtered = applyMasterFilters(base as unknown as MasterQuery, filterOpts, excludedInList);
    const { data, error } = await (filtered as unknown as typeof base)
      .order(dateColumn, { ascending: false })
      .order(idColumn, { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) {
      if (isCrmSchemaMissingError(error)) return;
      throw new Error(error.message);
    }
    const pageRows = (data ?? []) as unknown as CrmMasterRow[];
    if (pageRows.length === 0) return;
    await attachDerived(dataset, pageRows, range, resources);
    yield pageRows;
    if (pageRows.length < PAGE) return;
  }
}
