import { canAccess, type AccessContext } from "@/lib/auth/permissions";
import {
  isDisposableFixtureText,
  isDisposablePayrollBatchRow,
  isDisposableSalesBatchRow,
} from "@/lib/fixture-hygiene";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// The Monitoring page this module also fed (getOperationalMonitoringStats, its email-delivery
// summary and its security feed) was retired on 23 Oct 2026; the sign-in half moved to
// src/lib/security/login-security.ts for the System Audit page. What stays is the business
// activity feed and the audit-log page reader.

export type OperationalActivityEvent = {
  description: string;
  module: string;
  status: string;
  timestamp: string;
  userName: string;
};

export type OperationalActivitySummary = {
  failureCount24h: number;
  lastEventAt: string | null;
  recent: OperationalActivityEvent[];
  /**
   * The sources that could not be read this time, by name ("Payroll", "Sales"). A source named here
   * contributed NOTHING — its absence from `recent` and the 24-hour counts is a failed read, not a
   * quiet day.
   */
  staleSources: string[];
  totalEvents24h: number;
};

export type AuditLogFilter = {
  actor?: string | null;
  action?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  entityType?: string | null;
  page?: number;
  pageSize?: number;
};

export type FullAuditLogRow = {
  actorHrId: string | null;
  actorLoginId: string;
  actorRole: string | null;
  createdAt: string;
  entityId: string | null;
  entityType: string | null;
  id: string;
  requestIp: string | null;
  summary: string | null;
};

export type AuditLogPage = {
  logs: FullAuditLogRow[];
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
};

type SalaryBatchActivityRow = {
  approved_at?: string | null;
  approved_by?: string | null;
  created_at?: string | null;
  month?: number | null;
  status?: string | null;
  updated_at?: string | null;
  uploaded_by?: string | null;
  year?: number | null;
};

type SalesAuditActivityRow = {
  action?: string | null;
  actor_display_name?: string | null;
  actor_username?: string | null;
  created_at?: string | null;
  line?: string | null;
  period?: string | null;
};

function asString(value: unknown) {
  return typeof value === "string" ? value : String(value ?? "");
}

function payrollActivityDescription(row: SalaryBatchActivityRow) {
  const period = row.month && row.year ? `${row.month}/${row.year}` : "the selected period";
  if (row.status === "part1_ready") return `Payroll Part 1 ready for ${period}`;
  if (row.status === "part1_paid") return `Payroll Part 1 paid for ${period}`;
  if (row.status === "adjustments_open") return `Payroll adjustments open for ${period}`;
  if (row.status === "part2_ready") return `Payroll Part 2 ready for ${period}`;
  if (row.status === "under_review") return `Payroll under review for ${period}`;
  if (row.status === "approved") return `Payroll approved for ${period}`;
  if (row.status === "locked") return `Payroll locked for ${period}`;
  if (row.status === "rejected") return `Payroll rejected for ${period}`;
  return `Payroll uploaded for ${period}`;
}

function salesActivityDescription(row: SalesAuditActivityRow) {
  switch (row.action) {
    case "import.approved":
      return `Sales batch approved for ${row.period ?? "the selected period"}`;
    case "import.rejected":
      return `Sales batch rejected for ${row.period ?? "the selected period"}`;
    case "import.replaced":
      return `Sales batch replaced for ${row.period ?? "the selected period"}`;
    case "import.deleted":
      return `Sales batch deleted for ${row.period ?? "the selected period"}`;
    default:
      return `Sales activity recorded for ${row.period ?? row.line ?? "the selected scope"}`;
  }
}

function isFailureStatus(value: string | null | undefined) {
  const normalized = String(value ?? "").toLowerCase();
  return (
    normalized.includes("failed") ||
    normalized.includes("rejected") ||
    normalized.includes("error") ||
    normalized.includes("bounced") ||
    normalized.includes("complained")
  );
}

function isDisposablePayrollFixture(row: SalaryBatchActivityRow) {
  return isDisposablePayrollBatchRow(row as Record<string, unknown>);
}

function isDisposableSalesFixture(row: SalesAuditActivityRow) {
  return (
    isDisposableSalesBatchRow(row as Record<string, unknown>) ||
    isDisposableFixtureText(row.actor_username) ||
    isDisposableFixtureText(row.actor_display_name) ||
    /20(?:9\d)|2100/i.test(String(row.period ?? ""))
  );
}

/**
 * The business activity feed: payroll batch movements and sales import decisions, newest first.
 *
 * Two corrections on 23 Oct 2026. The feed used to read a third source, `job_offer_audit_logs`,
 * as "Recruitment" — that table had been DROPPED, so every call failed that read and showed no
 * recruitment activity as if there were none. And every failed read became `[]` while
 * `staleSources` stayed hard-wired to `[]`, so a payroll or sales outage looked like a quiet day.
 * A failed source is now named in `staleSources`.
 */
