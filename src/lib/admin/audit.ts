
import { getOperationalAuditLogs } from "@/lib/operations/events";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type AuditEntityType =
  // Bulk repointing of rows from one area to another, performed by the Super Admin from the Area
  // Consolidation screen. Written with `writeRequiredAuditLog` — a bulk org move that leaves no
  // audit trail is treated as a failed move, not a quiet success.
  | "area_consolidation"
  | "attendance_holiday_override"
  | "attendance_settlement"
  | "attendance_settlement_correction"
  | "auth_session"
  // The Business Review workbook export. The window is part of the entity id, so an audit row
  // says WHICH period was handed over, not just that something was.
  | "business_review_export"
  // Retired name, kept in the union so historical audit rows still typecheck. Nothing writes
  // it any more: the module stopped being a fixed S1 report when it grew a period filter.
  | "business_review_s1_export"
  | "calendar_event"
  | "cron_job_control"
  | "deduction_candidate"
  | "deduction_comment"
  | "deduction_decision"
  | "crm_master_export"
  // Pulling the mobile numbers behind the organogram export. The only route in the module
  // that hands back personal contact details in bulk, so who took the list is recorded.
  | "organogram_contact_export"
  | "crm_plan_sync"
  // A manager verifying a rep's plan. The ONLY thing Phoenix writes back into the customer's CRM,
  // so who signed off which plan is recorded on our side rather than being recoverable only from
  // the vendor's system. Entity id is the CRM plan id.
  | "crm_plan_verification"
  // Daily refresh of each rep's assigned doctor list from the CRM web app. One row per run,
  // keyed on the Cairo date, naming any agent refused or failed — the two outcomes that mean
  // the mirror is older than the board claims.
  | "crm_contact_list_sync"
  | "sos_raw_template_export"
  | "deduction_export"
  | "deduction_finalization"
  | "deduction_payroll_import"
  | "deduction_payroll_preview"
  | "deduction_summary"
  | "deductions_candidate"
  | "deductions_comment"
  | "deductions_decision"
  | "deductions_publication"
  | "direct_order_request"
  | "doctor_coverage_config"
  | "double_visit_import"
  | "employee_resignation"
  | "excuse_request"
  | "field_workforce_compliance_import"
  // The hiring-document checklist. Four types because the module writes four different
  // things and "who changed the checklist" is a different question from "who filed a scan".
  // Clearance & offboarding (Phase 6, 2026-08-28). Split in two on purpose: a station decision
  // is routine, and a settlement release is the row that says a departure was closed out. Both
  // use writeRequiredAuditLog - an unattributable release is treated as a failed release.
  | "hr_clearance_decision"
  | "hr_clearance_release"
  // A stay discussion or an exit interview was captured. The audit row records WHO and WHICH
  // conversation, never the content: the register holds what someone said in confidence about
  // their manager and their pay, and audit_logs is read far more widely than the register is.
  | "hr_retention_conversation"
  | "hiring_document_definition"
  | "hiring_document_file"
  | "hiring_document_note"
  | "hiring_document_status"
  // An offer of employment leaving the building. Written with `writeRequiredAuditLog`, and only
  // once mail has actually gone: it is the one action in this app that commits the company to a
  // salary in writing, to somebody who does not work here yet and so cannot be looked up in any
  // employee table afterwards. audit_logs has no CHECK on entity_type (verified against production
  // 2026-08-23, same as the note below), so this needs no migration of its own.
  | "job_offer"
  // A step in shutting a leaver's Turbify mailbox. Turbify publishes no email API, so Phoenix
  // cannot observe the mailbox — an audit row is the only record that a named admin claimed a
  // step was done. Written BEFORE the state changes, carrying the old values, so a later
  // reopen corrects the register without erasing what was previously asserted.
  | "mailbox_offboarding"
  | "marketing_customer"
  // A venue merge is neither a customer nor a request change: it retires one physical place in
  // favour of another and moves every link between them. audit_logs has no CHECK on entity_type
  // (verified against production 2026-08-23), so this needs no migration of its own.
  | "marketing_pharmacy"
  | "marketing_request"
  | "notification"
  | "outstation_expense_access"
  | "outstation_request"
  | "payroll_batch"
  | "permission_override"
  | "pharmacy_search_discovery"
  // Who pulled the shared Planning Calendar to XLSX, for which month. Gated to SFE
  // Manager / Super Admin; the month is the entity id so a row says WHICH period
  // was handed over. audit_logs has no CHECK on entity_type, so this needs no migration.
  | "planning_calendar_export"
  | "private_calendar_data_dispute"
  | "probation_case"
  | "probation_config"
  | "probation_decision"
  | "probation_dv_day"
  | "probation_feedback"
  | "probation_assessment"
  | "probation_development_action"
  | "salary_flag"
  | "sales_import_batch"
  | "source_of_sales_area"
  | "source_of_sales_block"
  | "source_of_sales_brick"
  | "source_of_sales_distributor"
  | "source_of_sales_product"
  | "source_of_sales_region"
  | "territory_preview_link"
  | "territory_sync"
  | "system_cleanup"
  | "user"
  | "user_activity_access"
  // The Company Activity Report export (day-by-day CRM/attendance/leave, not payroll). Named with
  // the "company_" prefix on purpose — "activity_report" alone would sit too close to
  // user_activity_access above, a different and unrelated concept.
  | "company_activity_report_export"
  | "vacation_report_export"
  | "vacation_request"
  | "vacation_retention_purge"
  | "vacation_weekly_off_policy"
  | "weekly_plan"
  | "weekly_sales_mapping"
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
  const supabase = getSupabaseAdmin({ requestTimeoutMs: 3000 });
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
    logError("Audit log could not be persisted", {
      labels: { event: "audit_persistence_failed", entityType: input.entityType, entityId: input.entityId ?? null },
      context: { actorLoginId: input.actorLoginId ?? null, summary: input.summary },
      error,
    });
    logError("Audit log could not be persisted", {
      labels: { event: "audit_persistence_failed", entityType: input.entityType },
      context: { summary: input.summary, entityId: input.entityId ?? null },
      error,
    });
  }
}

export async function writeRequiredAuditLog(input: AuditLogInput) {
  try {
    await insertAuditLog(input);
  } catch (error) {
    logError("Critical audit log could not be persisted", {
      labels: { event: "critical_audit_persistence_failed", entityType: input.entityType, entityId: input.entityId ?? null },
      context: { actorLoginId: input.actorLoginId ?? null, summary: input.summary },
      error,
    });
    // Critical: a required audit row could not be written. Page this loudly.
    logError("Critical audit log could not be persisted", {
      labels: { event: "critical_audit_persistence_failed", entityType: input.entityType },
      context: { summary: input.summary, entityId: input.entityId ?? null },
      error,
    });
    throw new AuditPersistenceError(error);
  }
}
