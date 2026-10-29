import { hrIdsMatch, resolveNavigationMode, type AccessContext } from "@/lib/auth/permissions";
import { humanizeCode } from "@/lib/format/code-label";
import { otherApprovalsInboxIsAlwaysEmptyFor } from "@/lib/action-center/inbox-reach";
import { isSamePerson, sharedIdentityKeys } from "@/lib/auth/identity-aliases";
import type { ActionHubItem, ActionHubModule, HistoricalApprovalItem, MyRequestItem, MyRequestStatusTone } from "@/components/action-center/types";
import { getEmployeeNameRoster, type EmployeeNameRosterRow } from "@/lib/employees/employee-directory";
import { logStructured } from "@/lib/observability/log";
// The same pager the Approvals Hub uses (#4273). One implementation, not a second copy: both
// surfaces answer the same question — "every request this person decided" — and a cap on either
// hides real decisions the same way.
import { fetchAllApprovalRows } from "@/lib/approvals-hub/page-rows";
import { quotedOrClause } from "@/lib/supabase/search-filter";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isMarketingDoubleVisit } from "@/lib/weekly-planning/marketing-double-visit";
import { vacationTypeLabel } from "@/lib/vacation/calculations";
import { getVacationReportData } from "@/lib/vacation/service";
import {
  getExcuseRequestForActionCenterDeepLink,
  getExcuseWorkspace,
  type EmployeeExcuseRequest,
} from "@/lib/excuses/service";
import { canUseAdminOutstationWorkspace } from "@/lib/outstation/admin-access";
import { listMedicalRepExpenseRequests, listOutstationRequests } from "@/lib/outstation/service";
import { listMyOwnPlanSummaries, type OwnPlanSummary } from "@/lib/weekly-planning/service";
import { resolvePlanCeoDecision } from "@/lib/weekly-planning/plan-v1";
import { getMyResignations, getResignationsDashboardData } from "@/lib/resignations/service";
import { getContractRenewalDashboardData } from "@/lib/contracts/service";
import { listMyDirectOrders } from "@/lib/direct-orders/service";
import { describeDirectOrderBasketQuantities } from "@/lib/direct-orders/basket-label";
import { formatHistoryMoney, historyDate, historyPlanPeriod } from "@/lib/action-center/approval-history-format";
import {
  buildLeaveHistory,
  directOrderHistoryRow,
  marketingStanding,
  resolveHistoryOutcome,
  type HistoryDirectOrderParent,
  type HistoryLeaveRequestRow,
  type HistoryLeaveStepRow,
} from "@/lib/action-center/approval-history-outcome";
import type { DirectOrderApprovalListItem } from "@/lib/direct-orders/types";
import type { VacationRequestRecord } from "@/lib/vacation/types";
import type { OutstationExpenseRequest } from "@/lib/outstation/types";
import type { ResignationRecord } from "@/lib/resignations/types";
import type { ContractRow } from "@/lib/contracts/types";

// Normalize any module's raw status token into a small set of display tones.
function toTone(status: string): MyRequestStatusTone {
  const s = String(status ?? "").toLowerCase();
  if (/(reject|declin|denied|cancel)/.test(s)) return "rejected";
  if (/(return|needs_edit|sent_back|resubmit)/.test(s)) return "returned";
  if (/(approv|acknowledg|complet|finaliz|active|accepted)/.test(s)) return "approved";
  if (/(pending|submit|review|await|draft|needs_assignment|in_progress|current)/.test(s)) return "pending";
  return "neutral";
}

function humanize(status: string): string {
  // Title Case is this module's own spelling; humanizeCode names the acronyms (CEO, HR) it used to mangle.
  return humanizeCode(String(status ?? "")).replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// Exported: reused by the Approvals Hub's company-wide "All Decisions" view
// (src/lib/approvals-hub/service.ts) so decision-text parsing stays in one place.
export function decodeDecision(raw: string | null | undefined): "approved" | "rejected" | "returned" | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (/(approv|accept)/.test(s)) return "approved";
  if (/(reject|declin|denied)/.test(s)) return "rejected";
  if (/(return|resubmit|sent_back)/.test(s)) return "returned";
  return null;
}

function mapVacation(row: VacationRequestRecord): MyRequestItem {
  const type = vacationTypeLabel(row.vacationType);
  return {
    id: `leave:${row.id}`,
    module: "leave",
    title: `${type} · ${Number(row.durationDays)} day${row.durationDays === 1 ? "" : "s"}`,
    statusLabel: humanize(row.status),
    statusTone: toTone(row.status),
    submittedAt: row.createdAt,
    href: `/employee-portals/excuses?requestId=${encodeURIComponent(row.id)}`,
    lines: [
      { label: "Type", value: type },
      { label: "From", value: row.startDate },
      { label: "To", value: row.endDate },
    ],
    decisionNote: row.hrDecisionComment ?? row.managerDecisionComment ?? null,
  };
}

function mapExcuse(row: EmployeeExcuseRequest): MyRequestItem {
  return {
    id: `excuse:${row.id}`,
    module: "excuse",
    title: `${row.excuseType === "morning" ? "Morning" : "Afternoon"} excuse · ${row.excuseDate}`,
    statusLabel: humanize(row.status),
    statusTone: toTone(row.status),
    submittedAt: row.createdAt,
    href: null,
    lines: [
      { label: "Date", value: row.excuseDate },
      { label: "Duration", value: `${row.durationHours} hours` },
    ],
    decisionNote: row.managerDecisionComment,
  };
}

function mapOutstation(row: OutstationExpenseRequest): MyRequestItem {
  const status = row.status ?? "submitted";
  return {
    id: `outstation:${row.id}`,
    module: "outstation",
    title: `Outstation · ${row.tripStartDate}`,
    statusLabel: humanize(status),
    statusTone: toTone(status),
    submittedAt: row.createdAt,
    href: null,
    lines: [
      { label: "Type", value: String(row.expenseType) },
      { label: "Trip start", value: row.tripStartDate },
      { label: "Claimed", value: `${Number(row.claimedTotalAmount || 0).toLocaleString("en-EG", { maximumFractionDigits: 2 })} EGP` },
    ],
    decisionNote: null,
  };
}

function mapPlan(row: OwnPlanSummary): MyRequestItem {
  return {
    id: `weekly_plan:${row.id}`,
    module: "weekly_plan",
    title: `Weekly plan · ${row.periodKey}`,
    statusLabel: humanize(row.status),
    statusTone: toTone(row.status),
    submittedAt: row.submittedAt ?? row.updatedAt,
    href: null,
    lines: [
      { label: "Period", value: row.periodStartDate },
      ...(row.managerName ? [{ label: "Manager", value: row.managerName }] : []),
    ],
    decisionNote: null,
  };
}

function mapResignationRecord(row: ResignationRecord): MyRequestItem {
  return {
    id: `resignation:${row.id}`,
    module: "resignation",
    title: `Resignation · effective ${row.effectiveDate}`,
    statusLabel: humanize(row.status),
    statusTone: toTone(row.status),
    submittedAt: row.createdAt,
    href: null,
    lines: [
      { label: "Effective", value: row.effectiveDate },
      { label: "Submitted", value: row.submittedDate },
    ],
    decisionNote: row.rejectedReason ?? row.workflowNotes ?? null,
  };
}

/** EGP amount formatted the same way every other money line in this hub is. */
function egp(amount: number): string {
  return formatHistoryMoney(amount);
}

/** The deal term an approver actually has to judge: bonus units, or a discount percentage. */
function directOrderDealLine(row: DirectOrderApprovalListItem): { label: string; value: string } {
  return row.dealType === "discount"
    ? { label: "Discount", value: `${Number(row.discountPct ?? 0)}%` }
    : { label: "Bonus", value: `${row.bonus} unit(s)` };
}

