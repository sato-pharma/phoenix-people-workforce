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

import {
  isManagerAskLive,
  isManagerPlanStatus,
  managerAskStage,
  managerPlanStage,
  type ManagerPlanStatus,
} from "@/lib/phoenix-crm/manager-plan-rules";
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

/** The status of each of these weeks, in one world. A week that is not found is absent from the map. */
async function loadPlanStatuses(planIds: ReadonlyArray<string>, isTest: boolean): Promise<Map<string, ManagerPlanStatus>> {
  const out = new Map<string, ManagerPlanStatus>();
  for (const part of chunk(dedupeIds(planIds), 100)) {
    const rows = await fetchAllRowsKeyset<Row>(
      () => getSupabaseAdmin().from("phoenix_crm_manager_plans").select("id, status").in("id", part).eq("is_test", isTest),
      byId,
    );
    for (const row of rows) {
      const id = textOrNull(row.id);
      if (id && isManagerPlanStatus(row.status)) out.set(id, row.status);
    }
  }
  return out;
}

/**
 * The asks to edit that wait on somebody. 🔴 An ask counts only while its week is still a sent one: the
 * database closes an ask in the same transaction that returns or re-sends the week (20261018234000), and this
 * read drops one that is still open on any other week — a returned week, a draft — so it never reaches an
 * approver's queue, his badge or the bell, and no Reopen is offered that could only fail.
 */
async function loadOpenEditAsks(isTest: boolean): Promise<ManagerEditAskRow[]> {
  const rows = await fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_manager_plan_edit_requests")
        .select(EDIT_ASK_COLUMNS)
        .in("status", ["pending", "first_approved"])
        .eq("is_test", isTest),
    byId,
  );
  const asks = rows.map(editAskRowOf).filter((row): row is ManagerEditAskRow => row !== null);
  if (asks.length === 0) return asks;
  const weeks = await loadPlanStatuses(asks.map((ask) => ask.planId), isTest);
  return asks.filter((ask) => isManagerAskLive(ask.status, weeks.get(ask.planId)));
}

async function loadOpenRemovals(isTest: boolean): Promise<Row[]> {
  return fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_manager_customers")
        .select("id, manager_hr_id, name, status, removal_approver_hr_id, removal_second_approver_hr_id, removal_requested_at, created_at")
        .in("status", ["removal_pending", "removal_first_approved"])
        .eq("is_test", isTest),
    byId,
  );
}

/**
 * Where one open item stands for this person: his turn now ("awaiting"), coming to him once the first
 * step is taken ("upcoming"), or neither. The same three answers for a week, an ask to edit it and an
 * own-list removal — after a regional manager agrees, the national sales manager stored on it decides
 * (owner, 2026-10-17: "Week + edit asks + removals").
 */
export function managerQueuePlace(me: string, stage: "first" | "second" | null, firstHrId: string | null, secondHrId: string | null): "awaiting" | "upcoming" | null {
  if (stage === "first" && sameKey(firstHrId, me)) return "awaiting";
  if (stage === "second" && sameKey(secondHrId, me)) return "awaiting";
  if (stage === "first" && sameKey(secondHrId, me)) return "upcoming";
  return null;
}

/**
 * What waits on this person now, and what is coming to him: anything still with the first approver whose
 * second approver he is. Throws on a failed read — the Hub decides what an unread queue costs.
 */
