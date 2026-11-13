import { cache } from "react";

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { assertPermission, canAccess } from "@/lib/auth/permissions";
import { ACTIVE_EMPLOYMENT_STATUSES } from "@/lib/auth/session-lifecycle";
import type { AccessContext } from "@/lib/auth/permissions";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { canonicalHrIdKey, hrIdForStorage, hrIdLookupKeys } from "@/lib/hr-id";
import { ilikeAnyFilter } from "@/lib/supabase/search-filter";
import type { ReportItPayload, ReportItReportRow } from "./types";

// Roles with report_it:export permission OR users listed in report_it_dashboard_access can see all reports.
//
// MEMOIZED PER REQUEST (React cache(), 2026-10-01, "slow to transfer between page and page"): the
// Report It page asks this to choose its view, then listReports asks it again for the same viewer
// before it reads a row — the same override read and dashboard-access read, twice per open. Both
// receive the page's request-cached `access` by reference, so the second call is a hit and the
// answer is the one gate either way. cache() never spans two requests, so a grant or a revocation
// still reaches the very next one; outside a render (an API route) it is a plain call, as before.
export const canViewAllReports = cache(async (access: AccessContext): Promise<boolean> => {
  if (await canAccess(access, "report_it", "export")) return true;
  if (!access.hrId) return false;
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("report_it_dashboard_access")
    .select("hr_id")
    .eq("hr_id", canonicalHrIdKey(access.hrId) ?? "")
    .maybeSingle();
  return data !== null;
});

// ─── Submit a new report ────────────────────────────────────────────────────

export type SubmitReportInput = {
  payload: ReportItPayload;
  submitterHrId: string | null;
  submitterName: string | null;
  submitterRole: string | null;
  department?: string | null;
  line?: string | null;
  area?: string | null;
};

/** The largest report body accepted — a full form with every block filled is a few kilobytes. */
export const REPORT_IT_MAX_PAYLOAD_BYTES = 200_000;

/**
 * The shape a report must have before it is stored. A payload with no reaction list or medicine
 * list used to throw a TypeError deep in `submitReport`; now it is refused at the door, by name.
 */
export function reportPayloadRefusal(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "Missing report payload.";
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.reactions)) return "The report must list the reactions.";
  if (!Array.isArray(record.medicines)) return "The report must list the medicines.";
  if (record.reactions.some((item) => !item || typeof item !== "object")) return "A reaction entry is not readable.";
  if (record.medicines.some((item) => !item || typeof item !== "object")) return "A medicine entry is not readable.";
  if (JSON.stringify(payload).length > REPORT_IT_MAX_PAYLOAD_BYTES) return "The report is too large.";
  return null;
}

export async function submitReport(input: SubmitReportInput): Promise<{ reportNumber: string; id: string }> {
  const refusal = reportPayloadRefusal(input.payload);
  if (refusal) throw new Error(`Validation: ${refusal}`);
  const supabase = getSupabaseAdmin();

  // Derive searchable summary fields from payload
  const isSerious = input.payload.reactions.some((r) => r.isSerious === "Yes");
  const outcomeSummary = input.payload.reactions
    .filter((r) => r.outcome)
    .map((r) => r.outcome)
    .join(", ") || null;
  const suspectedMedicines = input.payload.medicines
    .filter((m) => m.probablyCausingReaction && m.name)
    .map((m) => m.name);
  const reactionsSummary = input.payload.reactions
    .filter((r) => r.symptom)
    .map((r) => r.symptom);

  const row = {
    submitted_by_hr_id: input.submitterHrId,
    submitted_by_name: input.submitterName,
    submitted_by_role: input.submitterRole,
    department: input.department ?? null,
    line: input.line ?? null,
    area: input.area ?? null,
    patient_initials: input.payload.patientInitials || null,
    patient_sex: input.payload.patientSex || null,
    patient_country: input.payload.country || "Egypt",
    is_serious: isSerious,
    outcome_summary: outcomeSummary,
    suspected_medicines: suspectedMedicines,
    reactions_summary: reactionsSummary,
    report_payload: input.payload,
    status: "submitted",
  };

  const { data, error } = await supabase
    .from("report_it_reports")
    .insert(row)
    .select("id, report_number")
    .single();

  if (error) throw new Error(`Failed to save report: ${error.message}`);

  return { reportNumber: data.report_number, id: data.id };
}