function mapMyDirectOrder(row: DirectOrderApprovalListItem): MyRequestItem {
  return {
    id: `direct_order:${row.id}`,
    module: "direct_order",
    title: `Direct order · ${row.productName} → ${row.pharmacyName}`,
    statusLabel: row.status === "pending_approval" && row.activeStepLabel ? `Awaiting ${row.activeStepLabel}` : humanize(row.status),
    statusTone: toTone(row.status),
    submittedAt: row.createdAt,
    href: null,
    lines: [
      // Per product, in the order the title names them ("72 + 24") — a basket has no single quantity.
      { label: "Quantity", value: describeDirectOrderBasketQuantities(row, row.items) },
      directOrderDealLine(row),
      // Bonus units never enter value — see src/lib/direct-orders/approval-flow.ts.
      { label: "Sales value", value: egp(row.salesValue) },
      { label: "Pharmacy", value: `${row.pharmacyName} (${row.pharmacyCode})` },
      { label: "Area", value: row.areaName || "—" },
      { label: "Medical rep", value: row.medicalRepVacant ? "Vacant" : row.medicalRepName || "—" },
      ...(row.bonusOverCap ? [{ label: "Over cap", value: "Yes — flagged for approvers, not blocked" }] : []),
    ],
    decisionNote: null,
  };
}

/**
 * Aggregate every request the signed-in employee submitted themselves, across
 * modules, into one uniform list for the Actions "My requests" tab.
 *
 * Each source is resolved independently and failures degrade to "no items for
 * that module" (a non-eligible employee — e.g. a non-medical-rep with no
 * outstation access — simply contributes nothing) rather than failing the page.
 * Every source is additionally filtered to the caller's own HR_ID as a guard,
 * so a manager viewing their own list never sees a direct report's request here.
 */
export async function getMyRequestItems(
  access: AccessContext,
  // `only` reads one module's source and skips the rest — each approve page (leave, excuse, plans)
  // shows one module and used to wait on all six sources, then filter. The mapping is the same.
  options?: { only?: MyRequestItem["module"] },
): Promise<MyRequestItem[]> {
  const hrId = access.hrId?.trim() ?? "";
  if (!hrId) return [];
  const source = <T,>(module: MyRequestItem["module"], read: () => Promise<T>): Promise<T | null> =>
    !options?.only || options.only === module ? read().catch(() => null) : Promise.resolve(null);

  const settled = await Promise.allSettled([
    source("leave", () => getVacationReportData(access, { employee: hrId })),
    source("excuse", () => getExcuseWorkspace(access)),
    source("outstation", () => listMedicalRepExpenseRequests(access)),
    // The viewer's own plan headers — no longer the whole plan form (getEmployeePlansWorkspace).
    source("weekly_plan", () => listMyOwnPlanSummaries(access)),
    source("resignation", () => getMyResignations(access)),
    // listMyDirectOrders already filters to requester_hr_id = the caller and asserts
    // direct_orders:read, so a role without the resource contributes nothing (catch -> null)
    // rather than failing the tab — the same per-source tolerance every other entry here uses.
    source("direct_order", () => listMyDirectOrders(access)),
  ]);

  const [vacation, excuse, outstation, plans, resignations, directOrders] = settled;
  const items: MyRequestItem[] = [];

  if (vacation.status === "fulfilled" && vacation.value) {
    for (const row of vacation.value.rows) {
      if (hrIdsMatch(row.employeeHrId, hrId)) items.push(mapVacation(row));
    }
  }
  if (excuse.status === "fulfilled" && excuse.value) {
    for (const row of excuse.value.requests) items.push(mapExcuse(row));
  }
  if (outstation.status === "fulfilled" && outstation.value) {
    for (const row of outstation.value) {
      if (hrIdsMatch(row.employeeHrId, hrId)) items.push(mapOutstation(row));
    }
  }
  if (plans.status === "fulfilled" && plans.value) {
    for (const row of plans.value) {
      if (hrIdsMatch(row.employeeHrId, hrId)) items.push(mapPlan(row));
    }
  }
  if (resignations.status === "fulfilled" && resignations.value) {
    for (const row of resignations.value) items.push(mapResignationRecord(row));
  }
  if (directOrders.status === "fulfilled" && directOrders.value) {
    for (const row of directOrders.value) {
      if (hrIdsMatch(row.requesterHrId, hrId)) items.push(mapMyDirectOrder(row));
    }
  }

  items.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  return items;
}

// ── "Awaiting my action" inbox (approver-side) ────────────────────────────────
// Cross-module aggregation of items pending the caller's decision, reused by both
// the admin Actions page and the employee-portal Actions page.
//
// SECURITY: the "portal" audience includes ONLY access-scoped, manager-relevant
// sources — vacation (role-scoped to the caller's team/hierarchy/line), excuse
// (scoped to the caller's manager_hr_id), and weekly plans (scoped to the plan's
// manager_hr_id / CEO gate). The unscoped HR/admin sources (all resignations, all
// outstation, contract renewals) are admin-shell only and are never aggregated for
// a portal manager.

const ACTIVE_CONTRACT_STATUSES = new Set(["requested", "manager_review", "hr_review"]);

function liveEmployeeName(
  employees: EmployeeNameRosterRow[],
  hrId: string | null | undefined,
  rawName: string,
): string {
  if (!hrId) return rawName;
  const employee = employees.find((e) => hrIdsMatch(e.hrId, hrId));
  return employee?.displayName ?? rawName;
}

// `mapLeaveItem` and `mapWeeklyPlanItem` were deleted on 2026-10-23 with the reads that fed them:
// every item they built was dropped by `survivesAwaitingInbox`, so the awaiting-action fan-out no
// longer asks for leave or plans at all. Leave, excuse and plans each have their own Needs You
// source. `mapExcuseItem` SURVIVES — the Action Center deep link still renders one excuse request.

function mapResignationItem(
  record: ResignationRecord,
  employees: EmployeeNameRosterRow[],
): ActionHubItem {
  return {
    id: record.id,
    module: "resignation",
    employeeName: liveEmployeeName(employees, record.employeeHrId, record.employeeName),
    employeeHrId: record.employeeHrId,
    title: `Resignation · ${record.effectiveDate}`,
    statusLabel: humanizeCode(record.status),
    submittedAt: record.createdAt,
    urgency: "high",
    detail: {
      module: "resignation",
      effectiveDate: record.effectiveDate,
      submittedDate: record.submittedDate,
      reason: record.reason,
      workflowNotes: record.workflowNotes,
      rejectedReason: record.rejectedReason,
      jobTitle: record.jobTitle,
      lineName: record.lineName,
    },
  };
}

function mapExcuseItem(
  request: EmployeeExcuseRequest,
  employees: EmployeeNameRosterRow[],
  readOnlyReason?: string | null,
): ActionHubItem {
  return {
    id: request.id,
    module: "excuse",
    employeeName: liveEmployeeName(employees, request.employeeHrId, request.employeeName),
    employeeHrId: request.employeeHrId,
    title: `${request.excuseType === "morning" ? "Morning" : "Afternoon"} Excuse · ${request.excuseDate}`,
    statusLabel: humanize(request.status),
    submittedAt: request.createdAt,
    urgency: "normal",
    readOnlyReason: readOnlyReason ?? null,
    detail: {
      module: "excuse",
      excuseType: request.excuseType,
      excuseDate: request.excuseDate,
      durationHours: request.durationHours,
      managerName: request.managerName,
      departmentName: request.departmentName,
      lineName: request.lineName,
    },
  };
}

function mapOutstationItem(
  request: OutstationExpenseRequest,
  employees: EmployeeNameRosterRow[],
): ActionHubItem {
  return {
    id: String(request.id),
    module: "outstation",
    employeeName: liveEmployeeName(employees, request.employeeHrId, request.employeeName),
    employeeHrId: request.employeeHrId,
    title: `Outstation · ${request.tripStartDate}`,
    statusLabel: "Pending approval",
    submittedAt: request.createdAt,
    urgency: request.approvalRecommendation === "auto_approve" ? "low" : request.approvalRecommendation === "reject" ? "high" : "normal",
    detail: {
      module: "outstation",
      expenseType: request.expenseType,
      tripStartDate: request.tripStartDate,
      tripEndDate: request.tripEndDate,
      toLabel: request.toLabel,
      allowanceAmount: request.allowanceAmount,
      claimedTotalAmount: request.claimedTotalAmount,
      approvalRecommendation: request.approvalRecommendation,
      approvalReason: request.approvalReason,
      notes: request.notes,
      requestId: request.id,
      revision: request.updatedAt,
    },
  };
}

