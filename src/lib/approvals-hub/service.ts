import {
  hrIdsMatch,
  normalizeHrId,
  resolveNavigationMode,
  type AccessContext,
} from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  getVacationActionCenterData,
  getVacationReportData,
  isAllVacationVisibility,
} from "@/lib/vacation/service";
import { vacationTypeLabel } from "@/lib/vacation/calculations";
import {
  getExcuseRequestForActionCenterDeepLink,
  getManagerPendingExcuses,
  type EmployeeExcuseRequest,
} from "@/lib/excuses/service";
import { canonicalPersonHrId, isSamePerson } from "@/lib/auth/identity-aliases";
import { getMyApprovalHistory, getMyRequestItems, decodeDecision } from "@/lib/action-center/service";
import { getEmployeeDirectory, getEmployeeDirectoryRows, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { logStructured } from "@/lib/observability/log";
import { reportsToManagerSeat } from "@/lib/workforce/hierarchy-resolver";
import { listWeeklyPlanManagerGapRecords, type WeeklyPlanManagerGapRecord } from "@/lib/weekly-planning/drift-check";
import { listExcuseManagerGapRecords, type ExcuseManagerGapRecord } from "@/lib/excuses/drift-check";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { resolveApproverPlanStage } from "@/lib/weekly-planning/service";
import type { EmployeePlanKind, EmployeePlanStatus } from "@/lib/weekly-planning/plan-v1";
import { isDistrictManagerPlanTitle } from "@/lib/weekly-planning/plan-v1";
import type {
  VacationActionAvailability,
  VacationActionCenterRow,
  VacationRequestRecord,
  VacationRequestStatus,
} from "@/lib/vacation/types";
import type {
  HistoricalApprovalItem,
  MyRequestItem,
  WeeklyPlanCalendarItem,
  WeeklyPlanDetail,
} from "@/components/action-center/types";
import { APPROVALS_SLA_THRESHOLDS, slaTone } from "@/components/approvals-hub/sla-thresholds";

/**
 * Approvals Hub — Vacation & Excuse responder service (Phase 1).
 *
 * Consolidation layer for the new Approvals Hub. It does NOT change any approval
 * workflow logic — it reuses the existing vacation/excuse data sources and decide
 * endpoints and re-shapes them into the per-responder buckets the new pages need:
 *   • awaiting  — requests it is currently my turn to act on (buttons enabled)
 *   • upcoming  — requests where I am a later approver in the chain, not yet my turn
 *   • mine      — my own submitted requests, always read-only (I can't approve myself)
 * plus per-request detail (full record + stage tracker + per-viewer actions) and
 * per-responder history filtered from getMyApprovalHistory.
 */

/**
 * Viewer matching for approvals — resolves to the PERSON, not the login.
 *
 * The HR Manager also operates the system-administrator console, so "is this my own request?" and
 * "am I the assigned manager?" must hold across both of their HR_IDs. Matching only the signed-in
 * HR_ID let the self-approval guard be bypassed simply by deciding from the other login.
 * `hrIdsMatch` is kept alongside for its symbol-stripped formatting-drift fallback.
 */
function isViewer(candidate: string | null | undefined, viewerHrId: string | null | undefined) {
  return hrIdsMatch(candidate, viewerHrId) || isSamePerson(viewerHrId, candidate);
}

// ── Diagnostic logging for swallowed loader failures ──────────────────────────
//
// Every loader below catches its own failure and degrades to an empty bucket rather than
// blanking the page. Those failures must still be logged — but NOT all at ERROR.
//
// A `Forbidden: …` rejection from a domain permission gate is the access check WORKING, not a
// fault: an anon or merely unauthorized caller is expected to be denied. Logging it at ERROR
// meant a single unauthenticated GET of /employee-portals/approvals/vacation wrote two
// ERROR-severity Cloud Run entries (confirmed live on revision phoenix-hr-00661-yuw,
// 2026-07-30), polluting error dashboards and the production error alert with false positives.
//
// Permission denials are therefore emitted at DEBUG and labelled `classification=forbidden` so
// they stay searchable; every other failure keeps ERROR severity. Observability only — this
// changes nothing about who can read vacation, excuse, or plan data.

/**
 * Mirrors `isForbiddenError` from `@/lib/auth/server` (same `Forbidden:` message prefix).
 * Kept local on purpose: this service is imported directly by the Node test runner, which
 * cannot load the `next/headers` dependency that `@/lib/auth/server` pulls in.
 */
function isForbiddenLoadError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().startsWith("forbidden:");
}

function logLoadFailure(
  message: string,
  options: { labels: Record<string, string | number | boolean | null | undefined>; error: unknown },
) {
  const forbidden = isForbiddenLoadError(options.error);
  logStructured(forbidden ? "DEBUG" : "ERROR", message, {
    labels: { ...options.labels, classification: forbidden ? "forbidden" : "error" },
    error: options.error,
  });
}

// ── URL helpers (single source of truth for approval deep-links) ──────────────

export function vacationApprovalsBasePath(access: Pick<AccessContext, "role" | "scope" | "source">): string {
  return resolveNavigationMode(access as AccessContext) === "employee-portal"
    ? "/employee-portals/approvals/vacation"
    : "/admin/approvals/vacation";
}

export function excuseApprovalsBasePath(access: Pick<AccessContext, "role" | "scope" | "source">): string {
  return resolveNavigationMode(access as AccessContext) === "employee-portal"
    ? "/employee-portals/approvals/excuse"
    : "/admin/approvals/excuse";
}

export function vacationApprovalHref(access: Pick<AccessContext, "role" | "scope" | "source">, id: string): string {
  return `${vacationApprovalsBasePath(access)}/${encodeURIComponent(id)}`;
}

export function excuseApprovalHref(access: Pick<AccessContext, "role" | "scope" | "source">, id: string): string {
  return `${excuseApprovalsBasePath(access)}/${encodeURIComponent(id)}`;
}

// ── Shared shapes ─────────────────────────────────────────────────────────────

export type ApprovalTimelineStep = {
  order: number;
  stepKey: string;
  genericStep: string;
  status: string;
  approverName: string | null;
  approverTitle: string | null;
  decidedAt: string | null;
  decisionComment: string | null;
};

export type ApprovalActionFlags = {
  approve: boolean;
  reject: boolean;
  return: boolean;
  acknowledge: boolean;
};

const NO_ACTIONS: ApprovalActionFlags = { approve: false, reject: false, return: false, acknowledge: false };

function anyActionEnabled(a: VacationActionAvailability): boolean {
  return Boolean(
    a.approve?.enabled || a.reject?.enabled || a.return?.enabled || a.acknowledge?.enabled || a.assign?.enabled,
  );
}

function toActionFlags(a: VacationActionAvailability): ApprovalActionFlags {
  return {
    approve: Boolean(a.approve?.enabled),
    reject: Boolean(a.reject?.enabled),
    return: Boolean(a.return?.enabled),
    acknowledge: Boolean(a.acknowledge?.enabled),
  };
}

// HR acknowledgement authority for vacation is Super Admin / system ONLY (per the confirmed
// approver model — Talent Acquisition is explicitly NOT a leave approver). Reuse the vacation
// module's own gate (isAllVacationVisibility) rather than the broader isHrAuthorityRole set (which
// also includes Talent Acquisition) so the two never drift apart again.
const isHrActor = isAllVacationVisibility;

// ── Vacation buckets ──────────────────────────────────────────────────────────

export type VacationApprovalsBuckets = {
  awaiting: VacationActionCenterRow[];
  upcoming: VacationActionCenterRow[];
};

/**
 * Partition the vacation requests relevant to the responder.
 *
 * Sequential types (annual/other/compensatory/emergency) come from the Action Center
 * source, which already annotates each row with per-viewer `actionAvailability` and
 * includes rows where the caller is a *later* pending approver (all buttons disabled)
 * — that is exactly the "coming to you" set. Sick leave uses the legacy parallel flow
 * and is NOT in the Action Center source, so its pending items are folded in from the
 * report source (best-effort: manager's turn = pending_manager & assigned manager; HR's
 * turn = pending_hr & HR/Super-Admin actor).
 */
export async function getVacationApprovalsForResponder(access: AccessContext): Promise<VacationApprovalsBuckets> {
  const hrId = access.hrId?.trim() ?? "";

  // Defensive: a system-authority actor (Super Admin / scope=system, e.g. a shared HR login with
  // no personal HR_ID) must always see the true company-wide bucket. Every source below is already
  // scoped role/scope-first (isAllVacationVisibility), not hrId-first, so a blank hrId is safe here
  // — but NEVER silently collapse a real failure to an empty bucket without logging it, or a
  // transient error looks identical to "nothing pending" for exactly this actor.
  const [center, report] = await Promise.all([
    getVacationActionCenterData(access).catch((error) => {
      logLoadFailure("Approvals hub vacation action-center data load failed", {
        labels: { event: "approvals_hub_vacation_action_center_failed", hrId: access.hrId, role: access.role, scope: access.scope },
        error,
      });
      return null;
    }),
    getVacationReportData(access, { status: "all" }).catch((error) => {
      logLoadFailure("Approvals hub vacation report data load failed", {
        labels: { event: "approvals_hub_vacation_report_data_failed", hrId: access.hrId, role: access.role, scope: access.scope },
        error,
      });
      return null;
    }),
  ]);

  const awaiting: VacationActionCenterRow[] = [];
  const upcoming: VacationActionCenterRow[] = [];

  for (const row of center?.rows ?? []) {
    // Own submissions are surfaced separately (read-only) — never as an approvable item.
    if (isViewer(row.employeeHrId, hrId)) continue;
    if (anyActionEnabled(row.actionAvailability)) awaiting.push(row);
    else upcoming.push(row);
  }

  // Legacy sick-leave pending items (not covered by the Action Center source).
  const hrActor = isHrActor(access);
  const seen = new Set(awaiting.concat(upcoming).map((r) => r.id));
  for (const record of report?.rows ?? []) {
    if (record.vacationType !== "sick") continue;
    if (seen.has(record.id)) continue;
    if (isViewer(record.employeeHrId, hrId)) continue;
    const managerTurn = record.status === "pending_manager" && isViewer(record.managerHrId, hrId);
    const hrTurn = record.status === "pending_hr" && hrActor;
    if (managerTurn || hrTurn) awaiting.push(sickRecordAsActionRow(record, true));
  }

  // Own submissions live on the dedicated "My Requests" tab (getMyVacationRequestItems below),
  // which shows every status — pending and decided — in one report, not just in-flight ones.
  const byOldest = (a: { createdAt: string }, b: { createdAt: string }) => a.createdAt.localeCompare(b.createdAt);
  awaiting.sort(byOldest);
  upcoming.sort(byOldest);

  return { awaiting, upcoming };
}