export async function getOperationalRecentActivity(
  accessContext: AccessContext,
  options: { limit?: number } = {},
): Promise<OperationalActivitySummary> {
  const supabase = getSupabaseAdmin();
  const limit = Math.max(1, Math.min(50, options.limit ?? 5));
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [canReadPayroll, canReadSales] = await Promise.all([
    canAccess(accessContext, "payroll", "read"),
    canAccess(accessContext, "sales", "read"),
  ]);
  const staleSources: string[] = [];

  async function readSource<T>(label: string, read: () => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
    try {
      const result = await read();
      if (result.error) throw result.error;
      return (Array.isArray(result.data) ? result.data : []) as T[];
    } catch {
      staleSources.push(label);
      return [];
    }
  }

  const [salaryBatchActivity, salesAuditActivity] = await Promise.all([
    canReadPayroll
      ? readSource<SalaryBatchActivityRow>("Payroll", () =>
          supabase
            .from("salary_batches")
            .select("month,year,status,uploaded_by,approved_by,approved_at,created_at,updated_at")
            .order("updated_at", { ascending: false })
            .limit(limit))
      : Promise.resolve([] as SalaryBatchActivityRow[]),
    canReadSales
      ? readSource<SalesAuditActivityRow>("Sales", () =>
          supabase
            .from("sales_audit_logs")
            .select("action,actor_username,actor_display_name,line,period,created_at")
            .order("created_at", { ascending: false })
            .limit(limit))
      : Promise.resolve([] as SalesAuditActivityRow[]),
  ]);

  const businessSalaryBatchActivity = salaryBatchActivity.filter((row) => !isDisposablePayrollFixture(row));
  const businessSalesAuditActivity = salesAuditActivity.filter((row) => !isDisposableSalesFixture(row));

  const recent = [
    ...businessSalaryBatchActivity.map((row) => ({
      description: payrollActivityDescription(row),
      module: "Payroll",
      status: asString(row.status ?? "uploaded"),
      timestamp: asString(row.updated_at ?? row.created_at ?? new Date().toISOString()),
      userName: asString(row.approved_by ?? row.uploaded_by ?? "system"),
    })),
    ...businessSalesAuditActivity.map((row) => ({
      description: salesActivityDescription(row),
      module: "Sales",
      status: asString(row.action ?? "recorded").replace(/^import\./, ""),
      timestamp: asString(row.created_at ?? new Date().toISOString()),
      userName: asString(row.actor_display_name ?? row.actor_username ?? "system"),
    })),
  ]
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, limit);

  const allEvents = [...businessSalaryBatchActivity, ...businessSalesAuditActivity];
  const eventTimestamp = (row: SalaryBatchActivityRow | SalesAuditActivityRow) =>
    "updated_at" in row ? row.updated_at ?? row.created_at : row.created_at;
  const totalEvents24h = allEvents.filter((row) => {
    const timestamp = eventTimestamp(row);
    return Boolean(timestamp && timestamp >= since24h);
  }).length;
  const failureCount24h = allEvents.filter((row) => {
    const timestamp = eventTimestamp(row);
    if (!timestamp || timestamp < since24h) return false;
    const status = "status" in row ? row.status : "action" in row ? row.action : null;
    return isFailureStatus(status);
  }).length;

  return {
    failureCount24h,
    lastEventAt: recent[0]?.timestamp ?? null,
    recent,
    staleSources,
    totalEvents24h,
  };
}

export async function getOperationalAuditLogs(filter: AuditLogFilter = {}): Promise<AuditLogPage> {
  const supabase = getSupabaseAdmin();
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filter.pageSize ?? 50));
  const offset = (page - 1) * pageSize;

  let query = supabase
    .from("audit_logs")
    .select("id, actor_login_id, entity_id, entity_type, summary, created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + pageSize - 1);

  if (filter.actor) query = query.ilike("actor_login_id", `%${filter.actor}%`);
  if (filter.action) query = query.ilike("summary", `%${filter.action}%`);
  if (filter.entityType) query = query.eq("entity_type", filter.entityType);
  if (filter.dateFrom) query = query.gte("created_at", filter.dateFrom);
  if (filter.dateTo) query = query.lte("created_at", `${filter.dateTo}T23:59:59Z`);

  const { data, error, count } = await query;
  if (error) throw error;

  const total = count ?? 0;
  const logs: FullAuditLogRow[] = (data ?? []).map((row: Record<string, unknown>) => ({
    actorHrId: null,
    actorLoginId: (row.actor_login_id as string) ?? "system",
    actorRole: null,
    createdAt: row.created_at as string,
    entityId: (row.entity_id as string | null) ?? null,
    entityType: (row.entity_type as string | null) ?? null,
    id: String(row.id),
    requestIp: null,
    summary: (row.summary as string | null) ?? null,
  }));

  return { logs, page, pageCount: Math.max(1, Math.ceil(total / pageSize)), pageSize, total };
}