function mapContractRenewalItem(
  row: ContractRow,
  employees: EmployeeNameRosterRow[],
): ActionHubItem | null {
  if (!row.workflow || !ACTIVE_CONTRACT_STATUSES.has(row.workflow.status)) return null;
  const w = row.workflow;
  return {
    id: w.id,
    module: "contract_renewal",
    employeeName: liveEmployeeName(employees, w.employeeHrId, w.employeeName),
    employeeHrId: w.employeeHrId,
    title: `Contract Renewal · ${w.requestedRenewalDate}`,
    statusLabel: humanizeCode(w.status),
    submittedAt: w.createdAt,
    urgency: "high",
    detail: {
      module: "contract_renewal",
      requestedRenewalDate: w.requestedRenewalDate,
      proposedStartDate: w.proposedStartDate,
      proposedEndDate: w.proposedEndDate,
      jobTitle: w.jobTitle,
      lineName: w.lineName,
      areaName: w.areaName,
      workflowNotes: w.workflowNotes,
      decisionReason: w.decisionReason,
      currentStatus: w.status,
    },
  };
}

export type ActionInboxAudience = "admin" | "portal";

/**
 * Mirrors `isForbiddenError` from `@/lib/auth/server` (same `Forbidden:` message prefix), and kept
 * local for the same reason `src/lib/approvals-hub/service.ts:108` keeps its own copy: this service
 * is imported directly by the Node test runner, which cannot load the `next/headers` dependency
 * `@/lib/auth/server` pulls in.
 *
 * The distinction earns its place twice over here. A `Forbidden:` rejection means this viewer holds
 * no rung on that queue — a TRUE zero, and nothing to report. Any other rejection means the queue
 * did not answer, which is not a zero at all. Collapsing the two is what turns "I could not read
 * resignations" into "there are no resignations".
 */
export function isForbiddenSourceError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().startsWith("forbidden:");
}

/** One awaiting-action source that did not answer, named the way a person would say it. */
export type ActionSourceFailure = { source: string; because: string };

/**
 * Names for the four reads below, in the SAME ORDER as the `Promise.allSettled` array — the index
 * is the join. Exported so a test can hold the two lengths against each other: a source added to
 * the fan-out without a label here would report as the generic "An approval queue", which is the
 * quiet half of the failure this whole function exists to end.
 *
 * 🔴 FOUR, NOT SEVEN — leave, excuse and plans are NOT read here, so they get no label. They each
 * have their own Needs You source (`leaveApprovals`, `excuseApprovals`, `planApprovals`), with
 * their own health and their own clock; naming them here again would report one queue twice and
 * amber this source for a failure that already has its own row.
 */
export const ACTION_SOURCE_LABELS = [
  "Resignations",
  "Outstation requests",
  "Contract renewals",
  "Employee names",
] as const;

/**
 * The awaiting-action inbox, PLUS which of its sources failed to answer.
 *
 * 🔴 WHY THIS EXISTS, AND WHY THE `.catch(() => null)` WRAPPERS HAD TO GO. Until 2026-09-28 the
 * reads below each carried `.catch(() => null)` INSIDE the surrounding `Promise.allSettled`.
 * That made the `allSettled` decorative: every settled result was `"fulfilled"`, every failure
 * arrived as a `null` the item loops simply skipped, and this file contains no logging of any kind
 * — so a dead resignations read produced a shorter list and total silence, in the function
 * `/api/approvals/badge-counts` counts. A queue nobody could read was indistinguishable from a
 * queue with nothing in it.
 *
 * That is survivable for an inbox someone is already looking at. It is not survivable for
 * `src/lib/needs-you/`, whose entire job is to answer "is anything waiting on you" so he can stop
 * looking — there, a swallowed failure rendering as zero says "nothing needs you" and the looking
 * has already been delegated.
 *
 * `unavailable` is the reporting channel that matters, because it reaches the screen; the
 * structured log below is for after the fact. A source that refuses with `Forbidden:` is NOT listed
 * — the viewer holds no rung on it, which is a real zero.
 */
export async function getAwaitingMyActionItemsWithHealth(
  access: AccessContext,
  audience: ActionInboxAudience,
): Promise<{ items: ActionHubItem[]; unavailable: ActionSourceFailure[] }> {
  // Marketing is intentionally excluded everywhere — it keeps its own dedicated inbox.
  // Outstation: admin-only AND restricted to real approval authority — listOutstationRequests()
  // is an unscoped company-wide read, and only Super Admin can act on these requests
  // (see canUseAdminOutstationWorkspace). Other admin-shell roles (Finance Manager, CEO, etc.)
  // must not see items in an "awaiting my action" inbox they cannot act on.
  // Resignations: admin-only (unscoped company-wide aggregates).
  // Contract renewal: always included — already access-scoped via canSeeContractRow(access, employee).
  const includeOutstationAdminSource =
    audience === "admin" && canUseAdminOutstationWorkspace(access, "approve");
  // No `.catch()` on any of these — a rejection has to reach `allSettled` as a rejection, or the
  // failure is indistinguishable from an empty queue. The outstation slot resolves to `null` when
  // this viewer holds no approval authority, which is a real "nothing here", not a failure.
  //
  // 🔴 ONLY THE SOURCES WHOSE ITEMS SURVIVE `survivesAwaitingInbox` ARE READ (2026-10-23, the other
  // half of PERF-001 below). This used to read leave, excuse and plans too and then drop every item
  // they produced, which cost this source the full vacation, excuse and plan reads for nothing —
  // and because this source declares `cost: "heavy"` and Needs You gives it ONE 8-second budget in
  // a lane of its own, those three reads were spending a budget they could never contribute to.
  // `countAwaitingMyActionItems` was narrowed to these same sources on 2026-10-04; the list was
  // left behind, and the board reads the LIST. Each of the three has its own Needs You source, so
  // nothing is under-reported by not reading it twice.
  const settled = await Promise.allSettled([
    getResignationsDashboardData(access),
    includeOutstationAdminSource ? listOutstationRequests() : Promise.resolve(null),
    getContractRenewalDashboardData(access),
    getEmployeeNameRoster(),
  ]);

  const unavailable: ActionSourceFailure[] = [];
  settled.forEach((result, index) => {
    if (result.status !== "rejected") return;
    const source = ACTION_SOURCE_LABELS[index] ?? "An approval queue";
    if (isForbiddenSourceError(result.reason)) {
      // No rung on this queue. A true zero — nothing to report and nothing to alarm about.
      logStructured("DEBUG", "Action inbox source refused", {
        labels: { event: "action_inbox_source_forbidden", source, hrId: access.hrId, role: access.role, scope: access.scope },
        error: result.reason,
      });
      return;
    }
    const because = String((result.reason as Error | undefined)?.message ?? result.reason ?? "it did not answer")
      .split("\n")[0]
      .trim();
    unavailable.push({ source, because: because || "it did not answer" });
    logStructured("ERROR", "Action inbox source failed", {
      labels: { event: "action_inbox_source_failed", source, hrId: access.hrId, role: access.role, scope: access.scope },
      error: result.reason,
    });
  });

  const [resignations, outstation, contract, directoryResult] = settled;
  const employees = directoryResult.status === "fulfilled" && directoryResult.value ? directoryResult.value : [];
  const items: ActionHubItem[] = [];

  items.push(
    ...residualActionItems({
      resignations: resignations.status === "fulfilled" ? resignations.value : null,
      outstation: outstation.status === "fulfilled" ? outstation.value : null,
      contract: contract.status === "fulfilled" ? contract.value : null,
      employees,
    }),
  );
  items.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  return { items: items.filter((item) => survivesAwaitingInbox(item, access)), unavailable };
}

