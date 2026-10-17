/**
 * Phoenix CRM — the district manager's weekly plan, as the Approvals Hub reads it.
 *
 * His RSM or NSM decides the week in the Hub (owner, 2026-10-16), so the Hub's plan buckets, its badge,
 * the bell's `plan` domain and Needs You all read this file beside the legacy `employee_plan_headers`.
 * Three things wait on a person here: a sent week (first or second stage), his ask to edit a sent week,
 * and his ask to take a customer off his own list.
 *
 * 🔴 NO NOTICE SENDER IS IMPORTED HERE, AND NONE MAY BE. `notifications/in-app.ts` imports the Hub's
 * reader to decide whether a notice is still actionable, so a sender reached from here closes the
 * import cycle. Only db helpers, `scope.ts`, the pure rules and `manager-plan-rows.ts`.
 *
 * 🔴 ONE WORLD PER READ. A `TEST-` login reads the test world and everyone else the real one, so a
 * persona's practice week never lands in a real approver's count.
 *
 * The Administrator may act in place of the holder at any stage, but a week is never HIS task: it is not
 * counted in his awaiting bucket, and he reaches it through the company feeds.
 */

import { personKey } from "@/lib/phoenix-crm/scope";
import { chunk, dedupeIds, textOrNull } from "@/lib/phoenix-crm/server/db";
import {
  EDIT_ASK_COLUMNS,
  MANAGER_PLAN_COLUMNS,
  editAskRowOf,
  managerPlanRowOf,
  type ManagerEditAskRow,
  type ManagerPlanRow,
} from "@/lib/phoenix-crm/server/manager-plan-rows";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

export type ManagerQueueStage = "first" | "second" | "edit" | "removal";

export type ManagerQueueItem = {
  /** The plan id, the ask-to-edit id or the own-list customer id: the Hub's detail page resolves all three. */
  id: string;
  stage: ManagerQueueStage;
  managerHrId: string;
  weekStart: string | null;
  /** The own-list customer's name, for a removal. */
  customerName: string | null;
  /** When it started waiting: the send, or the ask. */
  waitingSince: string;
};

export type ManagerQueueBuckets = { awaiting: ManagerQueueItem[]; upcoming: ManagerQueueItem[] };

function sameKey(left: string | null | undefined, right: string | null | undefined): boolean {
  const key = personKey(left);
  return key !== null && key === personKey(right);
}

const byId = { cursorColumn: "id", cursorOf: (row: Row) => String(row.id) };

async function loadOpenPlans(isTest: boolean): Promise<ManagerPlanRow[]> {
  const rows = await fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_manager_plans")
        .select(MANAGER_PLAN_COLUMNS)
        .in("status", ["submitted", "first_approved"])
        .eq("is_test", isTest),
    byId,
  );
  return rows.map(managerPlanRowOf).filter((row): row is ManagerPlanRow => row !== null);
}

async function loadOpenEditAsks(isTest: boolean): Promise<ManagerEditAskRow[]> {
  const rows = await fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_manager_plan_edit_requests")
        .select(EDIT_ASK_COLUMNS)
        .eq("status", "pending")
        .eq("is_test", isTest),
    byId,
  );
  return rows.map(editAskRowOf).filter((row): row is ManagerEditAskRow => row !== null);
}

async function loadOpenRemovals(isTest: boolean): Promise<Row[]> {
  return fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_manager_customers")
        .select("id, manager_hr_id, name, removal_approver_hr_id, removal_requested_at, created_at")
        .eq("status", "removal_pending")
        .eq("is_test", isTest),
    byId,
  );
}

/**
 * What waits on this person now, and what is coming to him: a week still with the first approver whose
 * second approver he is. Throws on a failed read — the Hub decides what an unread queue costs.
 */