export async function loadManagerPlanQueue(hrId: string | null | undefined, isTest: boolean): Promise<ManagerQueueBuckets> {
  const me = personKey(hrId);
  if (!me) return { awaiting: [], upcoming: [] };
  const [plans, asks, removals] = await Promise.all([loadOpenPlans(isTest), loadOpenEditAsks(isTest), loadOpenRemovals(isTest)]);

  const awaiting: ManagerQueueItem[] = [];
  const upcoming: ManagerQueueItem[] = [];
  const file = (place: "awaiting" | "upcoming" | null, item: ManagerQueueItem) => {
    if (place === "awaiting") awaiting.push(item);
    else if (place === "upcoming") upcoming.push(item);
  };
  for (const plan of plans) {
    if (sameKey(plan.managerHrId, me)) continue;
    const stage = managerPlanStage(plan.status);
    const place = managerQueuePlace(me, stage, plan.firstApproverHrId, plan.secondApproverHrId);
    file(place, {
      id: plan.planId,
      // A week's own stage names the Hub's step; one still with the first approver is "first" for him too.
      stage: place === "awaiting" && stage === "second" ? "second" : "first",
      managerHrId: plan.managerHrId,
      weekStart: plan.weekStart,
      customerName: null,
      waitingSince: plan.submittedAt ?? "",
    });
  }
  for (const ask of asks) {
    if (sameKey(ask.managerHrId, me)) continue;
    const stage = managerAskStage(ask.status);
    file(managerQueuePlace(me, stage, ask.approverHrId, ask.secondApproverHrId), {
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
    if (!id || !managerHrId || managerHrId === me) continue;
    const stage = managerAskStage(row.status);
    file(managerQueuePlace(me, stage, textOrNull(row.removal_approver_hr_id), textOrNull(row.removal_second_approver_hr_id)), {
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
  /**
   * The plan's status; for an ask or a removal: pending / first_approved (the regional manager agreed,
   * the NSM above him decides next) / reopened / refused / expired / removed.
   */
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
          .select("id, name, status, removal_requested_at, removal_approver_hr_id, removal_second_approver_hr_id, removal_decided_at, removal_decision_note")
          .eq("manager_hr_id", me)
          .eq("is_test", isTest)
          .not("removal_requested_at", "is", null),
      byId,
    ),
  ]);
  const out: ManagerRequestRecord[] = [];
  const askRowList = askRows.map(editAskRowOf).filter((row): row is ManagerEditAskRow => row !== null);
  const weekStatuses = await loadPlanStatuses(askRowList.map((ask) => ask.planId), isTest);
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
  for (const ask of askRowList) {
    // An ask still open on a week that is no longer a sent one waits on nobody: it is as good as closed.
    const open = managerAskStage(ask.status) !== null;
    const live = isManagerAskLive(ask.status, weekStatuses.get(ask.planId));
    out.push({
      id: ask.requestId,
      kind: "edit",
      managerHrId: ask.managerHrId,
      weekStart: ask.weekStart,
      customerName: null,
      status: open && !live ? "expired" : ask.status,
      submittedAt: ask.createdAt ?? "",
      decisionNote: ask.decisionNote,
      waitingOnHrId: !live ? null : ask.status === "pending" ? ask.approverHrId : ask.status === "first_approved" ? ask.secondApproverHrId : null,
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
      status: status === "removed" ? "removed" : refused ? "refused" : status === "removal_first_approved" ? "first_approved" : "pending",
      submittedAt: textOrNull(row.removal_requested_at) ?? "",
      decisionNote: textOrNull(row.removal_decision_note),
      waitingOnHrId:
        status === "removal_pending"
          ? personKey(textOrNull(row.removal_approver_hr_id))
          : status === "removal_first_approved"
            ? personKey(textOrNull(row.removal_second_approver_hr_id))
            : null,
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
          .in("event_type", ["first_approved", "approved", "returned", "edit_first_approved", "reopened", "edit_refused"]),
      { cursorColumn: "id", cursorOf: (row: Row) => Number(row.id) },
    ),
    // A removal he decided: the last step, or the first step a regional manager agrees to.
    fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_manager_customers")
          .select("id, manager_hr_id, name, status, removal_decided_at, removal_decided_by_hr_id, removal_first_decided_at, removal_first_decided_by_hr_id")
          .or(`removal_decided_by_hr_id.eq."${me}",removal_first_decided_by_hr_id.eq."${me}"`)
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
    const isAsk = type === "reopened" || type === "edit_refused" || type === "edit_first_approved";
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
    const base = { id, kind: "removal" as const, managerHrId, weekStart: null, customerName: textOrNull(row.name) };
    if (sameKey(textOrNull(row.removal_decided_by_hr_id), me)) {
      out.push({ ...base, decision: row.status === "removed" ? "approved" : "rejected", decidedAt: textOrNull(row.removal_decided_at) ?? "" });
    } else if (sameKey(textOrNull(row.removal_first_decided_by_hr_id), me)) {
      // A first step is only ever an approval: a refusal there closes the ask as its last step.
      out.push({ ...base, decision: "approved", decidedAt: textOrNull(row.removal_first_decided_at) ?? "" });
    }
  }
  return out.sort((left, right) => right.decidedAt.localeCompare(left.decidedAt));
}

// ── The oversight feeds ───────────────────────────────────────────────────────────────────────────

/**
 * Every sent week (pending and decided), newest first: the CEO's and the Administrator's District Manager
 * feed, or — given `secondApproverHrId` — the second approver's feed: every week stored with him as its
 * second approver at the send (owner, 2026-10-17 — the NSM above any regional manager, read from the
 * organogram, never a named pair). The caller proves the reader may see it.
 */
export async function loadManagerPlanFeed(input: { isTest: boolean; secondApproverHrId?: string | null }): Promise<ManagerPlanRow[]> {
  const second = input.secondApproverHrId === undefined ? undefined : personKey(input.secondApproverHrId);
  if (second === null) return [];
  const rows = await fetchAllRowsKeyset<Row>(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: any = getSupabaseAdmin().from("phoenix_crm_manager_plans").select(MANAGER_PLAN_COLUMNS).eq("is_test", input.isTest).neq("status", "draft");
    if (second) query = query.eq("second_approver_hr_id", second);
    return query;
  }, byId);
  return rows
    .map(managerPlanRowOf)
    .filter((row): row is ManagerPlanRow => row !== null)
    .sort((left, right) => String(right.submittedAt ?? "").localeCompare(String(left.submittedAt ?? "")));
}