// Never surface a requester's own submission in their own action inbox — the CEO
// role can submit requests and those should only appear in "My Requests", not here.
// Vacation (leave), excuse & weekly/monthly plans now live on the dedicated Approvals Hub pages
// (/…/approvals/vacation, /…/approvals/excuse, /…/approvals/plan) — exclude them here so this
// residual "Other Approvals" inbox shows each request in exactly one place.
function survivesAwaitingInbox(item: ActionHubItem, access: AccessContext): boolean {
  return (
    item.module !== "leave" &&
    item.module !== "excuse" &&
    item.module !== "weekly_plan" &&
    !hrIdsMatch(item.employeeHrId, access.hrId)
  );
}

/**
 * The modules that have LEFT the "Other Approvals" inbox for a mailbox of their own, and where each
 * one lives now.
 *
 * Owner instruction, 2026-10-08: *"since I have the expense approvals outside in a separate mailbox,
 * don't show any related expense approvals in the Other Approvals"*. Outstation expense claims have
 * had their own desk at /admin/outstation/expense-approvals since 2026-08-08, so carrying them here
 * as well put one claim in two queues and made "Other Approvals" read as a dumping ground.
 *
 * 🔴 APPLIED TO THE HUB SURFACES ONLY — deliberately NOT inside
 * {@link getAwaitingMyActionItemsWithHealth}, which is also what `src/lib/needs-you/sources.ts`
 * reads. The Needs You board must never under-report (docs/needs-you.md), and filtering there would
 * make a waiting expense claim vanish from the one screen whose whole job is to say what is waiting.
 * The board keeps the item and links it to the mailbox named here instead.
 */
export const OTHER_APPROVALS_MOVED_OUT: Partial<Record<ActionHubModule, `/${string}`>> = {
  outstation: "/admin/outstation/expense-approvals",
};

/** True for an item that still belongs in the residual "Other Approvals" inbox. */
export function belongsInOtherApprovalsInbox(item: Pick<ActionHubItem, "module">): boolean {
  return !OTHER_APPROVALS_MOVED_OUT[item.module];
}

/** The items of the three sources whose items survive the inbox filter — shared so the count below can never drift from the list. */
function residualActionItems(input: {
  resignations: Awaited<ReturnType<typeof getResignationsDashboardData>> | null;
  outstation: Awaited<ReturnType<typeof listOutstationRequests>> | null;
  contract: Awaited<ReturnType<typeof getContractRenewalDashboardData>> | null;
  employees: EmployeeNameRosterRow[];
}): ActionHubItem[] {
  const items: ActionHubItem[] = [];
  for (const record of input.resignations?.records ?? []) {
    if (record.status === "submitted" || record.status === "under_review") {
      items.push(mapResignationItem(record, input.employees));
    }
  }
  for (const request of input.outstation ?? []) {
    if (request.status === "submitted") items.push(mapOutstationItem(request, input.employees));
  }
  for (const row of input.contract?.rows ?? []) {
    const item = mapContractRenewalItem(row, input.employees);
    if (item) items.push(item);
  }
  return items;
}

/**
 * How many items {@link getAwaitingMyActionItems} would list — for the 30 s sidebar badge poll.
 *
 * WHY (2026-10-04 performance review, PERF-001): the list reads seven sources and then throws away
 * every leave, excuse and plan item, so the badge was paying for the full vacation report (and the
 * excuse and plan reads) on every poll of every open tab for items it never counted. This reads only
 * the three sources whose items survive, through the same item builders and the same filter. The
 * directory is skipped too: it only supplies display names, which a count never reads.
 *
 * A failed source counts as nothing, exactly as it always did through the list. Callers that must
 * tell a failure from a zero keep calling {@link getAwaitingMyActionItemsWithHealth}.
 */
export async function countAwaitingMyActionItems(
  access: AccessContext,
  audience: ActionInboxAudience,
): Promise<number> {
  // Outstation left this inbox for its own mailbox (OTHER_APPROVALS_MOVED_OUT), so the badge no
  // longer reads it either — a count that included it would put a number over an empty inbox, which
  // is the "queue nobody could read" defect the hub's own comments warn about.
  const includeOutstationAdminSource =
    audience === "admin" &&
    !OTHER_APPROVALS_MOVED_OUT.outstation &&
    canUseAdminOutstationWorkspace(access, "approve");
  // A seat that can only ever see its OWN resignation and contract records has nothing this inbox
  // could count — survivesAwaitingInbox drops a viewer's own items — so it answers 0 without reading
  // either dashboard (2026-10-23, every page change under 1 second: these two reads are the heavy half
  // of every 30 s badge poll, and the seats listed in otherApprovalsInboxIsAlwaysEmptyFor are most of
  // the company). The proof, and why it is an allow-list, sit with that predicate.
  if (!includeOutstationAdminSource && otherApprovalsInboxIsAlwaysEmptyFor(access)) return 0;
  const [resignations, outstation, contract] = await Promise.allSettled([
    getResignationsDashboardData(access),
    includeOutstationAdminSource ? listOutstationRequests() : Promise.resolve(null),
    getContractRenewalDashboardData(access),
  ]);
  return residualActionItems({
    resignations: resignations.status === "fulfilled" ? resignations.value : null,
    outstation: outstation.status === "fulfilled" ? outstation.value : null,
    contract: contract.status === "fulfilled" ? contract.value : null,
    employees: [],
  }).filter((item) => survivesAwaitingInbox(item, access) && belongsInOtherApprovalsInbox(item)).length;
}

/**
 * The awaiting-action inbox, items only — the shape every existing caller already expects.
 *
 * Kept as a thin wrapper rather than changing the three call sites: those screens render a list and
 * have nowhere to put a source-health notice, so handing them one would be a change with no reader.
 * Callers that must not mistake a failure for an empty queue call
 * {@link getAwaitingMyActionItemsWithHealth} instead.
 *
 * This is also where the modules that moved to their own mailbox are dropped — see
 * OTHER_APPROVALS_MOVED_OUT for why the filter lives here and not one level down.
 */
export async function getAwaitingMyActionItems(
  access: AccessContext,
  audience: ActionInboxAudience,
): Promise<ActionHubItem[]> {
  const { items } = await getAwaitingMyActionItemsWithHealth(access, audience);
  return items.filter(belongsInOtherApprovalsInbox);
}

// ─────────────────────────────────────────────────────────────────────────────
// Row shapes for the decided-history feeds.
//
// They have to be written out because those reads are now PAGED through `fetchAllApprovalRows`,
// which cannot infer a row type from a PostgREST builder the way awaiting one directly does. Each
// type lists exactly the columns its `.select()` asks for, so the query and the code that reads it
// can no longer drift apart silently.
//
// Written as `type` aliases, never interfaces: three consumers below reach an embedded parent by
// casting the row (`row as Record<string, unknown>`, `row as { marketing_requests?: … }`), and
// only a type alias carries the implicit index signature those casts need. The embedded parents
// themselves stay `unknown` here — PostgREST returns an embedded relation as either an object or a
// one-element array depending on how it resolves the relationship, and the consumers already
// normalize both shapes rather than assume one.
// ─────────────────────────────────────────────────────────────────────────────

type DecidedLeaveRow = {
  id: string;
  employee_name: string | null;
  employee_hr_id: string | null;
  vacation_type: string | null;
  start_date: string | null;
  status: string | null;
  manager_decision: string | null;
  manager_decision_at: string | null;
  manager_decision_by_hr_id: string | null;
  hr_decision: string | null;
  hr_decision_at: string | null;
  hr_decision_by_hr_id: string | null;
};

type DecidedExcuseRow = {
  id: string;
  employee_name: string | null;
  employee_hr_id: string | null;
  excuse_date: string | null;
  excuse_type: string | null;
  manager_decision: string | null;
  manager_decision_at: string | null;
  manager_decision_by_hr_id: string | null;
};

type DecidedPlanRow = {
  id: string;
  employee_name: string | null;
  employee_hr_id: string | null;
  employee_job_title: string | null;
  manager_hr_id: string | null;
  period_key: string | null;
  period_start_date: string | null;
  period_end_date: string | null;
  plan_kind: string | null;
  status: string | null;
  manager_decision_at: string | null;
  manager_decision_by_hr_id: string | null;
  ceo_decision_at: string | null;
  ceo_decision_by_hr_id: string | null;
};

