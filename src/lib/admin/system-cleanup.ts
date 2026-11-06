import { writeRequiredAuditLog } from "@/lib/admin/audit";
import {
  assertPermission,
  resolveEmployeeIdentityId,
  type AccessContext,
  type PermissionAction,
} from "@/lib/auth/permissions";
import {
  deleteOutstationRequestAsAdmin,
  getOutstationRequestById,
} from "@/lib/outstation/service";
import { outstationPayrollTripId } from "@/lib/outstation/payroll-expense-mapping";
import { isPayrollExpensesSchemaMissing } from "@/lib/outstation/expenses";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { deleteVacationRequestAsAdmin } from "@/lib/vacation/service";
import { hrIdForStorage } from "@/lib/hr-id";

export const SYSTEM_CLEANUP_MAX_BULK = 25;
const SYSTEM_CLEANUP_PAGE_SIZE = 1000;

export const systemCleanupModuleKeys = [
  "vacation_requests",
  "outstation_expenses",
  "weekly_plans",
] as const;

export type SystemCleanupModuleKey = (typeof systemCleanupModuleKeys)[number];
export type SystemCleanupSafetyState = "blocked" | "payroll_locked" | "safe";
export type SystemCleanupMode = "execute" | "preview";

export type SystemCleanupTarget = {
  moduleKey: SystemCleanupModuleKey;
  recordId: string;
};

export type SystemCleanupFilters = {
  dateFrom?: string | null;
  dateTo?: string | null;
  moduleKey?: SystemCleanupModuleKey | "all" | null;
  query?: string | null;
  safetyState?: SystemCleanupSafetyState | "all" | null;
  status?: string | null;
};

export type SystemCleanupRecord = {
  blockReason: string | null;
  canDelete: boolean;
  createdAt: string | null;
  dateLabel: string;
  employeeHrId: string | null;
  employeeName: string | null;
  impact: string[];
  moduleKey: SystemCleanupModuleKey;
  moduleLabel: string;
  recordId: string;
  safetyState: SystemCleanupSafetyState;
  status: string;
  title: string;
};

export type SystemCleanupSummary = {
  blocked: number;
  payrollLocked: number;
  safe: number;
  total: number;
};

export type SystemCleanupRecordsResponse = {
  filters: SystemCleanupFilters;
  modules: Array<{ key: SystemCleanupModuleKey; label: string }>;
  records: SystemCleanupRecord[];
  summary: SystemCleanupSummary;
};

export type SystemCleanupPreviewResult = SystemCleanupRecord & {
  impactSummary: Record<string, unknown>;
};

export type SystemCleanupActionResult = {
  blockReason?: string | null;
  cleanupEventId?: string | null;
  employeeHrId?: string | null;
  employeeName?: string | null;
  message: string;
  moduleKey: SystemCleanupModuleKey;
  recordId: string;
  status: "blocked" | "deleted" | "failed";
  success: boolean;
};

type JsonRecord = Record<string, unknown>;

type LoadedCleanupRecord = {
  blockReason: string | null;
  canDelete: boolean;
  employeeHrId: string | null;
  employeeName: string | null;
  impact: string[];
  impactSummary: JsonRecord;
  moduleKey: SystemCleanupModuleKey;
  recordId: string;
  safetyState: SystemCleanupSafetyState;
  snapshot: JsonRecord;
  status: string;
  title: string;
};

type CleanupModuleDefinition = {
  deleteRecord: (input: {
    access: AccessContext;
    loaded: LoadedCleanupRecord;
    reason: string;
  }) => Promise<void>;
  label: string;
  listRecords: () => Promise<SystemCleanupRecord[]>;
  loadRecord: (recordId: string) => Promise<LoadedCleanupRecord>;
};

const moduleLabels: Record<SystemCleanupModuleKey, string> = {
  outstation_expenses: "Outstation expenses",
  vacation_requests: "Vacation requests",
  weekly_plans: "Weekly/monthly plans",
};

