import {
  hrIdsMatch,
  normalizeHrId,
  resolveNavigationMode,
  type AccessContext,
} from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchAllApprovalRows } from "@/lib/approvals-hub/page-rows";
import { isMarketingDoubleVisit } from "@/lib/weekly-planning/marketing-double-visit";
import {
  canManageVacationRecords,
  getVacationActionCenterData,
  getVacationAwaitingBadgeSource,
  getVacationReportData,
  isAllVacationVisibility,
  listStrandedVacationRequests,
  type StrandedVacationRow,
} from "@/lib/vacation/service";
import { vacationTypeLabel } from "@/lib/vacation/calculations";
import { formatPhoenixLongDate } from "@/lib/i18n/format";
import { addDaysIso } from "@/lib/crm/dates";
import {
  getExcuseRequestForActionCenterDeepLink,
  getManagerPendingExcuses,
  type EmployeeExcuseRequest,
} from "@/lib/excuses/service";
import { canonicalPersonHrId, isSamePerson } from "@/lib/auth/identity-aliases";
import { getMyApprovalHistory, getMyRequestItems, decodeDecision } from "@/lib/action-center/service";
import { getEmployeeDirectory, getEmployeeDirectoryRows, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { employeeRecordName, resolveEmployeeRecordName } from "@/lib/employees/record-name";
import { logStructured } from "@/lib/observability/log";
import { reportsToManagerSeat } from "@/lib/workforce/hierarchy-resolver";
import { listWeeklyPlanManagerGapRecords, type WeeklyPlanManagerGapRecord } from "@/lib/weekly-planning/drift-check";
import { listExcuseManagerGapRecords, type ExcuseManagerGapRecord } from "@/lib/excuses/drift-check";
import { listStrandedDirectOrders, type StrandedDirectOrderRow } from "@/lib/direct-orders/service";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { resolveApproverPlanStage, resolveSubmitterIsDistrictManager } from "@/lib/weekly-planning/service";
import { authRoleForHrId, loadDistrictManagerAppRoleMatcher } from "@/lib/weekly-planning/service";
import {
  isSecondApproverForManager,
  managerHrIdsForSecondApprover,
  planHasSecondApprover,
  secondApproverHrIdForManager,
  secondApproverTitleForManager,
} from "@/lib/weekly-planning/second-approver";
import type { PlanAdherenceHistory, PlanAdherenceScore } from "@/lib/weekly-planning/plan-adherence";
import { loadPlanAdherence, loadPlanAdherenceHistory } from "@/lib/weekly-planning/plan-adherence-data";
import type { EmployeePlanKind, EmployeePlanStatus } from "@/lib/weekly-planning/plan-v1";
import {
  loadManagerDecisionsBy,
  loadManagerOwnRequests,
  loadManagerPlanFeed,
  loadManagerPlanQueue,
  type ManagerQueueItem,
} from "@/lib/phoenix-crm/server/manager-plan-queue";
import { managerPlannerTitle } from "@/lib/phoenix-crm/manager-plan-rules";
import {
  isDistrictManagerPlanSubmitter,
  isDistrictManagerPlanTitle,
  resolvePlanCeoDecision,
} from "@/lib/weekly-planning/plan-v1";
import type {
  VacationActionAvailability,
  VacationActionButton,
  VacationActionCenterRow,
  VacationAdminOverrideState,
  VacationRequestRecord,
  VacationRequestStatus,
} from "@/lib/vacation/types";
import type {
  ActionHubItem,
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
  overrideApprove: boolean;
  overrideReject: boolean;
};

const NO_ACTIONS: ApprovalActionFlags = {
  approve: false,
  reject: false,
  return: false,
  acknowledge: false,
  overrideApprove: false,
  overrideReject: false,
};

function anyActionEnabled(a: VacationActionAvailability): boolean {
  return Boolean(
    a.approve?.enabled ||
      a.reject?.enabled ||
      a.return?.enabled ||
      a.acknowledge?.enabled ||
      a.assign?.enabled ||
      // Without these two a row whose ONLY live action is the override would be classed
      // read-only, and the button would be computed and then thrown away.
      a.overrideApprove?.enabled ||
      a.overrideReject?.enabled,
  );
}

/**
 * Why each button is off, for the ones we still want SHOWN while off.
 *
 * `ApprovalActionFlags` is a plain boolean per action, shared with excuses and weekly plans, so it
 * cannot carry a reason. The owner asked to see all four vacation buttons at once (2026-09-10) —
 * a greyed button with no explanation is worse than no button, so the reasons travel beside them.
 */
function toActionReasons(a: VacationActionAvailability): Partial<Record<VacationActionButton, string | null>> {
  return {
    acknowledge: a.acknowledge?.disabledReason ?? null,
    overrideApprove: a.overrideApprove?.disabledReason ?? null,
    overrideReject: a.overrideReject?.disabledReason ?? null,
    reject: a.reject?.disabledReason ?? null,
  };
}

function toActionFlags(a: VacationActionAvailability): ApprovalActionFlags {
  return {
    approve: Boolean(a.approve?.enabled),
    reject: Boolean(a.reject?.enabled),
    return: Boolean(a.return?.enabled),
    acknowledge: Boolean(a.acknowledge?.enabled),
    overrideApprove: Boolean(a.overrideApprove?.enabled),
    overrideReject: Boolean(a.overrideReject?.enabled),
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

  return partitionVacationApprovals(access, center?.rows ?? [], report?.rows ?? []);
}

/**
 * The one place the vacation awaiting/upcoming split is decided — the hub pages and the sidebar badge
 * both come through here, so a badge can never count a request the page would not list.
 */
function partitionVacationApprovals(
  access: AccessContext,
  centerRows: VacationActionCenterRow[],
  reportRows: VacationRequestRecord[],
): VacationApprovalsBuckets {
  const hrId = access.hrId?.trim() ?? "";
  const awaiting: VacationActionCenterRow[] = [];
  const upcoming: VacationActionCenterRow[] = [];

  for (const row of centerRows) {
    // Own submissions are surfaced separately (read-only) — never as an approvable item.
    if (isViewer(row.employeeHrId, hrId)) continue;
    if (anyActionEnabled(row.actionAvailability)) awaiting.push(row);
    else upcoming.push(row);
  }

  // Legacy sick-leave pending items (not covered by the Action Center source).
  const hrActor = isHrActor(access);
  const seen = new Set(awaiting.concat(upcoming).map((r) => r.id));
  for (const record of reportRows) {
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

/**
 * The awaiting vacation rows for the sidebar badge (and the per-domain pending-count route) — the
 * same split as {@link getVacationApprovalsForResponder}, built from getVacationAwaitingBadgeSource
 * instead of the full Action Center plus a second full Vacation Report. See that function for why.
 *
 * A failed read degrades exactly as the full path's does: logged, then counted as nothing.
 */
async function getVacationAwaitingForBadge(access: AccessContext): Promise<VacationActionCenterRow[]> {
  const source = await getVacationAwaitingBadgeSource(access).catch((error) => {
    logLoadFailure("Approvals hub vacation badge data load failed", {
      labels: { event: "approvals_hub_vacation_badge_source_failed", hrId: access.hrId, role: access.role, scope: access.scope },
      error,
    });
    return null;
  });
  return partitionVacationApprovals(access, source?.centerRows ?? [], source?.scopedRows ?? []).awaiting;
}

/** Shape a legacy sick-leave record into the Action-Center row form (single-step, best-effort). */
function sickRecordAsActionRow(record: VacationRequestRecord, actionable: boolean): VacationActionCenterRow {
  // Sick leave is the one type still on the LEGACY PARALLEL flow — it has no ordered approval
  // steps, so the stalled-approver override (which decides "the active management step") has
  // nothing to point at. Off on both branches, deliberately.
  const noOverride = { enabled: false, disabledReason: "Sick leave does not use the stepped approval flow." };
  const availability: VacationActionAvailability = actionable
    ? {
        approve: { enabled: true, disabledReason: null },
        reject: { enabled: true, disabledReason: null },
        acknowledge: { enabled: false, disabledReason: null },
        assign: { enabled: false, disabledReason: null },
        return: { enabled: true, disabledReason: null },
        overrideApprove: noOverride,
        overrideReject: noOverride,
      }
    : {
        approve: { enabled: false, disabledReason: "Not your turn." },
        reject: { enabled: false, disabledReason: "Not your turn." },
        acknowledge: { enabled: false, disabledReason: "Not your turn." },
        assign: { enabled: false, disabledReason: "Not your turn." },
        return: { enabled: false, disabledReason: "Not your turn." },
        overrideApprove: noOverride,
        overrideReject: noOverride,
      };
  return {
    ...record,
    approvalSteps: [],
    assignedActorName: record.managerName,
    assignedActorTitle: null,
    actionAvailability: availability,
    adminOverride: null,
    slaAgeDays: record.slaStatus?.businessDaysPending ?? 0,
    viewerStepKind: "management",
  };
}

export async function countVacationAwaiting(access: AccessContext): Promise<number> {
  try {
    const awaiting = await getVacationAwaitingForBadge(access);
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
// alarm badge's graduated urgency (see NavBadge in components/layout/nav-badge.tsx).
export async function isVacationAwaitingOverdue(access: AccessContext): Promise<boolean> {
  try {
    const awaiting = await getVacationAwaitingForBadge(access);
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
 *
 * `available` is false when the read FAILED, and it exists because `count: 0` cannot tell a real
 * zero from a dead query. A badge can live with that — a rail that goes quiet for one poll is a
 * cosmetic fault — but `src/lib/needs-you/` answers "is anything waiting on you", and there a
 * swallowed failure rendering as zero is the whole failure mode: it says "nothing needs you" and
 * the looking has already been delegated. Same field, same meaning and the same reason as
 * getPlanAwaitingBadge below, which has carried it since it was written.
 *
 * Additive on purpose: /api/approvals/badge-counts destructures `count`/`overdue` and is untouched.
 */
export async function getVacationAwaitingBadge(
  access: AccessContext,
): Promise<{ count: number; overdue: boolean; available: boolean }> {
  try {
    const awaiting = await getVacationAwaitingForBadge(access);
    return {
      count: awaiting.length,
      overdue: awaiting.some((row) => slaTone(row.slaAgeDays, APPROVALS_SLA_THRESHOLDS.leave) === "overdue"),
      available: true,
    };
  } catch (error) {
    logLoadFailure("Approvals hub vacation awaiting badge computation failed", {
      labels: { event: "approvals_hub_vacation_awaiting_badge_failed", hrId: access.hrId, role: access.role, scope: access.scope },
      error,
    });
    return { count: 0, overdue: false, available: false };
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

/**
 * Count + overdue flag from ONE responder fetch (see getVacationAwaitingBadge, including why
 * `available` exists and why adding it changes nothing for the badge endpoint).
 *
 * 🔴 One shape to know before trusting a `0` here: getExcuseApprovalsForResponder swallows its OWN
 * failure — getManagerPendingExcuses is wrapped in a `.catch` that logs and returns `[]` — so this
 * try/catch is not the only path to an empty list, and `available: true` alongside `count: 0` does
 * NOT prove the underlying read succeeded. Narrowing that is a change to the responder, not to this
 * badge; until then the needs-you adapter treats an excuse zero as the weakest of its signals.
 */
export async function getExcuseAwaitingBadge(
  access: AccessContext,
): Promise<{ count: number; overdue: boolean; available: boolean }> {
  try {
    const { awaiting } = await getExcuseApprovalsForResponder(access);
    return {
      count: awaiting.length,
      overdue: awaiting.some((req) => slaTone(daysSinceCalendar(req.createdAt), APPROVALS_SLA_THRESHOLDS.excuse) === "overdue"),
      available: true,
    };
  } catch (error) {
    logLoadFailure("Approvals hub excuse awaiting badge computation failed", {
      labels: { event: "approvals_hub_excuse_awaiting_badge_failed", hrId: access.hrId, role: access.role, scope: access.scope },
      error,
    });
    return { count: 0, overdue: false, available: false };
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
  /** Disabled reasons for the buttons that stay visible while off. */
  actionReasons: Partial<Record<VacationActionButton, string | null>>;
  adminOverride: VacationAdminOverrideState | null;
  /** Which seat the viewer occupies on this request — decides whether buttons read "as HR". */
  viewerStepKind: "management" | "hr" | "none";
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
  // HR/Super Admin with the leave create/update/delete grants: shows Edit and Delete on the request
  // page. The Vacation requests report no longer carries either (owner, 2026-10-08).
  canAdminManage: boolean;
};

function readOnlyReasonForStatus(status: VacationRequestStatus): string {
  if (status === "approved") return "This request is already approved — read-only.";
  if (status === "rejected") return "This request was rejected — read-only.";
  if (status === "returned") return "Returned to the employee — waiting for them to resubmit.";
  if (status === "cancelled") return "This request was closed because the employee left — read-only.";
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
  const canAdminManage = await canManageVacationRecords(access).catch(() => false);

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
      actionReasons: own ? {} : toActionReasons(row.actionAvailability),
      adminOverride: own ? null : row.adminOverride,
      viewerStepKind: own ? "none" : row.viewerStepKind,
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
      canAdminManage,
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
      actionReasons: {},
      adminOverride: null,
      viewerStepKind: "none",
      stageLabel: null,
      slaAgeDays: 0,
      readOnly: true,
      readOnlyReason: null,
      canReviewAttachments: false,
      canReviewEvidence: false,
      canAdminManage: false,
    };
  }
  const own = isViewer(record.employeeHrId, hrId);
  return {
    notFound: false,
    record,
    typeLabel: vacationTypeLabel(record.vacationType),
    steps: await fetchVacationStepsDirect(id),
    actions: NO_ACTIONS,
    actionReasons: {},
    adminOverride: null,
    viewerStepKind: "none",
    stageLabel: record.stageLabel ?? null,
    slaAgeDays: record.slaStatus?.businessDaysPending ?? 0,
    readOnly: true,
    readOnlyReason: own ? "This is your own request — you cannot approve it." : readOnlyReasonForStatus(record.status),
    // Decided/terminal/out-of-turn case: only HR/Super Admin retains attachment access here — the
    // turn-based widening only applies while it's genuinely the viewer's active turn (branch above).
    canReviewAttachments: isAllVacationVisibility(access),
    canReviewEvidence: isAllVacationVisibility(access),
    canAdminManage,
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

// ── Stuck approvals — the requests nobody can move (HR / Super Admin only) ────
//
// Cross-module surface listing requests pinned to someone who has left, so they can be unstuck.
// Gated identically to the two reassignment routes (isAllVacationVisibility = system scope OR Super
// Admin) so anyone who can SEE this panel can act on at least part of it.
//
// TWO DIFFERENT REMEDIES LIVE HERE, and the difference is the whole point of the copy:
//
//   * Weekly/monthly plans and excuses are REASSIGNED. The stuck actor is the APPROVER, the request
//     is untouched, and the panel only changes who owns the pending step — it never decides a
//     request in place (owner-locked approver model).
//   * A stranded direct order is CLOSED. There the stuck actor is the REQUESTER: a return is a
//     question addressed to the one person who raised the order, and `reviseDirectOrder` refuses
//     everyone else, so once they resign nobody can ever answer it. Reassigning it would hand a live
//     manager a money edit (a resubmit reprices on today's basis and resumes at the rung that
//     returned it, often the CEO's own), which is why the remedy is to retire the dead question
//     rather than to re-address it. That one DOES decide the request, so it is Super Admin only and
//     the service refuses while the requester can still log in.
//
// Added 2026-10-08, after five stranded direct orders had to be closed by hand-written SQL against
// production because the Needs You board named a remedy no screen could perform.

export type StuckApprovalManagerOption = { hrId: string; name: string };

export type StuckApprovalsData = {
  weeklyPlans: WeeklyPlanManagerGapRecord[];
  excuses: ExcuseManagerGapRecord[];
  /** Returned direct orders whose requester has left. Empty for a viewer who cannot close one. */
  strandedDirectOrders: StrandedDirectOrderRow[];
  /**
   * Whether this viewer may close a stranded direct order. HR can SEE this screen but closing is
   * Super Admin only, so the panel must be able to tell "none stranded" from "not yours to close"
   * rather than rendering a button that is certain to be refused.
   */
  canCloseStrandedDirectOrders: boolean;
  /** Returned vacation requests whose employee has left. Empty for a viewer who cannot close one. */
  strandedVacations: StrandedVacationRow[];
  managerOptions: StuckApprovalManagerOption[];
};

export async function getStuckApprovalsForReassignment(access: AccessContext): Promise<StuckApprovalsData> {
  if (!isAllVacationVisibility(access)) {
    throw new Error("Forbidden: only HR or Super Admin can view stuck approvals for reassignment.");
  }
  // The direct-orders reader's own gate (assertHeldDeskAccess), restated rather than discovered by
  // catching its throw: a swallowed Forbidden is indistinguishable from "nothing is stranded", and
  // this surface exists precisely because a stranded request that shows as nothing ages for ever.
  const canCloseStrandedDirectOrders = access.scope === "system" || access.role === "Super Admin";
  const [weeklyPlans, excuses, strandedDirectOrders, strandedVacations, directoryRows] = await Promise.all([
    listWeeklyPlanManagerGapRecords().catch(() => [] as WeeklyPlanManagerGapRecord[]),
    listExcuseManagerGapRecords().catch(() => [] as ExcuseManagerGapRecord[]),
    canCloseStrandedDirectOrders
      ? listStrandedDirectOrders(access).catch(() => [] as StrandedDirectOrderRow[])
      : Promise.resolve([] as StrandedDirectOrderRow[]),
    // Same gate as the direct orders above (isAllVacationVisibility is Super Admin / system), so
    // the one flag tells the panel "none stranded" from "not yours to close".
    canCloseStrandedDirectOrders
      ? listStrandedVacationRequests(access).catch(() => [] as StrandedVacationRow[])
      : Promise.resolve([] as StrandedVacationRow[]),
    getEmployeeDirectoryRows().catch(() => [] as EmployeeDirectoryRow[]),
  ]);
  // Active employees only (getEmployeeDirectoryRows default) — the picker must never offer an
  // inactive manager, and the service functions re-validate the choice server-side anyway.
  const managerOptions: StuckApprovalManagerOption[] = directoryRows
    .map((row) => ({ hrId: row.hrId, name: row.displayName || row.fullName || row.hrId }))
    .filter((option) => Boolean(option.hrId))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { weeklyPlans, excuses, strandedDirectOrders, canCloseStrandedDirectOrders, strandedVacations, managerOptions };
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
  // The RECORD name, not displayName — the same rule the snapshot resolver below uses. Without it
  // one card reads "<record name> … Decided by <nickname>", two names for two people on one row.
  const name = employeeRecordName(employee);
  return employee.jobTitle ? `${name} (${employee.jobTitle})` : name;
}

/**
 * Resolves a persisted employee_name snapshot to the employee RECORD's current name, falling back
 * to the raw snapshot when the id cannot be resolved. Keeps the persisted column itself raw (audit
 * trail) while every-day list/card views show the name the employee master holds today.
 *
 * It resolves to the RECORD name, not to `displayName`. displayName is nickname-first by design —
 * EmployeeDirectoryRow's own type comment reserves `fullName` for "persisted workflow audit
 * snapshots", and a stored `employee_name` is precisely that. Resolving to displayName is why one
 * outstation request read as the record name on the outstation queue (PRs #4135, #4136) and as a
 * nickname here, for the same person on the same day.
 *
 * `deciderDisplayName` above resolves the same way (owner, 2026-09-21: "align the decided-by name
 * to the record name too"). It is not reading a snapshot — it names a live person beside their job
 * title — but both halves of one card must say the same name for the same person, so it too reads
 * the record name. The one displayName left in this file is the stuck-approvals manager PICKER,
 * which is a live chooser of people and not a name rendered onto a request.
 */
function liveEmployeeName(
  employees: Awaited<ReturnType<typeof getEmployeeDirectory>>["employees"],
  hrId: string | null | undefined,
  rawName: string,
): string {
  if (!hrId) return rawName;
  const employee = employees.find((e) => hrIdsMatch(e.hrId, hrId));
  return resolveEmployeeRecordName(employee ? employeeRecordName(employee) : null, hrId, rawName);
}

/** The job title his HR record carries — "Group Product Manager", not the plan's own kind — or the fallback. */
function liveEmployeeTitle(
  employees: Awaited<ReturnType<typeof getEmployeeDirectory>>["employees"],
  hrId: string | null | undefined,
  fallback: string,
): string {
  if (!hrId) return fallback;
  const title = employees.find((e) => hrIdsMatch(e.hrId, hrId))?.jobTitle?.trim();
  return title || fallback;
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
    fetchAllApprovalRows<Record<string, unknown>>(() =>
      db
        .from("v2_vacation_requests")
        .select("id,employee_name,employee_hr_id,vacation_type,start_date,status,manager_decision,manager_decision_at,manager_decision_by_hr_id,hr_decision,hr_decision_at,hr_decision_by_hr_id")
        .or("manager_decision_at.not.is.null,hr_decision_at.not.is.null")
        .order("manager_decision_at", { ascending: false })
        .order("id", { ascending: false }),
    ),
    fetchAllApprovalRows<Record<string, unknown>>(() =>
      db
        .from("v2_vacation_approval_steps")
        .select("request_id,status,approver_hr_id,decided_at,v2_vacation_requests(id,employee_name,employee_hr_id,vacation_type,start_date)")
        .in("step_key", ["manager_of_manager", "manager_level_3"])
        .neq("status", "pending")
        .not("decided_at", "is", null)
        .order("decided_at", { ascending: false })
        .order("id", { ascending: false }),
    ),
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
    // A returned request's manager_decision can still read "approved" (HR returned after the direct
    // manager approved), so the request's current status wins over the stored decision text.
    const decision = row.status === "returned" ? ("returned" as const) : decodeDecision(decisionRaw as string | null);
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
    fetchAllApprovalRows<Record<string, unknown>>(() =>
      db
        .from("v2_excuse_requests")
        .select("id,employee_name,employee_hr_id,excuse_date,excuse_type,manager_decision,manager_decision_at,manager_decision_by_hr_id")
        .not("manager_decision", "is", null)
        .order("manager_decision_at", { ascending: false })
        .order("id", { ascending: false }),
    ),
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
    fetchAllApprovalRows<Record<string, unknown>>(() =>
      db
        .from("v2_excuse_requests")
        .select("id,employee_name,employee_hr_id,excuse_date,excuse_type,status,created_at")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false }),
    ),
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

// "list_removal" is the district manager's ask to take a customer off his own Phoenix CRM list.
export type PlanApprovalStage = "manager" | "ceo" | "hr" | "edit_request" | "list_removal";

export type PlanBucketItem = {
  id: string;
  // "crm_manager" is the district manager's weekly plan in Phoenix CRM (owner, 2026-10-16): his
  // RSM/NSM decides it here, beside the legacy plans, so the badge, the bell and Needs You count it.
  source: "legacy" | "crm_manager";
  employeeName: string;
  employeeHrId: string;
  planKind: EmployeePlanKind;
  periodKey: string;
  status: EmployeePlanStatus | "crm_waiting";
  stage: PlanApprovalStage;
  ageDays: number;
  submittedAt: string;
  // The card's own title, when it is not the legacy "Weekly plan · <period>".
  title?: string;
};

function crmManagerPlanTitle(item: Pick<ManagerQueueItem, "stage" | "weekStart" | "customerName">): string {
  const week = item.weekStart ? formatPhoenixLongDate(item.weekStart) : "";
  if (item.stage === "removal") return `Remove from Manager's own list · ${item.customerName ?? "a customer"}`;
  if (item.stage === "edit") return `Ask to edit · week of ${week}`;
  return `Weekly plan · week of ${week}`;
}

function crmManagerPlanBucketItem(
  item: ManagerQueueItem,
  employees: Awaited<ReturnType<typeof getEmployeeDirectory>>["employees"],
): PlanBucketItem {
  const stage: PlanApprovalStage =
    item.stage === "first" ? "manager" : item.stage === "second" ? "ceo" : item.stage === "edit" ? "edit_request" : "list_removal";
  return {
    id: item.id,
    source: "crm_manager",
    employeeName: liveEmployeeName(employees, item.managerHrId, "A manager"),
    employeeHrId: item.managerHrId,
    planKind: "weekly",
    periodKey: item.weekStart ?? "",
    status: "crm_waiting",
    stage,
    ageDays: item.waitingSince ? daysSinceCalendar(item.waitingSince) : 0,
    submittedAt: item.waitingSince,
    title: crmManagerPlanTitle(item),
  };
}

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

  const [{ data, error }, directory, crmQueue] = await Promise.all([
    fetchAllApprovalRows<Record<string, unknown>>(() =>
      getSupabaseAdmin()
        .from("employee_plan_headers")
        .select("id,employee_name,employee_hr_id,manager_hr_id,plan_kind,period_key,status,submitted_at,employee_job_title")
        .in("status", PLAN_ACTIVE_STATUSES)
        .order("submitted_at", { ascending: true })
        .order("id", { ascending: true }),
    ),
    getEmployeeDirectory(),
    // The district manager's weekly plan in Phoenix CRM (owner, 2026-10-16). A failed read costs these
    // items only, logged, never the legacy plans beside them — the same trade the legacy read makes.
    loadManagerPlanQueue(hrId, Boolean(access.testPersona)).catch((crmError: unknown) => {
      logLoadFailure("Approvals hub Phoenix CRM manager plan queue failed", {
        labels: { event: "approvals_hub_crm_manager_plan_queue_failed", hrId: access.hrId, role: access.role, scope: access.scope },
        error: crmError,
      });
      return null;
    }),
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
      source: "legacy" as const,
      employeeName: liveEmployeeName(directory.employees, employeeHrId, String(raw.employee_name ?? "Unknown")),
      employeeHrId,
      planKind: (String(raw.plan_kind ?? "weekly") === "monthly" ? "monthly" : "weekly") as EmployeePlanKind,
      periodKey: String(raw.period_key ?? ""),
      status,
      ageDays: raw.submitted_at ? daysSinceCalendar(String(raw.submitted_at)) : 0,
      submittedAt: String(raw.submitted_at ?? ""),
    };

    const employeeJobTitle = String(raw.employee_job_title ?? "");
    const stage = resolveApproverPlanStage(
      status,
      managerHrId,
      access,
      employeeJobTitle,
      await resolveSubmitterIsDistrictManager({
        employee_hr_id: employeeHrId,
        employee_job_title: employeeJobTitle,
        manager_hr_id: managerHrId,
        status,
      }),
    );
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
    // A District Manager plan never rests at manager_approved -- its single manager approval
    // cascades straight to final_approved (getNextEmployeePlanStatus bypassCeo), so it reaches HR
    // through the final_approved branch above. There is no manager_approved DM state to surface,
    // and acknowledging one would throw (phx_weekly_plan_acknowledge only accepts
    // final_approved/hr_acknowledged).
    // The CEO is the stage-2 approver for every plan today, so a plan still at the manager stage
    // is genuinely "coming to" them. (Super Admin can already act on every stage, so no upcoming.)
    if (isCeo && status === "submitted") {
      upcoming.push({ ...base, stage: "manager" });
      continue;
    }
    // The second approver of the DMs reporting to Hany Saad sees each plan still with that manager
    // as "coming to you" — the CEO has no turn on these plans, so this is the one place it is theirs.
    if (status === "submitted" && isSecondApproverForManager(hrId, managerHrId) && isDistrictManagerPlanTitle(String(raw.employee_job_title ?? ""))) {
      upcoming.push({ ...base, stage: "manager" });
      continue;
    }
  }

  // Phoenix CRM district-manager items: the week (first or second stage), his ask to edit it, and his
  // ask to take a customer off his own list. Each is counted once — never also by Phoenix CRM's own
  // Needs You count, which reads the reps' plans only.
  for (const item of crmQueue?.awaiting ?? []) awaiting.push(crmManagerPlanBucketItem(item, directory.employees));
  for (const item of crmQueue?.upcoming ?? []) upcoming.push(crmManagerPlanBucketItem(item, directory.employees));

  // Overdue-first: the longest-waiting plan surfaces to the top so nothing time-sensitive gets
  // buried (a stale weekly plan is worthless by mid-week). Age derives from submission, so this is
  // most-overdue-first with an oldest-submitted tiebreak.
  const byMostOverdue = (a: PlanBucketItem, b: PlanBucketItem) => b.ageDays - a.ageDays || a.submittedAt.localeCompare(b.submittedAt);
  awaiting.sort(byMostOverdue);
  upcoming.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  return { awaiting, upcoming };
}

/**
 * The Phoenix CRM district-manager items waiting on a person, shaped for the Super Admin's view-as
 * inbox (`/api/approvals-hub/hub-data`), which reads the legacy plans through getPlansAwaitingAction.
 * They open on the Hub's own page; the inbox only lists them.
 */
export async function getCrmManagerPlanActionItems(access: AccessContext): Promise<ActionHubItem[]> {
  const [queue, directory] = await Promise.all([
    loadManagerPlanQueue(access.hrId, Boolean(access.testPersona)),
    getEmployeeDirectory(),
  ]);
  return queue.awaiting.map((item) => {
    const bucket = crmManagerPlanBucketItem(item, directory.employees);
    const weekStart = item.weekStart ?? "";
    return {
      id: bucket.id,
      module: "weekly_plan",
      employeeName: bucket.employeeName,
      employeeHrId: bucket.employeeHrId,
      title: bucket.title ?? "Weekly plan",
      statusLabel: planStageStatusLabel(bucket.stage, false),
      submittedAt: bucket.submittedAt,
      urgency: "normal",
      detail: {
        module: "weekly_plan",
        stage: item.stage === "second" ? "ceo" : "manager",
        planKind: "weekly",
        periodKey: weekStart,
        periodStartDate: weekStart,
        periodEndDate: weekStart ? addDaysIso(weekStart, 5) : "",
        employeeJobTitle: liveEmployeeTitle(directory.employees, item.managerHrId, "Manager"),
        managerName: null,
        itemCount: 0,
        items: [],
        reviewHref: `/admin/approvals/plan/${encodeURIComponent(item.id)}`,
      },
    };
  });
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

/**
 * `available: false` on a genuine failure — a thrown/rejected getPlanApprovalsForResponder, not a
 * Promise rejection of this function itself, since this still never rejects (portal-home-plan-
 * count-canonical.test.ts pins that home-snapshot.ts can keep calling it exactly that way). A bare
 * `Promise<number>` could not express "the query failed" separately from "nothing is awaiting" —
 * every caller collapsed both into the same 0, which read on the portal home card and the sidebar
 * badge as a confident "0 plans awaiting your approval" even when the lookup never ran. `count` on
 * a failure is a placeholder value only; callers must gate on `available` before trusting it.
 */
export async function countPlanAwaiting(access: AccessContext): Promise<{ count: number; available: boolean }> {
  try {
    const { awaiting } = await getPlanApprovalsForResponder(access);
    return { count: awaiting.length, available: true };
  } catch (error) {
    logLoadFailure("Approvals hub count plan awaiting failed", {
      labels: { event: "approvals_hub_count_plan_awaiting_failed", hrId: access.hrId, role: access.role, scope: access.scope },
      error,
    });
    return { count: 0, available: false };
  }
}

/**
 * Count + overdue flag from ONE responder fetch (see getVacationAwaitingBadge). `available` carries
 * the same "did the lookup actually run" signal as countPlanAwaiting's — see its doc comment.
 */
export async function getPlanAwaitingBadge(access: AccessContext): Promise<{ count: number; overdue: boolean; available: boolean }> {
  try {
    const { awaiting } = await getPlanApprovalsForResponder(access);
    return {
      count: awaiting.length,
      overdue: awaiting.some((item) => slaTone(item.ageDays, APPROVALS_SLA_THRESHOLDS.plan) === "overdue"),
      available: true,
    };
  } catch (error) {
    logLoadFailure("Approvals hub plan awaiting badge computation failed", {
      labels: { event: "approvals_hub_plan_awaiting_badge_failed", hrId: access.hrId, role: access.role, scope: access.scope },
      error,
    });
    return { count: 0, overdue: false, available: false };
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
  const [all, crmDecisions, directory] = await Promise.all([
    getMyApprovalHistory(access).catch(() => [] as HistoricalApprovalItem[]),
    // The Phoenix CRM district-manager weeks, asks to edit and own-list removals he decided.
    loadManagerDecisionsBy(access.hrId, Boolean(access.testPersona)).catch(() => []),
    getEmployeeDirectory(),
  ]);
  const plans = all.filter((item) => item.module === "weekly_plan");
  const subtypes = await fetchPlanKindsForIds(plans.map((item) => historyRawId(item.id)));
  const legacy: ResponderHistoryItem[] = plans.map((item) => ({
    ...item,
    href: planApprovalHref(access, historyRawId(item.id)),
    subtype: subtypes.get(historyRawId(item.id)) ?? null,
  }));
  const crm: ResponderHistoryItem[] = crmDecisions.map((decision) => ({
    id: `crm_manager:${decision.kind}:${decision.id}`,
    module: "weekly_plan",
    employeeName: liveEmployeeName(directory.employees, decision.managerHrId, "A manager"),
    employeeHrId: decision.managerHrId,
    title: crmManagerPlanTitle({
      stage: decision.kind === "plan" ? "first" : decision.kind,
      weekStart: decision.weekStart,
      customerName: decision.customerName,
    }),
    decision: decision.decision,
    decidedAt: decision.decidedAt,
    href: planApprovalHref(access, decision.id),
    subtype: "Phoenix CRM",
  }));
  return [...legacy, ...crm].sort((left, right) => right.decidedAt.localeCompare(left.decidedAt));
}

function crmRequestStatus(
  record: Awaited<ReturnType<typeof loadManagerOwnRequests>>[number],
  waitingOnName: string | null,
): { label: string; tone: MyRequestItem["statusTone"] } {
  const waiting = { label: waitingOnName ? `Waiting for ${waitingOnName}` : "Waiting for approval", tone: "pending" as const };
  if (record.kind === "plan") {
    if (record.status === "submitted" || record.status === "first_approved") return waiting;
    if (record.status === "approved") return { label: "Approved", tone: "approved" };
    if (record.status === "returned") return { label: "Returned for changes", tone: "returned" };
    return { label: "Not sent", tone: "neutral" };
  }
  // An ask or a removal waits at either step: on the regional manager, then on the NSM above him.
  if (record.status === "pending" || record.status === "first_approved") return waiting;
  if (record.status === "reopened") return { label: "Reopened for editing", tone: "approved" };
  if (record.status === "removed") return { label: "Removed from the list", tone: "approved" };
  if (record.status === "expired") return { label: "Expired with the week", tone: "neutral" };
  return { label: "Refused", tone: "rejected" };
}

export async function getMyPlanRequestItems(access: AccessContext): Promise<MyRequestItem[]> {
  const [all, crmRequests, directory] = await Promise.all([
    getMyRequestItems(access).catch(() => [] as MyRequestItem[]),
    // The district manager's own Phoenix CRM weeks, asks to edit and own-list removals.
    loadManagerOwnRequests(access.hrId, Boolean(access.testPersona)).catch(() => []),
    getEmployeeDirectory(),
  ]);
  const legacy = all
    .filter((item) => item.module === "weekly_plan")
    .map((item) => ({ ...item, href: planApprovalHref(access, historyRawId(item.id)) }));
  const crm: MyRequestItem[] = crmRequests.map((record) => {
    const waitingOnName = record.waitingOnHrId ? liveEmployeeName(directory.employees, record.waitingOnHrId, "the approver") : null;
    const status = crmRequestStatus(record, waitingOnName);
    return {
      id: `crm_manager:${record.kind}:${record.id}`,
      module: "weekly_plan",
      title: crmManagerPlanTitle({
        stage: record.kind === "plan" ? "first" : record.kind,
        weekStart: record.weekStart,
        customerName: record.customerName,
      }).replace("Remove from Manager's own list", "Remove from my own list"),
      statusLabel: status.label,
      statusTone: status.tone,
      submittedAt: record.submittedAt,
      href: planApprovalHref(access, record.id),
      lines: [{ label: "Where", value: "Phoenix CRM" }],
      decisionNote: record.decisionNote,
    };
  });
  return [...legacy, ...crm].sort((left, right) => String(right.submittedAt).localeCompare(String(left.submittedAt)));
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
  // Did the week go the way it was planned — kept vs what the CRM can actually confirm, with the
  // mismatches named. Null when the read failed: a scoring overlay must never take the plan page
  // down, and no number at all is honest where a wrong one is not.
  adherence: PlanAdherenceScore | null;
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
    adherence: null,
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
      // A Marketing Double Visit's partner is a marketing colleague held in `attendees`, not a Medical Rep.
      repName: isMarketingDoubleVisit(activityType, title)
        ? (item.attendees ? String(item.attendees) : null)
        : item.double_visit_medical_rep_name ? String(item.double_visit_medical_rep_name) : null,
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
    else if (type === "Double Visit" || isMarketingDoubleVisit(type, title)) comp.doubleVisit += 1;
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

function planStageLabel(status: EmployeePlanStatus): string | null {
  switch (status) {
    case "submitted":
      return "Direct manager review";
    case "manager_approved":
      // Only non-District-Manager plans ever rest at manager_approved (a DM plan's manager
      // approval cascades straight to final_approved), so this status is always the CEO stage.
      return "CEO approval";
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
  // A District Manager plan whose manager has a second approver keeps a real stage after the
  // manager (second-approver.ts) — shown under the approver's own name, never labelled "CEO".
  hasSecondApprover = false,
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
  // A District Manager plan reaches HR at final_approved (its manager approval cascades straight
  // there, never resting at manager_approved), so the single final_approved test covers every
  // role; the CEO step itself is dropped for DM plans below.
  const hrStatus =
    status === "final_approved"
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
  if (!isDistrictManagerPlan || hasSecondApprover) {
    steps.push({
      order: 3,
      stepKey: "ceo",
      genericStep: "ceo",
      status: ceoStatus,
      approverName: deciderDisplayName(
        employees,
        String(row.ceo_decision_by_hr_id ?? (hasSecondApprover ? secondApproverHrIdForManager(String(row.manager_hr_id ?? "")) : "") ?? ""),
      ),
      approverTitle: hasSecondApprover ? (secondApproverTitleForManager(String(row.manager_hr_id ?? "")) ?? "Second approver") : "CEO",
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
      "id,employee_hr_id,employee_name,employee_job_title,manager_hr_id,manager_name,period_key,period_start_date,period_end_date,plan_kind,status,submitted_at,final_approved_at,manager_decision_at,manager_decision_by_hr_id,manager_decision_comment,ceo_decision_at,ceo_decision_by_hr_id,ceo_decision_comment,employee_plan_hr_acknowledgements(acknowledged_at,comment,hr_id),employee_plan_items(id,activity_date,activity_type,activity_title,area,location_text,objective,attendees,double_visit_medical_rep_name,start_time,end_time,notes,sort_order,employee_plan_visit_details(id,plan_id,item_id,doctor_name,speciality,address,objective,sort_order))",
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
  // The second approver of the DMs reporting to Hany Saad opens every plan of theirs, at any
  // status and period — the history he was asked to be able to read (owner 2026-09-20).
  const isSecondApprover = isSecondApproverForManager(hrId, managerHrId);
  if (!isSuperAdmin && !own && !isAssignedManager && !isCeo && !isSecondApprover) return emptyPlanDetail(id);

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
  const submitterIsDm = await resolveSubmitterIsDistrictManager({
    employee_hr_id: employeeHrId,
    employee_job_title: row.employee_job_title ? String(row.employee_job_title) : null,
    manager_hr_id: managerHrId,
    status,
  });
  const approverStage = resolveApproverPlanStage(status, managerHrId, access, String(row.employee_job_title ?? ""), submitterIsDm);
  // A District Manager plan by title, or by the submitter's app role (an acting District Manager
  // keeps a Medical Representative title). The app-role half is skipped for a plan that really did
  // go through a CEO stage — resting at manager_approved, or carrying a CEO decision, from before
  // the app-role check existed (2026-09-13) — so its tracker keeps the CEO step it actually has.
  const keptCeoStage =
    status === "manager_approved" ||
    resolvePlanCeoDecision(row.employee_job_title, row.ceo_decision_at, row.ceo_decision_by_hr_id, managerHrId) !== null;
  const isDistrictManagerPlan =
    isDistrictManagerPlanTitle(String(row.employee_job_title ?? "")) ||
    (!keptCeoStage && isDistrictManagerPlanSubmitter(null, await authRoleForHrId(employeeHrId)));
  const hasSecondApprover = planHasSecondApprover(managerHrId, isDistrictManagerPlan);
  const canAcknowledge = status === "final_approved" && isSuperAdmin && !own;
  const decisionStage = !own && approverStage ? approverStage : null;
  // The employee's edit-request (reopen a submitted plan) is decided ONLY by the actual direct
  // manager via the separate /edit-request-decision endpoint (assertManagerReviewer has no Super
  // Admin bypass — his authority doesn't extend to standing in for the assigned manager).
  const isEditRequestDecision = status === "edit_requested" && !own && isAssignedManager;
  // Manager may ask the employee for per-doctor visit details before approving (Field days only) —
  // same real-assigned-manager-only authority as requestVisitDetails' assertManagerReviewer guard.
  const canRequestVisitDetails = status === "submitted" && !own && isAssignedManager && hasFieldItems;
  const actionable = Boolean(decisionStage) || canAcknowledge || isEditRequestDecision;

  // The override is a vacation-only capability; weekly plans share the flag shape, not the rule.
  const actions: ApprovalActionFlags = decisionStage
    ? { approve: true, reject: true, return: true, acknowledge: false, overrideApprove: false, overrideReject: false }
    : canAcknowledge
      ? { approve: false, reject: false, return: false, acknowledge: true, overrideApprove: false, overrideReject: false }
      : NO_ACTIONS;

  const items = mapPlanItemsToCalendar(rawItems);
  // Scored here rather than in the component so the page stays a single server render. It reads the
  // CRM, so it is awaited alongside nothing else that depends on it and returns null on any failure.
  const adherence = await loadPlanAdherence(id);
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
    steps: buildPlanTrackerSteps(row, directory.employees, isDistrictManagerPlan, hasSecondApprover),
    actions,
    decisionStage,
    canAcknowledge,
    isEditRequestDecision,
    canRequestVisitDetails,
    returnableActivities: buildReturnableActivities(rawItems),
    isOwner: own,
    plannerHref,
    stageLabel: hasSecondApprover && status === "manager_approved" ? "Second approver review" : planStageLabel(status),
    slaAgeDays: row.submitted_at ? daysSinceCalendar(String(row.submitted_at)) : 0,
    readOnly: !actionable || own,
    readOnlyReason: own
      ? "This is your own plan — you cannot approve it."
      : actionable
        ? null
        : planReadOnlyReason(status),
    adherence,
  };
}

/** Every decided plan company-wide — same Super Admin / system-scope oversight gate as leave/excuse. */
export async function getAllPlanDecisionsCompanyWide(access: AccessContext): Promise<CompanyWideDecisionItem[]> {
  if (!isPlanHrActor(access)) {
    throw new Error("Forbidden: only HR or Super Admin can view company-wide decision history.");
  }
  const db = getSupabaseAdmin();
  const [{ data: plans }, directory] = await Promise.all([
    fetchAllApprovalRows<Record<string, unknown>>(() =>
      db
        .from("employee_plan_headers")
        .select("id,employee_name,employee_hr_id,employee_job_title,manager_hr_id,plan_kind,period_key,status,manager_decision_at,manager_decision_by_hr_id,ceo_decision_at,ceo_decision_by_hr_id")
        .or("manager_decision_at.not.is.null,ceo_decision_at.not.is.null")
        .order("manager_decision_at", { ascending: false })
        .order("id", { ascending: false }),
    ),
    getEmployeeDirectory(),
  ]);

  const items: CompanyWideDecisionItem[] = [];
  for (const row of (plans as Array<Record<string, unknown>> | null) ?? []) {
    const status = String(row.status ?? "").toLowerCase();
    // A District Manager plan has no CEO stage, so its header CEO stamp is never a decision to
    // attribute — resolvePlanCeoDecision, not row.ceo_decision_at, decides whose decision this is.
    const ceo = resolvePlanCeoDecision(row.employee_job_title, row.ceo_decision_at, row.ceo_decision_by_hr_id, row.manager_hr_id);
    const deciderHrId = ceo ? ceo.byHrId : String(row.manager_decision_by_hr_id ?? "");
    const decidedAt = ceo ? ceo.decidedAt : String(row.manager_decision_at ?? "");
    let decision: "approved" | "rejected" | "returned" | null = null;
    if (status.endsWith("_returned")) decision = "returned";
    else if (status.endsWith("_rejected")) decision = "rejected";
    else if (["manager_approved", "ceo_approved", "final_approved", "hr_acknowledged"].includes(status)) decision = "approved";
    if (!decision) continue;
    // Dropping the CEO stamp can leave a row with nothing to date the decision by.
    if (!decidedAt) continue;
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
  options?: { districtManagersOnly?: boolean; managerHrIds?: string[] },
): Promise<CompanyRequestItem[]> {
  if (options?.managerHrIds) {
    // The second approver's own feed (second-approver.ts): only the managers he decides the second
    // stage for, and only for him — never widened to the CEO/Super Admin gate below.
    if (options.managerHrIds.length === 0 || !options.managerHrIds.every((managerHrId) => isSecondApproverForManager(access.hrId, managerHrId))) {
      throw new Error("Forbidden: only the second approver can view this plan feed.");
    }
  } else if (!canSeeCeoApprovalTabs(access)) {
    throw new Error("Forbidden: only the CEO or Super Admin can view the company-wide request feed.");
  }
  // Rebuilt per page, never reused: a PostgREST builder is single-use, so paging a captured one
  // would re-await a spent query and stack a second .order() onto it.
  const buildQuery = () => {
    let query = getSupabaseAdmin()
      .from("employee_plan_headers")
      .select("id,employee_name,employee_hr_id,employee_job_title,plan_kind,period_start_date,status,submitted_at")
      .neq("status", "draft");
    if (options?.managerHrIds) query = query.in("manager_hr_id", options.managerHrIds);
    return query.order("submitted_at", { ascending: false }).order("id", { ascending: false });
  };
  const [{ data, error }, directory] = await Promise.all([
    fetchAllApprovalRows<Record<string, unknown>>(buildQuery),
    getEmployeeDirectory(),
  ]);
  if (error) {
    logLoadFailure("Approvals hub company plan requests query failed", {
      labels: { event: "approvals_hub_company_plan_requests_query_failed", role: access.role },
      error,
    });
    return [];
  }

  // Acting District Managers are titled Medical Representative, so the District Manager feed also
  // admits a submitter who holds the District Manager app role.
  const hasDistrictManagerAppRole = options?.districtManagersOnly ? await loadDistrictManagerAppRoleMatcher() : null;
  const items: CompanyRequestItem[] = [];
  for (const row of (data as Array<Record<string, unknown>> | null) ?? []) {
    const jobTitle = row.employee_job_title ? String(row.employee_job_title) : null;
    if (
      options?.districtManagersOnly &&
      !isDistrictManagerPlanTitle(jobTitle) &&
      !hasDistrictManagerAppRole?.(String(row.employee_hr_id ?? ""))
    ) {
      continue;
    }
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

// Company Plans also carries the Phoenix CRM weeks of the regional, national and product managers (owner,
// 2026-10-17): their legacy plans were on this tab, and the District Manager tab below is for district
// managers only.
export async function getCompanyPlanRequests(access: AccessContext): Promise<CompanyRequestItem[]> {
  const [legacy, crm] = await Promise.all([
    fetchCompanyPlanRequestItems(access),
    fetchCrmManagerPlanRequestItems(access, null, "others"),
  ]);
  return mergeCompanyPlanFeeds(legacy, crm);
}

// District Manager plans never reach a CEO decision (they cascade via their manager's
// approval — see decideEmployeePlan), so the CEO otherwise has no page that surfaces them at
// all. This is a read-only oversight feed, same shape as "Company Plans", filtered to just
// District Manager submitters.
export async function getCompanyDistrictManagerPlanRequests(access: AccessContext): Promise<CompanyRequestItem[]> {
  const [legacy, crm] = await Promise.all([
    fetchCompanyPlanRequestItems(access, { districtManagersOnly: true }),
    fetchCrmManagerPlanRequestItems(access, null, "dm"),
  ]);
  return mergeCompanyPlanFeeds(legacy, crm);
}

const CRM_MANAGER_PLAN_STATUS: Record<string, { label: string; tone: CompanyRequestStatusTone }> = {
  submitted: { label: "Waiting for the first approval", tone: "pending" },
  first_approved: { label: "Waiting for the second approval", tone: "pending" },
  approved: { label: "Approved", tone: "approved" },
  returned: { label: "Returned for changes", tone: "returned" },
};

/**
 * The managers' Phoenix CRM weeks for the same oversight feeds (owner, 2026-10-16; widened 2026-10-17).
 * The caller has already passed the feed's own gate; `secondApproverHrId` narrows it to the weeks stored
 * with that person as their second approver, and `kinds` to the district managers' weeks ("dm") or the
 * regional, national and product managers' ("others"). A failed read costs these rows only, logged.
 */
async function fetchCrmManagerPlanRequestItems(
  access: AccessContext,
  secondApproverHrId: string | null,
  kinds: "dm" | "others" | "all" = "all",
): Promise<CompanyRequestItem[]> {
  try {
    const [feed, directory] = await Promise.all([
      loadManagerPlanFeed(secondApproverHrId === null ? { isTest: Boolean(access.testPersona) } : { isTest: Boolean(access.testPersona), secondApproverHrId }),
      getEmployeeDirectory(),
    ]);
    const rows = kinds === "all" ? feed : feed.filter((row) => (row.plannerKind === "dm") === (kinds === "dm"));
    return rows.map((row) => {
      const status = CRM_MANAGER_PLAN_STATUS[row.status] ?? { label: humanizeStatus(row.status), tone: "neutral" as const };
      return {
        id: row.planId,
        href: planApprovalHref(access, row.planId),
        employeeName: liveEmployeeName(directory.employees, row.managerHrId, "A manager"),
        employeeHrId: row.managerHrId,
        submitterTitle: liveEmployeeTitle(directory.employees, row.managerHrId, managerPlannerTitle(row.plannerKind)),
        typeLabel: "Weekly · Phoenix CRM",
        requestDate: row.weekStart,
        submittedAt: row.submittedAt ?? "",
        status: row.status,
        statusLabel: status.label,
        statusTone: status.tone,
      };
    });
  } catch (error) {
    logLoadFailure("Approvals hub Phoenix CRM manager plan feed failed", {
      labels: { event: "approvals_hub_crm_manager_plan_feed_failed", role: access.role },
      error,
    });
    return [];
  }
}

function mergeCompanyPlanFeeds(legacy: CompanyRequestItem[], crm: CompanyRequestItem[]): CompanyRequestItem[] {
  return [...legacy, ...crm].sort((left, right) => String(right.submittedAt).localeCompare(String(left.submittedAt)));
}

// Every plan (pending AND decided, every period) of the District Managers reporting to the
// managers this viewer decides the second stage for — the read-only history feed that gives the
// second approver (second-approver.ts) the plans he approves and the ones that came before his stage
// existed. Null for everyone who is nobody's second approver, which is nearly everyone.
export async function getSecondApproverPlanRequests(access: AccessContext): Promise<CompanyRequestItem[] | null> {
  const managerHrIds = managerHrIdsForSecondApprover(access.hrId);
  const [legacy, crm] = await Promise.all([
    managerHrIds.length > 0 ? fetchCompanyPlanRequestItems(access, { managerHrIds }) : Promise.resolve([] as CompanyRequestItem[]),
    // His Phoenix CRM feed is every week stored with HIM as its second approver: the NSM above any
    // regional manager (owner, 2026-10-17), read from the organogram at the send — not the named pair.
    access.hrId ? fetchCrmManagerPlanRequestItems(access, access.hrId) : Promise.resolve([] as CompanyRequestItem[]),
  ]);
  if (managerHrIds.length === 0 && crm.length === 0) return null;
  return mergeCompanyPlanFeeds(legacy, crm);
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
  // The viewer's OWN plan-score history, newest first — the extra tab. Null for someone who has
  // never filed a plan, which is most of the company: the plan module is managers only (20 people
  // on production, no medical rep has ever submitted one), and a tab reading "no history" for
  // everybody else is noise on a page they came to for something else.
  scoreHistory: PlanAdherenceHistory | null;
  // Role-aware base for a plan's detail page, so a score-history row links straight to the plan it
  // scored — the owner's "I want them to be linking". Resolved here because the base differs
  // between the admin shell and the employee portal.
  planDetailBaseHref: string;
};

function planStageStatusLabel(stage: PlanApprovalStage, viewerIsCeo = true): string {
  if (stage === "manager") return "Needs manager review";
  // The second approver of the DMs reporting to Hany Saad holds this stage, not the CEO.
  if (stage === "ceo") return viewerIsCeo ? "Needs CEO approval" : "Needs your approval";
  if (stage === "edit_request") return "Edit request — decide";
  if (stage === "list_removal") return "Customer removal — decide";
  return "Needs HR acknowledgement";
}

export async function getPlanWorkspaceData(access: AccessContext): Promise<PlanWorkspaceData> {
  const showCompanyWide = isPlanHrActor(access);
  const showCeoTabs = canSeeCeoApprovalTabs(access);
  const [buckets, myRequests, history, companyWide, companyRequests, districtManagerRequests, scoreHistory] =
    await Promise.all([
      getPlanApprovalsForResponder(access),
      getMyPlanRequestItems(access),
      getResponderPlanHistory(access),
      showCompanyWide ? getAllPlanDecisionsCompanyWide(access).catch(() => []) : Promise.resolve(null),
      showCeoTabs ? getCompanyPlanRequests(access).catch(() => []) : Promise.resolve(null),
      showCeoTabs
        ? getCompanyDistrictManagerPlanRequests(access).catch(() => [])
        : getSecondApproverPlanRequests(access).catch(() => null),
      // Never throws — the score is an overlay, and a CRM read that fails must cost a tab, not the page.
      loadPlanAdherenceHistory(access.hrId).catch(() => null),
    ]);
  const toCard = (item: PlanBucketItem): ApprovalPendingCard => ({
    id: item.id,
    href: planApprovalHref(access, item.id),
    employeeName: item.employeeName,
    title: item.title ?? `${item.planKind === "monthly" ? "Monthly" : "Weekly"} plan · ${item.periodKey}`,
    statusLabel: planStageStatusLabel(item.stage, access.role === "CEO" || access.role === "Super Admin"),
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
    scoreHistory: scoreHistory && scoreHistory.entries.length > 0 ? scoreHistory : null,
    planDetailBaseHref: planApprovalsBasePath(access),
  };
}