type DecidedResignationRow = {
  id: string;
  employee_name: string | null;
  employee_hr_id: string | null;
  effective_date: string | null;
  status: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
};

type DecidedSalaryBatchRow = {
  id: string;
  file_name: string | null;
  month: string | number | null;
  year: string | number | null;
  status: string | null;
  approved_by: string | null;
  approved_at: string | null;
};

type DecidedSalesImportRow = {
  id: string;
  file_name: string | null;
  period: string | null;
  month: string | number | null;
  year: string | number | null;
  status: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
};

type DecidedMarketingStepRow = {
  id: string;
  request_id: string | null;
  step_name: string | null;
  status: string | null;
  decision_by_hr_id: string | null;
  decision_at: string | null;
  marketing_requests: unknown;
};

type DecidedExpenseRow = {
  id: string;
  specialist: string | null;
  hr_id: string | null;
  expense_date: string | null;
  total: number | string | null;
  status: string | null;
  approved_by: string | null;
  approved_at: string | null;
};

type DecidedVacationStepRow = {
  id: string;
  request_id: string | null;
  step_key: string | null;
  status: string | null;
  approver_hr_id: string | null;
  decided_at: string | null;
  v2_vacation_requests: HistoryLeaveStepRow["v2_vacation_requests"];
};

type DecidedDirectOrderEventRow = {
  id: string;
  request_id: string | null;
  actor_hr_id: string | null;
  event_type: string | null;
  created_at: string | null;
  direct_order_requests: unknown;
};

/**
 * Returns a chronological list of every approval decision the signed-in user has
 * ever made, across leave, excuse, weekly-plan, and resignation modules.
 * Ordered by decision timestamp descending (newest first).
 */