/** Shape a legacy sick-leave record into the Action-Center row form (single-step, best-effort). */
function sickRecordAsActionRow(record: VacationRequestRecord, actionable: boolean): VacationActionCenterRow {
  const availability: VacationActionAvailability = actionable
    ? {
        approve: { enabled: true, disabledReason: null },
        reject: { enabled: true, disabledReason: null },
        acknowledge: { enabled: false, disabledReason: null },
        assign: { enabled: false, disabledReason: null },
        return: { enabled: true, disabledReason: null },
      }
    : {
        approve: { enabled: false, disabledReason: "Not your turn." },
        reject: { enabled: false, disabledReason: "Not your turn." },
        acknowledge: { enabled: false, disabledReason: "Not your turn." },
        assign: { enabled: false, disabledReason: "Not your turn." },
        return: { enabled: false, disabledReason: "Not your turn." },
      };
  return {
    ...record,
    approvalSteps: [],
    assignedActorName: record.managerName,
    assignedActorTitle: null,
    actionAvailability: availability,
    slaAgeDays: record.slaStatus?.businessDaysPending ?? 0,
    viewerStepKind: "management",
  };
}

export async function countVacationAwaiting(access: AccessContext): Promise<number> {
  try {
    const { awaiting } = await getVacationApprovalsForResponder(access);
    return awaiting.length;
  } catch (error) {
    logLoadFailure("Approvals hub count vacation awaiting failed", {
      labels: { event: "approvals_hub_count_vacation_awaiting_failed", hrId: access.hrId, role: access.role, scope: access.scope },
      error,
    });
    return 0;
  }
}

// True when at least one awaiting vacation request has breached its SLA — drives the sidebar
// alarm badge's graduated urgency (see NavBadge in components/layout/sidebar.tsx).
export async function isVacationAwaitingOverdue(access: AccessContext): Promise<boolean> {
  try {
    const { awaiting } = await getVacationApprovalsForResponder(access);
    return awaiting.some((row) => slaTone(row.slaAgeDays, APPROVALS_SLA_THRESHOLDS.leave) === "overdue");
  } catch (error) {
    logLoadFailure("Approvals hub vacation awaiting-overdue check failed", {
      labels: { event: "approvals_hub_vacation_awaiting_overdue_failed", hrId: access.hrId, role: access.role, scope: access.scope },
      error,
    });
    return false;
  }
}

/**
 * Badge count + overdue flag derived from ONE getVacationApprovalsForResponder fetch.
 * countVacationAwaiting and isVacationAwaitingOverdue each fetch the full responder
 * dataset independently, so calling both (as the per-domain pending-count endpoint
 * does) fetches it twice per poll — this helper computes both answers, with the same
 * fallbacks, from a single fetch for the batched badge-counts endpoint.
 */
export async function getVacationAwaitingBadge(access: AccessContext): Promise<{ count: number; overdue: boolean }> {
  try {
    const { awaiting } = await getVacationApprovalsForResponder(access);
    return {
      count: awaiting.length,
      overdue: awaiting.some((row) => slaTone(row.slaAgeDays, APPROVALS_SLA_THRESHOLDS.leave) === "overdue"),
    };
  } catch (error) {
    logLoadFailure("Approvals hub vacation awaiting badge computation failed", {
      labels: { event: "approvals_hub_vacation_awaiting_badge_failed", hrId: access.hrId, role: access.role, scope: access.scope },
      error,
    });
    return { count: 0, overdue: false };
  }
}

// ── Excuse buckets (single-step: no "coming to you") ──────────────────────────

export type ExcuseApprovalsBuckets = {
  awaiting: EmployeeExcuseRequest[];
};

export async function getExcuseApprovalsForResponder(access: AccessContext): Promise<ExcuseApprovalsBuckets> {
  const hrId = access.hrId?.trim() ?? "";
  const pending = await getManagerPendingExcuses(access).catch((error) => {
    logLoadFailure("Approvals hub manager pending excuses load failed", {
      labels: { event: "approvals_hub_manager_pending_excuses_failed", hrId: access.hrId, role: access.role, scope: access.scope },
      error,
    });
    return [] as EmployeeExcuseRequest[];
  });

  // Own submissions live on the dedicated "My Requests" tab (getMyExcuseRequestItems below),
  // which shows every status — pending and decided — in one report, not just in-flight ones.
  const awaiting = pending.filter((r) => !isViewer(r.employeeHrId, hrId));
  awaiting.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { awaiting };
}

export async function countExcuseAwaiting(access: AccessContext): Promise<number> {
  try {
    const { awaiting } = await getExcuseApprovalsForResponder(access);
    return awaiting.length;
  } catch (error) {
    logLoadFailure("Approvals hub count excuse awaiting failed", {
      labels: { event: "approvals_hub_count_excuse_awaiting_failed", hrId: access.hrId, role: access.role, scope: access.scope },
      error,
    });
    return 0;
  }
}

// True when at least one awaiting excuse has breached its SLA (see isVacationAwaitingOverdue).
export async function isExcuseAwaitingOverdue(access: AccessContext): Promise<boolean> {
  try {
    const { awaiting } = await getExcuseApprovalsForResponder(access);
    return awaiting.some((req) => slaTone(daysSinceCalendar(req.createdAt), APPROVALS_SLA_THRESHOLDS.excuse) === "overdue");
  } catch (error) {
    logLoadFailure("Approvals hub excuse awaiting-overdue check failed", {
      labels: { event: "approvals_hub_excuse_awaiting_overdue_failed", hrId: access.hrId, role: access.role, scope: access.scope },
      error,
    });
    return false;
  }
}

/** Count + overdue flag from ONE responder fetch (see getVacationAwaitingBadge). */
export async function getExcuseAwaitingBadge(access: AccessContext): Promise<{ count: number; overdue: boolean }> {
  try {
    const { awaiting } = await getExcuseApprovalsForResponder(access);
    return {
      count: awaiting.length,
      overdue: awaiting.some((req) => slaTone(daysSinceCalendar(req.createdAt), APPROVALS_SLA_THRESHOLDS.excuse) === "overdue"),
    };
  } catch (error) {
    logLoadFailure("Approvals hub excuse awaiting badge computation failed", {
      labels: { event: "approvals_hub_excuse_awaiting_badge_failed", hrId: access.hrId, role: access.role, scope: access.scope },
      error,
    });
    return { count: 0, overdue: false };
  }
}

// ── Per-responder history (filtered from the shared history source) ───────────

// Adds a `subtype` (vacation type / excuse type) to the shared HistoricalApprovalItem WITHOUT
// touching that cross-module type or getMyApprovalHistory — both are used by resignation/plan/
// marketing history too. Fetched via one small direct query per page load (same pattern as
// fetchVacationStepsDirect), scoped only to the ids already in this responder's own history.
export type ResponderHistoryItem = HistoricalApprovalItem & { subtype: string | null };