export async function loadManagerPlanQueue(hrId: string | null | undefined, isTest: boolean): Promise<ManagerQueueBuckets> {
  const me = personKey(hrId);
  if (!me) return { awaiting: [], upcoming: [] };
  const [plans, asks, removals] = await Promise.all([loadOpenPlans(isTest), loadOpenEditAsks(isTest), loadOpenRemovals(isTest)]);

  const awaiting: ManagerQueueItem[] = [];
  const upcoming: ManagerQueueItem[] = [];
  for (const plan of plans) {
    if (sameKey(plan.managerHrId, me)) continue;
    const base = { id: plan.planId, managerHrId: plan.managerHrId, weekStart: plan.weekStart, customerName: null, waitingSince: plan.submittedAt ?? "" };
    if (plan.status === "submitted" && sameKey(plan.firstApproverHrId, me)) awaiting.push({ ...base, stage: "first" });
    else if (plan.status === "first_approved" && sameKey(plan.secondApproverHrId, me)) awaiting.push({ ...base, stage: "second" });
    else if (plan.status === "submitted" && sameKey(plan.secondApproverHrId, me)) upcoming.push({ ...base, stage: "first" });
  }
  for (const ask of asks) {
    if (!sameKey(ask.approverHrId, me) || sameKey(ask.managerHrId, me)) continue;
    awaiting.push({
      id: ask.requestId,
      stage: "edit",
      managerHrId: ask.managerHrId,
      weekStart: ask.weekStart,
      customerName: null,
      waitingSince: ask.createdAt ?? "",
    });
  }
  for (const row of removals) {
    const id = textOrNull(row.id);
    const managerHrId = personKey(textOrNull(row.manager_hr_id));
    if (!id || !managerHrId || managerHrId === me || !sameKey(textOrNull(row.removal_approver_hr_id), me)) continue;
    awaiting.push({
      id,
      stage: "removal",
      managerHrId,
      weekStart: null,
      customerName: textOrNull(row.name),
      waitingSince: textOrNull(row.removal_requested_at) ?? textOrNull(row.created_at) ?? "",
    });
  }
  return { awaiting, upcoming };
}

// ── The district manager's own requests, and the decisions a person made ──────────────────────────

export type ManagerRequestRecord = {
  id: string;
  kind: "plan" | "edit" | "removal";
  managerHrId: string;
  weekStart: string | null;
  customerName: string | null;
  /** The plan's status; for an ask or a removal: pending / reopened / refused / expired / removed. */
  status: string;
  submittedAt: string;
  decisionNote: string | null;
  /** Who it waits on now, when it waits on anyone. */
  waitingOnHrId: string | null;
};

/** Every week he sent, every ask to edit and every ask to take a customer off his list — newest first. */
export async function loadManagerOwnRequests(hrId: string | null | undefined, isTest: boolean): Promise<ManagerRequestRecord[]> {
  const me = personKey(hrId);
  if (!me) return [];
  const [planRows, askRows, removalRows] = await Promise.all([
    fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_manager_plans")
          .select(MANAGER_PLAN_COLUMNS)
          .eq("manager_hr_id", me)
          .eq("is_test", isTest)
          .neq("status", "draft"),
      byId,
    ),
    fetchAllRowsKeyset<Row>(
      () => getSupabaseAdmin().from("phoenix_crm_manager_plan_edit_requests").select(EDIT_ASK_COLUMNS).eq("manager_hr_id", me).eq("is_test", isTest),
      byId,
    ),
    fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_manager_customers")
          .select("id, name, status, removal_requested_at, removal_approver_hr_id, removal_decided_at, removal_decision_note")
          .eq("manager_hr_id", me)
          .eq("is_test", isTest)
          .not("removal_requested_at", "is", null),
      byId,
    ),
  ]);
  const out: ManagerRequestRecord[] = [];
  for (const plan of planRows.map(managerPlanRowOf)) {
    if (!plan) continue;
    out.push({
      id: plan.planId,
      kind: "plan",
      managerHrId: plan.managerHrId,
      weekStart: plan.weekStart,
      customerName: null,
      status: plan.status,
      submittedAt: plan.submittedAt ?? "",
      decisionNote: plan.decisionNote ?? plan.firstDecisionNote,
      waitingOnHrId: plan.status === "submitted" ? plan.firstApproverHrId : plan.status === "first_approved" ? plan.secondApproverHrId : null,
    });
  }
  for (const ask of askRows.map(editAskRowOf)) {
    if (!ask) continue;
    out.push({
      id: ask.requestId,
      kind: "edit",
      managerHrId: ask.managerHrId,
      weekStart: ask.weekStart,
      customerName: null,
      status: ask.status,
      submittedAt: ask.createdAt ?? "",
      decisionNote: ask.decisionNote,
      waitingOnHrId: ask.status === "pending" ? ask.approverHrId : null,
    });
  }
  for (const row of removalRows) {
    const id = textOrNull(row.id);
    if (!id) continue;
    const status = textOrNull(row.status);
    // A refused removal puts the customer back to active; its decision stamp tells it from one never decided.
    const refused = status === "active" && textOrNull(row.removal_decided_at) !== null;
    out.push({
      id,
      kind: "removal",
      managerHrId: me,
      weekStart: null,
      customerName: textOrNull(row.name),
      status: status === "removed" ? "removed" : refused ? "refused" : "pending",
      submittedAt: textOrNull(row.removal_requested_at) ?? "",
      decisionNote: textOrNull(row.removal_decision_note),
      waitingOnHrId: status === "removal_pending" ? personKey(textOrNull(row.removal_approver_hr_id)) : null,
    });
  }
  return out.sort((left, right) => right.submittedAt.localeCompare(left.submittedAt));
}