export async function getMyApprovalHistory(
  access: AccessContext,
  // `only` reads one module's feed and skips the other nine — the approve-plans page asks for
  // "weekly_plan" and used to wait on all ten, then filter. The mapping below is the same either way.
  options?: { only?: HistoricalApprovalItem["module"] },
): Promise<HistoricalApprovalItem[]> {
  const hrId = (access.hrId ?? "").trim().toUpperCase();
  if (!hrId) return [];
  const skipped = { data: [] as never[], error: null };
  const feed = <T,>(module: HistoricalApprovalItem["module"], read: () => Promise<{ data: T[] | null; error: unknown }>) =>
    !options?.only || options.only === module ? read() : Promise.resolve(skipped);

  // A person who holds more than one login (the HR Manager also operates the system-administrator
  // console) records decisions under whichever HR_ID was signed in at the time. History is per
  // PERSON, not per login, so every query below matches all of their HR_IDs — otherwise half of
  // their own decisions are invisible depending on how they signed in today.
  const actorHrIds = Array.from(sharedIdentityKeys(hrId));
  // PostgREST `or` terms. `ilike` (not `eq`/`in`) because stored casing drifts — "admin-HR",
  // "ADMIN-HR" and "admin-hr" all appear in historic decision columns.
  // Each value is QUOTED. `sharedIdentityKeys` upper-cases and expands aliases; it does not restrict
  // the character set, so a `,` or `)` in one login id would end that arm early and hand PostgREST a
  // filter nobody wrote — across all eleven history reads below at once (AGENTS.md MR-B04).
  const decidedByAnyOfMine = (...columns: string[]) =>
    columns.flatMap((column) => actorHrIds.map((id) => quotedOrClause(column, "ilike", id))).join(",");
  /** True when a stored decider value is this same person, under any of their logins. */
  const decidedByMe = (value: unknown) => isSamePerson(hrId, value == null ? null : String(value));

  const db = getSupabaseAdmin();
  const items: HistoricalApprovalItem[] = [];

  // Role-aware deep-link back into the Approvals Hub (portal vs admin shell). Mirrors the
  // `?module=X&id=Y` convention the inbox/notifications already use, so "View request" always
  // routes to the correct surface for the viewer and never dead-ends.
  const isPortal = resolveNavigationMode(access) === "employee-portal";
  const hubBase = isPortal ? "/employee-portals/approvals-hub" : "/admin/approvals-hub";
  // Vacation/excuse/plan history links point at their dedicated per-request pages (they left the
  // "Other Approvals" hub) so clicking a past decision never re-opens it inside the residual hub
  // inbox. Resignation (and any other still-in-hub module) keeps the ?module=X&id=Y hub deep-link.
  const dedicatedHistorySegment: Record<string, string> = { leave: "vacation", excuse: "excuse", weekly_plan: "plan" };
  const historyHref = (module: string, id: unknown) => {
    const segment = dedicatedHistorySegment[module];
    const encodedId = encodeURIComponent(String(id ?? ""));
    if (segment) {
      const base = isPortal ? `/employee-portals/approvals/${segment}` : `/admin/approvals/${segment}`;
      return `${base}/${encodedId}`;
    }
    return `${hubBase}?module=${module}&id=${encodedId}`;
  };

  // Native-page deep-links for the admin/system modules (these never render inside the hub —
  // they live on their own dedicated pages, where the full decided record is shown).
  const NATIVE_HREFS = {
    salary: "/payroll",
    sales_import: "/sales/import?tab=approvals",
    marketing_request: "/admin/marketing-requests/inbox",
    payroll_expense: "/admin/outstation/expenses",
  } as const;

  // Direct orders deep-link to their own dedicated per-request page, which differs by shell.
  const directOrderHistoryHref = (requestId: unknown) => {
    const base = isPortal ? "/employee-portals/approvals/direct-orders" : "/admin/approvals/direct-orders";
    return `${base}/${encodeURIComponent(String(requestId ?? ""))}`;
  };

  // Every feed below is PAGED, not capped, and every one ends its ordering with `id`.
  //
  // WHY BOTH HALVES MATTER. These ten reads used to end in `.limit(200)` or `.limit(100)`, which
  // made a person's own decision history quietly stop at the cap. Measured on production
  // 2026-09-23, this was live for the owner himself: B-10 has approved 370 outstation expenses,
  // so 170 of his own approvals — everything decided before 2026-09-07 back to 2026-06-07 — were
  // simply absent from his history, with nothing on the page saying the list was cut.
  //
  // The `id` tiebreak is not defensive tidiness either. 240 of those 370 approvals share ONE
  // `approved_at` instant (a bulk approval writes them together), so `order by approved_at desc`
  // alone cut straight through the middle of a tie: Postgres was free to return a different
  // arbitrary 200 of those 240 on each load, and did not have to be consistent between them.
  // Ordering by `(decided_at, id)` makes the sequence total, which is what paging needs to be
  // correct at all — a non-total sort both drops and duplicates rows across page boundaries.
  const [
    leaves,
    excuses,
    plans,
    resignations,
    salaries,
    salesImports,
    marketingSteps,
    expenses,
    momSteps,
    directOrderEvents,
    directoryResult,
  ] = await Promise.allSettled([
      feed("leave", () => fetchAllApprovalRows<DecidedLeaveRow>(() =>
        db
          .from("v2_vacation_requests")
          .select("id,employee_name,employee_hr_id,vacation_type,start_date,status,manager_decision,manager_decision_at,manager_decision_by_hr_id,hr_decision,hr_decision_at,hr_decision_by_hr_id")
          .or(decidedByAnyOfMine("manager_decision_by_hr_id", "hr_decision_by_hr_id"))
          .not("manager_decision_at", "is", null)
          .order("manager_decision_at", { ascending: false })
          .order("id", { ascending: false }))),
      feed("excuse", () => fetchAllApprovalRows<DecidedExcuseRow>(() =>
        db
          .from("v2_excuse_requests")
          .select("id,employee_name,employee_hr_id,excuse_date,excuse_type,manager_decision,manager_decision_at,manager_decision_by_hr_id")
          .or(decidedByAnyOfMine("manager_decision_by_hr_id"))
          .not("manager_decision", "is", null)
          .order("manager_decision_at", { ascending: false })
          .order("id", { ascending: false }))),
      feed("weekly_plan", () => fetchAllApprovalRows<DecidedPlanRow>(() =>
        db
          .from("employee_plan_headers")
          .select("id,employee_name,employee_hr_id,employee_job_title,manager_hr_id,period_key,period_start_date,period_end_date,plan_kind,status,manager_decision_at,manager_decision_by_hr_id,ceo_decision_at,ceo_decision_by_hr_id")
          .or(decidedByAnyOfMine("manager_decision_by_hr_id", "ceo_decision_by_hr_id"))
          .not("manager_decision_at", "is", null)
          .order("manager_decision_at", { ascending: false })
          .order("id", { ascending: false }))),
      feed("resignation", () => fetchAllApprovalRows<DecidedResignationRow>(() =>
        db
          .from("employee_resignations")
          .select("id,employee_name,employee_hr_id,effective_date,status,reviewed_by,reviewed_at,approved_by,approved_at,rejected_by,rejected_at")
          .or(decidedByAnyOfMine("reviewed_by", "approved_by", "rejected_by"))
          .order("reviewed_at", { ascending: false })
          .order("id", { ascending: false }))),
      feed("salary", () => fetchAllApprovalRows<DecidedSalaryBatchRow>(() =>
        db
          .from("salary_batches")
          .select("id,file_name,month,year,status,approved_by,approved_at")
          .or(decidedByAnyOfMine("approved_by"))
          .not("approved_at", "is", null)
          .order("approved_at", { ascending: false })
          .order("id", { ascending: false }))),
      feed("sales_import", () => fetchAllApprovalRows<DecidedSalesImportRow>(() =>
        db
          .from("sales_import_batches")
          .select("id,file_name,period,month,year,status,approved_by,approved_at,rejected_by,rejected_at")
          .or(decidedByAnyOfMine("approved_by", "rejected_by"))
          .order("approved_at", { ascending: false })
          .order("id", { ascending: false }))),
      // `id` joins the select purely so the ordering can be made total — the consumer keys this
      // item on request_id + step_name, which is not unique enough to page on.
      feed("marketing_request", () => fetchAllApprovalRows<DecidedMarketingStepRow>(() =>
        db
          .from("marketing_request_approval_steps")
          .select("id,request_id,step_name,status,decision_by_hr_id,decision_at,marketing_requests(request_code,requester_hr_id,status)")
          .or(decidedByAnyOfMine("decision_by_hr_id"))
          .not("decision_at", "is", null)
          .order("decision_at", { ascending: false })
          .order("id", { ascending: false }))),
      feed("payroll_expense", () => fetchAllApprovalRows<DecidedExpenseRow>(() =>
        db
          .from("outstation_expenses")
          .select("id,specialist,hr_id,expense_date,total,status,approved_by,approved_at")
          .or(decidedByAnyOfMine("approved_by"))
          .not("approved_at", "is", null)
          .order("approved_at", { ascending: false })
          .order("id", { ascending: false }))),
      // manager_of_manager and manager_level_3 decisions are never written to the main request's
      // manager_decision_by_hr_id column (only direct_manager is). Query the
      // steps table directly so the secondary manager sees their history too.
      // EVERY step key is read, not just those two (owner, 2026-10-26): the request row stores the
      // direct manager's id as typed at the time, and it drifts — Hany Saad's leave carries "AA"
      // there while the step is his own A-12 — so the request feed alone misses a request the
      // viewer really decided, and only the steps table, keyed on the approver, finds it. A request
      // in both feeds is listed once. The request's `status` rides along: it is the FINAL outcome.
      // `id` is selected for the same reason as the marketing steps above.
      feed("leave", () => fetchAllApprovalRows<DecidedVacationStepRow>(() =>
        db
          .from("v2_vacation_approval_steps")
          .select("id,request_id,step_key,status,approver_hr_id,decided_at,v2_vacation_requests(id,employee_name,employee_hr_id,vacation_type,start_date,status)")
          .or(decidedByAnyOfMine("approver_hr_id"))
          .neq("status", "pending")
          .not("decided_at", "is", null)
          .order("decided_at", { ascending: false })
          .order("id", { ascending: false }))),
      // Direct orders read from the EVENT log, not direct_order_approval_steps: a `return` decision
      // deliberately leaves the step row untouched (see phx_apply_direct_order_decision), so the
      // steps table cannot attribute a return to the approver who made it. The event log records
      // every transition with its actor, so returns show up here too.
      feed("direct_order", () => fetchAllApprovalRows<DecidedDirectOrderEventRow>(() =>
        db
          .from("direct_order_events")
          .select("id,request_id,actor_hr_id,event_type,created_at,direct_order_requests(status,product_name,qty,sales_value,requester_hr_id,direct_order_pharmacies(pharmacy_name),direct_order_request_items(line_no,product_name,qty))")
          .or(decidedByAnyOfMine("actor_hr_id"))
          .in("event_type", ["approve", "reject", "return"])
          .order("created_at", { ascending: false })
          .order("id", { ascending: false }))),
      getEmployeeNameRoster(),
    ]);

  const employees = directoryResult.status === "fulfilled" ? directoryResult.value : [];

  // LEAVE. Two feeds (the request row for the direct manager and HR, the steps table for every other
  // approver — and for a direct manager whose stored id drifted), merged into one row per request
  // whose outcome is the request's FINAL status, not the viewer's own step. See approval-history-outcome.ts.
  const leaveRequestRows: HistoryLeaveRequestRow[] =
    leaves.status === "fulfilled" && !leaves.value.error ? (leaves.value.data ?? []) : [];
  const leaveStepRows: HistoryLeaveStepRow[] =
    momSteps.status === "fulfilled" && !momSteps.value.error ? (momSteps.value.data ?? []) : [];
  items.push(
    ...buildLeaveHistory(
      { requests: leaveRequestRows, steps: leaveStepRows },
      {
        decidedByMe,
        decode: decodeDecision,
        personName: (id, fallback) => liveEmployeeName(employees, id, fallback),
        hrefFor: (requestId) => historyHref("leave", requestId),
      },
    ),
  );

  if (excuses.status === "fulfilled" && !excuses.value.error) {
    for (const row of excuses.value.data ?? []) {
      const decision = decodeDecision(row.manager_decision);
      if (!decision) continue;
      items.push({
        id: `history:excuse:${row.id}`,
        module: "excuse",
        employeeName: liveEmployeeName(employees, String(row.employee_hr_id ?? ""), String(row.employee_name ?? "Unknown")),
        employeeHrId: String(row.employee_hr_id ?? ""),
        title: `Excuse · ${String(row.excuse_type ?? "")}${historyDate(row.excuse_date) ? ` · ${historyDate(row.excuse_date)}` : ""}`,
        decision,
        decidedAt: String(row.manager_decision_at ?? ""),
        href: historyHref("excuse", row.id),
      });
    }
  }

  if (plans.status === "fulfilled" && !plans.value.error) {
    for (const row of plans.value.data ?? []) {
      // A District Manager plan has no CEO stage, so a header CEO stamp on one is never this
      // viewer's decision — it must not put the row in his history, nor date it. The one exception
      // is the second approver of the DMs reporting to Hany Saad (second-approver.ts): his own
      // stamp on those plans is a real decision and belongs in his history.
      const ceo = resolvePlanCeoDecision(row.employee_job_title, row.ceo_decision_at, row.ceo_decision_by_hr_id, row.manager_hr_id);
      const isMgrDecider = decidedByMe(row.manager_decision_by_hr_id);
      const isCeoDecider = Boolean(ceo) && decidedByMe(row.ceo_decision_by_hr_id);
      if (!isMgrDecider && !isCeoDecider) continue;
      const s = String(row.status ?? "").toLowerCase();
      // Derive decision from status — employee_plan_headers has no text decision columns
      let decision: "approved" | "rejected" | "returned" | null = null;
      let decidedAt: string | null = null;
      if (isCeoDecider && ceo) {
        decision = ["final_approved", "hr_acknowledged"].includes(s) ? "approved" : s === "ceo_returned" ? "returned" : null;
        decidedAt = ceo.decidedAt;
      } else if (isMgrDecider && row.manager_decision_at) {
        decision = s === "manager_returned" ? "returned" : row.manager_decision_at ? "approved" : null;
        decidedAt = row.manager_decision_at;
      }
      if (!decision) continue;
      items.push({
        id: `history:weekly_plan:${row.id}`,
        module: "weekly_plan",
        employeeName: liveEmployeeName(employees, String(row.employee_hr_id ?? ""), String(row.employee_name ?? "Unknown")),
        employeeHrId: String(row.employee_hr_id ?? ""),
        title: `${String(row.plan_kind ?? "weekly").charAt(0).toUpperCase()}${String(row.plan_kind ?? "weekly").slice(1)} plan · ${historyPlanPeriod(row.period_start_date, row.period_end_date, row.period_key)}`,
        decision,
        decidedAt: String(decidedAt ?? ""),
        href: historyHref("weekly_plan", row.id),
      });
    }
  }

  if (resignations.status === "fulfilled" && !resignations.value.error) {
    for (const row of resignations.value.data ?? []) {
      const isApprover = decidedByMe(row.approved_by);
      const isRejector = decidedByMe(row.rejected_by);
      const isReviewer = decidedByMe(row.reviewed_by);
      if (!isApprover && !isRejector && !isReviewer) continue;
      // Derive the decision from the final status, not from which actor column matched — a
      // reviewer is not necessarily the approver. A row still under review (matched only via
      // reviewed_by) is shown as "returned" (in-progress), never as "approved".
      const status = String(row.status ?? "").toLowerCase();
      let decision: "approved" | "rejected" | "returned" | null;
      if (/(approv|complet)/.test(status)) decision = "approved";
      else if (/(reject)/.test(status)) decision = "rejected";
      else if (/(cancel|review|return)/.test(status)) decision = "returned";
      else decision = isApprover ? "approved" : isRejector ? "rejected" : "returned";
      const decidedAt = isApprover ? row.approved_at : isRejector ? row.rejected_at : row.reviewed_at;
      items.push({
        id: `history:resignation:${row.id}`,
        module: "resignation",
        employeeName: liveEmployeeName(employees, String(row.employee_hr_id ?? ""), String(row.employee_name ?? "Unknown")),
        employeeHrId: String(row.employee_hr_id ?? ""),
        title: `Resignation${historyDate(row.effective_date) ? ` · effective ${historyDate(row.effective_date)}` : ""}`,
        decision,
        decidedAt: String(decidedAt ?? ""),
        href: historyHref("resignation", row.id),
      });
    }
  }

  if (salaries.status === "fulfilled" && !salaries.value.error) {
    for (const row of salaries.value.data ?? []) {
      items.push({
        id: `history:salary:${row.id}`,
        module: "salary",
        employeeName: String(row.file_name ?? "Payroll batch"),
        employeeHrId: "",
        title: `Payroll batch · ${String(row.month ?? "")}/${String(row.year ?? "")}`,
        decision: "approved",
        decidedAt: String(row.approved_at ?? ""),
        href: NATIVE_HREFS.salary,
      });
    }
  }

  if (salesImports.status === "fulfilled" && !salesImports.value.error) {
    for (const row of salesImports.value.data ?? []) {
      const isApprover = decidedByMe(row.approved_by) && row.approved_at;
      const isRejector = decidedByMe(row.rejected_by) && row.rejected_at;
      if (!isApprover && !isRejector) continue;
      const periodLabel = row.period ?? `${String(row.month ?? "")}/${String(row.year ?? "")}`;
      items.push({
        id: `history:sales_import:${row.id}`,
        module: "sales_import",
        employeeName: String(row.file_name ?? "Sales import"),
        employeeHrId: "",
        title: `Sales import · ${String(periodLabel)}`,
        decision: isRejector ? "rejected" : "approved",
        decidedAt: String((isRejector ? row.rejected_at : row.approved_at) ?? ""),
        href: NATIVE_HREFS.sales_import,
      });
    }
  }

  if (marketingSteps.status === "fulfilled" && !marketingSteps.value.error) {
    for (const row of marketingSteps.value.data ?? []) {
      const stepDecision = decodeDecision(row.status);
      if (!stepDecision) continue;
      const rawParent = (row as { marketing_requests?: unknown }).marketing_requests;
      const parent = (Array.isArray(rawParent) ? rawParent[0] : rawParent) as
        | { request_code?: string | null; requester_hr_id?: string | null; status?: string | null }
        | null
        | undefined;
      // The REQUESTER is who the row is about (it used to print the request code in that slot), and
      // the badge is where the request ENDED, not this one approval step.
      const outcome = resolveHistoryOutcome(stepDecision, marketingStanding(parent?.status));
      items.push({
        id: `history:marketing:${row.request_id}:${row.step_name ?? ""}`,
        module: "marketing_request",
        employeeName: liveEmployeeName(employees, parent?.requester_hr_id, "Marketing request"),
        employeeHrId: String(parent?.requester_hr_id ?? ""),
        title: `Marketing · ${String(row.step_name ?? "approval")}`,
        decision: outcome.decision,
        outcomeNote: outcome.note,
        decidedAt: String(row.decision_at ?? ""),
        href: NATIVE_HREFS.marketing_request,
      });
    }
  }

  if (expenses.status === "fulfilled" && !expenses.value.error) {
    for (const row of expenses.value.data ?? []) {
      items.push({
        id: `history:payroll_expense:${row.id}`,
        module: "payroll_expense",
        employeeName: liveEmployeeName(employees, String(row.hr_id ?? ""), String(row.specialist ?? "Expense")),
        employeeHrId: String(row.hr_id ?? ""),
        title: `Expense · ${formatHistoryMoney(row.total)}${historyDate(row.expense_date) ? ` · ${historyDate(row.expense_date)}` : ""}`,
        decision: "approved",
        decidedAt: String(row.approved_at ?? ""),
        href: NATIVE_HREFS.payroll_expense,
      });
    }
  }

  if (directOrderEvents.status === "fulfilled" && !directOrderEvents.value.error) {
    for (const row of directOrderEvents.value.data ?? []) {
      // The embedded parent can come back as an object or a one-element array depending on how
      // PostgREST resolves the relationship; normalize both rather than assuming one shape.
      const rawParent = (row as Record<string, unknown>).direct_order_requests;
      const parent = (Array.isArray(rawParent) ? rawParent[0] : rawParent) as HistoryDirectOrderParent | null | undefined;
      const eventType = String(row.event_type ?? "");
      const viewerDecision =
        eventType === "approve" ? ("approved" as const)
        : eventType === "reject" ? ("rejected" as const)
        : eventType === "return" ? ("returned" as const)
        : null;
      if (!viewerDecision) continue;
      const requesterHrId = String(parent?.requester_hr_id ?? "");
      // The badge is where the ORDER ended, and the title names the pharmacy and EVERY product with
      // its own units (a multi-product order used to print its first product alone).
      const outcome = directOrderHistoryRow(viewerDecision, parent);
      items.push({
        id: `history:direct_order:${row.id}`,
        module: "direct_order",
        employeeName: liveEmployeeName(employees, requesterHrId, "Direct order"),
        employeeHrId: requesterHrId,
        title: outcome.title,
        decision: outcome.decision,
        outcomeNote: outcome.note,
        decidedAt: String(row.created_at ?? ""),
        href: directOrderHistoryHref(row.request_id),
      });
    }
  }

  items.sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
  return items;
}

