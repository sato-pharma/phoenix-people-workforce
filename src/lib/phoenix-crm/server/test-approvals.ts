/**
 * Phoenix CRM — the Super Admin's "Test accounts" tab: every approval the test personas sent, in one
 * list, each decided by him one step at a time (owner, 2026-10-22: *"add a new tab called Test accounts.
 * It will be responsible for all approvals that I do with test accounts … anything that needs approval
 * in Phoenix CRM, I can submit it in the test account and approve in my own admin account"*).
 *
 * His three picks the same day, and what each means here:
 *   - STEP BY STEP — an item is listed at the step it is AT and deciding it takes that step only, so a
 *     two-step item comes back at its second step and the test rep reads every in-between state a real
 *     rep would. Nothing here skips a step or decides two at once;
 *   - ONLY HIS TAB — `assertTestWorldDecider` (access.ts) refuses a test manager login on every test
 *     decision, so this list is the only place a test entry's approval is taken;
 *   - REAL ROWS UNCHANGED — every read is pinned to the test world, and the decide path reads the row's
 *     own `is_test` before it dispatches and refuses a real one by name.
 *
 * 🔴 IT REUSES THE MODULE'S OWN LOADERS AND DECIDERS, AND MUST NOT GROW A SECOND COPY OF EITHER. The
 * list requests, off-plan visits and requests to edit a week are read with the Team tab's own row
 * loaders and rights; the weekly and monthly plans through their review loaders asked for the test world
 * by name; the place checks through the Place checks board; the managers' weeks and asks through the
 * Approvals Hub's own four reads. Every decision goes through the very function the real screens call,
 * so the database, the stage guards, the version guards and the notices are the ones a real decision
 * meets. A test row's notice reaches TEST- logins only, in-app only (notifications.ts `deliver`).
 *
 * Left out, deliberately: an invitation to a double or chain visit and a visit ask (the test person they
 * are addressed to answers them — his own ruling), a recorded visit's Administrator step (taken on the
 * Visit Recording page, which already reads test recordings) and a held polyclinic or centre (the
 * Shared places board).
 */