export type ManagerDecisionRecord = {
  /** The plan id, ask id or own-list customer id the decision was made on. */
  id: string;
  kind: "plan" | "edit" | "removal";
  managerHrId: string;
  weekStart: string | null;
  customerName: string | null;
  decision: "approved" | "returned" | "rejected";
  decidedAt: string;
};

/** Every decision this person made on a district manager's week, ask to edit or own-list removal. */
export async function loadManagerDecisionsBy(hrId: string | null | undefined, isTest: boolean): Promise<ManagerDecisionRecord[]> {
  const me = personKey(hrId);
  if (!me) return [];
  const [eventRows, removalRows] = await Promise.all([
    fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_manager_plan_events")
          .select("id, plan_id, event_type, details, created_at")
          .eq("actor_hr_id", me)
          .in("event_type", ["first_approved", "approved", "returned", "reopened", "edit_refused"]),
      { cursorColumn: "id", cursorOf: (row: Row) => Number(row.id) },
    ),
    fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_manager_customers")
          .select("id, manager_hr_id, name, status, removal_decided_at")
          .eq("removal_decided_by_hr_id", me)
          .eq("is_test", isTest),
      byId,
    ),
  ]);

  // The events carry no world of their own: the plan they sit on does.
  const plans = new Map<string, ManagerPlanRow>();
  for (const part of chunk(dedupeIds(eventRows.map((row) => textOrNull(row.plan_id))), 100)) {
    const rows = await fetchAllRowsKeyset<Row>(
      () => getSupabaseAdmin().from("phoenix_crm_manager_plans").select(MANAGER_PLAN_COLUMNS).in("id", part).eq("is_test", isTest),
      byId,
    );
    for (const plan of rows.map(managerPlanRowOf)) if (plan) plans.set(plan.planId, plan);
  }

  const out: ManagerDecisionRecord[] = [];
  for (const row of eventRows) {
    const plan = plans.get(String(row.plan_id ?? ""));
    if (!plan) continue;
    const type = String(row.event_type ?? "");
    const details = (row.details && typeof row.details === "object" ? row.details : {}) as Row;
    const askId = textOrNull(details.request_id);
    const isAsk = type === "reopened" || type === "edit_refused";
    out.push({
      id: isAsk && askId ? askId : plan.planId,
      kind: isAsk ? "edit" : "plan",
      managerHrId: plan.managerHrId,
      weekStart: plan.weekStart,
      customerName: null,
      decision: type === "returned" ? "returned" : type === "edit_refused" ? "rejected" : "approved",
      decidedAt: textOrNull(row.created_at) ?? "",
    });
  }
  for (const row of removalRows) {
    const id = textOrNull(row.id);
    const managerHrId = personKey(textOrNull(row.manager_hr_id));
    if (!id || !managerHrId) continue;
    out.push({
      id,
      kind: "removal",
      managerHrId,
      weekStart: null,
      customerName: textOrNull(row.name),
      decision: row.status === "removed" ? "approved" : "rejected",
      decidedAt: textOrNull(row.removal_decided_at) ?? "",
    });
  }
  return out.sort((left, right) => right.decidedAt.localeCompare(left.decidedAt));
}

// ── The oversight feeds ───────────────────────────────────────────────────────────────────────────

/**
 * Every sent week (pending and decided), newest first: the CEO's and the Administrator's District Manager
 * feed, or — given `firstApproverHrIds` — the second approver's feed over the managers he decides after.
 * The caller proves the reader may see it.
 */
export async function loadManagerPlanFeed(input: { isTest: boolean; firstApproverHrIds?: ReadonlyArray<string> | null }): Promise<ManagerPlanRow[]> {
  const approvers = input.firstApproverHrIds ? dedupeIds(input.firstApproverHrIds.map((id) => personKey(id))) : null;
  if (approvers && approvers.length === 0) return [];
  const rows = await fetchAllRowsKeyset<Row>(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: any = getSupabaseAdmin().from("phoenix_crm_manager_plans").select(MANAGER_PLAN_COLUMNS).eq("is_test", input.isTest).neq("status", "draft");
    if (approvers) query = query.in("first_approver_hr_id", approvers);
    return query;
  }, byId);
  return rows
    .map(managerPlanRowOf)
    .filter((row): row is ManagerPlanRow => row !== null)
    .sort((left, right) => String(right.submittedAt ?? "").localeCompare(String(left.submittedAt ?? "")));
}