const DEEP_LINK_READ_ONLY = "Decision already recorded — this is a read-only view.";

// Build a read-only inbox card for a leave request the caller already decided. Self-contained
// (queries the table directly) so it never perturbs the live, pending-only inbox pipeline. Only
// returns the item when the caller is the actual decider (or HR/system) — so it can never leak.
async function buildLeaveDeepLinkItem(
  access: AccessContext,
  id: string,
  hrId: string,
  employees: EmployeeNameRosterRow[],
): Promise<ActionHubItem | null> {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("v2_vacation_requests")
    .select("id,employee_name,employee_hr_id,vacation_type,start_date,end_date,duration_days,payment_status,balance_before_days,hr_decision_comment,status,manager_decision,manager_decision_at,manager_decision_by_hr_id,hr_decision,hr_decision_at,hr_decision_by_hr_id")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  // Same-person matching: the deep-link must open for the human who decided it, whichever of
  // their logins recorded the decision.
  const isDecider =
    isSamePerson(hrId, row.manager_decision_by_hr_id == null ? null : String(row.manager_decision_by_hr_id)) ||
    isSamePerson(hrId, row.hr_decision_by_hr_id == null ? null : String(row.hr_decision_by_hr_id));
  if (!isDecider && access.scope !== "system") return null;

  const { data: stepData } = await db
    .from("v2_vacation_approval_steps")
    .select("step_order,step_key,status,approver_hr_id,decision_comment,decided_at")
    .eq("request_id", id)
    .order("step_order", { ascending: true });
  const approvalSteps = ((stepData as Array<Record<string, unknown>> | null) ?? []).map((step) => ({
    order: Number(step.step_order ?? 0),
    status: String(step.status ?? ""),
    stepKey: String(step.step_key ?? ""),
    genericStep: String(step.step_key ?? ""),
    approverName: step.approver_hr_id ? String(step.approver_hr_id) : null,
    decidedAt: step.decided_at ? String(step.decided_at) : null,
    decisionComment: step.decision_comment ? String(step.decision_comment) : null,
  }));

  return {
    id: String(row.id),
    module: "leave",
    employeeName: liveEmployeeName(employees, String(row.employee_hr_id ?? ""), String(row.employee_name ?? "Unknown")),
    employeeHrId: String(row.employee_hr_id ?? ""),
    title: `${vacationTypeLabel(String(row.vacation_type ?? "annual"))} · ${Number(row.duration_days ?? 0)} day${Number(row.duration_days ?? 0) === 1 ? "" : "s"}`,
    statusLabel: humanizeCode(String(row.status ?? "")),
    submittedAt: String(row.manager_decision_at ?? row.start_date ?? ""),
    urgency: "normal",
    readOnlyReason: DEEP_LINK_READ_ONLY,
    detail: {
      module: "leave",
      vacationType: vacationTypeLabel(String(row.vacation_type ?? "annual")),
      startDate: String(row.start_date ?? ""),
      endDate: String(row.end_date ?? ""),
      durationDays: Number(row.duration_days ?? 0),
      paymentStatus: String(row.payment_status ?? "unpaid"),
      balanceBeforeDays: Number(row.balance_before_days ?? 0),
      hrDecisionComment: row.hr_decision_comment ? String(row.hr_decision_comment) : null,
      actionAvailability: {},
      approvalSteps,
      slaAgeDays: 0,
    },
  };
}

