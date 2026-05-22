import { getOperationalAuditLogs } from "@/lib/operations/events";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type AuditEntityType =
  | "auth_session"
  | "employee_resignation"
  | "job_offer"
  | "outstation_request"
  | "payroll_batch"
  | "permission_override"
  | "salary_flag"
  | "sales_import_batch"
  | "user"
  | "vacation_request";

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
  return getOperationalAuditLogs(filter);
}

async function insertAuditLog(input: AuditLogInput) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("audit_logs").insert({
    actor_login_id: input.actorLoginId ?? "system",
    entity_id: input.entityId ?? null,
    entity_type: input.entityType,
    new_values: input.newValues ?? null,
    old_values: input.oldValues ?? null,
    summary: input.summary,
  });

  if (error) {
    throw error;
  }
}

export async function writeAuditLog(input: AuditLogInput) {
  try {
    await insertAuditLog(input);
  } catch (error) {
    console.error(JSON.stringify({
      actorLoginId: input.actorLoginId ?? null,
      entityId: input.entityId ?? null,
      entityType: input.entityType,
      error: error instanceof Error ? error.message : String(error),
      event: "audit_persistence_failed",
      summary: input.summary,
    }));
  }
}

export async function writeRequiredAuditLog(input: AuditLogInput) {
  try {
    await insertAuditLog(input);
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
