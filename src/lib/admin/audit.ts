import { getSupabaseAdmin } from "@/lib/supabase/server";

export type AuditEntityType = "auth_session" | "permission_override" | "salary_flag" | "user";
export type AuditModule =
  | "access"
  | "auth"
  | "coaching"
  | "governance"
  | "outstation"
  | "recruitment"
  | "sales";

export const AUDIT_MODULES: AuditModule[] = [
  "access",
  "auth",
  "coaching",
  "governance",
  "outstation",
  "recruitment",
  "sales",
];

export const AUDIT_SOURCE_TABLES = [
  "audit_logs",
  "coaching_report_audit_logs",
  "job_offer_audit_logs",
  "outstation_location_audit_logs",
  "sales_audit_logs",
] as const;

export type AuditSourceTable = typeof AUDIT_SOURCE_TABLES[number];

export type AuditLogInput = {
  actorLoginId?: string | null;
  entityId?: string | null;
  entityType: AuditEntityType;
  newValues?: Record<string, unknown> | null;
  oldValues?: Record<string, unknown> | null;
  summary: string;
};

export class AuditPersistenceError extends Error {
  cause: unknown;

  constructor(cause: unknown) {
    super("Critical audit log could not be persisted. Review mutation state before retrying.");
    this.name = "AuditPersistenceError";
    this.cause = cause;
  }
}

export type AuditLogFilter = {
  actor?: string | null;
  action?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  module?: AuditModule | null;
  page?: number;
  pageSize?: number;
  source?: AuditSourceTable | null;
  status?: string | null;
};

export type FullAuditLogRow = {
  action: string | null;
  id: string;
  actorHrId: string | null;
  actorLoginId: string;
  actorRole: string | null;
  entityId: string | null;
  entityType: string | null;
  metadata: Record<string, unknown> | null;
  module: AuditModule;
  summary: string | null;
  requestIp: string | null;
  source: AuditSourceTable;
  status: string | null;
  createdAt: string;
};