// ─── List reports ──────────────────────────────────────────────────────────

export type ListReportsOptions = {
  limit?: number;
  offset?: number;
  isSerious?: boolean;
  outcome?: string;
  medicine?: string;
  submittedBy?: string;
  dateFrom?: string;
  dateTo?: string;
  line?: string;
  area?: string;
  department?: string;
};

export async function listReports(
  access: AccessContext,
  opts: ListReportsOptions = {},
): Promise<{ rows: ReportItReportRow[]; total: number }> {
  const supabase = getSupabaseAdmin();

  let query = supabase
    .from("report_it_reports")
    .select("*", { count: "exact" });

  // Employees without report_it:export see only their own reports
  const readsAll = await canViewAllReports(access);
  if (!readsAll) {
    if (!access.hrId) return { rows: [], total: 0 };
    query = query.eq("submitted_by_hr_id", access.hrId);
  }

  // Filters
  if (opts.isSerious !== undefined) {
    query = query.eq("is_serious", opts.isSerious);
  }
  if (opts.outcome) {
    query = query.ilike("outcome_summary", `%${opts.outcome}%`);
  }
  if (opts.medicine) {
    query = query.contains("suspected_medicines", [opts.medicine]);
  }
  if (opts.submittedBy) {
    const submittedByFilter = ilikeAnyFilter(["submitted_by_hr_id", "submitted_by_name"], opts.submittedBy);
    if (submittedByFilter) query = query.or(submittedByFilter);
  }
  if (opts.dateFrom) {
    query = query.gte("created_at", opts.dateFrom);
  }
  if (opts.dateTo) {
    query = query.lte("created_at", opts.dateTo + "T23:59:59Z");
  }
  if (opts.line) {
    query = query.ilike("line", `%${opts.line}%`);
  }
  if (opts.area) {
    query = query.ilike("area", `%${opts.area}%`);
  }
  if (opts.department) {
    query = query.ilike("department", `%${opts.department}%`);
  }

  const { limit, offset } = boundedReportPage(opts);
  query = query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) throw new Error(`Failed to list reports: ${error.message}`);

  const rows = (data ?? []) as ReportItReportRow[];
  // Every read that shows a report is logged before it is shown — and if the log cannot be
  // written, nothing is shown. A zero-row read disclosed nothing, so it leaves no row.
  if (rows.length > 0) {
    await logReportRead(access, {
      action: "reports_listed",
      reportId: rows.length === 1 ? rows[0].id : null,
      metadata: {
        count: rows.length,
        offset,
        reportNumbers: rows.map((row) => row.report_number),
        scope: readsAll ? "all" : "own",
      },
    });
  }

  return { rows, total: count ?? 0 };
}

/** The most rows one list read may return — the dashboard asks for 50. */
export const REPORT_IT_MAX_PAGE = 100;

/** A page size and start that are whole numbers inside their bounds, whatever the query string said. */
export function boundedReportPage(opts: { limit?: number; offset?: number }): { limit: number; offset: number } {
  const limit = Number.isFinite(opts.limit) ? Math.trunc(opts.limit as number) : 50;
  const offset = Number.isFinite(opts.offset) ? Math.trunc(opts.offset as number) : 0;
  return { limit: Math.min(Math.max(limit, 1), REPORT_IT_MAX_PAGE), offset: Math.max(offset, 0) };
}

// ─── Get single report ─────────────────────────────────────────────────────