import { ApiError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { formatPhoenixDateTime, formatPhoenixLongDate } from "@/lib/i18n/format";
import { logError } from "@/lib/observability/log";
import { POTENTIAL_GRADES } from "@/lib/phoenix-crm/entry-rules";
import { setsAdmissionGrades } from "@/lib/phoenix-crm/list-request-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { territoryName, territoryReviewer, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { assertTestWorldDecider, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import { decideListRequest, loadRequestRows, mapRequestRow, requestPeople, requestRights } from "@/lib/phoenix-crm/server/list";
import { decideManagerCustomerRemoval } from "@/lib/phoenix-crm/server/manager-customers";
import { loadOpenManagerPlanItems, type OpenManagerPlanItem } from "@/lib/phoenix-crm/server/manager-plan-queue";
import { decideManagerPlanEdit, transitionManagerPlan } from "@/lib/phoenix-crm/server/manager-plans";
import { decideSingleVisitDay } from "@/lib/phoenix-crm/server/manager-single-visit-days";
import { decideMonthlyPlan, loadMonthlyPlanReviews } from "@/lib/phoenix-crm/server/monthly-plans";
import { loadPeopleNames, nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";
import { canDecidePlanEditRow, decidePlanEdit, loadPlanEditRows, mapPlanEditRow, planEditPeople } from "@/lib/phoenix-crm/server/plan-edits";
import { loadPlanReviews, transitionPlan } from "@/lib/phoenix-crm/server/plans";
import { canDecideUnplannedRow, decideUnplannedVisit, loadUnplannedRows, mapUnplannedRow, unplannedPeople } from "@/lib/phoenix-crm/server/unplanned";
import { decideValidationReview, loadValidationReviews } from "@/lib/phoenix-crm/server/validation-reviews";
import { reasonsFor } from "@/lib/phoenix-crm/validation-feedback";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/** What a test approval is. One word per kind the decide route dispatches on. */
export type TestApprovalKind =
  | "list_request"
  | "off_plan_visit"
  | "plan_edit"
  | "weekly_plan"
  | "monthly_plan"
  | "place_check"
  | "manager_week"
  | "manager_edit"
  | "manager_removal"
  | "manager_single_visit_day";

export const TEST_APPROVAL_KINDS: readonly TestApprovalKind[] = [
  "list_request",
  "off_plan_visit",
  "plan_edit",
  "weekly_plan",
  "monthly_plan",
  "place_check",
  "manager_week",
  "manager_edit",
  "manager_removal",
  "manager_single_visit_day",
];

/** A decision the tab may send. Each kind takes exactly two of these: a yes, and a no that needs words. */
export type TestApprovalDecision = "approve" | "refuse" | "return" | "reject" | "reopen";

export type TestApprovalItem = {
  /** Unique on the page: the kind and the row id. */
  key: string;
  kind: TestApprovalKind;
  /** The id the decision is taken on: a request, a visit, a plan, a review, an own-list customer. */
  id: string;
  /** What it is, in a few words: "Add to the list", "Weekly plan", "Manager's week". */
  what: string;
  /** Who it is about: the customer, the week, the month. */
  subject: string;
  /** The test login that sent it, marked "(test)". */
  personName: string;
  territoryName: string | null;
  /** Whose step he takes: "District manager's step", "SFE's step", "Ahmed Hassan's step (second)". */
  stepLabel: string;
  /** When it started waiting, Cairo time. */
  waitingSince: string;
  /** For the order: oldest first. */
  waitingSinceIso: string;
  /** What the person wrote or what the row says, one line each. */
  details: string[];
  /** The yes and the no, in that order. */
  approve: { decision: TestApprovalDecision; label: string };
  decline: { decision: TestApprovalDecision; label: string; reasonRequired: boolean };
  /** Sent back with the decision: the row's version, stage and asked-at, whichever its decider checks. */
  version: number | null;
  stage: string | null;
  requestedAt: string | null;
  /** An add at its grading step: the grade he confirms (proposed first) and the potential he must set. */
  grading: { proposedGrade: "A" | "B" | "C" | null; potentials: readonly string[] } | null;
  /** A place check's refusal reasons — the rep is told the one he picks. */
  refusalReasons: Array<{ key: string; label: string }> | null;
};

export type TestApprovalsView = {
  items: TestApprovalItem[];
  /** A section that could not be read, named — never shown as "nothing waiting". */
  unreadable: string[];
};

/** The test login's name, marked so it never reads as a real person's decision on his screen. */
function testName(names: PeopleNames, hrId: string | null | undefined): string {
  const name = nameOf(names, hrId, "");
  return name ? `${name} (test)` : "A test login";
}

/** The territory's own manager step, named by the rung that holds it; SFE's when the chain is vacant. */
function managerStepLabel(viewer: PhoenixCrmViewer, seat: OrgSeat | undefined): string {
  if (!seat) return "The manager's step";
  const reviewer = territoryReviewer(viewer.org, seat.seatId);
  const tier = reviewer?.seat.tier ?? null;
  if (tier === "DM" || tier === "ACTING_DM") return "District manager's step";
  if (tier === "RSM") return "Regional manager's step";
  if (tier === "NSM") return "National sales manager's step";
  return "SFE's step";
}

function stepOf(viewer: PhoenixCrmViewer, seat: OrgSeat | undefined, stage: string | null): string {
  return stage === "sfe" ? "SFE's step" : managerStepLabel(viewer, seat);
}

/** Every seat in his scope. The Super Admin's scope is the whole company. */
function seatsOf(viewer: PhoenixCrmViewer): { seatIds: string[]; seatById: Map<string, OrgSeat> } {
  const seatById = new Map(viewer.scopeTerritories.map((seat) => [seat.seatId, seat]));
  return { seatIds: [...seatById.keys()], seatById };
}

function territoryNameOf(seat: OrgSeat | undefined): string | null {
  return seat ? territoryName(seat) : null;
}

/** A section's read, or null with its name recorded — one failed table never empties the whole tab. */
async function section<T>(unreadable: string[], name: string, read: () => Promise<T[]>): Promise<T[]> {
  try {
    return await read();
  } catch (error) {
    // A refusal is the gate's answer, not a failed read: it must reach the caller.
    if (error instanceof ApiError && error.status === 403) throw error;
    logError("Phoenix CRM could not read a section of the test approvals", {
      error,
      labels: { event: "phoenix_crm_test_approvals_section_failed", section: name },
    });
    unreadable.push(name);
    return [];
  }
}

// ── The read ────────────────────────────────────────────────────────────────────────────────────

export async function loadTestApprovals(viewer: PhoenixCrmViewer): Promise<TestApprovalsView> {
  assertTestWorldDecider(viewer);
  const { seatIds, seatById } = seatsOf(viewer);
  const unreadable: string[] = [];

  const [requestRows, unplannedRows, planEditRows, weekly, monthly, placeChecks, managerItems] = await Promise.all([
    section<Row>(unreadable, "List requests", () => (seatIds.length === 0 ? Promise.resolve<Row[]>([]) : loadRequestRows(seatIds, true, { pendingOnly: true }))),
    section<Row>(unreadable, "Off-plan visits", () => loadUnplannedRows(seatIds, true)),
    section<Row>(unreadable, "Requests to edit a week", () => loadPlanEditRows(seatIds, true, viewer.cairoToday)),
    section(unreadable, "Weekly plans", () => loadWeeklyPlanItems(viewer)),
    section(unreadable, "Monthly plans", () => loadMonthlyPlanItems(viewer)),
    section(unreadable, "Place checks", () => loadPlaceCheckItems(viewer)),
    section(unreadable, "Managers' weeks", () => loadOpenManagerPlanItems(true)),
  ]);

  const names = await loadPeopleNames([
    ...requestPeople(requestRows),
    ...unplannedPeople(unplannedRows),
    ...planEditPeople(planEditRows),
    ...managerItems.flatMap((item) => [item.managerHrId, item.holderHrId]),
    ...[...seatById.values()].map((seat) => seat.occupantHrId),
  ]);

  const items: TestApprovalItem[] = [];

  for (const row of requestRows) {
    const seat = seatById.get(String(row.seat_id));
    if (!seat) continue;
    const request = mapRequestRow(row, names);
    // A request with the rep for a comment waits on nobody here; only a step somebody takes is listed.
    if (!requestRights(viewer, seat, true, request).canDecide) continue;
    const grading = setsAdmissionGrades({ kind: request.kind, stage: request.stage, managerDecidedAt: request.managerDecision?.at ?? null });
    const details = [
      request.kind === "grade" && request.proposedGrade ? `Grade ${request.currentGrade ?? "none"} to ${request.proposedGrade}` : null,
      request.kind === "add" && request.proposedGrade ? `Proposed grade ${request.proposedGrade}` : null,
      request.dropReasonLabel ? `Why: ${request.dropReasonLabel}` : null,
      request.note ? `Note: ${request.note}` : null,
      request.managerDecision ? `Manager's step taken by ${request.managerDecision.byName}${request.managerDecision.note ? `: ${request.managerDecision.note}` : ""}` : null,
    ].filter((line): line is string => Boolean(line));
    items.push({
      key: `list_request:${request.requestId}`,
      kind: "list_request",
      id: request.requestId,
      what: request.kindLabel,
      subject: request.customerName,
      personName: testName(names, text(row.requested_by_hr_id) ?? seat.occupantHrId),
      territoryName: territoryNameOf(seat),
      stepLabel: request.stage === null && territoryReviewer(viewer.org, seat.seatId) !== null ? managerStepLabel(viewer, seat) : stepOf(viewer, seat, request.stage),
      waitingSince: formatPhoenixDateTime(request.requestedAt),
      waitingSinceIso: request.requestedAt,
      details,
      approve: { decision: "approve", label: "Approve" },
      decline: { decision: "refuse", label: "Refuse", reasonRequired: true },
      version: null,
      stage: request.stage,
      requestedAt: null,
      grading: grading ? { proposedGrade: request.proposedGrade, potentials: POTENTIAL_GRADES } : null,
      refusalReasons: null,
    });
  }

  for (const row of unplannedRows) {
    const view = mapUnplannedRow(row, names);
    const seat = seatById.get(view.seatId);
    if (!seat || !canDecideUnplannedRow(viewer, seat, true, view.status)) continue;
    items.push({
      key: `off_plan_visit:${view.visitId}`,
      kind: "off_plan_visit",
      id: view.visitId,
      what: "Off-plan visit",
      subject: `${view.customerName}, ${formatPhoenixLongDate(view.visitDate)}`,
      personName: testName(names, view.repHrId),
      territoryName: territoryNameOf(seat),
      stepLabel: stepOf(viewer, seat, view.stage),
      waitingSince: formatPhoenixDateTime(view.raisedAt),
      waitingSinceIso: view.raisedAt,
      details: [
        `Why: ${view.clarification}`,
        view.managerDecidedByName ? `Manager's step taken by ${view.managerDecidedByName}${view.managerNote ? `: ${view.managerNote}` : ""}` : null,
      ].filter((line): line is string => Boolean(line)),
      approve: { decision: "approve", label: "Approve" },
      decline: { decision: "refuse", label: "Refuse", reasonRequired: true },
      version: view.version,
      stage: view.stage,
      requestedAt: null,
      grading: null,
      refusalReasons: null,
    });
  }

  for (const row of planEditRows) {
    const view = mapPlanEditRow(row, names);
    const seat = seatById.get(view.seatId);
    if (!seat || !canDecidePlanEditRow(viewer, seat, true, view.status)) continue;
    items.push({
      key: `plan_edit:${view.requestId}`,
      kind: "plan_edit",
      id: view.requestId,
      what: "Request to edit a sent week",
      subject: view.weekLabel,
      personName: testName(names, text(row.rep_hr_id) ?? seat.occupantHrId),
      territoryName: territoryNameOf(seat),
      stepLabel: stepOf(viewer, seat, view.stage),
      waitingSince: formatPhoenixDateTime(view.raisedAt),
      waitingSinceIso: view.raisedAt,
      details: [
        `The week is ${view.planStatusLabel.toLowerCase()}`,
        view.managerDecidedByName ? `Manager's step taken by ${view.managerDecidedByName}${view.managerNote ? `: ${view.managerNote}` : ""}` : null,
      ].filter((line): line is string => Boolean(line)),
      approve: { decision: "approve", label: "Approve" },
      decline: { decision: "refuse", label: "Refuse", reasonRequired: true },
      version: view.version,
      stage: view.stage,
      requestedAt: null,
      grading: null,
      refusalReasons: null,
    });
  }

  items.push(...weekly, ...monthly, ...placeChecks);

  for (const item of managerItems) items.push(managerItem(item, names));

  items.sort((left, right) => left.waitingSinceIso.localeCompare(right.waitingSinceIso) || left.key.localeCompare(right.key));
  return { items, unreadable };
}

function text(value: unknown): string | null {
  const out = typeof value === "string" ? value.trim() : "";
  return out ? out : null;
}

/** Every waiting weekly plan, a week at a time — the review loader opens on one week and counts the rest. */
async function loadWeeklyPlanItems(viewer: PhoenixCrmViewer): Promise<TestApprovalItem[]> {
  const first = await loadPlanReviews(viewer, { test: true, weekStart: null }, { testWorld: true });
  const others = first.weeks.filter((week) => week.waiting > 0 && week.weekStart !== first.weekStart);
  const views = [first, ...(await Promise.all(others.map((week) => loadPlanReviews(viewer, { test: true, weekStart: week.weekStart }, { testWorld: true }))))];
  const items: TestApprovalItem[] = [];
  for (const view of views) {
    for (const row of view.rows) {
      const plan = row.plan;
      if (!plan || plan.status !== "submitted" || !row.canApprove) continue;
      const seat = viewer.org.seats.get(row.territory.seatId);
      items.push({
        key: `weekly_plan:${plan.planId}`,
        kind: "weekly_plan",
        id: plan.planId,
        what: "Weekly plan",
        subject: `Week of ${formatPhoenixLongDate(plan.weekStart)}`,
        personName: row.territory.repName ? `${row.territory.repName} (test)` : "A test login",
        territoryName: row.territory.name,
        stepLabel: managerStepLabel(viewer, seat),
        waitingSince: formatPhoenixDateTime(plan.submittedAt),
        waitingSinceIso: plan.submittedAt ?? "",
        details: [
          `${row.accounts} AM and ${row.doctors} PM visits planned`,
          row.exceptions > 0 ? `${row.exceptions} on a day the customer does not receive` : null,
          row.farApartDays.length > 0 ? `${row.farApartDays.length} day${row.farApartDays.length === 1 ? "" : "s"} with customers far apart` : null,
          plan.submittedLate ? "Sent after it was due" : null,
        ].filter((line): line is string => Boolean(line)),
        approve: { decision: "approve", label: "Approve" },
        decline: { decision: "return", label: "Return", reasonRequired: true },
        version: plan.version,
        stage: null,
        requestedAt: null,
        grading: null,
        refusalReasons: null,
      });
    }
  }
  return items;
}

/** Every waiting monthly plan, a month at a time, the same way. */
async function loadMonthlyPlanItems(viewer: PhoenixCrmViewer): Promise<TestApprovalItem[]> {
  const first = await loadMonthlyPlanReviews(viewer, { test: true, month: null }, { testWorld: true });
  const others = first.months.filter((month) => month.waiting > 0 && month.monthStart !== first.monthStart);
  const views = [first, ...(await Promise.all(others.map((month) => loadMonthlyPlanReviews(viewer, { test: true, month: month.monthStart }, { testWorld: true }))))];
  const items: TestApprovalItem[] = [];
  for (const view of views) {
    const label = view.months.find((month) => month.monthStart === view.monthStart)?.label ?? view.monthStart;
    for (const row of view.rows) {
      const plan = row.plan;
      if (!plan || plan.status !== "submitted" || !row.canApprove) continue;
      const seat = viewer.org.seats.get(row.territory.seatId);
      items.push({
        key: `monthly_plan:${plan.monthlyPlanId}`,
        kind: "monthly_plan",
        id: plan.monthlyPlanId,
        what: "Monthly plan",
        subject: label,
        personName: row.territory.repName ? `${row.territory.repName} (test)` : "A test login",
        territoryName: row.territory.name,
        stepLabel: managerStepLabel(viewer, seat),
        waitingSince: formatPhoenixDateTime(plan.submittedAt),
        waitingSinceIso: plan.submittedAt ?? "",
        details: [
          `${row.accounts} AM and ${row.doctors} PM visits planned`,
          row.exceptions > 0 ? `${row.exceptions} on a day the customer does not receive` : null,
          plan.submittedLate ? "Sent after it was due" : null,
        ].filter((line): line is string => Boolean(line)),
        approve: { decision: "approve", label: "Approve" },
        decline: { decision: "return", label: "Return", reasonRequired: true },
        version: plan.version,
        stage: null,
        requestedAt: null,
        grading: null,
        refusalReasons: null,
      });
    }
  }
  return items;
}

/** The test places held for a check — the Place checks board's own read, the test world's waiting rows. */
async function loadPlaceCheckItems(viewer: PhoenixCrmViewer): Promise<TestApprovalItem[]> {
  const board = await loadValidationReviews(viewer);
  return board.rows
    .filter((row) => row.isTest && row.status === "pending")
    .map(
      (row): TestApprovalItem => ({
        key: `place_check:${row.reviewId}`,
        kind: "place_check",
        id: row.reviewId,
        what: row.kind === "added_place" ? "Place check: an added place" : "Place check",
        subject: row.customerName,
        personName: row.repName ? `${row.repName} (test)` : "A test login",
        territoryName: row.territory,
        stepLabel: "SFE's step",
        waitingSince: row.createdAtText,
        waitingSinceIso: row.createdAt,
        details: [row.placeLabel, row.address, row.signText ? `The sign reads: ${row.signText}` : null].filter((line): line is string => Boolean(line)),
        approve: { decision: "approve", label: "Approve" },
        decline: { decision: "reject", label: "Reject", reasonRequired: false },
        version: null,
        stage: null,
        requestedAt: null,
        grading: null,
        refusalReasons: reasonsFor(row.photoKind).map((reason) => ({ key: reason.key, label: reason.label })),
      }),
    );
}

const MANAGER_WHAT: Record<OpenManagerPlanItem["kind"], { kind: TestApprovalKind; what: string }> = {
  plan: { kind: "manager_week", what: "Manager's week" },
  edit: { kind: "manager_edit", what: "Manager's ask to edit a sent week" },
  removal: { kind: "manager_removal", what: "Manager's ask to take a customer off the manager's own list" },
  single_visit_day: { kind: "manager_single_visit_day", what: "Manager's ask for a day of single visits" },
};

function managerItem(item: OpenManagerPlanItem, names: PeopleNames): TestApprovalItem {
  const { kind, what } = MANAGER_WHAT[item.kind];
  const holder = item.holderHrId ? nameOf(names, item.holderHrId, "") : "";
  const step = item.stage === "second" ? "second" : "first";
  const subject =
    item.kind === "removal"
      ? item.customerName ?? "A customer"
      : item.kind === "single_visit_day" && item.visitDate
        ? formatPhoenixLongDate(item.visitDate)
        : item.weekStart
          ? `Week of ${formatPhoenixLongDate(item.weekStart)}`
          : "A week";
  return {
    key: `${kind}:${item.id}`,
    kind,
    id: item.id,
    what,
    subject,
    personName: testName(names, item.managerHrId),
    territoryName: null,
    stepLabel: holder ? `${holder}'s step (${step} approver)` : `The ${step} approver's step`,
    waitingSince: formatPhoenixDateTime(item.requestedAt),
    waitingSinceIso: item.requestedAt,
    details: item.reason ? [`Why: ${item.reason}`] : [],
    approve: { decision: item.kind === "edit" ? "reopen" : "approve", label: item.kind === "edit" ? "Reopen the week" : "Approve" },
    decline: item.kind === "plan" ? { decision: "return", label: "Return", reasonRequired: true } : { decision: "refuse", label: "Refuse", reasonRequired: true },
    version: item.version,
    stage: item.stage,
    requestedAt: item.requestedAt,
    grading: null,
    refusalReasons: null,
  };
}

// ── The decision ────────────────────────────────────────────────────────────────────────────────

/** The table and id column each kind lives in — read for `is_test` before anything is decided. */
const ROW_OF: Record<TestApprovalKind, { table: string; idColumn: string }> = {
  list_request: { table: "phoenix_crm_list_requests", idColumn: "id" },
  off_plan_visit: { table: "phoenix_crm_unplanned_visits", idColumn: "visit_id" },
  plan_edit: { table: "phoenix_crm_plan_edit_requests", idColumn: "id" },
  weekly_plan: { table: "phoenix_crm_plans", idColumn: "id" },
  monthly_plan: { table: "phoenix_crm_monthly_plans", idColumn: "id" },
  place_check: { table: "phoenix_crm_validation_reviews", idColumn: "id" },
  manager_week: { table: "phoenix_crm_manager_plans", idColumn: "id" },
  manager_edit: { table: "phoenix_crm_manager_plan_edit_requests", idColumn: "id" },
  manager_removal: { table: "phoenix_crm_manager_customers", idColumn: "id" },
  manager_single_visit_day: { table: "phoenix_crm_manager_single_visit_days", idColumn: "id" },
};

/** The two decisions each kind takes; anything else is refused before a row is read. */
const DECISIONS_OF: Record<TestApprovalKind, readonly [TestApprovalDecision, TestApprovalDecision]> = {
  list_request: ["approve", "refuse"],
  off_plan_visit: ["approve", "refuse"],
  plan_edit: ["approve", "refuse"],
  weekly_plan: ["approve", "return"],
  monthly_plan: ["approve", "return"],
  place_check: ["approve", "reject"],
  manager_week: ["approve", "return"],
  manager_edit: ["reopen", "refuse"],
  manager_removal: ["approve", "refuse"],
  manager_single_visit_day: ["approve", "refuse"],
};

export function isTestApprovalKind(value: unknown): value is TestApprovalKind {
  return typeof value === "string" && (TEST_APPROVAL_KINDS as readonly string[]).includes(value);
}

export type TestApprovalResult = { kind: TestApprovalKind; id: string };

/**
 * One step on one test entry, taken through the module's own decider for that kind.
 *
 * 🔴 THE ROW'S OWN `is_test` IS READ FIRST, AND A REAL ROW IS REFUSED BY NAME. Most deciders read the
 * world off the row themselves, so a real row would reach the real gates and be refused there by
 * `superAdminDoesNotDecide` — but a refusal that depends on the next function down is one edit away from
 * a real decision taken from a test screen. This one does not depend on anything below it.
 */
export async function decideTestApproval(viewer: PhoenixCrmViewer, raw: unknown): Promise<TestApprovalResult> {
  assertTestWorldDecider(viewer);
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  const kind = body.kind;
  if (!isTestApprovalKind(kind)) throw validationError("Reload the page and try again.");
  const id = typeof body.id === "string" ? body.id.trim().toLowerCase() : "";
  if (!isUuid(id)) throw validationError("Reload the page and try again.");
  const decision = body.decision;
  const [yes, no] = DECISIONS_OF[kind];
  if (decision !== yes && decision !== no) throw validationError("Reload the page and try again.");
  const note = typeof body.note === "string" ? body.note : null;

  const { table, idColumn } = ROW_OF[kind];
  const { data, error } = await getSupabaseAdmin().from(table).select(`${idColumn}, is_test`).eq(idColumn, id).maybeSingle();
  throwIfError(error);
  const row = data as Row | null;
  if (!row) throw notFoundError("This entry is no longer there. Reload the page.");
  if (row.is_test !== true) throw forbiddenError("This is a real entry. Its decision belongs to its own manager chain, never to the test tab.");

  const version = body.version;
  const stage = body.stage;
  switch (kind) {
    case "list_request":
      await decideListRequest(viewer, {
        requestId: id,
        decision,
        note,
        stage,
        approvedGrade: body.approvedGrade,
        potentialGrade: body.potentialGrade,
      });
      break;
    case "off_plan_visit":
      await decideUnplannedVisit(viewer, { visitId: id, decision, note, expectedVersion: version });
      break;
    case "plan_edit":
      await decidePlanEdit(viewer, { requestId: id, decision, note, expectedVersion: version });
      break;
    case "weekly_plan":
      await transitionPlan(viewer, { planId: id, action: decision, note, expectedVersion: version });
      break;
    case "monthly_plan":
      await decideMonthlyPlan(viewer, { monthlyPlanId: id, action: decision, note, expectedVersion: version });
      break;
    case "place_check":
      await decideValidationReview(viewer, { reviewId: id, decision, note, refusalReason: body.refusalReason });
      break;
    case "manager_week":
      await transitionManagerPlan(viewer, { planId: id, action: decision, note, version }, { testWorld: true });
      break;
    case "manager_edit":
      await decideManagerPlanEdit(viewer, { requestId: id, decision, note, stage, version }, { testWorld: true });
      break;
    case "manager_removal":
      await decideManagerCustomerRemoval(viewer, { id, decision, note, stage, requestedAt: body.requestedAt }, { testWorld: true });
      break;
    case "manager_single_visit_day":
      await decideSingleVisitDay(viewer, { requestId: id, decision, note, stage, version }, { testWorld: true });
      break;
  }
  return { kind, id };
}