// Read-only inbox card for a weekly/monthly plan the caller already decided. Self-contained; the
// status label reflects the *real* decided status (never a misleading "Needs … approval").
async function buildPlanDeepLinkItem(
  access: AccessContext,
  id: string,
  hrId: string,
  employees: EmployeeNameRosterRow[],
): Promise<ActionHubItem | null> {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("employee_plan_headers")
    .select("id,employee_name,employee_hr_id,employee_job_title,manager_name,period_key,period_start_date,period_end_date,plan_kind,status,manager_decision_by_hr_id,ceo_decision_by_hr_id,employee_plan_items(activity_date,activity_type,activity_title,area,location_text,objective,double_visit_medical_rep_name,attendees,start_time,end_time,notes,sort_order)")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  const isMgr = isSamePerson(hrId, row.manager_decision_by_hr_id == null ? null : String(row.manager_decision_by_hr_id));
  const isCeo = isSamePerson(hrId, row.ceo_decision_by_hr_id == null ? null : String(row.ceo_decision_by_hr_id));
  if (!isMgr && !isCeo && access.scope !== "system") return null;

  const rawItems = ((row.employee_plan_items as Array<Record<string, unknown>> | undefined) ?? [])
    .slice()
    .sort((a, b) =>
      `${String(a.activity_date ?? "")}-${String(a.sort_order ?? "").padStart(4, "0")}`.localeCompare(
        `${String(b.activity_date ?? "")}-${String(b.sort_order ?? "").padStart(4, "0")}`,
      ),
    );
  const items = rawItems.map((item) => ({
    activityDate: String(item.activity_date ?? ""),
    activityLabel: String(item.activity_title ?? ""),
    activityType: String(item.activity_type ?? ""),
    area: item.area ? String(item.area) : null,
    isCoaching: /coach/i.test(String(item.activity_type ?? "")),
    notes: item.notes ? String(item.notes) : null,
    objective: item.objective ? String(item.objective) : null,
    region: null,
    // A Marketing Double Visit keeps its partner in attendees, never in the Medical Rep columns.
    repName: isMarketingDoubleVisit(String(item.activity_type ?? ""), String(item.activity_title ?? ""))
      ? item.attendees
        ? String(item.attendees)
        : null
      : item.double_visit_medical_rep_name
        ? String(item.double_visit_medical_rep_name)
        : null,
    timeLabel:
      item.start_time || item.end_time ? `${String(item.start_time ?? "")}${item.end_time ? `–${String(item.end_time)}` : ""}` : null,
    visitDetails: [],
  }));
  const kindLabel = String(row.plan_kind ?? "weekly") === "monthly" ? "Monthly" : "Weekly";
  const reviewBase = resolveNavigationMode(access) === "employee-portal" ? "/employee-portals/plans" : "/admin/weekly-plans";

  return {
    id: String(row.id),
    module: "weekly_plan",
    employeeName: liveEmployeeName(employees, String(row.employee_hr_id ?? ""), String(row.employee_name ?? "Unknown")),
    employeeHrId: String(row.employee_hr_id ?? ""),
    title: `${kindLabel} plan · ${String(row.period_key ?? "")}`,
    statusLabel: humanizeCode(String(row.status ?? "")),
    submittedAt: "",
    urgency: "normal",
    readOnlyReason: DEEP_LINK_READ_ONLY,
    detail: {
      module: "weekly_plan",
      stage: isCeo ? "ceo" : "manager",
      planKind: String(row.plan_kind ?? "weekly") === "monthly" ? "monthly" : "weekly",
      periodKey: String(row.period_key ?? ""),
      periodStartDate: String(row.period_start_date ?? ""),
      periodEndDate: String(row.period_end_date ?? ""),
      employeeJobTitle: row.employee_job_title ? String(row.employee_job_title) : null,
      managerName: row.manager_name ? String(row.manager_name) : null,
      itemCount: items.length,
      items,
      reviewHref: `${reviewBase}?plan=${String(row.id)}`,
    },
  };
}

export async function getActionCenterDeepLinkItem(
  access: AccessContext,
  module: string | null | undefined,
  id: string | null | undefined,
): Promise<ActionHubItem | null> {
  if (!id) return null;
  const hrId = (access.hrId ?? "").trim().toUpperCase();
  const employees = await getEmployeeNameRoster().catch(() => []);

  if (module === "excuse") {
    const result = await getExcuseRequestForActionCenterDeepLink(access, id);
    if (!result) return null;
    return mapExcuseItem(
      result.request,
      employees,
      result.canAct ? null : "Direct manager owns this approval. HR has visibility only.",
    );
  }

  if (module === "resignation") {
    const dashboard = await getResignationsDashboardData(access).catch(() => null);
    const record = dashboard?.records.find((r) => r.id === id) ?? null;
    if (!record) return null;
    const decided = /(approv|reject|complet|cancel)/.test(String(record.status ?? "").toLowerCase());
    return { ...mapResignationItem(record, employees), readOnlyReason: decided ? DEEP_LINK_READ_ONLY : null };
  }

  if (module === "leave") return buildLeaveDeepLinkItem(access, id, hrId, employees);
  if (module === "weekly_plan") return buildPlanDeepLinkItem(access, id, hrId, employees);

  return null;
}