export async function getReport(
  access: AccessContext,
  id: string,
): Promise<ReportItReportRow | null> {
  const supabase = getSupabaseAdmin();

  let query = supabase.from("report_it_reports").select("*").eq("id", id);

  const readsAll = await canViewAllReports(access);
  if (!readsAll) {
    if (!access.hrId) return null;
    query = query.eq("submitted_by_hr_id", access.hrId);
  }

  const { data, error } = await query.single();
  if (error) return null;
  const report = data as ReportItReportRow;
  await logReportRead(access, {
    action: "report_viewed",
    reportId: report.id,
    metadata: { reportNumber: report.report_number, scope: readsAll ? "all" : "own" },
  });
  return report;
}

// ─── The read log ─────────────────────────────────────────────────────────

export type ReportItAuditAction =
  | "report_viewed"
  | "reports_listed"
  | "dashboard_access_granted"
  | "dashboard_access_revoked";

/**
 * Writes one row to `report_it_audit_logs` for a read of patient data, and REFUSES the read if it
 * cannot. These are adverse-event reports: who opened which one, and when, must always be
 * answerable, so a read that could not be recorded is a read that did not happen.
 */
export async function logReportRead(
  access: AccessContext,
  input: { action: "report_viewed" | "reports_listed"; reportId: string | null; metadata: Record<string, unknown> },
): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("report_it_audit_logs")
    .insert({
      report_id: input.reportId,
      actor_hr_id: hrIdForStorage(access.hrId),
      action: input.action,
      metadata: { ...input.metadata, role: access.role },
    });
  if (error) {
    console.error("report-it: the read log could not be written, so the read was refused", error.message);
    throw new Error("Unavailable: this report read could not be recorded, so it was not shown. Please try again.");
  }
}

// ─── Who may read every report ────────────────────────────────────────────

export type ReportItAccessGrant = {
  hrId: string;
  name: string | null;
  grantedAt: string;
  grantedByName: string | null;
};

export type ReportItAuditEntry = {
  id: string;
  action: string;
  actorName: string | null;
  reportNumber: string | null;
  count: number | null;
  subjectName: string | null;
  createdAt: string;
};

/**
 * The read-all list and the latest entries of the read log. Managed by whoever holds
 * `report_it:export` — the Super Admin, the CEO and the Finance Manager (owner, 2026-11-13).
 */
export async function getDashboardAccessOverview(
  access: AccessContext,
  logLimit = 100,
): Promise<{ grants: ReportItAccessGrant[]; log: ReportItAuditEntry[] }> {
  await assertPermission(access, "report_it", "export");
  const supabase = getSupabaseAdmin();
  const [grantsRes, logRes] = await Promise.all([
    supabase.from("report_it_dashboard_access").select("hr_id,granted_at,granted_by").order("granted_at", { ascending: true }),
    supabase
      .from("report_it_audit_logs")
      .select("id,action,actor_hr_id,metadata,created_at")
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(Math.trunc(logLimit), 1), 500)),
  ]);
  if (grantsRes.error) throw new Error(`Failed to read the access list: ${grantsRes.error.message}`);
  if (logRes.error) throw new Error(`Failed to read the report log: ${logRes.error.message}`);

  const grantRows = (grantsRes.data ?? []) as Array<{ hr_id: string; granted_at: string; granted_by: string | null }>;
  const logRows = (logRes.data ?? []) as Array<{
    id: string;
    action: string;
    actor_hr_id: string | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
  }>;
  const names = await namesByHrId([
    ...grantRows.flatMap((row) => [row.hr_id, row.granted_by]),
    ...logRows.flatMap((row) => [row.actor_hr_id, typeof row.metadata?.hrId === "string" ? row.metadata.hrId : null]),
  ]);

  return {
    grants: grantRows.map((row) => ({
      hrId: row.hr_id,
      name: names.get(row.hr_id),
      grantedAt: row.granted_at,
      grantedByName: names.get(row.granted_by) ?? (row.granted_by === "system-setup" ? "Initial setup" : null),
    })),
    log: logRows.map((row) => {
      const meta = row.metadata ?? {};
      return {
        id: row.id,
        action: row.action,
        actorName: names.get(row.actor_hr_id),
        reportNumber: typeof meta.reportNumber === "string" ? meta.reportNumber : null,
        count: typeof meta.count === "number" ? meta.count : null,
        subjectName: typeof meta.hrId === "string" ? names.get(meta.hrId) : null,
        createdAt: row.created_at,
      };
    }),
  };
}

