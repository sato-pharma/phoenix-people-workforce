import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { AccessContext } from "@/lib/auth/permissions";
import type { ReportItPayload, ReportItReportRow } from "./types";

// ─── Roles that can see ALL reports ────────────────────────────────────────
const ADMIN_REPORT_ROLES = new Set(["Super Admin", "CEO", "Finance Manager"]);

export function canViewAllReports(access: AccessContext): boolean {
  return ADMIN_REPORT_ROLES.has(access.role);
}

export function canExportReports(access: AccessContext): boolean {
  return canViewAllReports(access);
}

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

export async function submitReport(input: SubmitReportInput): Promise<{ reportNumber: string; id: string }> {
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

  // Employees see only their own reports
  if (!canViewAllReports(access)) {
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
    query = query.or(
      `submitted_by_hr_id.ilike.%${opts.submittedBy}%,submitted_by_name.ilike.%${opts.submittedBy}%`,
    );
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

  query = query
    .order("created_at", { ascending: false })
    .range(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 50) - 1);

  const { data, error, count } = await query;
  if (error) throw new Error(`Failed to list reports: ${error.message}`);

  return { rows: (data ?? []) as ReportItReportRow[], total: count ?? 0 };
}

// ─── Get single report ─────────────────────────────────────────────────────

export async function getReport(
  access: AccessContext,
  id: string,
): Promise<ReportItReportRow | null> {
  const supabase = getSupabaseAdmin();

  let query = supabase.from("report_it_reports").select("*").eq("id", id);

  if (!canViewAllReports(access)) {
    if (!access.hrId) return null;
    query = query.eq("submitted_by_hr_id", access.hrId);
  }

  const { data, error } = await query.single();
  if (error) return null;
  return data as ReportItReportRow;
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
