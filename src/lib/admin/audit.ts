import { getSupabaseAdmin } from "@/lib/supabase/server";

export type AuditEntityType = "auth_session" | "permission_override" | "salary_flag" | "user";

export type AuditLogInput = {
  actorLoginId?: string | null;
  entityId?: string | null;
  entityType: AuditEntityType;
  newValues?: Record<string, unknown> | null;
  oldValues?: Record<string, unknown> | null;
  summary: string;
};

export type AuditLogFilter = {
  actor?: string | null;
  action?: string | null;
  entityType?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  page?: number;
  pageSize?: number;
};

export type FullAuditLogRow = {
  id: string;
  actorHrId: string | null;
  actorLoginId: string;
  actorRole: string | null;
  entityId: string | null;
  entityType: string | null;
  summary: string | null;
  requestIp: string | null;
  createdAt: string;
};

export type AuditLogPage = {
  logs: FullAuditLogRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

export async function getAuditLogs(filter: AuditLogFilter = {}): Promise<AuditLogPage> {
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
    id: String(row.id),
    actorHrId: null,
    actorLoginId: (row.actor_login_id as string) ?? "system",
    actorRole: null,
    entityId: (row.entity_id as string | null) ?? null,
    entityType: (row.entity_type as string | null) ?? null,
    summary: (row.summary as string | null) ?? null,
    requestIp: null,
    createdAt: row.created_at as string,
  }));

  return { logs, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function writeAuditLog(input: AuditLogInput) {
  const supabase = getSupabaseAdmin();
  await supabase.from("audit_logs").insert({
    actor_login_id: input.actorLoginId ?? "system",
    entity_id: input.entityId ?? null,
    entity_type: input.entityType,
    new_values: input.newValues ?? null,
    old_values: input.oldValues ?? null,
    summary: input.summary,
  });
}
