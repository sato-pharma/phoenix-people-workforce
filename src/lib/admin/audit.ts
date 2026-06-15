import * as Sentry from "@sentry/nextjs";

import { getOperationalAuditLogs } from "@/lib/operations/events";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type AuditEntityType =
  | "auth_session"
  | "calendar_event"
  | "deduction_candidate"
  | "deduction_comment"
  | "deduction_decision"
  | "deduction_export"
  | "deduction_finalization"
  | "deduction_payroll_import"
  | "deduction_payroll_preview"
  | "deduction_summary"
  | "double_visit_import"
  | "employee_resignation"
  | "field_workforce_compliance_import"
  | "marketing_request"
  | "notification"
  | "outstation_expense_access"
  | "outstation_request"
  | "payroll_batch"
  | "permission_override"
  | "salary_flag"
  | "sales_import_batch"
  | "source_of_sales_area"
  | "source_of_sales_block"
  | "source_of_sales_brick"
  | "source_of_sales_distributor"
  | "source_of_sales_product"
  | "source_of_sales_region"
  | "system_cleanup"
  | "user"
  | "user_activity_access"
  | "vacation_request"
  | "vacation_weekly_off_policy"
  | "weekly_plan"
  | "weekly_plan_day"
  | "workflow_registry";

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
    Sentry.captureException(error, {
      level: "error",
      tags: { event: "audit_persistence_failed", entityType: input.entityType },
      extra: { summary: input.summary, entityId: input.entityId ?? null },
    });
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
    // Critical: a required audit row could not be written. Page this loudly.
    Sentry.captureException(error, {
      level: "fatal",
      tags: { event: "critical_audit_persistence_failed", entityType: input.entityType },
      extra: { summary: input.summary, entityId: input.entityId ?? null },
    });
    throw new AuditPersistenceError(error);
  }
}