/** The current employees who could be given read-all access, by name — the panel's choice list. */
export async function listGrantableEmployees(access: AccessContext): Promise<Array<{ hrId: string; name: string }>> {
  await assertPermission(access, "report_it", "export");
  const { data, error } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id,full_name,nickname")
    .in("employment_status", Array.from(ACTIVE_EMPLOYMENT_STATUSES))
    .order("full_name", { ascending: true })
    .limit(2000);
  if (error) throw new Error(`Failed to read employees: ${error.message}`);
  return ((data ?? []) as Array<{ hr_id: string | null; full_name: string | null; nickname: string | null }>)
    .filter((row) => row.hr_id && row.full_name)
    .map((row) => ({
      hrId: row.hr_id as string,
      name: resolveEmployeeDisplayName(row.full_name as string, row.nickname, row.hr_id),
    }));
}

/**
 * Gives or removes one person's read-all access. The change and its audit row are one database
 * transaction (`phx_report_it_set_dashboard_access`), so neither can land without the other.
 */
export async function setDashboardAccess(
  access: AccessContext,
  input: { hrId: string; grant: boolean },
): Promise<{ changed: boolean }> {
  await assertPermission(access, "report_it", "export");
  const key = canonicalHrIdKey(input.hrId);
  if (!key) throw new Error("Validation: choose an employee.");
  const supabase = getSupabaseAdmin();

  if (input.grant) {
    // Only a current employee can be given access to patient data.
    const { data, error } = await supabase
      .from("employees")
      .select("hr_id,employment_status")
      .in("hr_id", hrIdLookupKeys(input.hrId))
      .limit(1);
    if (error) throw new Error(`Failed to read the employee: ${error.message}`);
    const employee = (data ?? [])[0] as { employment_status?: string | null } | undefined;
    if (!employee) throw new Error("Validation: no employee has that id.");
    if (!ACTIVE_EMPLOYMENT_STATUSES.has(String(employee.employment_status ?? "").trim().toLowerCase())) {
      throw new Error("Validation: only a current employee can be given access.");
    }
  }

  const names = await namesByHrId([input.hrId]);
  const { data, error } = await supabase.rpc("phx_report_it_set_dashboard_access", {
    p_hr_id: key,
    p_grant: input.grant,
    p_actor_hr_id: hrIdForStorage(access.hrId) ?? "",
    p_metadata: { name: names.get(input.hrId), actorRole: access.role },
  });
  if (error) throw new Error(`Failed to change access: ${error.message}`);
  return { changed: data === true };
}

// ─── KPI summary ──────────────────────────────────────────────────────────

export type ReportItKpis = {
  total: number;
  serious: number;
  thisMonth: number;
  withSuspectedMedicine: number;
};

export async function getReportKpis(): Promise<ReportItKpis> {
  const supabase = getSupabaseAdmin();

  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

  const [totalRes, seriousRes, monthRes, medicineRes] = await Promise.all([
    supabase.from("report_it_reports").select("id", { count: "exact", head: true }),
    supabase.from("report_it_reports").select("id", { count: "exact", head: true }).eq("is_serious", true),
    supabase.from("report_it_reports").select("id", { count: "exact", head: true }).gte("created_at", monthStart),
    supabase.from("report_it_reports").select("id", { count: "exact", head: true }).gt("suspected_medicines", "{}"),
  ]);

  return {
    total: totalRes.count ?? 0,
    serious: seriousRes.count ?? 0,
    thisMonth: monthRes.count ?? 0,
    withSuspectedMedicine: medicineRes.count ?? 0,
  };
}