export type AuditLogPage = {
  logs: FullAuditLogRow[];
  moduleCounts: Record<AuditModule, number>;
  sourceCounts: Partial<Record<AuditSourceTable, number>>;
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

type RawRow = Record<string, unknown>;

function asString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textIncludes(value: string | null | undefined, needle: string | null | undefined) {
  if (!needle) return true;
  return String(value ?? "").toLowerCase().includes(needle.toLowerCase());
}

function metadataText(metadata: Record<string, unknown> | null) {
  if (!metadata) return "";
  try {
    return JSON.stringify(metadata);
  } catch {
    return "";
  }
}

function moduleForGenericAudit(entityType: string | null): AuditModule {
  if (entityType === "auth_session") return "auth";
  if (entityType === "permission_override" || entityType === "salary_flag" || entityType === "user") return "access";
  if (entityType === "coaching_report") return "coaching";
  return "governance";
}

function statusFromAction(action: string | null, fallback?: string | null) {
  const value = (fallback ?? action ?? "").toLowerCase();
  if (value.includes("reject")) return "rejected";
  if (value.includes("fail") || value.includes("error")) return "failed";
  if (value.includes("pending") || value.includes("queued")) return "pending";
  if (value.includes("approve")) return "approved";
  if (value.includes("success") || value.includes("succeed") || value.includes("sent") || value.includes("accepted")) return "succeeded";
  if (value.includes("cancel") || value.includes("delete") || value.includes("lock")) return "changed";
  return fallback ?? null;
}

function salesSummary(row: RawRow) {
  const action = asString(row.action);
  const period = asString(row.period) ?? "selected period";
  switch (action) {
    case "import.approved":
      return `Sales batch approved for ${period}`;
    case "import.rejected":
      return `Sales batch rejected for ${period}`;
    case "import.replaced":
      return `Sales batch replaced for ${period}`;
    case "import.deleted":
      return `Sales batch deleted for ${period}`;
    default:
      return `Sales activity recorded for ${period}`;
  }
}

function offerSummary(row: RawRow) {
  const action = asString(row.action);
  switch (action) {
    case "offer_sent":
      return "Job offer sent";
    case "offer_accepted":
      return "Job offer accepted";
    case "offer_rejected":
      return "Job offer rejected";
    case "offer_expired":
    case "offer_expired_on_click":
      return "Job offer expired";
    default:
      return action ? `Offer ${action.replace(/_/g, " ")}` : "Offer activity recorded";
  }
}

function normalizeGenericAudit(row: RawRow): FullAuditLogRow {
  const entityType = asString(row.entity_type);
  const metadata = {
    newValues: asRecord(row.new_values),
    oldValues: asRecord(row.old_values),
  };
  return {
    action: asString(row.summary),
    actorHrId: null,
    actorLoginId: asString(row.actor_login_id) ?? "system",
    actorRole: null,
    createdAt: String(row.created_at),
    entityId: asString(row.entity_id),
    entityType,
    id: `audit_logs:${String(row.id)}`,
    metadata,
    module: moduleForGenericAudit(entityType),
    requestIp: asRecord(row.new_values)?.ip ? String(asRecord(row.new_values)?.ip) : null,
    source: "audit_logs",
    status: statusFromAction(asString(row.summary)),
    summary: asString(row.summary),
  };
}

function normalizeSalesAudit(row: RawRow): FullAuditLogRow {
  const metadata = asRecord(row.metadata);
  return {
    action: asString(row.action),
    actorHrId: null,
    actorLoginId: asString(row.actor_display_name) ?? asString(row.actor_username) ?? "system",
    actorRole: null,
    createdAt: String(row.created_at),
    entityId: asString(row.batch_id),
    entityType: "sales_import",
    id: `sales_audit_logs:${String(row.id)}`,
    metadata: {
      ...(metadata ?? {}),
      line: asString(row.line),
      period: asString(row.period),
      username: asString(row.actor_username),
    },
    module: "sales",
    requestIp: null,
    source: "sales_audit_logs",
    status: statusFromAction(asString(row.action)),
    summary: salesSummary(row),
  };
}

function normalizeOfferAudit(row: RawRow): FullAuditLogRow {
  return {
    action: asString(row.action),
    actorHrId: null,
    actorLoginId: asString(row.actor_reference) ?? asString(row.actor_type) ?? "system",
    actorRole: asString(row.actor_type),
    createdAt: String(row.created_at),
    entityId: asString(row.offer_id),
    entityType: "job_offer",
    id: `job_offer_audit_logs:${String(row.id)}`,
    metadata: asRecord(row.details),
    module: "recruitment",
    requestIp: null,
    source: "job_offer_audit_logs",
    status: statusFromAction(asString(row.action)),
    summary: offerSummary(row),
  };
}

function normalizeCoachingAudit(row: RawRow): FullAuditLogRow {
  const action = asString(row.action);
  return {
    action,
    actorHrId: asString(row.actor_hr_id),
    actorLoginId: asString(row.actor_hr_id) ?? "system",
    actorRole: null,
    createdAt: String(row.created_at),
    entityId: asString(row.report_id),
    entityType: "coaching_report",
    id: `coaching_report_audit_logs:${String(row.id)}`,
    metadata: {
      metadata: asRecord(row.metadata),
      newValues: asRecord(row.new_values),
      oldValues: asRecord(row.old_values),
    },
    module: "coaching",
    requestIp: null,
    source: "coaching_report_audit_logs",
    status: statusFromAction(action),
    summary: action ? `Coaching report ${action.replace(/_/g, " ")}` : "Coaching report audit event",
  };
}

function normalizeOutstationAudit(row: RawRow): FullAuditLogRow {
  const status = asString(row.validation_result);
  return {
    action: status,
    actorHrId: asString(row.employee_hr_id),
    actorLoginId: asString(row.employee_hr_id) ?? "system",
    actorRole: "employee",
    createdAt: String(row.created_at),
    entityId: asString(row.expense_request_id) ?? asString(row.employee_hr_id),
    entityType: "outstation_location",
    id: `outstation_location_audit_logs:${String(row.id)}`,
    metadata: {
      fraudFlags: row.fraud_flags_json ?? null,
      suspiciousLocationScore: row.suspicious_location_score ?? null,
    },
    module: "outstation",
    requestIp: null,
    source: "outstation_location_audit_logs",
    status,
    summary: asString(row.validation_reason) ?? "Outstation location validation recorded",
  };
}

async function fetchRows(
  source: AuditSourceTable,
  select: string,
  normalize: (row: RawRow) => FullAuditLogRow,
  filter: AuditLogFilter,
  limit: number,
) {
  if (filter.source && filter.source !== source) return [];

  const sourceModule: Partial<Record<AuditSourceTable, AuditModule>> = {
    coaching_report_audit_logs: "coaching",
    job_offer_audit_logs: "recruitment",
    outstation_location_audit_logs: "outstation",
    sales_audit_logs: "sales",
  };
  const fixedModule = sourceModule[source];
  if (filter.module && fixedModule && filter.module !== fixedModule) return [];

  const supabase = getSupabaseAdmin();
  let query = supabase
    .from(source)
    .select(select)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (filter.dateFrom) query = query.gte("created_at", filter.dateFrom);
  if (filter.dateTo) query = query.lte("created_at", `${filter.dateTo}T23:59:59Z`);

  const { data, error } = await query;
  if (error) {
    console.warn(`Audit source ${source} skipped: ${error.message}`);
    return [];
  }

  return ((data ?? []) as unknown as RawRow[]).map(normalize);
}

function matchesFilter(log: FullAuditLogRow, filter: AuditLogFilter) {
  if (filter.module && log.module !== filter.module) return false;
  if (filter.source && log.source !== filter.source) return false;
  if (filter.entityType && log.entityType !== filter.entityType) return false;
  if (filter.status && !textIncludes(log.status, filter.status)) return false;
  if (filter.entityId && !textIncludes(log.entityId, filter.entityId)) return false;
  if (filter.actor && ![
    log.actorLoginId,
    log.actorHrId,
    log.actorRole,
  ].some((value) => textIncludes(value, filter.actor))) return false;
  if (filter.action && ![
    log.action,
    log.summary,
    log.entityType,
    metadataText(log.metadata),
  ].some((value) => textIncludes(value, filter.action))) return false;
  return true;
}

export async function getAuditLogs(
  filter: AuditLogFilter = {},
): Promise<AuditLogPage> {
  const supabase = getSupabaseAdmin();
  const page = Number.isFinite(filter.page) && (filter.page ?? 0) > 0 ? Number(filter.page) : 1;
  const pageSize = Number.isFinite(filter.pageSize) && (filter.pageSize ?? 0) > 0
    ? Number(filter.pageSize)
    : 50;
  const offset = (page - 1) * pageSize;

  let query = supabase
    .from("v_unified_audit_logs")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + pageSize - 1);

  // Apply Filters in SQL
  if (filter.module) query = query.eq("module", filter.module);
  if (filter.status) query = query.eq("status", filter.status);
  if (filter.actor) query = query.ilike("actor_id", `%${filter.actor}%`);
  if (filter.action) {
    query = query.or(`summary.ilike.%${filter.action}%,entity_type.ilike.%${filter.action}%,entity_id.ilike.%${filter.action}%`);
  }
  if (filter.dateFrom) query = query.gte("created_at", filter.dateFrom);
  if (filter.dateTo) query = query.lte("created_at", `${filter.dateTo}T23:59:59Z`);

  const [{ data, count, error }, countsResult] = await Promise.all([
    query,
    supabase.rpc("fn_get_audit_module_counts"),
  ]);

  if (error) throw error;

  const logs: FullAuditLogRow[] = (data ?? []).map((row: any) => ({
    action: row.action,
    actorHrId: null,
    actorLoginId: row.actor_id ?? "system",
    actorRole: row.actor_type,
    createdAt: row.created_at,
    entityId: row.entity_id,
    entityType: row.entity_type,
    id: `${row.source}:${row.id}`,
    metadata: row.metadata,
    module: row.module as AuditModule,
    requestIp: row.metadata?.ip ?? null,
    source: row.source as AuditSourceTable,
    status: row.status,
    summary: row.summary,
  }));

  const moduleCounts = (countsResult.data as any) ?? {
    access: 0,
    auth: 0,
    coaching: 0,
    governance: 0,
    outstation: 0,
    recruitment: 0,
    sales: 0,
    total: count ?? 0,
  };

  return {
    logs,
    total: count ?? 0,
    page,
    pageSize,
    pageCount: Math.ceil((count ?? 0) / pageSize),
    moduleCounts,
    sourceCounts: {}, // Not implemented in view yet, can be added if needed
  };
}

export async function writeAuditLog(input: AuditLogInput) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("audit_logs").insert({
    actor_login_id: input.actorLoginId ?? "system",
    entity_id: input.entityId ?? null,
    entity_type: input.entityType,
    new_values: input.newValues ?? null,
    old_values: input.oldValues ?? null,
    summary: input.summary,
  });
  if (error) throw error;
}

export async function writeRequiredAuditLog(input: AuditLogInput) {
  try {
    await writeAuditLog(input);
  } catch (error) {
    console.error(JSON.stringify({
      actorLoginId: input.actorLoginId ?? null,
      entityId: input.entityId ?? null,
      entityType: input.entityType,
      error: error instanceof Error ? error.message : String(error),
      event: "critical_audit_persistence_failed",
      summary: input.summary,
    }));
    throw new AuditPersistenceError(error);
  }
}