// PostgREST folds every .in() value into the request URL; an unbatched array of a few hundred ids
// can push the URL past undici's ~16KB header limit and throw "TypeError: fetch failed" /
// HeadersOverflowError. A long-tenured approver's own history can reach several hundred ids, so
// these id-lookup helpers batch instead of passing the whole array in one .in() call.
function chunk<T>(items: T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function fetchVacationTypesForIds(ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  for (const batch of chunk(ids)) {
    const { data } = await getSupabaseAdmin().from("v2_vacation_requests").select("id,vacation_type").in("id", batch);
    for (const row of (data as Array<{ id: string; vacation_type: string }> | null) ?? []) {
      map.set(row.id, vacationTypeLabel(row.vacation_type as VacationRequestRecord["vacationType"]));
    }
  }
  return map;
}

async function fetchExcuseTypesForIds(ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  for (const batch of chunk(ids)) {
    const { data } = await getSupabaseAdmin().from("v2_excuse_requests").select("id,excuse_type").in("id", batch);
    for (const row of (data as Array<{ id: string; excuse_type: string }> | null) ?? []) {
      map.set(row.id, row.excuse_type === "morning" ? "Morning" : "Afternoon");
    }
  }
  return map;
}

export async function getResponderVacationHistory(access: AccessContext): Promise<ResponderHistoryItem[]> {
  const all = await getMyApprovalHistory(access).catch(() => [] as HistoricalApprovalItem[]);
  const leave = all.filter((item) => item.module === "leave");
  const types = await fetchVacationTypesForIds(leave.map((item) => historyRawId(item.id)));
  return leave.map((item) => ({
    ...item,
    href: vacationApprovalHref(access, historyRawId(item.id)),
    subtype: types.get(historyRawId(item.id)) ?? null,
  }));
}

export async function getResponderExcuseHistory(access: AccessContext): Promise<ResponderHistoryItem[]> {
  const all = await getMyApprovalHistory(access).catch(() => [] as HistoricalApprovalItem[]);
  const excuse = all.filter((item) => item.module === "excuse");
  const types = await fetchExcuseTypesForIds(excuse.map((item) => historyRawId(item.id)));
  return excuse.map((item) => ({
    ...item,
    href: excuseApprovalHref(access, historyRawId(item.id)),
    subtype: types.get(historyRawId(item.id)) ?? null,
  }));
}

/** History ids are namespaced (e.g. "history:leave:<id>"); recover the raw request id. */
function historyRawId(id: string): string {
  const parts = id.split(":");
  return parts[parts.length - 1] ?? id;
}

// ── "My Requests" — the caller's own submissions, pending AND decided, one report ─
// Reuses the existing cross-module getMyRequestItems/MyRequestItem (same data the old combined
// hub's "My requests" tab showed) filtered to this module, with the href repointed to the new
// per-request page. Unlike the pending "awaiting"/"upcoming" buckets, this never drops an item
// when it gets decided — approve/reject/return all just update its status in place, same list.

export async function getMyVacationRequestItems(access: AccessContext): Promise<MyRequestItem[]> {
  const all = await getMyRequestItems(access).catch(() => [] as MyRequestItem[]);
  return all
    .filter((item) => item.module === "leave")
    .map((item) => ({ ...item, href: vacationApprovalHref(access, historyRawId(item.id)) }));
}

export async function getMyExcuseRequestItems(access: AccessContext): Promise<MyRequestItem[]> {
  const all = await getMyRequestItems(access).catch(() => [] as MyRequestItem[]);
  return all
    .filter((item) => item.module === "excuse")
    .map((item) => ({ ...item, href: excuseApprovalHref(access, historyRawId(item.id)) }));
}

// ── Per-request detail (full record + tracker + per-viewer actions) ───────────

export type VacationApprovalDetail = {
  notFound: boolean;
  record: VacationRequestRecord | null;
  typeLabel: string;
  steps: ApprovalTimelineStep[];
  actions: ApprovalActionFlags;
  stageLabel: string | null;
  slaAgeDays: number;
  readOnly: boolean;
  readOnlyReason: string | null;
  // Mirrors the widened server-side gate in createVacationAttachmentReviewUrl: HR/Super Admin
  // always, OR the caller is the currently assigned, active-turn approver for this request.
  canReviewAttachments: boolean;
  // Stricter than canReviewAttachments: reviewVacationEvidence (accept/reject/needs-follow-up)
  // is HR/Super Admin only, even during a non-HR approver's active turn.
  canReviewEvidence: boolean;
};

function readOnlyReasonForStatus(status: VacationRequestStatus): string {
  if (status === "approved") return "This request is already approved — read-only.";
  if (status === "rejected") return "This request was rejected — read-only.";
  if (status === "returned") return "Returned to the employee — waiting for them to resubmit.";
  return "Not yet your turn — waiting for an earlier approver.";
}

async function fetchVacationStepsDirect(id: string): Promise<ApprovalTimelineStep[]> {
  const db = getSupabaseAdmin();
  const { data } = await db
    .from("v2_vacation_approval_steps")
    .select("step_order,step_key,status,approver_hr_id,decision_comment,decided_at")
    .eq("request_id", id)
    .order("step_order", { ascending: true });
  return ((data as Array<Record<string, unknown>> | null) ?? []).map((s) => ({
    order: Number(s.step_order ?? 0),
    stepKey: String(s.step_key ?? ""),
    genericStep: String(s.step_key ?? ""),
    status: String(s.status ?? ""),
    approverName: s.approver_hr_id ? String(s.approver_hr_id) : null,
    approverTitle: null,
    decidedAt: s.decided_at ? String(s.decided_at) : null,
    decisionComment: s.decision_comment ? String(s.decision_comment) : null,
  }));
}

export async function getVacationApprovalDetail(access: AccessContext, id: string): Promise<VacationApprovalDetail> {
  const hrId = access.hrId?.trim() ?? "";

  // 1) Actionable / coming-to-me — full row with per-viewer availability and named steps.
  const center = await getVacationActionCenterData(access).catch(() => null);
  const row = center?.rows.find((r) => r.id === id) ?? null;
  if (row) {
    const actionable = anyActionEnabled(row.actionAvailability);
    const own = isViewer(row.employeeHrId, hrId);
    return {
      notFound: false,
      record: row,
      typeLabel: vacationTypeLabel(row.vacationType),
      steps: row.approvalSteps.map((step) => ({
        order: step.order,
        stepKey: step.stepKey,
        genericStep: step.genericStep,
        status: step.status,
        approverName: step.approverName,
        approverTitle: step.approverTitle,
        decidedAt: step.decidedAt,
        decisionComment: step.decisionComment,
      })),
      actions: actionable && !own ? toActionFlags(row.actionAvailability) : NO_ACTIONS,
      stageLabel: row.stageLabel ?? null,
      slaAgeDays: row.slaAgeDays,
      readOnly: !actionable || own,
      readOnlyReason: own
        ? "This is your own request — you cannot approve it."
        : actionable
          ? null
          : row.stageLabel ?? "This request is waiting on another approver.",
      canReviewAttachments: isAllVacationVisibility(access) || (actionable && !own),
      canReviewEvidence: isAllVacationVisibility(access),
    };
  }

  // 2) Read-only — decided / terminal / own / out-of-turn. Full record via the scoped report.
  const report = await getVacationReportData(access, { requestId: id, status: "all" }).catch(() => null);
  const record = report?.rows.find((r) => r.id === id) ?? report?.rows[0] ?? null;
  if (!record) {
    return {
      notFound: true,
      record: null,
      typeLabel: "",
      steps: [],
      actions: NO_ACTIONS,
      stageLabel: null,
      slaAgeDays: 0,
      readOnly: true,
      readOnlyReason: null,
      canReviewAttachments: false,
      canReviewEvidence: false,
    };
  }
  const own = isViewer(record.employeeHrId, hrId);
  return {
    notFound: false,
    record,
    typeLabel: vacationTypeLabel(record.vacationType),
    steps: await fetchVacationStepsDirect(id),
    actions: NO_ACTIONS,
    stageLabel: record.stageLabel ?? null,
    slaAgeDays: record.slaStatus?.businessDaysPending ?? 0,
    readOnly: true,
    readOnlyReason: own ? "This is your own request — you cannot approve it." : readOnlyReasonForStatus(record.status),
    // Decided/terminal/out-of-turn case: only HR/Super Admin retains attachment access here — the
    // turn-based widening only applies while it's genuinely the viewer's active turn (branch above).
    canReviewAttachments: isAllVacationVisibility(access),
    canReviewEvidence: isAllVacationVisibility(access),
  };
}

export type ExcuseApprovalDetail = {
  notFound: boolean;
  request: EmployeeExcuseRequest | null;
  canAct: boolean;
  readOnlyReason: string | null;
};

export async function getExcuseApprovalDetail(access: AccessContext, id: string): Promise<ExcuseApprovalDetail> {
  const hrId = access.hrId?.trim() ?? "";
  const result = await getExcuseRequestForActionCenterDeepLink(access, id).catch(() => null);
  if (!result) return { notFound: true, request: null, canAct: false, readOnlyReason: null };

  const own = isViewer(result.request.employeeHrId, hrId);
  const decided = result.request.status !== "pending_manager";
  const canAct = result.canAct && !own && !decided;
  const readOnlyReason = own
    ? "This is your own request — you cannot approve it."
    : decided
      ? "Decision already recorded — read-only."
      : result.canAct
        ? null
        : "Direct manager owns this approval. HR has visibility only.";
  return { notFound: false, request: result.request, canAct, readOnlyReason };
}

// ── View builders (page-ready card data; keeps admin & portal pages identical) ─

export type ApprovalPendingCard = {
  id: string;
  href: string;
  employeeName: string;
  title: string;
  statusLabel: string;
  ageDays?: number | null;
};

function humanizeStatus(status: string): string {
  return String(status ?? "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Excuse has no business-day SLA calculator (unlike vacation's slaStatus.businessDaysPending) —
// mirrors the same calendar-day fallback already used in action-center-hub.tsx's daysSince().
function daysSinceCalendar(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
}

export type VacationWorkspaceData = {
  awaiting: ApprovalPendingCard[];
  upcoming: ApprovalPendingCard[];
  myRequests: MyRequestItem[];
  history: ResponderHistoryItem[];
  pendingCount: number;
  // Only populated for Super Admin / system-scope viewers — the "All Decisions" tab.
  companyWide: CompanyWideDecisionItem[] | null;
  // CEO + Super Admin only — the "Who I Approve" and "Company Requests" oversight tabs.
  approvalScope: ApprovalScopeData | null;
  companyRequests: CompanyRequestItem[] | null;
};

export async function getVacationWorkspaceData(access: AccessContext): Promise<VacationWorkspaceData> {
  const showCompanyWide = isAllVacationVisibility(access);
  const showCeoTabs = canSeeCeoApprovalTabs(access);
  const [buckets, myRequests, history, companyWide, approvalScope, companyRequests] = await Promise.all([
    getVacationApprovalsForResponder(access),
    getMyVacationRequestItems(access),
    getResponderVacationHistory(access),
    showCompanyWide ? getAllVacationDecisionsCompanyWide(access).catch(() => []) : Promise.resolve(null),
    showCeoTabs ? getVacationApprovalScope(access).catch(() => null) : Promise.resolve(null),
    showCeoTabs ? getCompanyVacationRequestsExcludingFieldForce(access).catch(() => []) : Promise.resolve(null),
  ]);
  const toCard = (row: VacationRequestRecord & { slaAgeDays?: number }): ApprovalPendingCard => ({
    id: row.id,
    href: vacationApprovalHref(access, row.id),
    employeeName: row.employeeName,
    title: `${vacationTypeLabel(row.vacationType)} · ${Number(row.durationDays)} day${row.durationDays === 1 ? "" : "s"}`,
    statusLabel: humanizeStatus(row.status),
    ageDays: row.slaAgeDays ?? row.slaStatus?.businessDaysPending ?? null,
  });
  return {
    awaiting: buckets.awaiting.map(toCard),
    upcoming: buckets.upcoming.map(toCard),
    myRequests,
    history,
    pendingCount: buckets.awaiting.length,
    companyWide,
    approvalScope,
    companyRequests,
  };
}

export type ExcuseWorkspaceData = {
  awaiting: ApprovalPendingCard[];
  myRequests: MyRequestItem[];
  history: ResponderHistoryItem[];
  pendingCount: number;
  companyWide: CompanyWideDecisionItem[] | null;
  // CEO + Super Admin only — the "Who I Approve" and "Company Requests" oversight tabs.
  approvalScope: ApprovalScopeData | null;
  companyRequests: CompanyRequestItem[] | null;
};

export async function getExcuseWorkspaceData(access: AccessContext): Promise<ExcuseWorkspaceData> {
  const showCompanyWide = isAllVacationVisibility(access);
  const showCeoTabs = canSeeCeoApprovalTabs(access);
  const [buckets, myRequests, history, companyWide, approvalScope, companyRequests] = await Promise.all([
    getExcuseApprovalsForResponder(access),
    getMyExcuseRequestItems(access),
    getResponderExcuseHistory(access),
    showCompanyWide ? getAllExcuseDecisionsCompanyWide(access).catch(() => []) : Promise.resolve(null),
    showCeoTabs ? getExcuseApprovalScope(access).catch(() => null) : Promise.resolve(null),
    showCeoTabs ? getCompanyExcuseRequestsExcludingFieldForce(access).catch(() => []) : Promise.resolve(null),
  ]);
  const toCard = (req: EmployeeExcuseRequest): ApprovalPendingCard => ({
    id: req.id,
    href: excuseApprovalHref(access, req.id),
    employeeName: req.employeeName,
    title: `${req.excuseType === "morning" ? "Morning" : "Afternoon"} excuse · ${req.excuseDate}`,
    statusLabel: humanizeStatus(req.status),
    ageDays: daysSinceCalendar(req.createdAt),
  });
  return {
    awaiting: buckets.awaiting.map(toCard),
    myRequests,
    history,
    pendingCount: buckets.awaiting.length,
    companyWide,
    approvalScope,
    companyRequests,
  };
}

// ── Stuck approvals — needs reassignment (HR / Super Admin only) ──────────────
//
// Cross-module surface (weekly/monthly plans + excuses) listing requests pinned to a resigned or
// missing approver, so HR can re-route each to an active manager. Gated identically to the two
// reassignment routes (isAllVacationVisibility = system scope OR Super Admin) so anyone who can SEE
// this panel can actually act on it. This is REASSIGNMENT only: the panel changes WHO owns the
// pending step; it never decides a request in place (owner-locked approver model).

export type StuckApprovalManagerOption = { hrId: string; name: string };

export type StuckApprovalsData = {
  weeklyPlans: WeeklyPlanManagerGapRecord[];
  excuses: ExcuseManagerGapRecord[];
  managerOptions: StuckApprovalManagerOption[];
};

export async function getStuckApprovalsForReassignment(access: AccessContext): Promise<StuckApprovalsData> {
  if (!isAllVacationVisibility(access)) {
    throw new Error("Forbidden: only HR or Super Admin can view stuck approvals for reassignment.");
  }
  const [weeklyPlans, excuses, directoryRows] = await Promise.all([
    listWeeklyPlanManagerGapRecords().catch(() => [] as WeeklyPlanManagerGapRecord[]),
    listExcuseManagerGapRecords().catch(() => [] as ExcuseManagerGapRecord[]),
    getEmployeeDirectoryRows().catch(() => [] as EmployeeDirectoryRow[]),
  ]);
  // Active employees only (getEmployeeDirectoryRows default) — the picker must never offer an
  // inactive manager, and the service functions re-validate the choice server-side anyway.
  const managerOptions: StuckApprovalManagerOption[] = directoryRows
    .map((row) => ({ hrId: row.hrId, name: row.displayName || row.fullName || row.hrId }))
    .filter((option) => Boolean(option.hrId))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { weeklyPlans, excuses, managerOptions };
}

// ── Company-wide "All Decisions" (Super Admin / system-scope oversight only) ──

export type CompanyWideDecisionItem = ResponderHistoryItem & { decidedByName: string | null };

function deciderDisplayName(
  employees: Awaited<ReturnType<typeof getEmployeeDirectory>>["employees"],
  hrId: string | null | undefined,
): string | null {
  if (!hrId) return null;
  // The system-administrator console account is not in the employee directory, so a decision it
  // recorded would otherwise render as a bare code. Fall back to the person behind that login —
  // "show names, not codes" — before giving up and returning the raw HR_ID.
  const employee =
    employees.find((e) => hrIdsMatch(e.hrId, hrId))
    ?? employees.find((e) => hrIdsMatch(e.hrId, canonicalPersonHrId(hrId)));
  if (!employee) return hrId;
  return employee.jobTitle ? `${employee.displayName} (${employee.jobTitle})` : employee.displayName;
}

/**
 * Resolves a persisted employee_name snapshot to the employee's live nickname-aware
 * display name when they're still in the active directory, else falls back to the raw
 * snapshot (e.g. an employee who has since left). Keeps the persisted column itself raw
 * (audit trail) while every-day list/card views show the current display name.
 */
function liveEmployeeName(
  employees: Awaited<ReturnType<typeof getEmployeeDirectory>>["employees"],
  hrId: string | null | undefined,
  rawName: string,
): string {
  if (!hrId) return rawName;
  const employee = employees.find((e) => hrIdsMatch(e.hrId, hrId));
  return employee?.displayName ?? rawName;
}

/**
 * Every decided leave request company-wide, regardless of who decided it — Super Admin /
 * system-scope oversight only (never called for any other role; the page also gates the tab's
 * existence behind the same check). Mirrors getMyApprovalHistory's leave query but without the
 * per-caller hrId filter, and resolves each decider's display name via the employee directory.
 */
export async function getAllVacationDecisionsCompanyWide(access: AccessContext): Promise<CompanyWideDecisionItem[]> {
  if (!isAllVacationVisibility(access)) {
    throw new Error("Forbidden: only HR or Super Admin can view company-wide decision history.");
  }
  const db = getSupabaseAdmin();
  const [{ data: leaves }, { data: momSteps }, directory] = await Promise.all([
    db
      .from("v2_vacation_requests")
      .select("id,employee_name,employee_hr_id,vacation_type,start_date,status,manager_decision,manager_decision_at,manager_decision_by_hr_id,hr_decision,hr_decision_at,hr_decision_by_hr_id")
      .or("manager_decision_at.not.is.null,hr_decision_at.not.is.null")
      .order("manager_decision_at", { ascending: false })
      .limit(500),
    db
      .from("v2_vacation_approval_steps")
      .select("request_id,status,approver_hr_id,decided_at,v2_vacation_requests(id,employee_name,employee_hr_id,vacation_type,start_date)")
      .eq("step_key", "manager_of_manager")
      .neq("status", "pending")
      .not("decided_at", "is", null)
      .order("decided_at", { ascending: false })
      .limit(500),
    getEmployeeDirectory(),
  ]);

  const items: CompanyWideDecisionItem[] = [];
  const seenIds = new Set<string>();

  for (const row of (leaves as Array<Record<string, unknown>> | null) ?? []) {
    const id = String(row.id ?? "");
    const isHrDecider = Boolean(row.hr_decision_by_hr_id);
    const decisionRaw = isHrDecider && row.hr_decision ? row.hr_decision : row.manager_decision;
    const decidedAt = isHrDecider && row.hr_decision_at ? row.hr_decision_at : row.manager_decision_at;
    const deciderHrId = isHrDecider ? String(row.hr_decision_by_hr_id) : String(row.manager_decision_by_hr_id ?? "");
    const decision = decodeDecision(decisionRaw as string | null) ?? (row.status === "returned" ? ("returned" as const) : null);
    if (!decision) continue;
    seenIds.add(id);
    items.push({
      id: `history:leave:${id}`,
      module: "leave",
      employeeName: liveEmployeeName(directory.employees, String(row.employee_hr_id ?? ""), String(row.employee_name ?? "Unknown")),
      employeeHrId: String(row.employee_hr_id ?? ""),
      title: `Leave · ${String(row.vacation_type ?? "").replace(/_/g, " ")} · ${row.start_date ?? ""}`,
      decision,
      decidedAt: String(decidedAt ?? ""),
      href: vacationApprovalHref(access, id),
      subtype: vacationTypeLabel(row.vacation_type as VacationRequestRecord["vacationType"]),
      decidedByName: deciderDisplayName(directory.employees, deciderHrId),
    });
  }

  for (const row of (momSteps as Array<Record<string, unknown>> | null) ?? []) {
    const reqId = String(row.request_id ?? "");
    if (!reqId || seenIds.has(reqId)) continue;
    const req = (row as { v2_vacation_requests?: { id?: string; employee_name?: string; employee_hr_id?: string; vacation_type?: string; start_date?: string } | null }).v2_vacation_requests;
    if (!req) continue;
    const decision = row.status === "approved" ? ("approved" as const) : row.status === "rejected" ? ("rejected" as const) : null;
    if (!decision) continue;
    items.push({
      id: `history:leave:${reqId}`,
      module: "leave",
      employeeName: liveEmployeeName(directory.employees, String(req.employee_hr_id ?? ""), String(req.employee_name ?? "Unknown")),
      employeeHrId: String(req.employee_hr_id ?? ""),
      title: `Leave · ${String(req.vacation_type ?? "").replace(/_/g, " ")} · ${String(req.start_date ?? "")}`,
      decision,
      decidedAt: String(row.decided_at ?? ""),
      href: vacationApprovalHref(access, reqId),
      subtype: vacationTypeLabel(req.vacation_type as VacationRequestRecord["vacationType"]),
      decidedByName: deciderDisplayName(directory.employees, String(row.approver_hr_id ?? "")),
    });
  }

  items.sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
  return items;
}

/** Every decided excuse request company-wide — same Super Admin / system-scope oversight gate. */
export async function getAllExcuseDecisionsCompanyWide(access: AccessContext): Promise<CompanyWideDecisionItem[]> {
  if (!isAllVacationVisibility(access)) {
    throw new Error("Forbidden: only HR or Super Admin can view company-wide decision history.");
  }
  const db = getSupabaseAdmin();
  const [{ data: excuses }, directory] = await Promise.all([
    db
      .from("v2_excuse_requests")
      .select("id,employee_name,employee_hr_id,excuse_date,excuse_type,manager_decision,manager_decision_at,manager_decision_by_hr_id")
      .not("manager_decision", "is", null)
      .order("manager_decision_at", { ascending: false })
      .limit(500),
    getEmployeeDirectory(),
  ]);

  const items: CompanyWideDecisionItem[] = [];
  for (const row of (excuses as Array<Record<string, unknown>> | null) ?? []) {
    const decision = decodeDecision(row.manager_decision as string | null);
    if (!decision) continue;
    const id = String(row.id ?? "");
    items.push({
      id: `history:excuse:${id}`,
      module: "excuse",
      employeeName: liveEmployeeName(directory.employees, String(row.employee_hr_id ?? ""), String(row.employee_name ?? "Unknown")),
      employeeHrId: String(row.employee_hr_id ?? ""),
      title: `Excuse · ${String(row.excuse_type ?? "")} · ${row.excuse_date ?? ""}`,
      decision,
      decidedAt: String(row.manager_decision_at ?? ""),
      href: excuseApprovalHref(access, id),
      subtype: row.excuse_type === "morning" ? "Morning" : "Afternoon",
      decidedByName: deciderDisplayName(directory.employees, String(row.manager_decision_by_hr_id ?? "")),
    });
  }
  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// CEO / Super Admin oversight tabs (approval scope + company-wide request feed)
// ─────────────────────────────────────────────────────────────────────────────
// Two extra tabs surfaced ONLY to the CEO and Super Admin on the Vacation/Excuse
// Approvals hub:
//   • "Who I Approve"    — the people whose leave/excuse actually routes to the
//                          viewer, derived LIVE from the org directory + the same
//                          manager-chain rule the approval workflow uses. There is
//                          no static role→role approver map anywhere; authority is
//                          org-position driven, so this is computed, never hard-coded.
//   • "Company Requests" — every leave/excuse request (pending AND decided) company-
//                          wide, excluding submissions by the field force (District
//                          Manager + Medical Rep). Vacation reuses the viewer's own
//                          COMPANY-scoped report (the CEO already sees all company
//                          leave); excuse reads company-wide via the admin client — a
//                          new oversight view the owner explicitly approved for CEO+SA.

/** The CEO and Super Admin (system scope) are the only viewers who get the two oversight tabs. */
export function canSeeCeoApprovalTabs(access: AccessContext): boolean {
  return access.role === "CEO" || isAllVacationVisibility(access);
}

export type ApprovalScopePerson = {
  hrId: string;
  name: string;
  jobTitle: string | null;
};

export type ApprovalScopeGroup = {
  title: string;
  people: ApprovalScopePerson[];
};

export type ApprovalScopeData = {
  groups: ApprovalScopeGroup[];
  totalPeople: number;
};

/**
 * The viewer's DIRECT reports — the people they are personally responsible for approving.
 * Owner-confirmed: "Who I Approve" is the direct-report set ONLY, identical for BOTH leave and
 * excuse — NOT the downstream manager-of-manager chain (e.g. a District Manager is approved by
 * their own National Sales Manager, and must NOT be surfaced under the CEO here). Derived live
 * from the org directory (employee.managerHrId), never a hard-coded list.
 */
async function buildApprovalScope(access: AccessContext): Promise<ApprovalScopeData> {
  const viewerCanonicalHrId = normalizeHrId(access.hrId);
  if (!viewerCanonicalHrId) return { groups: [], totalPeople: 0 };

  const directory = await getEmployeeDirectory().catch((error) => {
    logLoadFailure("Approvals hub approval scope directory load failed", {
      labels: { event: "approvals_hub_build_approval_scope_directory_failed", role: access.role },
      error,
    });
    return null;
  });
  const employees = directory?.employees ?? [];
  if (employees.length === 0) return { groups: [], totalPeople: 0 };

  const people = computeApprovalScopePeople(employees, viewerCanonicalHrId);

  // Group by job title (the human answer to "which roles do I approve"), most-populated first.
  const groupsByTitle = new Map<string, ApprovalScopePerson[]>();
  for (const person of people) {
    const title = (person.jobTitle && person.jobTitle.trim()) || "Unspecified title";
    const bucket = groupsByTitle.get(title) ?? [];
    bucket.push(person);
    groupsByTitle.set(title, bucket);
  }
  const groups = Array.from(groupsByTitle.entries())
    .map(([title, groupPeople]) => ({
      title,
      people: groupPeople.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => b.people.length - a.people.length || a.title.localeCompare(b.title));

  return { groups, totalPeople: people.length };
}

/**
 * Pure, unit-testable core of "Who I Approve": the viewer's DIRECT reports only.
 * Extracted from buildApprovalScope so it can be tested without the getEmployeeDirectory()
 * I/O that function performs. Seat-continuity aware — a report orphaned up to a grandparent
 * after a sub-manager resignation is still owned by the vacant seat — but strictly ONE level
 * (never the manager-of-manager chain), per the owner rule documented above.
 */
export function computeApprovalScopePeople(
  employees: EmployeeDirectoryRow[],
  viewerCanonicalHrId: string,
): ApprovalScopePerson[] {
  const people: ApprovalScopePerson[] = [];
  for (const employee of employees) {
    if (hrIdsMatch(employee.hrId, viewerCanonicalHrId)) continue; // never list the viewer themselves
    // TEAM-only (direct reports) per the owner rule above — do NOT widen to isWithinManagerHierarchy.
    if (reportsToManagerSeat({ employee, viewerCanonicalHrId, canonicalize: normalizeHrId })) {
      people.push({ hrId: employee.hrId, name: employee.displayName || employee.fullName, jobTitle: employee.jobTitle });
    }
  }
  return people;
}

export function getVacationApprovalScope(access: AccessContext): Promise<ApprovalScopeData> {
  return buildApprovalScope(access);
}

export function getExcuseApprovalScope(access: AccessContext): Promise<ApprovalScopeData> {
  return buildApprovalScope(access);
}

// ── "Company Requests" — every request (pending + decided) except the field force ──

export type CompanyRequestStatusTone = "pending" | "approved" | "rejected" | "returned" | "neutral";

export type CompanyRequestItem = {
  id: string;
  href: string;
  employeeName: string;
  employeeHrId: string;
  submitterTitle: string | null;
  typeLabel: string;
  requestDate: string; // the leave start date / excuse date
  submittedAt: string; // when it was submitted (created_at)
  status: string;
  statusLabel: string;
  statusTone: CompanyRequestStatusTone;
};

/** hrId → current job title, for the field-force exclusion + submitter-title display. */
function buildTitleByHrId(employees: EmployeeDirectoryRow[]): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const employee of employees) {
    const key = normalizeHrId(employee.hrId);
    if (key) map.set(key, employee.jobTitle);
  }
  return map;
}

function titleForHrId(titleByHrId: Map<string, string | null>, hrId: string | null | undefined): string | null {
  const key = normalizeHrId(hrId ?? "");
  return key ? titleByHrId.get(key) ?? null : null;
}

/** True when the submitter's current job title classifies as District Manager or Medical Rep. */
function isExcludedFieldForce(title: string | null): boolean {
  const role = resolveJobFunctionRole(title);
  return role === "District Manager" || role === "Medical Rep";
}

function vacationStatusTone(status: string): CompanyRequestStatusTone {
  if (status === "approved") return "approved";
  if (status === "rejected") return "rejected";
  if (status === "returned") return "returned";
  if (status.startsWith("pending") || status.startsWith("needs")) return "pending";
  return "neutral";
}

function excuseStatusTone(status: string): CompanyRequestStatusTone {
  if (status === "approved") return "approved";
  if (status === "rejected") return "rejected";
  if (status === "returned_to_employee") return "returned";
  if (status === "pending_manager") return "pending";
  return "neutral";
}

/**
 * Every leave request company-wide (pending AND decided) except those submitted by the
 * field force (District Manager / Medical Rep). Reuses the viewer's own COMPANY-scoped
 * report — the CEO already has company-wide leave visibility — so this exposes no leave
 * data the viewer couldn't already reach; it only re-shapes and filters it.
 */
export async function getCompanyVacationRequestsExcludingFieldForce(access: AccessContext): Promise<CompanyRequestItem[]> {
  if (!canSeeCeoApprovalTabs(access)) {
    throw new Error("Forbidden: only the CEO or Super Admin can view the company-wide request feed.");
  }
  const [report, directory] = await Promise.all([
    getVacationReportData(access, { status: "all" }).catch((error) => {
      logLoadFailure("Approvals hub company vacation requests report load failed", {
        labels: { event: "approvals_hub_company_vacation_requests_report_failed", role: access.role },
        error,
      });
      return null;
    }),
    getEmployeeDirectory().catch(() => null),
  ]);
  const rows = report?.rows ?? [];
  const titleByHrId = buildTitleByHrId(directory?.employees ?? []);

  const items: CompanyRequestItem[] = [];
  for (const row of rows) {
    const title = titleForHrId(titleByHrId, row.employeeHrId);
    if (isExcludedFieldForce(title)) continue;
    items.push({
      id: row.id,
      href: vacationApprovalHref(access, row.id),
      employeeName: liveEmployeeName(directory?.employees ?? [], row.employeeHrId, row.employeeName),
      employeeHrId: row.employeeHrId,
      submitterTitle: title,
      typeLabel: vacationTypeLabel(row.vacationType),
      requestDate: row.startDate,
      submittedAt: row.createdAt,
      status: row.status,
      statusLabel: humanizeStatus(row.status),
      statusTone: vacationStatusTone(row.status),
    });
  }
  items.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  return items;
}

/**
 * Every excuse request company-wide (pending AND decided) except field-force submissions.
 * Excuse has no company-wide viewer scope today, so this reads via the admin client — a new
 * oversight surface the owner explicitly approved for the CEO + Super Admin only.
 */
export async function getCompanyExcuseRequestsExcludingFieldForce(access: AccessContext): Promise<CompanyRequestItem[]> {
  if (!canSeeCeoApprovalTabs(access)) {
    throw new Error("Forbidden: only the CEO or Super Admin can view the company-wide request feed.");
  }
  const db = getSupabaseAdmin();
  const [{ data, error }, directory] = await Promise.all([
    db
      .from("v2_excuse_requests")
      .select("id,employee_name,employee_hr_id,excuse_date,excuse_type,status,created_at")
      .order("created_at", { ascending: false })
      .limit(1000),
    getEmployeeDirectory().catch(() => null),
  ]);
  if (error) {
    logLoadFailure("Approvals hub company excuse requests query failed", {
      labels: { event: "approvals_hub_company_excuse_requests_query_failed", role: access.role },
      error,
    });
    return [];
  }
  const titleByHrId = buildTitleByHrId(directory?.employees ?? []);

  const items: CompanyRequestItem[] = [];
  for (const row of (data as Array<Record<string, unknown>> | null) ?? []) {
    const employeeHrId = String(row.employee_hr_id ?? "");
    const title = titleForHrId(titleByHrId, employeeHrId);
    if (isExcludedFieldForce(title)) continue;
    const status = String(row.status ?? "");
    const id = String(row.id ?? "");
    items.push({
      id,
      href: excuseApprovalHref(access, id),
      employeeName: liveEmployeeName(directory?.employees ?? [], employeeHrId, String(row.employee_name ?? "Unknown")),
      employeeHrId,
      submitterTitle: title,
      typeLabel: row.excuse_type === "morning" ? "Morning" : "Afternoon",
      requestDate: String(row.excuse_date ?? ""),
      submittedAt: String(row.created_at ?? ""),
      status,
      statusLabel: humanizeStatus(status),
      statusTone: excuseStatusTone(status),
    });
  }
  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// Weekly / Monthly Plan approvals (consolidation only — routing unchanged)
// ─────────────────────────────────────────────────────────────────────────────
// Reuses the existing plan workflow (submit → manager_approve → ceo_approve → HR acknowledge) and
// its decide/acknowledge endpoints verbatim. NOTHING here changes who-approves-whom: the second
// approver is still the CEO for every plan today. The confirmed "manager-of-manager" routing model
// (CEO only for PM) is a separate, later, migration-backed change — deliberately NOT applied here.

export function planApprovalsBasePath(access: Pick<AccessContext, "role" | "scope" | "source">): string {
  return resolveNavigationMode(access as AccessContext) === "employee-portal"
    ? "/employee-portals/approvals/plan"
    : "/admin/approvals/plan";
}

export function planApprovalHref(access: Pick<AccessContext, "role" | "scope" | "source">, id: string): string {
  return `${planApprovalsBasePath(access)}/${encodeURIComponent(id)}`;
}

// Super Admin / system is the only HR-acknowledge authority for plans — mirrors isHrReviewer in
// weekly-planning/service.ts (Super Admin only) and the confirmed approver model.
function isPlanHrActor(access: Pick<AccessContext, "role" | "scope">): boolean {
  return access.role === "Super Admin" || access.scope === "system";
}

// NOTE: the real ceo_approve transition (plan-v1.ts EMPLOYEE_PLAN_TRANSITIONS) goes
// manager_approved -> final_approved DIRECTLY — "ceo_approved" is a legacy enum value the live
// workflow never produces (confirmed: 0 rows in production ever hold it). HR-acknowledge activates
// on "final_approved", not "ceo_approved" — this was caught by an e2e click-through and fixed here.
const PLAN_ACTIVE_STATUSES: EmployeePlanStatus[] = ["submitted", "manager_approved", "final_approved", "edit_requested"];
const PLAN_BUCKET_LIMIT = 400;

export type PlanApprovalStage = "manager" | "ceo" | "hr" | "edit_request";

export type PlanBucketItem = {
  id: string;
  employeeName: string;
  employeeHrId: string;
  planKind: EmployeePlanKind;
  periodKey: string;
  status: EmployeePlanStatus;
  stage: PlanApprovalStage;
  ageDays: number;
  submittedAt: string;
};

export type PlanApprovalsBuckets = {
  awaiting: PlanBucketItem[];
  upcoming: PlanBucketItem[];
};

/**
 * Partition the active plans relevant to the responder into:
 *   • awaiting  — it is currently the caller's turn (manager stage for the assigned manager,
 *                 CEO stage for the CEO, HR acknowledge for Super Admin).
 *   • upcoming  — the caller is a later approver but not yet their turn (the CEO seeing a plan
 *                 still with the direct manager). "Coming to you", view-only.
 * Authority mirrors resolveApproverPlanStage (the same rule the server decide guards enforce),
 * so a plan only lands in "awaiting" for someone actually allowed to act on it now.
 */
export async function getPlanApprovalsForResponder(access: AccessContext): Promise<PlanApprovalsBuckets> {
  const hrId = access.hrId?.trim() ?? "";
  const isCeo = access.role === "CEO";
  const hrActor = isPlanHrActor(access);

  const [{ data, error }, directory] = await Promise.all([
    getSupabaseAdmin()
      .from("employee_plan_headers")
      .select("id,employee_name,employee_hr_id,manager_hr_id,plan_kind,period_key,status,submitted_at,employee_job_title")
      .in("status", PLAN_ACTIVE_STATUSES)
      .order("submitted_at", { ascending: true })
      .limit(PLAN_BUCKET_LIMIT),
    getEmployeeDirectory(),
  ]);
  if (error) {
    logLoadFailure("Approvals hub plan approvals query failed", {
      labels: { event: "approvals_hub_plan_approvals_query_failed", hrId: access.hrId, role: access.role, scope: access.scope },
      error,
    });
    return { awaiting: [], upcoming: [] };
  }

  const awaiting: PlanBucketItem[] = [];
  const upcoming: PlanBucketItem[] = [];

  for (const raw of (data as Array<Record<string, unknown>> | null) ?? []) {
    const status = String(raw.status ?? "") as EmployeePlanStatus;
    const employeeHrId = String(raw.employee_hr_id ?? "");
    // Own submissions live on the dedicated "My Requests" tab, never as an approvable item.
    if (isViewer(employeeHrId, hrId)) continue;
    const managerHrId = raw.manager_hr_id ? String(raw.manager_hr_id) : null;
    const base = {
      id: String(raw.id ?? ""),
      employeeName: liveEmployeeName(directory.employees, employeeHrId, String(raw.employee_name ?? "Unknown")),
      employeeHrId,
      planKind: (String(raw.plan_kind ?? "weekly") === "monthly" ? "monthly" : "weekly") as EmployeePlanKind,
      periodKey: String(raw.period_key ?? ""),
      status,
      ageDays: raw.submitted_at ? daysSinceCalendar(String(raw.submitted_at)) : 0,
      submittedAt: String(raw.submitted_at ?? ""),
    };

    const stage = resolveApproverPlanStage(status, managerHrId, access, String(raw.employee_job_title ?? ""));
    if (stage) {
      awaiting.push({ ...base, stage });
      continue;
    }
    // Employee asked to reopen a submitted plan for edits — only the actual direct manager decides
    // (assertManagerReviewer has no Super Admin bypass — owner-confirmed: he can't act on someone
    // else's turn, only where he's the real assigned manager or at the final HR-acknowledge step).
    if (status === "edit_requested" && isViewer(managerHrId, hrId)) {
      awaiting.push({ ...base, stage: "edit_request" });
      continue;
    }
    if (status === "final_approved" && hrActor) {
      awaiting.push({ ...base, stage: "hr" });
      continue;
    }
    // Also include stuck District Manager plans (manager_approved) for HR to acknowledge.
    // (Acknowledge handles cascading them to final_approved first).
    const isDistrictManagerPlan = isDistrictManagerPlanTitle(String(raw.employee_job_title ?? ""));
    if (status === "manager_approved" && isDistrictManagerPlan && hrActor) {
      awaiting.push({ ...base, stage: "hr" });
      continue;
    }
    // The CEO is the stage-2 approver for every plan today, so a plan still at the manager stage
    // is genuinely "coming to" them. (Super Admin can already act on every stage, so no upcoming.)
    if (isCeo && status === "submitted") {
      upcoming.push({ ...base, stage: "manager" });
      continue;
    }
  }

  // Overdue-first: the longest-waiting plan surfaces to the top so nothing time-sensitive gets
  // buried (a stale weekly plan is worthless by mid-week). Age derives from submission, so this is
  // most-overdue-first with an oldest-submitted tiebreak.
  const byMostOverdue = (a: PlanBucketItem, b: PlanBucketItem) => b.ageDays - a.ageDays || a.submittedAt.localeCompare(b.submittedAt);
  awaiting.sort(byMostOverdue);
  upcoming.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  return { awaiting, upcoming };
}

// True when at least one awaiting plan has breached its SLA (see isVacationAwaitingOverdue).
export async function isPlanAwaitingOverdue(access: AccessContext): Promise<boolean> {
  try {
    const { awaiting } = await getPlanApprovalsForResponder(access);
    return awaiting.some((item) => slaTone(item.ageDays, APPROVALS_SLA_THRESHOLDS.plan) === "overdue");
  } catch (error) {
    logLoadFailure("Approvals hub plan awaiting-overdue check failed", {
      labels: { event: "approvals_hub_plan_awaiting_overdue_failed", hrId: access.hrId, role: access.role, scope: access.scope },
      error,
    });
    return false;
  }
}

export async function countPlanAwaiting(access: AccessContext): Promise<number> {
  try {
    const { awaiting } = await getPlanApprovalsForResponder(access);
    return awaiting.length;
  } catch (error) {
    logLoadFailure("Approvals hub count plan awaiting failed", {
      labels: { event: "approvals_hub_count_plan_awaiting_failed", hrId: access.hrId, role: access.role, scope: access.scope },
      error,
    });
    return 0;
  }
}

/** Count + overdue flag from ONE responder fetch (see getVacationAwaitingBadge). */
export async function getPlanAwaitingBadge(access: AccessContext): Promise<{ count: number; overdue: boolean }> {
  try {
    const { awaiting } = await getPlanApprovalsForResponder(access);
    return {
      count: awaiting.length,
      overdue: awaiting.some((item) => slaTone(item.ageDays, APPROVALS_SLA_THRESHOLDS.plan) === "overdue"),
    };
  } catch (error) {
    logLoadFailure("Approvals hub plan awaiting badge computation failed", {
      labels: { event: "approvals_hub_plan_awaiting_badge_failed", hrId: access.hrId, role: access.role, scope: access.scope },
      error,
    });
    return { count: 0, overdue: false };
  }
}

// ── Plan history + My Requests (filtered from the shared cross-module sources) ─

async function fetchPlanKindsForIds(ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  for (const batch of chunk(ids)) {
    const { data } = await getSupabaseAdmin().from("employee_plan_headers").select("id,plan_kind").in("id", batch);
    for (const row of (data as Array<{ id: string; plan_kind: string }> | null) ?? []) {
      map.set(row.id, row.plan_kind === "monthly" ? "Monthly" : "Weekly");
    }
  }
  return map;
}

export async function getResponderPlanHistory(access: AccessContext): Promise<ResponderHistoryItem[]> {
  const all = await getMyApprovalHistory(access).catch(() => [] as HistoricalApprovalItem[]);
  const plans = all.filter((item) => item.module === "weekly_plan");
  const subtypes = await fetchPlanKindsForIds(plans.map((item) => historyRawId(item.id)));
  return plans.map((item) => ({
    ...item,
    href: planApprovalHref(access, historyRawId(item.id)),
    subtype: subtypes.get(historyRawId(item.id)) ?? null,
  }));
}

export async function getMyPlanRequestItems(access: AccessContext): Promise<MyRequestItem[]> {
  const all = await getMyRequestItems(access).catch(() => [] as MyRequestItem[]);
  return all
    .filter((item) => item.module === "weekly_plan")
    .map((item) => ({ ...item, href: planApprovalHref(access, historyRawId(item.id)) }));
}

// ── Per-plan detail (full calendar + stage tracker + per-viewer actions) ──────

// One activity the approver can flag with a note when returning a plan (premium return composer).
export type PlanReturnableActivity = {
  id: string;
  date: string;
  label: string;
  activityType: string;
  timeLabel: string | null;
};

// At-a-glance make-up of the plan, so the approver sees its shape before reading day-by-day.
export type PlanComposition = {
  field: number;
  doubleVisit: number;
  coaching: number;
  training: number;
  meeting: number;
  admin: number;
  other: number;
  total: number;
  plannedDays: number;
  emptyDays: number;
  totalDays: number;
};

export type PlanPeriodStatus = "upcoming" | "current" | "past";

const EMPTY_PLAN_COMPOSITION: PlanComposition = {
  field: 0, doubleVisit: 0, coaching: 0, training: 0, meeting: 0, admin: 0, other: 0,
  total: 0, plannedDays: 0, emptyDays: 0, totalDays: 0,
};

export type PlanApprovalDetail = {
  notFound: boolean;
  planId: string;
  employeeName: string;
  employeeHrId: string;
  employeeJobTitle: string | null;
  managerName: string | null;
  planKind: EmployeePlanKind;
  periodKey: string;
  periodStartDate: string;
  periodEndDate: string;
  periodStatus: PlanPeriodStatus;
  submittedAt: string | null;
  status: EmployeePlanStatus;
  statusLabel: string;
  // The full day-by-day plan, rendered read-only by the shared WeeklyPlanCalendar.
  calendar: WeeklyPlanDetail | null;
  composition: PlanComposition;
  steps: ApprovalTimelineStep[];
  actions: ApprovalActionFlags;
  // Which decide action the viewer's buttons map to ("manager_*" vs "ceo_*"); null when the only
  // available action is HR acknowledge (different endpoint) or the plan is read-only.
  decisionStage: "manager" | "ceo" | null;
  canAcknowledge: boolean;
  // The employee asked to reopen a submitted plan for edits — the direct manager / Super Admin
  // decides that request (separate /edit-request-decision endpoint).
  isEditRequestDecision: boolean;
  // Manager may ask the employee to add per-doctor visit details before approving (Field days only).
  canRequestVisitDetails: boolean;
  // Activities (with ids) the return composer can attach per-activity notes to.
  returnableActivities: PlanReturnableActivity[];
  // The viewer is the plan's own submitter (read-only for them + gets the planner button; the
  // approver context panel is hidden for them).
  isOwner: boolean;
  // Role-aware link to the full planner where the owner can view/edit their plan through its life.
  plannerHref: string;
  stageLabel: string | null;
  slaAgeDays: number;
  readOnly: boolean;
  readOnlyReason: string | null;
};

function emptyPlanDetail(id: string): PlanApprovalDetail {
  return {
    notFound: true,
    planId: id,
    employeeName: "",
    employeeHrId: "",
    employeeJobTitle: null,
    managerName: null,
    planKind: "weekly",
    periodKey: "",
    periodStartDate: "",
    periodEndDate: "",
    periodStatus: "current",
    submittedAt: null,
    status: "draft",
    statusLabel: "",
    calendar: null,
    composition: EMPTY_PLAN_COMPOSITION,
    steps: [],
    actions: NO_ACTIONS,
    decisionStage: null,
    canAcknowledge: false,
    isEditRequestDecision: false,
    canRequestVisitDetails: false,
    returnableActivities: [],
    isOwner: false,
    plannerHref: "",
    stageLabel: null,
    slaAgeDays: 0,
    readOnly: true,
    readOnlyReason: null,
  };
}

function planTimeLabel(start: unknown, end: unknown): string | null {
  const clean = (v: unknown) => {
    const raw = String(v ?? "").trim();
    if (!raw) return null;
    const m = raw.match(/^(\d{1,2}:\d{2})/);
    return m ? m[1] : raw;
  };
  const s = clean(start);
  const e = clean(end);
  if (s && e) return `${s}–${e}`;
  if (s) return `from ${s}`;
  if (e) return `until ${e}`;
  return null;
}

function mapPlanItemsToCalendar(raw: unknown): WeeklyPlanCalendarItem[] {
  const rows = ((raw as Array<Record<string, unknown>> | undefined) ?? [])
    .slice()
    .sort((a, b) =>
      `${String(a.activity_date ?? "")}-${String(a.sort_order ?? "").padStart(4, "0")}`.localeCompare(
        `${String(b.activity_date ?? "")}-${String(b.sort_order ?? "").padStart(4, "0")}`,
      ),
    );
  return rows.map((item) => {
    const activityType = String(item.activity_type ?? "");
    const title = String(item.activity_title ?? "");
    const isCoaching = activityType === "Other" && title.toLowerCase() === "coaching";
    const visitDetails = ((item.employee_plan_visit_details as Array<Record<string, unknown>> | undefined) ?? [])
      .map((d) => ({
        id: String(d.id ?? ""),
        doctorName: String(d.doctor_name ?? ""),
        speciality: String(d.speciality ?? ""),
        address: String(d.address ?? ""),
        objective: String(d.objective ?? ""),
        sortOrder: Number(d.sort_order ?? 0),
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder);
    return {
      activityDate: String(item.activity_date ?? ""),
      activityLabel: isCoaching ? "Coaching" : title || activityType,
      activityType,
      area: item.area ? String(item.area) : null,
      isCoaching,
      notes: item.notes ? String(item.notes) : null,
      objective: item.objective ? String(item.objective) : null,
      region: item.location_text ? String(item.location_text) : null,
      repName: item.double_visit_medical_rep_name ? String(item.double_visit_medical_rep_name) : null,
      timeLabel: planTimeLabel(item.start_time, item.end_time),
      visitDetails,
    };
  });
}

function planItemIsCoaching(activityType: string, title: string): boolean {
  return activityType === "Other" && title.trim().toLowerCase() === "coaching";
}

/** The plan's activities with ids, for the return composer's per-activity notes. */
function buildReturnableActivities(raw: unknown): PlanReturnableActivity[] {
  const rows = ((raw as Array<Record<string, unknown>> | undefined) ?? [])
    .slice()
    .sort((a, b) =>
      `${String(a.activity_date ?? "")}-${String(a.sort_order ?? "").padStart(4, "0")}`.localeCompare(
        `${String(b.activity_date ?? "")}-${String(b.sort_order ?? "").padStart(4, "0")}`,
      ),
    );
  return rows
    .filter((item) => item.id)
    .map((item) => {
      const activityType = String(item.activity_type ?? "");
      const title = String(item.activity_title ?? "");
      return {
        id: String(item.id),
        date: String(item.activity_date ?? ""),
        label: planItemIsCoaching(activityType, title) ? "Coaching" : title || activityType,
        activityType,
        timeLabel: planTimeLabel(item.start_time, item.end_time),
      };
    });
}

function daysInPlanPeriod(startIso: string, endIso: string): number {
  if (!startIso || !endIso) return 0;
  const toUtc = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y, (m || 1) - 1, d || 1);
  };
  const diff = Math.round((toUtc(endIso) - toUtc(startIso)) / 86_400_000) + 1;
  return diff > 0 && diff < 400 ? diff : 0;
}

/** Count the plan's activities by kind + day coverage — pure, from the raw item rows. */
function computePlanComposition(raw: unknown, planKind: EmployeePlanKind, startIso: string, endIso: string): PlanComposition {
  const rows = (raw as Array<Record<string, unknown>> | undefined) ?? [];
  const comp: PlanComposition = { ...EMPTY_PLAN_COMPOSITION };
  const days = new Set<string>();
  for (const item of rows) {
    const type = String(item.activity_type ?? "");
    const title = String(item.activity_title ?? "");
    comp.total += 1;
    if (item.activity_date) days.add(String(item.activity_date));
    if (planItemIsCoaching(type, title)) comp.coaching += 1;
    else if (type === "Field") comp.field += 1;
    else if (type === "Double Visit") comp.doubleVisit += 1;
    else if (type === "Training") comp.training += 1;
    else if (type === "Meeting" || type === "Event") comp.meeting += 1;
    else if (type === "Office" || type === "Admin" || type === "Remote") comp.admin += 1;
    else comp.other += 1;
  }
  comp.plannedDays = days.size;
  // Empty-day coverage is only meaningful for a weekly grid; monthly is an agenda of active days.
  comp.totalDays = planKind === "weekly" ? daysInPlanPeriod(startIso, endIso) : days.size;
  comp.emptyDays = planKind === "weekly" ? Math.max(0, comp.totalDays - comp.plannedDays) : 0;
  return comp;
}

/** Whether the plan's period is still to come, in progress, or already over — relative to today. */
function computePeriodStatus(startIso: string, endIso: string): PlanPeriodStatus {
  const today = new Date().toISOString().slice(0, 10);
  if (startIso && today < startIso) return "upcoming";
  if (endIso && today > endIso) return "past";
  return "current";
}

function planStageLabel(status: EmployeePlanStatus, isDistrictManagerPlan = false): string | null {
  switch (status) {
    case "submitted":
      return "Direct manager review";
    case "manager_approved":
      // District Manager plans skip the CEO stage entirely -- their manager's approval
      // cascades straight to final_approved, so this status means "awaiting HR", not "awaiting
      // the CEO" (see decideEmployeePlan's isDistrictManagerPlan cascade).
      return isDistrictManagerPlan ? "HR acknowledgement" : "CEO approval";
    case "final_approved":
      // The real ceo_approve transition goes manager_approved -> final_approved directly (no
      // separate "ceo_approved" status exists in practice) — this is the HR-acknowledge stage.
      return "HR acknowledgement";
    case "edit_requested":
      return "Edit request — awaiting manager";
    case "details_requested":
      return "Awaiting visit details";
    case "manager_returned":
    case "ceo_returned":
      return "Returned to employee";
    case "manager_rejected":
    case "ceo_rejected":
      return "Rejected";
    case "hr_acknowledged":
      return "Completed";
    default:
      return null;
  }
}

function planReadOnlyReason(status: EmployeePlanStatus): string {
  switch (status) {
    case "edit_requested":
      return "The employee asked to reopen this plan for edits — waiting on the manager's decision.";
    case "details_requested":
      return "Waiting for the employee to add the requested visit details.";
    case "manager_returned":
    case "ceo_returned":
      return "Returned to the employee — waiting for them to resubmit.";
    case "manager_rejected":
    case "ceo_rejected":
      return "This plan was rejected — read-only.";
    case "final_approved":
      return "Approved — awaiting HR acknowledgement.";
    case "hr_acknowledged":
      return "This plan is fully approved — read-only.";
    default:
      return "Not yet your turn — waiting for an earlier approver.";
  }
}

function buildPlanTrackerSteps(
  row: Record<string, unknown>,
  employees: Awaited<ReturnType<typeof getEmployeeDirectory>>["employees"],
  isDistrictManagerPlan = false,
): ApprovalTimelineStep[] {
  const status = String(row.status ?? "") as EmployeePlanStatus;
  const submittedAt = row.submitted_at ? String(row.submitted_at) : null;
  const managerAt = row.manager_decision_at ? String(row.manager_decision_at) : null;
  const ceoAt = row.ceo_decision_at ? String(row.ceo_decision_at) : null;
  const ack = ((row.employee_plan_hr_acknowledgements as Array<Record<string, unknown>> | undefined) ?? [])[0];
  const ackAt = ack?.acknowledged_at
    ? String(ack.acknowledged_at)
    : row.final_approved_at
      ? String(row.final_approved_at)
      : null;
  const acknowledged = status === "hr_acknowledged" || Boolean(ack);

  const managerStatus =
    status === "submitted" ? "pending"
      : status === "manager_returned" ? "returned"
        : status === "manager_rejected" ? "rejected"
          : managerAt ? "approved"
            : "";
  const ceoStatus =
    status === "manager_approved" ? "pending"
      : status === "ceo_returned" ? "returned"
        : status === "ceo_rejected" ? "rejected"
          : ceoAt ? "approved"
            : "";
  // District Manager plans never carry a real CEO decision -- their manager's approval
  // auto-cascades straight to final_approved (decideEmployeePlan), so "manager_approved" here
  // means "awaiting HR", the same as final_approved does for every other role.
  const hrStatus =
    status === "final_approved" || (isDistrictManagerPlan && status === "manager_approved")
      ? "pending"
      : acknowledged
        ? "approved"
        : "";

  const steps: ApprovalTimelineStep[] = [
    {
      order: 1,
      stepKey: "submitted",
      genericStep: "submitted",
      status: "approved",
      approverName: liveEmployeeName(employees, String(row.employee_hr_id ?? ""), String(row.employee_name ?? "Employee")),
      approverTitle: null,
      decidedAt: submittedAt,
      decisionComment: null,
    },
    {
      order: 2,
      stepKey: "direct_manager",
      genericStep: "direct_manager",
      status: managerStatus,
      approverName: deciderDisplayName(employees, String(row.manager_decision_by_hr_id ?? row.manager_hr_id ?? "")),
      approverTitle: null,
      decidedAt: managerAt,
      decisionComment: row.manager_decision_comment ? String(row.manager_decision_comment) : null,
    },
  ];
  if (!isDistrictManagerPlan) {
    steps.push({
      order: 3,
      stepKey: "ceo",
      genericStep: "ceo",
      status: ceoStatus,
      approverName: deciderDisplayName(employees, String(row.ceo_decision_by_hr_id ?? "")),
      approverTitle: "CEO",
      decidedAt: ceoAt,
      decisionComment: row.ceo_decision_comment ? String(row.ceo_decision_comment) : null,
    });
  }
  steps.push({
    order: steps.length + 1,
    stepKey: "hr",
    genericStep: "hr",
    status: hrStatus,
    approverName: ack?.hr_id ? deciderDisplayName(employees, String(ack.hr_id)) : null,
    approverTitle: "HR",
    decidedAt: ackAt,
    decisionComment: ack?.comment ? String(ack.comment) : null,
  });
  return steps;
}

export async function getPlanApprovalDetail(access: AccessContext, id: string): Promise<PlanApprovalDetail> {
  const hrId = access.hrId?.trim() ?? "";
  const { data, error } = await getSupabaseAdmin()
    .from("employee_plan_headers")
    .select(
      "id,employee_hr_id,employee_name,employee_job_title,manager_hr_id,manager_name,period_key,period_start_date,period_end_date,plan_kind,status,submitted_at,final_approved_at,manager_decision_at,manager_decision_by_hr_id,manager_decision_comment,ceo_decision_at,ceo_decision_by_hr_id,ceo_decision_comment,employee_plan_hr_acknowledgements(acknowledged_at,comment,hr_id),employee_plan_items(id,activity_date,activity_type,activity_title,area,location_text,objective,double_visit_medical_rep_name,start_time,end_time,notes,sort_order,employee_plan_visit_details(id,plan_id,item_id,doctor_name,speciality,address,objective,sort_order))",
    )
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return emptyPlanDetail(id);

  const row = data as Record<string, unknown>;
  const employeeHrId = String(row.employee_hr_id ?? "");
  const status = String(row.status ?? "") as EmployeePlanStatus;
  const managerHrId = row.manager_hr_id ? String(row.manager_hr_id) : null;
  const own = isViewer(employeeHrId, hrId);

  // Visibility (scoped): Super Admin/system, the plan owner, the assigned manager, or the CEO.
  // Anyone else is not allowed to open the plan → not found.
  const isSuperAdmin = access.role === "Super Admin" || access.scope === "system";
  const isCeo = access.role === "CEO";
  const isAssignedManager = isViewer(managerHrId, hrId);
  if (!isSuperAdmin && !own && !isAssignedManager && !isCeo) return emptyPlanDetail(id);

  const directory = await getEmployeeDirectory();
  const planKind = (String(row.plan_kind ?? "weekly") === "monthly" ? "monthly" : "weekly") as EmployeePlanKind;
  const periodStartDate = String(row.period_start_date ?? "");
  const periodEndDate = String(row.period_end_date ?? "");
  const rawItems = row.employee_plan_items;
  const hasFieldItems = ((rawItems as Array<Record<string, unknown>> | undefined) ?? []).some((i) => String(i.activity_type ?? "") === "Field");

  // The viewer's actionable stage (manager|ceo) mirrors the server decide guards; HR acknowledge
  // is the separate final_approved → Super-Admin gate (the real ceo_approve transition goes
  // manager_approved -> final_approved directly; "ceo_approved" is never produced in practice —
  // confirmed live during e2e testing, 0 production rows ever hold that status). Own plans are
  // never actionable by the owner.
  const approverStage = resolveApproverPlanStage(status, managerHrId, access, String(row.employee_job_title ?? ""));
  const isDistrictManagerPlan = isDistrictManagerPlanTitle(String(row.employee_job_title ?? ""));
  const canAcknowledge = (status === "final_approved" || (status === "manager_approved" && isDistrictManagerPlan)) && isSuperAdmin && !own;
  const decisionStage = !own && approverStage ? approverStage : null;
  // The employee's edit-request (reopen a submitted plan) is decided ONLY by the actual direct
  // manager via the separate /edit-request-decision endpoint (assertManagerReviewer has no Super
  // Admin bypass — his authority doesn't extend to standing in for the assigned manager).
  const isEditRequestDecision = status === "edit_requested" && !own && isAssignedManager;
  // Manager may ask the employee for per-doctor visit details before approving (Field days only) —
  // same real-assigned-manager-only authority as requestVisitDetails' assertManagerReviewer guard.
  const canRequestVisitDetails = status === "submitted" && !own && isAssignedManager && hasFieldItems;
  const actionable = Boolean(decisionStage) || canAcknowledge || isEditRequestDecision;

  const actions: ApprovalActionFlags = decisionStage
    ? { approve: true, reject: true, return: true, acknowledge: false }
    : canAcknowledge
      ? { approve: false, reject: false, return: false, acknowledge: true }
      : NO_ACTIONS;

  const items = mapPlanItemsToCalendar(rawItems);
  const reviewBase = resolveNavigationMode(access) === "employee-portal" ? "/employee-portals/plans" : "/admin/weekly-plans";
  const plannerHref = `${reviewBase}?plan=${encodeURIComponent(id)}`;
  const calendar: WeeklyPlanDetail = {
    module: "weekly_plan",
    stage: status === "submitted" ? "manager" : "ceo",
    planKind,
    periodKey: String(row.period_key ?? ""),
    periodStartDate,
    periodEndDate,
    employeeJobTitle: row.employee_job_title ? String(row.employee_job_title) : null,
    managerName: row.manager_name ? String(row.manager_name) : null,
    itemCount: items.length,
    items,
    reviewHref: plannerHref,
  };

  return {
    notFound: false,
    planId: id,
    employeeName: liveEmployeeName(directory.employees, employeeHrId, String(row.employee_name ?? "Unknown")),
    employeeHrId,
    employeeJobTitle: row.employee_job_title ? String(row.employee_job_title) : null,
    managerName: row.manager_name ? String(row.manager_name) : null,
    planKind,
    periodKey: String(row.period_key ?? ""),
    periodStartDate,
    periodEndDate,
    periodStatus: computePeriodStatus(periodStartDate, periodEndDate),
    submittedAt: row.submitted_at ? String(row.submitted_at) : null,
    status,
    statusLabel: humanizeStatus(status),
    calendar,
    composition: computePlanComposition(rawItems, planKind, periodStartDate, periodEndDate),
    steps: buildPlanTrackerSteps(row, directory.employees, isDistrictManagerPlan),
    actions,
    decisionStage,
    canAcknowledge,
    isEditRequestDecision,
    canRequestVisitDetails,
    returnableActivities: buildReturnableActivities(rawItems),
    isOwner: own,
    plannerHref,
    stageLabel: planStageLabel(status, isDistrictManagerPlan),
    slaAgeDays: row.submitted_at ? daysSinceCalendar(String(row.submitted_at)) : 0,
    readOnly: !actionable || own,
    readOnlyReason: own
      ? "This is your own plan — you cannot approve it."
      : actionable
        ? null
        : planReadOnlyReason(status),
  };
}

/** Every decided plan company-wide — same Super Admin / system-scope oversight gate as leave/excuse. */
export async function getAllPlanDecisionsCompanyWide(access: AccessContext): Promise<CompanyWideDecisionItem[]> {
  if (!isPlanHrActor(access)) {
    throw new Error("Forbidden: only HR or Super Admin can view company-wide decision history.");
  }
  const db = getSupabaseAdmin();
  const [{ data: plans }, directory] = await Promise.all([
    db
      .from("employee_plan_headers")
      .select("id,employee_name,employee_hr_id,plan_kind,period_key,status,manager_decision_at,manager_decision_by_hr_id,ceo_decision_at,ceo_decision_by_hr_id")
      .or("manager_decision_at.not.is.null,ceo_decision_at.not.is.null")
      .order("manager_decision_at", { ascending: false })
      .limit(500),
    getEmployeeDirectory(),
  ]);

  const items: CompanyWideDecisionItem[] = [];
  for (const row of (plans as Array<Record<string, unknown>> | null) ?? []) {
    const status = String(row.status ?? "").toLowerCase();
    const hasCeo = Boolean(row.ceo_decision_at);
    const deciderHrId = hasCeo ? String(row.ceo_decision_by_hr_id ?? "") : String(row.manager_decision_by_hr_id ?? "");
    const decidedAt = hasCeo ? row.ceo_decision_at : row.manager_decision_at;
    let decision: "approved" | "rejected" | "returned" | null = null;
    if (status.endsWith("_returned")) decision = "returned";
    else if (status.endsWith("_rejected")) decision = "rejected";
    else if (["manager_approved", "ceo_approved", "final_approved", "hr_acknowledged"].includes(status)) decision = "approved";
    if (!decision) continue;
    const id = String(row.id ?? "");
    const kindLabel = String(row.plan_kind ?? "weekly") === "monthly" ? "Monthly" : "Weekly";
    items.push({
      id: `history:weekly_plan:${id}`,
      module: "weekly_plan",
      employeeName: liveEmployeeName(directory.employees, String(row.employee_hr_id ?? ""), String(row.employee_name ?? "Unknown")),
      employeeHrId: String(row.employee_hr_id ?? ""),
      title: `${kindLabel} plan · ${row.period_key ?? ""}`,
      decision,
      decidedAt: String(decidedAt ?? ""),
      href: planApprovalHref(access, id),
      subtype: kindLabel,
      decidedByName: deciderDisplayName(directory.employees, deciderHrId),
    });
  }
  items.sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
  return items;
}

/** Maps every plan status to the same tone vocabulary the vacation/excuse company views use. */
function planStatusTone(status: string): CompanyRequestStatusTone {
  if (status === "manager_rejected" || status === "ceo_rejected") return "rejected";
  if (status === "manager_returned" || status === "ceo_returned") return "returned";
  if (status === "final_approved" || status === "hr_acknowledged" || status === "ceo_approved") return "approved";
  if (status === "submitted" || status === "edit_requested" || status === "details_requested" || status === "manager_approved") return "pending";
  return "neutral";
}

/**
 * Every submitted plan company-wide (pending AND decided) — CEO + Super Admin oversight only.
 * Unlike the vacation/excuse "Company Requests" views, this does NOT exclude the field force:
 * a District Manager's plans belong here just like anyone else's. Excludes only "draft" rows
 * (never actually submitted, or currently back under revision after a `revise` action).
 */
async function fetchCompanyPlanRequestItems(
  access: AccessContext,
  options?: { districtManagersOnly?: boolean },
): Promise<CompanyRequestItem[]> {
  if (!canSeeCeoApprovalTabs(access)) {
    throw new Error("Forbidden: only the CEO or Super Admin can view the company-wide request feed.");
  }
  const [{ data, error }, directory] = await Promise.all([
    getSupabaseAdmin()
      .from("employee_plan_headers")
      .select("id,employee_name,employee_hr_id,employee_job_title,plan_kind,period_start_date,status,submitted_at")
      .neq("status", "draft")
      .order("submitted_at", { ascending: false })
      .limit(1000),
    getEmployeeDirectory(),
  ]);
  if (error) {
    logLoadFailure("Approvals hub company plan requests query failed", {
      labels: { event: "approvals_hub_company_plan_requests_query_failed", role: access.role },
      error,
    });
    return [];
  }

  const items: CompanyRequestItem[] = [];
  for (const row of (data as Array<Record<string, unknown>> | null) ?? []) {
    const jobTitle = row.employee_job_title ? String(row.employee_job_title) : null;
    if (options?.districtManagersOnly && !isDistrictManagerPlanTitle(jobTitle)) continue;
    const status = String(row.status ?? "");
    const id = String(row.id ?? "");
    items.push({
      id,
      href: planApprovalHref(access, id),
      employeeName: liveEmployeeName(directory.employees, String(row.employee_hr_id ?? ""), String(row.employee_name ?? "Unknown")),
      employeeHrId: String(row.employee_hr_id ?? ""),
      submitterTitle: jobTitle,
      typeLabel: String(row.plan_kind ?? "weekly") === "monthly" ? "Monthly" : "Weekly",
      requestDate: String(row.period_start_date ?? ""),
      submittedAt: String(row.submitted_at ?? ""),
      status,
      statusLabel: humanizeStatus(status),
      statusTone: planStatusTone(status),
    });
  }
  return items;
}

export async function getCompanyPlanRequests(access: AccessContext): Promise<CompanyRequestItem[]> {
  return fetchCompanyPlanRequestItems(access);
}

// District Manager plans never reach a CEO decision (they cascade via their manager's
// approval — see decideEmployeePlan), so the CEO otherwise has no page that surfaces them at
// all. This is a read-only oversight feed, same shape as "Company Plans", filtered to just
// District Manager submitters.
export async function getCompanyDistrictManagerPlanRequests(access: AccessContext): Promise<CompanyRequestItem[]> {
  return fetchCompanyPlanRequestItems(access, { districtManagersOnly: true });
}

// ── Plan workspace (page-ready data for the 4-tab body) ───────────────────────

export type PlanWorkspaceData = {
  awaiting: ApprovalPendingCard[];
  upcoming: ApprovalPendingCard[];
  myRequests: MyRequestItem[];
  history: ResponderHistoryItem[];
  pendingCount: number;
  companyWide: CompanyWideDecisionItem[] | null;
  // CEO + Super Admin only — the "Company Plans" oversight tab (pending AND decided, all roles).
  companyRequests: CompanyRequestItem[] | null;
  // CEO + Super Admin only — read-only "District Manager Plans" tab. District Manager plans
  // never reach a CEO decision (manager approval cascades straight to final_approved), so this
  // is the CEO's only page-level visibility into them.
  districtManagerRequests: CompanyRequestItem[] | null;
};

function planStageStatusLabel(stage: PlanApprovalStage): string {
  if (stage === "manager") return "Needs manager review";
  if (stage === "ceo") return "Needs CEO approval";
  if (stage === "edit_request") return "Edit request — decide";
  return "Needs HR acknowledgement";
}

export async function getPlanWorkspaceData(access: AccessContext): Promise<PlanWorkspaceData> {
  const showCompanyWide = isPlanHrActor(access);
  const showCeoTabs = canSeeCeoApprovalTabs(access);
  const [buckets, myRequests, history, companyWide, companyRequests, districtManagerRequests] = await Promise.all([
    getPlanApprovalsForResponder(access),
    getMyPlanRequestItems(access),
    getResponderPlanHistory(access),
    showCompanyWide ? getAllPlanDecisionsCompanyWide(access).catch(() => []) : Promise.resolve(null),
    showCeoTabs ? getCompanyPlanRequests(access).catch(() => []) : Promise.resolve(null),
    showCeoTabs ? getCompanyDistrictManagerPlanRequests(access).catch(() => []) : Promise.resolve(null),
  ]);
  const toCard = (item: PlanBucketItem): ApprovalPendingCard => ({
    id: item.id,
    href: planApprovalHref(access, item.id),
    employeeName: item.employeeName,
    title: `${item.planKind === "monthly" ? "Monthly" : "Weekly"} plan · ${item.periodKey}`,
    statusLabel: planStageStatusLabel(item.stage),
    ageDays: item.ageDays,
  });
  return {
    awaiting: buckets.awaiting.map(toCard),
    upcoming: buckets.upcoming.map(toCard),
    myRequests,
    history,
    pendingCount: buckets.awaiting.length,
    companyWide,
    companyRequests,
    districtManagerRequests,
  };
}