const DEFAULT_CLEANUP_NOTE = "No cleanup note provided.";
// The legacy `weekly_plans` table (and its `weekly_plan_days` / `weekly_plan_approval_tokens`
// children) is empty in production and is being retired (mossy-ocean C7). The System Cleanup Center
// therefore sources weekly/monthly plans only from the live `employee_plan_headers` table, and a
// bare/unprefixed recordId routes to it — never to the retiring legacy table.
type WeeklyPlanSourceTable = "employee_plan_headers";

function text(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function nullableText(value: unknown) {
  const normalized = text(value);
  return normalized ? normalized : null;
}

function isoOrNull(value: unknown) {
  const raw = text(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toISOString();
}

function dateOnly(value: unknown) {
  const iso = isoOrNull(value);
  return iso ? iso.slice(0, 10) : "";
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeModuleKey(value: unknown): SystemCleanupModuleKey | null {
  return systemCleanupModuleKeys.includes(value as SystemCleanupModuleKey)
    ? value as SystemCleanupModuleKey
    : null;
}

function normalizeStatus(value: unknown) {
  const status = text(value);
  return status || "unknown";
}

function normalizeReason(value: unknown) {
  return text(value).slice(0, 500);
}

function optionalCleanupNote(value: unknown) {
  const normalized = normalizeReason(value);
  // admin_cleanup_events_reason_check requires char_length(btrim(reason)) >= 10;
  // a short-but-nonempty note must fall back too, not just a blank one.
  return normalized.length >= 10 ? normalized : DEFAULT_CLEANUP_NOTE;
}

function ensureRecordId(value: unknown) {
  const recordId = text(value);
  if (!recordId) throw new Error("Cleanup record id is required.");
  return recordId;
}

function asJsonRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function summarize(records: SystemCleanupRecord[]): SystemCleanupSummary {
  return {
    blocked: records.filter((record) => record.safetyState === "blocked").length,
    payrollLocked: records.filter((record) => record.safetyState === "payroll_locked").length,
    safe: records.filter((record) => record.safetyState === "safe").length,
    total: records.length,
  };
}

function targetKey(target: SystemCleanupTarget) {
  return `${target.moduleKey}:${target.recordId}`;
}

function sortCleanupRecordsNewestFirst(records: SystemCleanupRecord[]) {
  return [...records].sort((left, right) => {
    const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
    const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
    return rightTime - leftTime;
  });
}

function weeklyPlanRecordId(sourceTable: WeeklyPlanSourceTable, rawRecordId: string) {
  return `${sourceTable}:${rawRecordId}`;
}

function parseWeeklyPlanRecordId(recordId: string): { rawRecordId: string; sourceTable: WeeklyPlanSourceTable } {
  if (recordId.startsWith("employee_plan_headers:")) {
    return {
      rawRecordId: recordId.slice("employee_plan_headers:".length),
      sourceTable: "employee_plan_headers",
    };
  }
  // A bare id (or any other prefix) resolves against the live table, not the retired legacy one.
  return {
    rawRecordId: recordId,
    sourceTable: "employee_plan_headers",
  };
}

function normalizeTargets(input: unknown): SystemCleanupTarget[] {
  if (!Array.isArray(input)) throw new Error("Cleanup targets must be an array.");

  const targets = input.map((value) => {
    const row = asJsonRecord(value);
    const moduleKey = normalizeModuleKey(row.moduleKey);
    if (!moduleKey) throw new Error("Unsupported cleanup module.");
    return {
      moduleKey,
      recordId: ensureRecordId(row.recordId),
    };
  });

  if (targets.length === 0) throw new Error("At least one cleanup record is required.");
  if (targets.length > SYSTEM_CLEANUP_MAX_BULK) {
    throw new Error(`Cleanup is limited to ${SYSTEM_CLEANUP_MAX_BULK} records per action.`);
  }

  return Array.from(new Map(targets.map((target) => [targetKey(target), target])).values());
}

function applyFilters(records: SystemCleanupRecord[], filters: SystemCleanupFilters) {
  const moduleKey = filters.moduleKey && filters.moduleKey !== "all" ? filters.moduleKey : null;
  const safetyState = filters.safetyState && filters.safetyState !== "all" ? filters.safetyState : null;
  const status = text(filters.status).toLowerCase();
  const query = text(filters.query).toLowerCase();
  const dateFrom = dateOnly(filters.dateFrom);
  const dateTo = dateOnly(filters.dateTo);

  return records.filter((record) => {
    if (moduleKey && record.moduleKey !== moduleKey) return false;
    if (safetyState && record.safetyState !== safetyState) return false;
    if (status && status !== "all" && record.status.toLowerCase() !== status) return false;

    if (dateFrom || dateTo) {
      const recordDate = dateOnly(record.createdAt);
      if (!recordDate) return false;
      if (dateFrom && recordDate < dateFrom) return false;
      if (dateTo && recordDate > dateTo) return false;
    }

    if (!query) return true;
    const haystack = [
      record.blockReason,
      record.dateLabel,
      record.employeeHrId,
      record.employeeName,
      record.moduleLabel,
      record.recordId,
      record.status,
      record.title,
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(query);
  });
}

export async function assertSystemCleanupAccess(
  access: AccessContext,
  action: Extract<PermissionAction, "delete" | "read"> = "read",
) {
  if (access.scope !== "system" && access.role !== "Super Admin") {
    throw new Error("Forbidden: only Super Admin can access system cleanup.");
  }

  await assertPermission(access, "system_cleanup", action);
}

async function selectRows(table: string, select = "*") {
  const rows: JsonRecord[] = [];

  for (let from = 0; ; from += SYSTEM_CLEANUP_PAGE_SIZE) {
    const { data, error } = await getSupabaseAdmin()
      .from(table)
      .select(select)
      .order("created_at", { ascending: false })
      // Every table read here has a unique `id`; without it two rows sharing a created_at can swap
      // places between pages and one record is listed twice while another is never listed.
      .order("id", { ascending: false })
      .range(from, from + SYSTEM_CLEANUP_PAGE_SIZE - 1);

    if (error) throw new Error(error.message);
    const page = (data ?? []) as unknown as JsonRecord[];
    rows.push(...page);
    if (page.length < SYSTEM_CLEANUP_PAGE_SIZE) break;
  }

  return rows;
}

async function selectMaybeSingle(table: string, recordId: string, idColumn = "id") {
  const { data, error } = await getSupabaseAdmin()
    .from(table)
    .select("*")
    .eq(idColumn, recordId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ? data as unknown as JsonRecord : null;
}

async function selectChildren(table: string, column: string, value: string | number, orderColumn = "created_at") {
  const { data, error } = await getSupabaseAdmin()
    .from(table)
    .select("*")
    .eq(column, value)
    .order(orderColumn, { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as JsonRecord[];
}

async function getPayrollExpenseRows(tripIds: string[]) {
  const byTrip = new Map<string, JsonRecord[]>();
  if (tripIds.length === 0) return byTrip;

  // PostgREST folds every .in() value into the request URL; batch since tripIds comes from an
  // unbounded, fully-paginated scan of every outstation_expense_requests row ever created.
  for (let i = 0; i < tripIds.length; i += 100) {
    const batch = tripIds.slice(i, i + 100);
    const { data, error } = await getSupabaseAdmin()
      .from("outstation_expenses")
      .select("id, imported_payroll_batch_id, imported_to_payroll_at, report_id, trip_id")
      .in("trip_id", batch);

    if (error) {
      if (isPayrollExpensesSchemaMissing(error)) return byTrip;
      throw new Error(error.message);
    }

    for (const row of (data ?? []) as unknown as JsonRecord[]) {
      const tripId = text(row.trip_id);
      if (!tripId) continue;
      byTrip.set(tripId, [...(byTrip.get(tripId) ?? []), row]);
    }
  }
  return byTrip;
}

function payrollLockState(payrollRows: JsonRecord[]) {
  const locked = payrollRows.some(
    (row) => row.imported_payroll_batch_id != null || row.imported_to_payroll_at != null,
  );
  return locked
    ? {
        blockReason: "This outstation expense is already linked to an imported payroll batch.",
        safetyState: "payroll_locked" as const,
      }
    : {
        blockReason: null,
        safetyState: "safe" as const,
      };
}

function vacationRecord(row: JsonRecord): SystemCleanupRecord {
  const startDate = dateOnly(row.start_date);
  const endDate = dateOnly(row.end_date);
  const duration = numberValue(row.duration_days);

  return {
    blockReason: null,
    canDelete: true,
    createdAt: isoOrNull(row.created_at),
    dateLabel: startDate && endDate ? `${startDate} to ${endDate}` : startDate || endDate || "No date",
    employeeHrId: nullableText(row.employee_hr_id),
    employeeName: nullableText(row.employee_name),
    impact: [
      "Delete vacation request",
      "Delete linked vacation events/tokens through existing cascade",
      "Remove sick/compensatory attachment through existing vacation service",
    ],
    moduleKey: "vacation_requests",
    moduleLabel: moduleLabels.vacation_requests,
    recordId: text(row.id),
    safetyState: "safe",
    status: normalizeStatus(row.status),
    title: `${text(row.vacation_type) || "Vacation"} - ${duration || "?"} day(s)`,
  };
}

async function listVacationCleanupRecords() {
  return (await selectRows("v2_vacation_requests")).map(vacationRecord);
}

async function loadVacationCleanupRecord(recordId: string): Promise<LoadedCleanupRecord> {
  const request = await selectMaybeSingle("v2_vacation_requests", recordId);
  if (!request) {
    return missingRecord("vacation_requests", recordId);
  }

  const [events, emailTokens, evidenceReviews, attachmentRows] = await Promise.all([
    selectChildren("v2_vacation_request_events", "request_id", recordId),
    // Always empty: nothing has ever issued a vacation email token, and the GET that consumed
    // them was removed in #3274. Kept so cleanup stays exhaustive over the schema as it IS, not as
    // it is used — see the note on vacationTokensTable in src/lib/vacation/service.ts.
    selectChildren("v2_vacation_email_tokens", "request_id", recordId),
    selectChildren("v2_vacation_evidence_reviews", "request_id", recordId),
    // A sick request may carry SEVERAL documents and only the FIRST is in the legacy columns below.
    // These rows cascade away with the request, so they are snapshotted and every object path they
    // name is listed — otherwise deleting one request silently orphaned the rest of its files in
    // Storage with nothing left pointing at them.
    selectChildren("v2_vacation_request_attachments", "request_id", recordId),
  ]);
  const record = vacationRecord(request);
  const snapshot = { attachmentRows, emailTokens, events, evidenceReviews, request };
  const impactSummary = {
    attachments: Array.from(
      new Set(
        [
          nullableText(request.sick_attachment_object_path),
          nullableText(request.compensatory_attachment_object_path),
          ...attachmentRows.map((row) => nullableText(row.object_path)),
        ].filter(Boolean),
      ),
    ),
    emailTokens: emailTokens.length,
    events: events.length,
    evidenceReviews: evidenceReviews.length,
    requestTable: "v2_vacation_requests",
  };

  return {
    ...record,
    impactSummary,
    snapshot,
  };
}

function outstationRecord(row: JsonRecord, payrollRows: JsonRecord[] = []): SystemCleanupRecord {
  const tripId = outstationPayrollTripId(text(row.id));
  const { blockReason, safetyState } = payrollLockState(payrollRows);
  const startDate = dateOnly(row.trip_start_date);
  const endDate = dateOnly(row.trip_end_date);
  const linkedPayrollRows = payrollRows.length;

  return {
    blockReason,
    canDelete: safetyState === "safe",
    createdAt: isoOrNull(row.created_at),
    dateLabel: startDate && endDate ? `${startDate} to ${endDate}` : startDate || endDate || "No trip date",
    employeeHrId: nullableText(row.employee_hr_id),
    employeeName: nullableText(row.employee_name),
    impact: [
      "Delete outstation expense request",
      "Remove evidence/ticket attachments through existing outstation service",
      linkedPayrollRows > 0
        ? `Delete ${linkedPayrollRows} pre-payroll expense row(s) if still unlocked`
        : `Check payroll trip ${tripId} before deletion`,
    ],
    moduleKey: "outstation_expenses",
    moduleLabel: moduleLabels.outstation_expenses,
    recordId: text(row.id),
    safetyState,
    status: normalizeStatus(row.status),
    title: `${text(row.expense_type) || "Outstation"} - ${text(row.to_label) || text(row.to_city) || "destination pending"}`,
  };
}

async function listOutstationCleanupRecords() {
  const rows = await selectRows("outstation_expense_requests");
  const tripIds = rows.map((row) => outstationPayrollTripId(text(row.id))).filter(Boolean);
  const payrollRowsByTrip = await getPayrollExpenseRows(tripIds);

  return rows.map((row) => {
    const tripId = outstationPayrollTripId(text(row.id));
    return outstationRecord(row, payrollRowsByTrip.get(tripId) ?? []);
  });
}

async function loadOutstationCleanupRecord(recordId: string): Promise<LoadedCleanupRecord> {
  const requestId = Number(recordId);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    return missingRecord("outstation_expenses", recordId);
  }

  const [requestRow, serviceRecord] = await Promise.all([
    selectMaybeSingle("outstation_expense_requests", recordId),
    getOutstationRequestById(requestId),
  ]);
  if (!requestRow || !serviceRecord) {
    return missingRecord("outstation_expenses", recordId);
  }

  const tripId = outstationPayrollTripId(requestId);
  const payrollRows = await getPayrollExpenseRows([tripId]);
  const linkedPayrollRows = payrollRows.get(tripId) ?? [];
  const record = outstationRecord(requestRow, linkedPayrollRows);
  const snapshot = {
    payrollRows: linkedPayrollRows,
    request: requestRow,
    serviceRecord,
  };
  const impactSummary = {
    carEvidenceImagePath: nullableText(requestRow.car_evidence_image_path),
    linkedPayrollRows: linkedPayrollRows.length,
    payrollTripId: tripId,
    ticketAttachmentCount: Array.isArray(serviceRecord.ticketAttachmentPaths)
      ? serviceRecord.ticketAttachmentPaths.length
      : 0,
  };

  return {
    ...record,
    impactSummary,
    snapshot,
  };
}

function employeePlanRecord(row: JsonRecord): SystemCleanupRecord {
  const periodStart = dateOnly(row.period_start_date);
  const periodEnd = dateOnly(row.period_end_date);
  const periodKey = text(row.period_key);
  const planKind = text(row.plan_kind) || "plan";
  const revision = numberValue(row.revision);
  const rawRecordId = text(row.id);

  return {
    blockReason: null,
    canDelete: true,
    createdAt: isoOrNull(row.submitted_at ?? row.created_at),
    dateLabel: periodStart && periodEnd ? `${periodStart} to ${periodEnd}` : periodKey || "No plan date",
    employeeHrId: nullableText(row.employee_hr_id),
    employeeName: nullableText(row.employee_name),
    impact: [
      "Delete weekly/monthly plan header",
      "Delete plan items, decisions, acknowledgements, and return notes through existing cascade",
      "Preserve the full plan snapshot in cleanup history",
    ],
    moduleKey: "weekly_plans",
    moduleLabel: moduleLabels.weekly_plans,
    recordId: weeklyPlanRecordId("employee_plan_headers", rawRecordId),
    safetyState: "safe",
    status: normalizeStatus(row.status),
    title: `${statusLabel(planKind)} plan ${periodKey || rawRecordId}${revision ? ` - rev ${revision}` : ""}`,
  };
}

function statusLabel(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

async function listWeeklyPlanCleanupRecords() {
  const employeePlans = await selectRows("employee_plan_headers");
  return sortCleanupRecordsNewestFirst(employeePlans.map(employeePlanRecord));
}

async function loadWeeklyPlanCleanupRecord(recordId: string): Promise<LoadedCleanupRecord> {
  const parsed = parseWeeklyPlanRecordId(recordId);
  return loadEmployeePlanCleanupRecord(parsed.rawRecordId);
}

async function loadEmployeePlanCleanupRecord(rawRecordId: string): Promise<LoadedCleanupRecord> {
  const header = await selectMaybeSingle("employee_plan_headers", rawRecordId);
  if (!header) {
    return missingRecord("weekly_plans", weeklyPlanRecordId("employee_plan_headers", rawRecordId));
  }

  const [items, decisions, acknowledgements, returnNotes] = await Promise.all([
    selectChildren("employee_plan_items", "plan_id", rawRecordId),
    selectChildren("employee_plan_decisions", "plan_id", rawRecordId),
    selectChildren("employee_plan_hr_acknowledgements", "plan_id", rawRecordId, "acknowledged_at"),
    selectChildren("employee_plan_item_return_notes", "plan_id", rawRecordId),
  ]);
  const record = employeePlanRecord(header);
  const snapshot = {
    acknowledgements,
    decisions,
    header,
    items,
    returnNotes,
  };
  const impactSummary = {
    acknowledgements: acknowledgements.length,
    decisions: decisions.length,
    items: items.length,
    planTable: "employee_plan_headers",
    returnNotes: returnNotes.length,
  };

  return {
    ...record,
    impactSummary,
    snapshot,
  };
}

function missingRecord(
  moduleKey: SystemCleanupModuleKey,
  recordId: string,
): LoadedCleanupRecord {
  return {
    blockReason: "Record was not found or was already deleted.",
    canDelete: false,
    employeeHrId: null,
    employeeName: null,
    impact: ["No delete will run."],
    impactSummary: {},
    moduleKey,
    recordId,
    safetyState: "blocked",
    snapshot: {},
    status: "missing",
    title: "Missing record",
  };
}

async function deleteWeeklyPlanAsAdmin(input: {
  access: AccessContext;
  loaded: LoadedCleanupRecord;
  reason: string;
}) {
  const parsed = parseWeeklyPlanRecordId(input.loaded.recordId);
  const { error } = await getSupabaseAdmin()
    .from(parsed.sourceTable)
    .delete()
    .eq("id", parsed.rawRecordId);

  if (error) throw new Error(error.message);

  await writeRequiredAuditLog({
    actorLoginId: input.access.loginId ?? resolveEmployeeIdentityId(input.access) ?? "system",
    entityId: input.loaded.recordId,
    entityType: "weekly_plan",
    oldValues: input.loaded.snapshot,
    summary: `Super Admin deleted weekly plan ${input.loaded.recordId} from System Cleanup Center.`,
  });
}

const cleanupModuleRegistry: Record<SystemCleanupModuleKey, CleanupModuleDefinition> = {
  outstation_expenses: {
    deleteRecord: async ({ access, loaded }) => {
      await deleteOutstationRequestAsAdmin(Number(loaded.recordId), access);
    },
    label: moduleLabels.outstation_expenses,
    listRecords: listOutstationCleanupRecords,
    loadRecord: loadOutstationCleanupRecord,
  },
  vacation_requests: {
    deleteRecord: async ({ access, loaded }) => {
      await deleteVacationRequestAsAdmin(access, loaded.recordId);
    },
    label: moduleLabels.vacation_requests,
    listRecords: listVacationCleanupRecords,
    loadRecord: loadVacationCleanupRecord,
  },
  weekly_plans: {
    deleteRecord: deleteWeeklyPlanAsAdmin,
    label: moduleLabels.weekly_plans,
    listRecords: listWeeklyPlanCleanupRecords,
    loadRecord: loadWeeklyPlanCleanupRecord,
  },
};

async function insertCleanupEvent(input: {
  access: AccessContext;
  loaded: LoadedCleanupRecord;
  reason: string;
  status?: "blocked" | "started";
}) {
  const status = input.status ?? "started";
  const { data, error } = await getSupabaseAdmin()
    .from("admin_cleanup_events")
    .insert({
      action: "delete",
      actor_hr_id: hrIdForStorage(input.access.hrId),
      actor_login_id: input.access.loginId ?? resolveEmployeeIdentityId(input.access) ?? "system",
      actor_role: input.access.role,
      block_reason: input.loaded.blockReason,
      completed_at: status === "blocked" ? new Date().toISOString() : null,
      employee_hr_id: input.loaded.employeeHrId,
      employee_name: input.loaded.employeeName,
      impact_summary: input.loaded.impactSummary,
      module_key: input.loaded.moduleKey,
      old_values: input.loaded.snapshot,
      reason: input.reason,
      record_id: input.loaded.recordId,
      safety_level: input.loaded.safetyState === "safe" ? "standard" : input.loaded.safetyState,
      status,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`Cleanup history could not be written. Delete was not executed. ${error.message}`);
  }

  return text((data as { id?: unknown } | null)?.id);
}

async function finishCleanupEvent(input: {
  cleanupEventId: string;
  errorMessage?: string | null;
  status: "failed" | "succeeded";
}) {
  const { error } = await getSupabaseAdmin()
    .from("admin_cleanup_events")
    .update({
      completed_at: new Date().toISOString(),
      error_message: input.errorMessage ?? null,
      status: input.status,
    })
    .eq("id", input.cleanupEventId);

  if (error) throw new Error(error.message);
}

async function writeSystemCleanupAudit(input: {
  access: AccessContext;
  cleanupEventId: string | null;
  loaded: LoadedCleanupRecord;
  reason: string;
}) {
  await writeRequiredAuditLog({
    actorLoginId: input.access.loginId ?? resolveEmployeeIdentityId(input.access) ?? "system",
    entityId: input.cleanupEventId ?? input.loaded.recordId,
    entityType: "system_cleanup",
    newValues: {
      cleanupEventId: input.cleanupEventId,
      moduleKey: input.loaded.moduleKey,
      reason: input.reason,
      recordId: input.loaded.recordId,
    },
    oldValues: input.loaded.snapshot,
    summary: `Super Admin cleanup deleted ${input.loaded.moduleKey} record ${input.loaded.recordId}.`,
  });
}

async function loadTarget(target: SystemCleanupTarget) {
  return cleanupModuleRegistry[target.moduleKey].loadRecord(target.recordId);
}

export async function listCleanupRecords(
  access: AccessContext,
  filters: SystemCleanupFilters = {},
): Promise<SystemCleanupRecordsResponse> {
  await assertSystemCleanupAccess(access, "read");

  const moduleKey = filters.moduleKey && filters.moduleKey !== "all" ? filters.moduleKey : null;
  const modulesToLoad = moduleKey
    ? [moduleKey]
    : systemCleanupModuleKeys;

  const records = (await Promise.all(
    modulesToLoad.map((key) => cleanupModuleRegistry[key].listRecords()),
  )).flat();
  const filteredRecords = applyFilters(records, filters);

  return {
    filters,
    modules: systemCleanupModuleKeys.map((key) => ({
      key,
      label: cleanupModuleRegistry[key].label,
    })),
    records: filteredRecords,
    summary: summarize(filteredRecords),
  };
}

export async function previewCleanupAction(
  access: AccessContext,
  input: { targets: unknown },
): Promise<{ previews: SystemCleanupPreviewResult[] }> {
  await assertSystemCleanupAccess(access, "delete");
  const targets = normalizeTargets(input.targets);
  const loadedRecords = await Promise.all(targets.map(loadTarget));

  return {
    previews: loadedRecords.map((loaded) => ({
      blockReason: loaded.blockReason,
      canDelete: loaded.canDelete,
      createdAt: null,
      dateLabel: "",
      employeeHrId: loaded.employeeHrId,
      employeeName: loaded.employeeName,
      impact: loaded.impact,
      impactSummary: loaded.impactSummary,
      moduleKey: loaded.moduleKey,
      moduleLabel: moduleLabels[loaded.moduleKey],
      recordId: loaded.recordId,
      safetyState: loaded.safetyState,
      status: loaded.status,
      title: loaded.title,
    })),
  };
}

export async function executeCleanupAction(
  access: AccessContext,
  input: { reason: unknown; targets: unknown },
): Promise<{ results: SystemCleanupActionResult[] }> {
  await assertSystemCleanupAccess(access, "delete");
  const reason = optionalCleanupNote(input.reason);
  const targets = normalizeTargets(input.targets);
  const results: SystemCleanupActionResult[] = [];

  for (const target of targets) {
    const loaded = await loadTarget(target);
    let cleanupEventId: string | null = null;

    try {
      if (!loaded.canDelete) {
        cleanupEventId = await insertCleanupEvent({
          access,
          loaded,
          reason,
          status: "blocked",
        });
        results.push({
          blockReason: loaded.blockReason,
          cleanupEventId,
          employeeHrId: loaded.employeeHrId,
          employeeName: loaded.employeeName,
          message: loaded.blockReason ?? "Cleanup was blocked.",
          moduleKey: loaded.moduleKey,
          recordId: loaded.recordId,
          status: "blocked",
          success: false,
        });
        continue;
      }

      cleanupEventId = await insertCleanupEvent({ access, loaded, reason });
      await cleanupModuleRegistry[loaded.moduleKey].deleteRecord({ access, loaded, reason });
      await finishCleanupEvent({ cleanupEventId, status: "succeeded" });
      await writeSystemCleanupAudit({ access, cleanupEventId, loaded, reason });

      results.push({
        cleanupEventId,
        employeeHrId: loaded.employeeHrId,
        employeeName: loaded.employeeName,
        message: "Record deleted.",
        moduleKey: loaded.moduleKey,
        recordId: loaded.recordId,
        status: "deleted",
        success: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (cleanupEventId) {
        await finishCleanupEvent({
          cleanupEventId,
          errorMessage: message,
          status: "failed",
        }).catch(() => undefined);
      }

      results.push({
        blockReason: loaded.blockReason,
        cleanupEventId,
        employeeHrId: loaded.employeeHrId,
        employeeName: loaded.employeeName,
        message,
        moduleKey: loaded.moduleKey,
        recordId: loaded.recordId,
        status: "failed",
        success: false,
      });
    }
  }

  return { results };
}

export function parseCleanupFilters(searchParams: URLSearchParams): SystemCleanupFilters {
  const moduleKey = normalizeModuleKey(searchParams.get("module") ?? searchParams.get("moduleKey"));
  const safetyStateRaw = text(searchParams.get("safety") ?? searchParams.get("safetyState"));
  const safetyState = safetyStateRaw === "safe" || safetyStateRaw === "blocked" || safetyStateRaw === "payroll_locked"
    ? safetyStateRaw
    : safetyStateRaw === "all"
      ? "all"
      : null;

  return {
    dateFrom: nullableText(searchParams.get("dateFrom")),
    dateTo: nullableText(searchParams.get("dateTo")),
    moduleKey: moduleKey ?? (searchParams.get("module") === "all" ? "all" : null),
    query: nullableText(searchParams.get("query")),
    safetyState,
    status: nullableText(searchParams.get("status")),
  };
}
