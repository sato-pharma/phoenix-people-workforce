// Probation CRM DV-Day source definition (Phase 3, P3-T01).
//
// Single place that defines WHERE probation Double-Visit Days come from and HOW each CRM record
// is identified. Detection (P3-T02), dedup (P3-T03), identity/role resolution (P3-T04/T05) and
// window validation (P3-T06) all build on the constants + mappers here so there is exactly one
// definition of "a double visit" across the probation module.
//
// The canonical definition is deliberately IDENTICAL to double-visit-analytics
// (src/lib/double-visit-analytics/service.ts): a double visit is an ireports360_visits row with a
// real double partner on a fieldwork visit type. We reuse that predicate verbatim so probation and
// the DV analytics module can never disagree about what counts.
//
//   Attribution (from dbRowFromMirrorVisit):
//     probation employee (the one being evaluated) = agent_hr_id
//     accompanying evaluator                       = double_hr_id
//     CRM source id (dedup / traceability / resync) = crm_visit_id
//     date                                          = visit_date
//     sub-day granularity                           = ampm  ("AM" | "PM"; no clock time in CRM)
//
// NOTE: double-visit-analytics also runs a "same-day chain resolution" that can re-point the
// visited party from a manager down to the real MR. Probation intentionally does NOT apply that:
// a probation DV-Day is anchored to the employee UNDER PROBATION (agent_hr_id) — we only keep rows
// whose agent_hr_id maps to an active probation case (resolved in P3-T04).

import type { SupabaseClient } from "@supabase/supabase-js";

/** The CRM mirror table that carries synced visits. */
export const DV_SOURCE_TABLE = "ireports360_visits";
export const DV_SOURCE_TYPE = "ireports360" as const;

/**
 * Fieldwork visit-type codes that can count as a double visit — Regular (0) and
 * Campaign/Prospection (-8). Mirrors DOUBLE_VISIT_TYPE_CODES in double-visit-analytics/service.ts.
 * Meetings/Training/Vacation/Conference (-11/-9/-4/-1 …) are excluded (bookkeeping, not fieldwork).
 */
export const DV_VISIT_TYPE_CODES = [0, -8] as const;

/** Columns selected from ireports360_visits for probation DV detection. */
export const DV_SOURCE_COLUMNS =
  "id, crm_visit_id, visit_date, visit_type, visit_type_description, " +
  "agent_hr_id, agent_name, double_crm_id, double_hr_id, double_name, " +
  "contact_name, customer_name, comment, ampm";

/** Raw shape of a selected ireports360_visits row. */
export type RawDvVisitRow = {
  id: string;
  crm_visit_id: number | null;
  visit_date: string;
  visit_type: number | null;
  visit_type_description: string | null;
  agent_hr_id: string | null;
  agent_name: string | null;
  double_crm_id: number | null;
  double_hr_id: string | null;
  double_name: string | null;
  contact_name: string | null;
  customer_name: string | null;
  comment: string | null;
  ampm: string | null;
};

/** Normalized, probation-oriented view of one CRM double-visit record. */
export type SourceDvVisit = {
  /** ireports360_visits.crm_visit_id — the stable CRM source id used for dedup + resync. */
  crmVisitId: number;
  /** Employee under probation (the visited party). */
  employeeHrId: string | null;
  employeeName: string | null;
  /** Accompanying evaluator (the double visitor). */
  evaluatorHrId: string | null;
  evaluatorName: string | null;
  dvDate: string;
  ampm: "AM" | "PM" | null;
  visitType: number | null;
  visitTypeDescription: string | null;
  contactName: string | null;
  customerName: string | null;
  comment: string | null;
};

function normalizeAmpm(value: string | null): "AM" | "PM" | null {
  const v = String(value ?? "").trim().toUpperCase();
  return v === "AM" || v === "PM" ? v : null;
}

/**
 * Apply the canonical double-visit filter to a PostgREST query builder:
 * a real double partner (double_crm_id present and ≠ 0) on a fieldwork visit type.
 * Returns the same builder for chaining (date range, ordering, pagination are added by callers).
 */
export function applyDoubleVisitFilter<T>(query: T): T {
  // The generic is a PostgREST filter builder; cast narrowly to chain the known methods.
  const q = query as unknown as {
    not: (col: string, op: string, val: unknown) => typeof q;
    neq: (col: string, val: unknown) => typeof q;
    in: (col: string, vals: readonly unknown[]) => typeof q;
  };
  return q
    .not("double_crm_id", "is", null)
    .neq("double_crm_id", 0)
    .in("visit_type", [...DV_VISIT_TYPE_CODES]) as unknown as T;
}

/** The dedup / uniqueness key for a DV-Day: one field day per (evaluator, employee, date). */
export function dvDayKey(
  evaluatorHrId: string | null | undefined,
  employeeHrId: string | null | undefined,
  dvDate: string,
): string {
  return `${(evaluatorHrId ?? "").trim().toLowerCase()}|${(employeeHrId ?? "").trim().toLowerCase()}|${dvDate}`;
}

/** Normalize a raw CRM row into the probation-oriented SourceDvVisit shape. */
export function mapRawDvVisit(row: RawDvVisitRow): SourceDvVisit {
  return {
    // A null/absent CRM id must become NaN (not Number(null)===0, which would look valid).
    crmVisitId: row.crm_visit_id == null ? Number.NaN : Number(row.crm_visit_id),
    employeeHrId: row.agent_hr_id,
    employeeName: row.agent_name,
    evaluatorHrId: row.double_hr_id,
    evaluatorName: row.double_name,
    dvDate: row.visit_date,
    ampm: normalizeAmpm(row.ampm),
    visitType: row.visit_type,
    visitTypeDescription: row.visit_type_description,
    contactName: row.contact_name,
    customerName: row.customer_name,
    comment: row.comment,
  };
}

/**
 * Load raw double-visit rows for a date window (inclusive), paginated. Read-only.
 * Detection/validation layers (P3-T02+) consume the mapped output.
 */
export async function loadDoubleVisitRows(
  supabase: SupabaseClient,
  dateFrom: string,
  dateTo: string,
  // Scope to specific visited employees (the probation cohort). Omit to load all — but the
  // probation sync ALWAYS scopes to probation employees so non-probation double visits never
  // enter the probation tables.
  employeeHrIds?: string[],
): Promise<RawDvVisitRow[]> {
  if (employeeHrIds && employeeHrIds.length === 0) return [];
  const pageSize = 1000;
  const rows: RawDvVisitRow[] = [];
  for (let from = 0; ; from += pageSize) {
    let base = supabase
      .from(DV_SOURCE_TABLE)
      .select(DV_SOURCE_COLUMNS)
      .gte("visit_date", dateFrom)
      .lte("visit_date", dateTo);
    if (employeeHrIds && employeeHrIds.length > 0) {
      base = (base as unknown as { in: (c: string, v: readonly unknown[]) => typeof base }).in(
        "agent_hr_id",
        employeeHrIds,
      );
    }
    const { data, error } = await applyDoubleVisitFilter(base)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as unknown as RawDvVisitRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}
