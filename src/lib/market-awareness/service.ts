import { randomUUID } from "node:crypto";

import type { AccessContext } from "@/lib/auth/permissions";
import { assertPermission } from "@/lib/auth/permissions";
import { canonicalHrIdKey, hrIdForStorage } from "@/lib/hr-id";
import type {
  ApproverDirectoryEntry,
  MarketAwarenessApproverRole,
  MarketAwarenessApproverSlot,
} from "@/lib/market-awareness/approvers";
import {
  NATIONAL_SALES_MANAGER_ROLE,
  MARKETING_MANAGER_ROLE,
  pendingSlotsFor,
  planApproverSlots,
} from "@/lib/market-awareness/approvers";
import type { MarketAwarenessDecisionBadge } from "@/lib/market-awareness/badge";
import { summarizeMarketAwarenessDecisionBadge } from "@/lib/market-awareness/badge";
import { findLineById, loadMarketAwarenessLines } from "@/lib/market-awareness/lines";
import type { MarketAwarenessLine } from "@/lib/market-awareness/lines";
import { findArea, loadRegionManagers } from "@/lib/market-awareness/geography";
import { notifyConversationMessage } from "@/lib/conversations/notify";
import {
  notifyActivityApproved,
  notifyActivityHeld,
  notifyActivityReturned,
  notifyDecisionPending,
} from "@/lib/market-awareness/notifications";
import type { ActivityVisibility } from "@/lib/market-awareness/scope";
import {
  canCloseActivity,
  canCreateActivity,
  canEditActivity,
  canMarkFinancePaid,
  canViewActivity,
  canWithdrawActivity,
  resolveActivityVisibility,
} from "@/lib/market-awareness/scope";
import { buildTracking } from "@/lib/market-awareness/tracking";
import type {
  MarketAwarenessActivity,
  MarketAwarenessComment,
  MarketAwarenessDecisionAction,
  MarketAwarenessSeatHolder,
  MarketAwarenessStatus,
  MarketAwarenessStepCode,
  MarketAwarenessTracking,
} from "@/lib/market-awareness/types";
import {
  canDecideStep,
  canReleaseHold,
  currentStep,
  findTransition,
  statusAfterResubmit,
} from "@/lib/market-awareness/workflow";
import { logError } from "@/lib/observability/log";
import { quotedOrClause } from "@/lib/supabase/search-filter";
import { getSupabaseAdmin, toQueryError } from "@/lib/supabase/server";

/**
 * Market Awareness — the domain service. Every route calls into here; nothing re-implements a rule.
 *
 * Access is enforced twice on purpose: `assertPermission` decides whether the ROLE may touch the
 * module, and the scope helpers decide WHOSE rows. The matrix has no per-row layer, so a route that
 * only asserted the permission would hand one Product Manager another's activities.
 */

export class MarketAwarenessError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "MarketAwarenessError";
    this.status = status;
  }
}

function cairoToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
}

/** `MAW-20260906-3F2A9C41`, matching the shape of MKT-REQ codes in the sibling module. */
function nextActivityCode(): string {
  const date = cairoToday().replace(/-/g, "");
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  return `MAW-${date}-${suffix}`;
}

function periodOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

type EmployeeRow = {
  hr_id: string;
  full_name: string | null;
  manager_hr_id: string | null;
  job_title: string | null;
  /** Which sales line this person sits on. A National Sales Manager slot is answerable only by the
   * NSM of that line, and three people hold the title. */
  line_id: number | null;
};

async function loadEmployees(hrIds: Array<string | null | undefined>) {
  const wanted = [...new Set(hrIds.filter((id): id is string => Boolean(id?.trim())))];
  if (wanted.length === 0) return new Map<string, EmployeeRow>();

  const supabase = getSupabaseAdmin();
  const byKey = new Map<string, EmployeeRow>();

  // Chunked at 50. A PostgREST `.in()` carrying several hundred ids returns ZERO rows and no error,
  // and a silent empty result here would render every name blank rather than raise.
  for (let index = 0; index < wanted.length; index += 50) {
    const chunk = wanted.slice(index, index + 50);
    const { data, error } = await supabase
      .from("employees")
      .select("hr_id, full_name, manager_hr_id, job_title, line_id")
      .in("hr_id", chunk);
    if (error) throw toQueryError(error);
    for (const row of (data as EmployeeRow[] | null) ?? []) {
      // HR ids are mixed case on this database, so the map is keyed canonically. A plain equality
      // lookup silently under-returns — one such join hid 28% of reps' own orders.
      const key = canonicalHrIdKey(row.hr_id);
      if (key) byKey.set(key, row);
    }
  }
  return byKey;
}

/**
 * HR ids holding any of these roles, from `app_auth_users` — the role directory the marketing module
 * resolves its approvers through.
 *
 * Filtered in JS rather than with `.in("role", ...)`: the column is free text and its casing is not
 * guaranteed, and a case-sensitive match here would return nobody and silently notify an empty list,
 * which looks exactly like "nobody holds that role".
 */
async function loadRoleHolderHrIds(roles: string[]): Promise<string[]> {
  const wanted = new Set(roles.map((role) => role.trim().toLowerCase()));
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("app_auth_users")
    .select("hr_id, role, is_active")
    .eq("is_active", true)
    .limit(1000);
  if (error) throw toQueryError(error);

  return ((data as Array<{ hr_id?: string | null; role?: string | null }> | null) ?? [])
    .filter((row) => wanted.has(String(row.role ?? "").trim().toLowerCase()))
    .map((row) => row.hr_id)
    .filter((hrId): hrId is string => Boolean(hrId?.trim()));
}

/**
 * The people who can hold an approval slot: the Marketing Manager, and every National Sales Manager
 * with the line he sits on.
 *
 * Two reads rather than one join, because `app_auth_users` holds the ROLE and `employees` holds the
 * LINE, and PostgREST cannot join them without an embedded relationship that does not exist here.
 * The role is matched case-insensitively for the reason `loadRoleHolderHrIds` gives: the column is
 * free text, and a case-sensitive match returns nobody, which looks exactly like "nobody holds that
 * role" and would route every activity to an empty group.
 */
async function loadApproverDirectory(): Promise<ApproverDirectoryEntry[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("app_auth_users")
    .select("hr_id, role, is_active")
    .eq("is_active", true)
    .limit(1000);
  if (error) throw toQueryError(error);

  const holders = ((data as Array<{ hr_id?: string | null; role?: string | null }> | null) ?? [])
    .map((row) => ({
      hrId: String(row.hr_id ?? "").trim(),
      role: String(row.role ?? "").trim().toLowerCase(),
    }))
    .filter((row) => row.hrId)
    .map((row) => ({
      hrId: row.hrId,
      approverRole:
        row.role === MARKETING_MANAGER_ROLE.toLowerCase()
          ? ("marketing_manager" as const)
          : row.role === NATIONAL_SALES_MANAGER_ROLE.toLowerCase()
            ? ("nsm" as const)
            : null,
    }))
    .filter((row): row is { hrId: string; approverRole: MarketAwarenessApproverRole } =>
      row.approverRole !== null,
    );

  const employees = await loadEmployees(holders.map((holder) => holder.hrId));

  return holders.map((holder) => {
    const row = employees.get(canonicalHrIdKey(holder.hrId) ?? "");
    return {
      hrId: holder.hrId,
      name: row?.full_name ?? null,
      approverRole: holder.approverRole,
      lineId: row?.line_id == null ? null : Number(row.line_id),
    };
  });
}

/**
 * The line the person acting sits on. Only a National Sales Manager slot reads it, and reading it
 * for anybody else costs one lookup and removes a whole class of "which of the three is this".
 */
async function loadActorLineId(hrId: string | null | undefined): Promise<number | null> {
  const key = canonicalHrIdKey(hrId ?? "");
  if (!key) return null;
  const row = (await loadEmployees([hrId])).get(key);
  return row?.line_id == null ? null : Number(row.line_id);
}

/** One person's name for a message. Human names, never a raw id printed in place of one. */
async function nameOfHrId(hrId: string | null | undefined): Promise<string | null> {
  const key = canonicalHrIdKey(hrId ?? "");
  if (!key) return null;
  return (await loadEmployees([hrId])).get(key)?.full_name ?? null;
}

type ActivityRow = Record<string, unknown>;

async function hydrate(
  rows: ActivityRow[],
  lines: MarketAwarenessLine[],
): Promise<MarketAwarenessActivity[]> {
  if (rows.length === 0) return [];
  const supabase = getSupabaseAdmin();
  const ids = rows.map((row) => String(row.id));

  const [types, lineRows, productRows, brickRows, costRows, decisionRows, approverRows] =
    await Promise.all([
      supabase.from("market_awareness_activity_types").select("*"),
      supabase.from("market_awareness_activity_lines").select("*").in("activity_id", ids),
      supabase.from("market_awareness_activity_products").select("*").in("activity_id", ids),
      supabase.from("market_awareness_activity_bricks").select("*").in("activity_id", ids),
      supabase.from("market_awareness_cost_items").select("*").in("activity_id", ids).order("sort_order"),
      supabase.from("market_awareness_decisions").select("*").in("activity_id", ids).order("created_at"),
      // Ordered so the screen always lists the Marketing Manager first and then the lines in the
      // order they were chosen, rather than in whatever order the rows come back.
      supabase.from("market_awareness_activity_approvers").select("*").in("activity_id", ids).order("id"),
    ]);

  for (const result of [types, lineRows, productRows, brickRows, costRows, decisionRows, approverRows]) {
    if (result.error) throw toQueryError(result.error);
  }

  const typeById = new Map(
    ((types.data as Array<Record<string, unknown>> | null) ?? []).map((row) => [
      Number(row.id),
      {
        id: Number(row.id),
        code: String(row.code),
        name: String(row.name),
        description: (row.description as string | null) ?? null,
        sortOrder: Number(row.sort_order ?? 0),
        active: Boolean(row.active),
      },
    ]),
  );

  const group = <T extends { activity_id: unknown }>(list: T[] | null) => {
    const map = new Map<string, T[]>();
    for (const row of list ?? []) {
      const key = String(row.activity_id);
      const bucket = map.get(key);
      if (bucket) bucket.push(row);
      else map.set(key, [row]);
    }
    return map;
  };

  const linesByActivity = group((lineRows.data as Array<{ activity_id: unknown; line_id: unknown }> | null) ?? []);
  const productsByActivity = group((productRows.data as Array<{ activity_id: unknown } & Record<string, unknown>> | null) ?? []);
  const bricksByActivity = group((brickRows.data as Array<{ activity_id: unknown } & Record<string, unknown>> | null) ?? []);
  const costsByActivity = group((costRows.data as Array<{ activity_id: unknown } & Record<string, unknown>> | null) ?? []);
  const decisionsByActivity = group((decisionRows.data as Array<{ activity_id: unknown } & Record<string, unknown>> | null) ?? []);
  const approversByActivity = group((approverRows.data as Array<{ activity_id: unknown } & Record<string, unknown>> | null) ?? []);

  const peopleWanted = rows.flatMap((row) => [
    row.requester_hr_id as string | null,
    row.manager_hr_id as string | null,
    row.held_by_hr_id as string | null,
    row.rep_hr_id_at_approval as string | null,
    row.dm_hr_id_at_approval as string | null,
  ]);
  for (const list of decisionsByActivity.values()) {
    for (const decision of list) peopleWanted.push(decision.actor_hr_id as string | null);
  }
  // Both halves of a slot: who it was routed to, and who actually answered it. They differ whenever
  // somebody is covering, and the screen has to be able to say so rather than printing one name for
  // two different people.
  for (const list of approversByActivity.values()) {
    for (const slot of list) {
      peopleWanted.push(slot.assigned_hr_id as string | null);
      peopleWanted.push(slot.decided_by_hr_id as string | null);
    }
  }
  const people = await loadEmployees(peopleWanted);
  const nameOf = (hrId: unknown) => {
    const key = hrId ? canonicalHrIdKey(String(hrId)) : null;
    return key ? people.get(key)?.full_name ?? null : null;
  };

  const activities: MarketAwarenessActivity[] = [];

  for (const row of rows) {
    const id = String(row.id);
    const primaryLine =
      findLineById(lines, toNumber(row.primary_line_id)) ??
      ({ id: Number(row.primary_line_id), lineCode: "", name: "Unknown line" } as MarketAwarenessLine);

    const activityLines = (linesByActivity.get(id) ?? [])
      .map((entry) => findLineById(lines, toNumber(entry.line_id)))
      .filter((line): line is MarketAwarenessLine => Boolean(line));

    // The seat holders. TODAY's holder is what the screen shows (owner answer 33), with the
    // approval-time holder carried alongside so a replacement can be named rather than hidden.
    const area = primaryLine.lineCode
      ? await findArea(primaryLine.lineCode, String(row.area_code ?? ""))
      : null;

    const originalRepHrId = (row.rep_hr_id_at_approval as string | null) ?? null;
    const rep: MarketAwarenessSeatHolder = {
      hrId: area?.repHrId ?? null,
      name: area?.repName ?? null,
      originalHrId: originalRepHrId,
      originalName: nameOf(originalRepHrId),
      replacedOriginal:
        Boolean(originalRepHrId) &&
        canonicalHrIdKey(originalRepHrId) !== canonicalHrIdKey(area?.repHrId ?? ""),
      vacant: area ? area.repVacant : false,
    };

    const amendedCost = toNumber(row.amended_cost);
    const estimatedCost = toNumber(row.estimated_cost) ?? 0;
    const status = String(row.status) as MarketAwarenessStatus;

    activities.push({
      id,
      activityCode: String(row.activity_code),
      status,
      requesterHrId: String(row.requester_hr_id),
      requesterName: nameOf(row.requester_hr_id),
      managerHrId: (row.manager_hr_id as string | null) ?? null,
      managerName: nameOf(row.manager_hr_id),
      approvers: (approversByActivity.get(id) ?? []).map((slot) => {
        const lineId = toNumber(slot.line_id);
        return {
          id: Number(slot.id),
          approverRole: String(slot.approver_role) as MarketAwarenessApproverRole,
          lineId,
          lineName: findLineById(lines, lineId)?.name ?? null,
          isPrimaryLine: Boolean(slot.is_primary_line),
          assignedHrId: (slot.assigned_hr_id as string | null) ?? null,
          assignedName: nameOf(slot.assigned_hr_id),
          decision: (slot.decision as MarketAwarenessApproverSlot["decision"]) ?? null,
          decidedByHrId: (slot.decided_by_hr_id as string | null) ?? null,
          decidedByName: nameOf(slot.decided_by_hr_id),
          decidedAt: (slot.decided_at as string | null) ?? null,
          comment: (slot.comment as string | null) ?? null,
        };
      }),
      heldByHrId: (row.held_by_hr_id as string | null) ?? null,
      heldByName: nameOf(row.held_by_hr_id),
      heldAt: (row.held_at as string | null) ?? null,
      holdReason: (row.hold_reason as string | null) ?? null,
      activityType:
        typeById.get(Number(row.activity_type_id)) ??
        { id: Number(row.activity_type_id), code: "unknown", name: "Unknown", description: null, sortOrder: 0, active: false },
      title: (row.title as string | null) ?? null,
      venue: (row.venue as string | null) ?? null,
      city: (row.city as string | null) ?? null,
      startDate: String(row.start_date),
      endDate: (row.end_date as string | null) ?? null,
      expectedAttendees: toNumber(row.expected_attendees),
      speakers: (row.speakers as string | null) ?? null,
      primaryLine,
      lines: activityLines.length > 0 ? activityLines : [primaryLine],
      regionCode: String(row.region_code ?? ""),
      regionName: area?.regionName ?? null,
      areaCode: String(row.area_code ?? ""),
      areaName: area?.areaName ?? null,
      products: (productsByActivity.get(id) ?? []).map((entry) => ({
        productCode: String(entry.product_code),
        productName: (entry.product_name as string | null) ?? null,
        lineId: toNumber(entry.line_id),
      })),
      bricks: (bricksByActivity.get(id) ?? []).map((entry) => ({
        brickId: String(entry.brick_id),
        brickName: null,
        isPrimary: Boolean(entry.is_primary),
      })),
      costItems: (costsByActivity.get(id) ?? []).map((entry) => ({
        id: Number(entry.id),
        label: String(entry.label),
        amount: toNumber(entry.amount) ?? 0,
        sortOrder: Number(entry.sort_order ?? 0),
      })),
      currency: String(row.currency ?? "EGP"),
      estimatedCost,
      amendedCost,
      approvedCost: status === "draft" || status === "withdrawn" ? null : amendedCost ?? estimatedCost,
      actualCost: toNumber(row.actual_cost),
      durationMonths: Number(row.duration_months ?? 3),
      baselineMonths: Number(row.baseline_months ?? 3),
      expectedUpliftPct: toNumber(row.expected_uplift_pct),
      financePaid: Boolean(row.finance_paid),
      financeMarkedAt: (row.finance_marked_at as string | null) ?? null,
      rep,
      districtManagers: [],
      executedAt: (row.executed_at as string | null) ?? null,
      outcomeNote: (row.outcome_note as string | null) ?? null,
      submittedAt: (row.submitted_at as string | null) ?? null,
      approvedAt: (row.approved_at as string | null) ?? null,
      rejectedAt: (row.rejected_at as string | null) ?? null,
      returnedAt: (row.returned_at as string | null) ?? null,
      withdrawnAt: (row.withdrawn_at as string | null) ?? null,
      closedAt: (row.closed_at as string | null) ?? null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      decisions: (decisionsByActivity.get(id) ?? []).map((entry) => ({
        id: Number(entry.id),
        stepCode: String(entry.step_code),
        actorHrId: String(entry.actor_hr_id),
        actorName: nameOf(entry.actor_hr_id),
        action: String(entry.action) as MarketAwarenessDecisionAction,
        comment: (entry.comment as string | null) ?? null,
        amendedCost: toNumber(entry.amended_cost),
        createdAt: String(entry.created_at),
      })),
    });
  }

  return activities;
}

export async function listActivities(
  access: AccessContext,
  options: { status?: MarketAwarenessStatus | null } = {},
): Promise<MarketAwarenessActivity[]> {
  await assertPermission(access, "market_awareness", "read");

  const visibility = resolveActivityVisibility(access);
  if (visibility.kind === "none") return [];

  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("market_awareness_activities")
    .select("*")
    .order("created_at", { ascending: false })
    // Explicit bound: an unbounded select stops at 1000 with no marker, and a silently truncated
    // list is indistinguishable from a short one.
    .limit(500);

  if (visibility.kind === "own") {
    // Through the shared builder, which holds the casing rule AND the quoting in one place — this
    // site carried a verbatim copy of the clause before (AGENTS.md MR-B04).
    const ownFilter = ownActivityFilter(visibility);
    if (ownFilter) query = query.or(ownFilter);
  }
  if (options.status) query = query.eq("status", options.status);

  const { data, error } = await query;
  if (error) throw toQueryError(error);

  const lines = await loadMarketAwarenessLines();
  return hydrate((data as ActivityRow[] | null) ?? [], lines);
}

/**
 * What is waiting for THIS person to decide.
 *
 * The inbox is derived from the same `canDecideStep` the decision route enforces, never from a
 * second rule. A list built from its own predicate is how an inbox comes to show a row the server
 * then refuses — the manager step is identity-checked, so a Group Product Manager sees only the
 * activities routed to HER, not every Product Manager's.
 *
 * Fetch-then-filter rather than a clever WHERE: the CEO step is role-based and the manager step is
 * identity-based, and expressing both in one PostgREST filter would mean restating the rule.
 * Pending activities are a handful by construction — this module has four possible requesters.
 */
export type MarketAwarenessInboxScope = "open" | "history";

/** An inbox row plus whether THIS caller may act on it. */
export type MarketAwarenessInboxRow = {
  activity: MarketAwarenessActivity;
  /** True only when the decision route would accept a decision from this caller right now. */
  canDecide: boolean;
  /**
   * True only when the release route would accept a release from this caller right now. A frozen
   * request offers no decision buttons at all, so without this the one control that can unfreeze it
   * would be the one control nobody is shown.
   */
  canRelease: boolean;
};

/**
 * Still moving through the chain. `on_hold` belongs here: a frozen request has not been answered and
 * dropping it out of the open view is how one comes to be forgotten — it would appear in neither
 * list, which is worse than appearing in the wrong one.
 */
const OPEN_STATUSES: MarketAwarenessStatus[] = [
  "pending_group",
  "on_hold",
  "pending_ceo",
  "returned",
];

/** Answered, one way or another. `draft` is in neither: nobody has been told about it. */
const HISTORY_STATUSES: MarketAwarenessStatus[] = [
  "approved",
  "rejected",
  "withdrawn",
  "executed",
  "closed",
];

/**
 * The `own`-visibility narrowing, written once.
 *
 * Returns the PostgREST `or` filter for a viewer who may see only their own activities, or null when
 * no narrowing applies. Both casings, because HR ids are stored mixed-case and a single `.eq`
 * silently under-returns. It is a shared string rather than a shared query builder so that the inbox
 * and its badge cannot drift: a badge carrying its own copy of "whose rows" is how a count comes to
 * disagree with the list it sits on.
 */
function ownActivityFilter(visibility: ActivityVisibility): string | null {
  if (visibility.kind !== "own") return null;
  // Each arm's value is QUOTED: the HR id reaches here normalised, which is not the same as
  // validated — `canonicalHrIdKey` guarantees no character set — and a `,` or `)` in it would end
  // its arm early, leaving the whole `own` narrowing something nobody wrote (AGENTS.md MR-B04).
  return [visibility.hrId, visibility.hrId.toUpperCase(), visibility.hrId.toLowerCase()]
    .map((value) => quotedOrClause("requester_hr_id", "eq", value))
    .join(",");
}

/**
 * The approvals inbox: two views of the same queue, the same two the Marketing inbox has.
 *
 * TWO AUDIENCES, ONE LIST, AND THE DIFFERENCE IS A FLAG — never a second query. `open` returns
 * everything still moving that the caller may SEE, not only what they may DECIDE, because the Group
 * Product Manager asked to track a Product Manager's request while it sits with that PM's own
 * manager (owner, 2026-09-07). He is not in its chain and must never be offered its buttons, so
 * every row carries `canDecide`, computed from the same `canDecideStep` the decision route enforces.
 * A list built from its own predicate is how an inbox comes to show a button the server refuses.
 *
 * Visibility is `resolveActivityVisibility` and nothing else: a Product Manager sees only their own
 * rows here exactly as they do in the workspace, so this view widens nobody's reach — it only stops
 * hiding what they could already read.
 */
export async function listInbox(
  access: AccessContext,
  scope: MarketAwarenessInboxScope = "open",
): Promise<MarketAwarenessInboxRow[]> {
  await assertPermission(access, "market_awareness", "read");

  const visibility = resolveActivityVisibility(access);
  if (visibility.kind === "none") return [];

  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("market_awareness_activities")
    .select("*")
    .in("status", scope === "history" ? HISTORY_STATUSES : OPEN_STATUSES)
    // Newest first in history — what was answered most recently is what someone is looking for.
    // Oldest first while open, because the longest wait is the one that needs a decision.
    .order(scope === "history" ? "updated_at" : "submitted_at", { ascending: scope !== "history" })
    // Explicit bound: an unbounded select stops at 1000 with no marker.
    .limit(500);

  const ownFilter = ownActivityFilter(visibility);
  if (ownFilter) query = query.or(ownFilter);

  const { data, error } = await query;
  if (error) throw toQueryError(error);

  const lines = await loadMarketAwarenessLines();
  const activities = await hydrate((data as ActivityRow[] | null) ?? [], lines);
  const actorLineId = await loadActorLineIdIfNeeded(access);

  return activities.map((activity) => {
    const step = currentStep(activity.status);
    return {
      activity,
      canDecide: step
        ? canDecideStep({
            access,
            actorLineId,
            approvers: activity.approvers,
            managerHrId: activity.managerHrId,
            step,
          })
        : false,
      canRelease:
        activity.status === "on_hold" &&
        canReleaseHold({ access, heldByHrId: activity.heldByHrId }),
    };
  });
}

/**
 * The actor's line, but only when a slot could actually need it.
 *
 * A National Sales Manager slot is answerable by the NSM OF THAT LINE, and three people hold the
 * title — so the check needs the actor's line. Nobody else's line changes any answer, and this runs
 * on a list and on a badge polled every thirty seconds by every open tab, so the lookup is skipped
 * rather than paid for on every request.
 */
async function loadActorLineIdIfNeeded(
  access: Pick<AccessContext, "role" | "hrId">,
): Promise<number | null> {
  if (access.role !== NATIONAL_SALES_MANAGER_ROLE) return null;
  return loadActorLineId(access.hrId);
}

/**
 * What is waiting for THIS person to decide — the actionable subset of the open view.
 *
 * Kept as its own function because it is the honest answer to "how many decisions do I owe",
 * which is a different question from "what can I see moving".
 */
export async function listDecisionInbox(
  access: AccessContext,
): Promise<MarketAwarenessActivity[]> {
  const rows = await listInbox(access, "open");
  return rows.filter((row) => row.canDecide).map((row) => row.activity);
}

/**
 * The pending-count badge for the Awareness Approvals nav item.
 *
 * The inbox shipped with no sign on its link at all — the only tab in Approvals Hub without one,
 * beside four siblings that all carry a count — so an approver learned a request was waiting only by
 * opening the page on the off-chance. A queue nobody is told about is the same failure as a queue
 * with no door, and this module already had one of those.
 *
 * DELIBERATELY NOT `listDecisionInbox`. This is polled every 30 seconds by every open tab, and that
 * function hydrates every row — six further queries for the types, lines, products, bricks, cost
 * items and decisions, plus the employee lookups — to produce a number that needs three columns.
 *
 * What it DOES share is the rule, not a copy of it: the same `OPEN_STATUSES`, the same
 * `ownActivityFilter` narrowing, and `summarizeMarketAwarenessDecisionBadge`, which decides who owes
 * what through the same `canDecideStep` the decision route enforces.
 */
export async function getMarketAwarenessDecisionBadge(
  access: AccessContext,
): Promise<MarketAwarenessDecisionBadge> {
  await assertPermission(access, "market_awareness", "read");

  const visibility = resolveActivityVisibility(access);
  if (visibility.kind === "none") return { count: 0, overdue: false };

  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("market_awareness_activities")
    // Who must decide, at which step, and since when. The approvers come back EMBEDDED rather than
    // as a second query, because this is polled every thirty seconds by every open tab and a
    // parallel step cannot be counted without them. Nothing here is displayed.
    .select(
      "status, manager_hr_id, step_opened_at, updated_at, market_awareness_activity_approvers(id, approver_role, line_id, assigned_hr_id, decision)",
    )
    .in("status", OPEN_STATUSES)
    // Explicit bound, same as the list: an unbounded select stops at 1000 with no marker.
    .limit(500);
  const ownFilter = ownActivityFilter(visibility);
  if (ownFilter) query = query.or(ownFilter);

  const { data, error } = await query;
  if (error) throw toQueryError(error);

  const rows =
    (data as Array<{
      manager_hr_id: string | null;
      status: string;
      step_opened_at: string | null;
      updated_at: string | null;
      market_awareness_activity_approvers?: Array<Record<string, unknown>> | null;
    }> | null) ?? [];
  return summarizeMarketAwarenessDecisionBadge({
    access,
    actorLineId: await loadActorLineIdIfNeeded(access),
    now: new Date().toISOString(),
    rows: rows.map((row) => ({
      managerHrId: row.manager_hr_id ?? null,
      // `step_opened_at`, falling back to `updated_at` only where the column has never been set.
      // An update trigger stamps `updated_at` on every write, so under a parallel group each partial
      // approval would silently restart the clock for everyone still to answer.
      openedAt: row.step_opened_at ?? row.updated_at ?? null,
      status: row.status,
      approvers: (row.market_awareness_activity_approvers ?? []).map((slot) => ({
        approverRole: String(slot.approver_role) as MarketAwarenessApproverRole,
        lineId: slot.line_id == null ? null : Number(slot.line_id),
        assignedHrId: (slot.assigned_hr_id as string | null) ?? null,
        decision: (slot.decision as MarketAwarenessApproverSlot["decision"]) ?? null,
      })),
    })),
  });
}

export async function listActivityComments(
  access: AccessContext,
  activityId: string,
): Promise<MarketAwarenessComment[]> {
  // getActivity carries the read gate AND the per-row narrowing, so a Product Manager cannot read
  // the thread on somebody else's activity by asking for it directly.
  await getActivity(access, activityId);

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("market_awareness_comments")
    .select("*")
    .eq("activity_id", activityId)
    .order("created_at", { ascending: true })
    .limit(500);
  if (error) throw toQueryError(error);

  const rows = (data as Array<Record<string, unknown>> | null) ?? [];
  const people = await loadEmployees(rows.map((row) => row.author_hr_id as string | null));

  return rows.map((row) => {
    const key = canonicalHrIdKey(String(row.author_hr_id ?? ""));
    return {
      id: Number(row.id),
      authorHrId: String(row.author_hr_id),
      authorName: key ? people.get(key)?.full_name ?? null : null,
      body: String(row.body),
      createdAt: String(row.created_at),
    };
  });
}

/**
 * Add a comment, then tell the people the OWNER'S RULE says to tell.
 *
 * The addressing is NOT decided here. `notifyConversationMessage` is his rule from 2026-09-03 —
 * email the submitter, CC the sender and every participant, in-app and Telegram to everyone except
 * the author — and it lives in one module precisely so it does not become four different rules in
 * four modules. This function's only job is to say who the participants ARE.
 *
 * Participants = the requester, the manager the activity was routed to, everyone who has already
 * decided on it, and everyone who has already commented. The CEO is included once the activity has
 * reached his step, so a conversation opened at the manager stage does not page him early.
 */
export async function addActivityComment(
  access: AccessContext,
  activityId: string,
  body: string,
): Promise<MarketAwarenessComment[]> {
  const activity = await getActivity(access, activityId);

  const text = body.trim();
  if (!text) throw new MarketAwarenessError("A comment cannot be empty.");
  if (!access.hrId) {
    throw new MarketAwarenessError("Your account has no HR id, so a comment cannot be attributed.", 403);
  }

  const supabase = getSupabaseAdmin();
  // The id comes back because the notifier needs it: without a per-message key every comment after
  // the first is deduplicated onto the first one's event and nobody is emailed (see `messageKey`).
  const { data: inserted, error } = await supabase
    .from("market_awareness_comments")
    .insert({
      activity_id: activityId,
      author_hr_id: hrIdForStorage(access.hrId),
      body: text,
    })
    .select("id")
    .single();
  if (error) throw toQueryError(error);
  const messageKey = (inserted as { id?: number } | null)?.id ?? null;

  const comments = await listActivityComments(access, activityId);

  // Best-effort by contract: the comment row is committed, so a delivery failure is logged and
  // swallowed rather than thrown back into the write path, where it would lose the comment.
  try {
    const authorKey = canonicalHrIdKey(access.hrId);
    const authorName = authorKey
      ? (await loadEmployees([access.hrId])).get(authorKey)?.full_name ?? null
      : null;

    const ceoHrIds =
      activity.status === "pending_ceo" || activity.approvedAt
        ? await loadRoleHolderHrIds(["CEO"])
        : [];

    await notifyConversationMessage({
      actionUrl: `/employee-portals/market-awareness?activity=${activity.id}`,
      authorHrId: hrIdForStorage(access.hrId),
      authorName,
      body: text,
      eventType: "market_awareness_comment",
      messageKey,
      metadata: { activityCode: activity.activityCode, status: activity.status },
      module: "market_awareness",
      participantHrIds: [
        activity.managerHrId,
        ...activity.decisions.map((decision) => decision.actorHrId),
        ...comments.map((comment) => comment.authorHrId),
        ...ceoHrIds,
      ],
      recordId: activity.id,
      // The thread belongs to the person who raised it — the email's To.
      submitterHrId: activity.requesterHrId,
      subjectLabel: activity.title?.trim() || activity.activityCode,
      threadLabel: "awareness activity",
    });
  } catch (caught) {
    logError("Market Awareness comment notification failed", {
      labels: {
        event: "market_awareness_comment_notify_failed",
        activity_id: activity.id,
      },
      error: caught,
    });
  }

  return comments;
}

export async function getActivity(
  access: AccessContext,
  activityId: string,
): Promise<MarketAwarenessActivity> {
  await assertPermission(access, "market_awareness", "read");

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("market_awareness_activities")
    .select("*")
    .eq("id", activityId)
    .maybeSingle();
  if (error) throw toQueryError(error);
  if (!data) throw new MarketAwarenessError("That activity does not exist.", 404);

  const lines = await loadMarketAwarenessLines();
  const [activity] = await hydrate([data as ActivityRow], lines);
  if (!activity) throw new MarketAwarenessError("That activity does not exist.", 404);

  if (!canViewActivity(access, activity)) {
    throw new MarketAwarenessError("You do not have access to that activity.", 403);
  }

  activity.districtManagers = (
    await loadRegionManagers(activity.primaryLine.lineCode, activity.regionCode)
  ).map((manager) => ({
    hrId: manager.dmHrId,
    name: manager.dmName,
    originalHrId: null,
    originalName: null,
    replacedOriginal: false,
    vacant: !manager.dmHrId,
  }));

  return activity;
}

export type ActivityInput = {
  activityTypeId: number;
  title?: string | null;
  venue?: string | null;
  city?: string | null;
  startDate: string;
  endDate?: string | null;
  expectedAttendees?: number | null;
  speakers?: string | null;
  primaryLineId: number;
  lineIds: number[];
  regionCode: string;
  areaCode: string;
  brickIds: string[];
  primaryBrickId: string;
  productCodes: Array<{ productCode: string; productName?: string | null; lineId?: number | null }>;
  estimatedCost: number;
  costItems?: Array<{ label: string; amount: number }>;
  durationMonths: number;
  baselineMonths?: number;
  expectedUpliftPct?: number | null;
};

function assertInput(input: ActivityInput) {
  if (!input.productCodes.length) {
    throw new MarketAwarenessError("Pick at least one targeted product.");
  }
  if (!input.brickIds.length) {
    throw new MarketAwarenessError("Pick the brick the activity is held in.");
  }
  if (!input.brickIds.includes(input.primaryBrickId)) {
    throw new MarketAwarenessError("The main brick must be one of the selected bricks.");
  }
  if (!input.lineIds.includes(input.primaryLineId)) {
    throw new MarketAwarenessError("The primary line must be one of the targeted lines.");
  }
  if (!(input.estimatedCost > 0)) {
    throw new MarketAwarenessError("Enter the estimated cost.");
  }
  if (input.durationMonths < 1 || input.durationMonths > 12) {
    throw new MarketAwarenessError("The measurement window must be between 1 and 12 months.");
  }
}

async function writeChildren(activityId: string, input: ActivityInput) {
  const supabase = getSupabaseAdmin();

  // Replace wholesale rather than diffing: a draft edit is small, and a partial update is how an
  // optional field written unconditionally becomes a silent erase.
  await Promise.all([
    supabase.from("market_awareness_activity_lines").delete().eq("activity_id", activityId),
    supabase.from("market_awareness_activity_products").delete().eq("activity_id", activityId),
    supabase.from("market_awareness_activity_bricks").delete().eq("activity_id", activityId),
    supabase.from("market_awareness_cost_items").delete().eq("activity_id", activityId),
  ]);

  const inserts: Array<PromiseLike<unknown>> = [
    supabase.from("market_awareness_activity_lines").insert(
      input.lineIds.map((lineId) => ({ activity_id: activityId, line_id: lineId })),
    ),
    supabase.from("market_awareness_activity_products").insert(
      input.productCodes.map((product) => ({
        activity_id: activityId,
        product_code: product.productCode,
        product_name: product.productName ?? null,
        line_id: product.lineId ?? null,
      })),
    ),
    supabase.from("market_awareness_activity_bricks").insert(
      input.brickIds.map((brickId) => ({
        activity_id: activityId,
        brick_id: brickId,
        is_primary: brickId === input.primaryBrickId,
      })),
    ),
  ];

  if (input.costItems?.length) {
    inserts.push(
      supabase.from("market_awareness_cost_items").insert(
        input.costItems.map((item, index) => ({
          activity_id: activityId,
          label: item.label,
          amount: item.amount,
          sort_order: (index + 1) * 10,
        })),
      ),
    );
  }

  await Promise.all(inserts);
}

export async function createActivity(
  access: AccessContext,
  input: ActivityInput,
): Promise<MarketAwarenessActivity> {
  await assertPermission(access, "market_awareness", "create");
  if (!canCreateActivity(access)) {
    throw new MarketAwarenessError("Your role cannot raise an awareness activity.", 403);
  }
  if (!access.hrId) {
    throw new MarketAwarenessError("Your account has no HR id, so an activity cannot be raised.", 403);
  }
  assertInput(input);

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("market_awareness_activities")
    .insert({
      activity_code: nextActivityCode(),
      status: "draft",
      requester_hr_id: hrIdForStorage(access.hrId),
      activity_type_id: input.activityTypeId,
      title: input.title ?? null,
      venue: input.venue ?? null,
      city: input.city ?? null,
      start_date: input.startDate,
      end_date: input.endDate ?? null,
      expected_attendees: input.expectedAttendees ?? null,
      speakers: input.speakers ?? null,
      primary_line_id: input.primaryLineId,
      region_code: input.regionCode,
      area_code: input.areaCode,
      estimated_cost: input.estimatedCost,
      duration_months: input.durationMonths,
      baseline_months: input.baselineMonths ?? 3,
      expected_uplift_pct: input.expectedUpliftPct ?? null,
      created_by_hr_id: hrIdForStorage(access.hrId),
      updated_by_hr_id: hrIdForStorage(access.hrId),
    })
    .select("id")
    .single();
  if (error) throw toQueryError(error);

  const activityId = String((data as { id: string }).id);
  await writeChildren(activityId, input);
  return getActivity(access, activityId);
}

export async function updateActivity(
  access: AccessContext,
  activityId: string,
  input: ActivityInput,
): Promise<MarketAwarenessActivity> {
  const existing = await getActivity(access, activityId);
  if (!canEditActivity(access, existing)) {
    throw new MarketAwarenessError(
      existing.status === "approved"
        ? "An approved activity is locked. Withdraw it and raise a new one to change it."
        : "You cannot edit that activity.",
      403,
    );
  }
  assertInput(input);

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("market_awareness_activities")
    .update({
      activity_type_id: input.activityTypeId,
      title: input.title ?? null,
      venue: input.venue ?? null,
      city: input.city ?? null,
      start_date: input.startDate,
      end_date: input.endDate ?? null,
      expected_attendees: input.expectedAttendees ?? null,
      speakers: input.speakers ?? null,
      primary_line_id: input.primaryLineId,
      region_code: input.regionCode,
      area_code: input.areaCode,
      estimated_cost: input.estimatedCost,
      duration_months: input.durationMonths,
      baseline_months: input.baselineMonths ?? 3,
      expected_uplift_pct: input.expectedUpliftPct ?? null,
      updated_by_hr_id: hrIdForStorage(access.hrId),
    })
    .eq("id", activityId);
  if (error) throw toQueryError(error);

  await writeChildren(activityId, input);
  return getActivity(access, activityId);
}

/**
 * Submit. Builds the parallel approval group — the Marketing Manager and one National Sales Manager
 * per targeted line — and routes to all of them at once.
 *
 * THE GROUP IS REBUILT FROM SCRATCH, NEVER PATCHED. A resubmission may target different lines from
 * the one that was returned, and every existing answer is stale by definition: what those people
 * approved is not what is now in front of them. Deleting and rewriting is also what makes the
 * owner's "a return resets the group" true without a second rule saying so.
 *
 * IT REFUSES RATHER THAN SHIPPING AN UNAPPROVABLE REQUEST. A line whose National Sales Manager seat
 * is empty produces no slot, and a request carrying a slot nobody can fill looks exactly like one
 * somebody is being slow about — it would sit in the queue for ever with no error anywhere.
 */
export async function submitActivity(
  access: AccessContext,
  activityId: string,
): Promise<MarketAwarenessActivity> {
  const existing = await getActivity(access, activityId);
  if (!["draft", "returned"].includes(existing.status)) {
    throw new MarketAwarenessError("Only a draft or a returned activity can be submitted.");
  }
  if (!canEditActivity(access, existing)) {
    throw new MarketAwarenessError("Only the requester can submit this activity.", 403);
  }

  const plan = planApproverSlots({
    requesterHrId: existing.requesterHrId,
    primaryLine: existing.primaryLine,
    lines: existing.lines,
    directory: await loadApproverDirectory(),
  });

  if (plan.linesWithoutNsm.length > 0) {
    // Named lines, never a code and never a count. The person reading this is the one who chose
    // them, and "one of your lines has no approver" is not something he can act on.
    const names = plan.linesWithoutNsm.map((line) => line.name).join(" and ");
    throw new MarketAwarenessError(
      `There is no National Sales Manager in the seat for ${names}, so this cannot be sent for approval yet. Ask for the seat to be filled, or remove that line.`,
    );
  }

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  // Clear first, then write. A resubmission of a returned activity would otherwise collide with its
  // own previous group on the one-slot-per-role-and-line index.
  const { error: clearError } = await supabase
    .from("market_awareness_activity_approvers")
    .delete()
    .eq("activity_id", activityId);
  if (clearError) throw toQueryError(clearError);

  if (plan.slots.length > 0) {
    const { error: slotError } = await supabase
      .from("market_awareness_activity_approvers")
      .insert(
        plan.slots.map((slot) => ({
          activity_id: activityId,
          approver_role: slot.approverRole,
          line_id: slot.lineId,
          is_primary_line: slot.isPrimaryLine,
          assigned_hr_id: slot.assignedHrId ? hrIdForStorage(slot.assignedHrId) : null,
        })),
      );
    if (slotError) throw toQueryError(slotError);
  }

  const { error } = await supabase
    .from("market_awareness_activities")
    .update({
      status: statusAfterResubmit(plan.slots.length > 0),
      // The retired single-manager step. Cleared rather than left pointing at somebody who is no
      // longer in the chain, which would read on the screen as an approver who never answered.
      manager_hr_id: null,
      submitted_at: now,
      // The group's clock starts now, not at the first submission of a request that came back.
      step_opened_at: now,
      returned_at: null,
      updated_by_hr_id: hrIdForStorage(access.hrId),
    })
    .eq("id", activityId);
  if (error) throw toQueryError(error);

  const submitted = await getActivity(access, activityId);

  // Tell whoever now has to act. Without this the activity lands in an approvals inbox nobody has
  // been sent to — measured on production 2026-09-07, two real submissions sat untouched because
  // nothing announced them. Best-effort: the submission is committed, so a delivery failure is
  // logged inside the notifier and never thrown back here.
  const pendingStep = currentStep(submitted.status);
  if (pendingStep) {
    await notifyDecisionPending({
      activity: submitted,
      actionUrl: "/employee-portals/market-awareness/inbox",
      ceoHrIds: pendingStep === "ceo" ? await loadRoleHolderHrIds(["CEO"]) : [],
      step: pendingStep,
    });
  }

  return submitted;
}

/**
 * Apply one decision and its audit row as a single database statement.
 *
 * WHY THIS EXISTS. Every decision path used to do two writes — move the status, then insert the row
 * recording who moved it — with no transaction around them. Anything failing between the two left a
 * request that had MOVED with no record of who moved it, which on a spending approval is the whole
 * audit trail. Reproduced on staging 2026-09-07, and a Supabase request that times out at 15s still
 * commits, so a slow network reaches the same state with nobody at fault.
 *
 * `phx_market_awareness_apply_decision` does both inside one function body, so the insert failing
 * takes the status change with it.
 *
 * IT ALSO REFUSES A STALE WRITE. The caller passes the status it believed the activity was in; the
 * function takes the row lock and re-reads. If somebody decided first, nothing is written and
 * `applied` comes back false — which is a real answer, not an error, and is why a double-click can
 * no longer put two decisions on one step.
 */
async function applyDecisionAtomically(input: {
  action: MarketAwarenessDecisionAction;
  activityId: string;
  actorHrId: string;
  amendedCost?: number | null;
  approvedAt?: string | null;
  closedAt?: string | null;
  comment?: string | null;
  dmHrIdAtApproval?: string | null;
  executedAt?: string | null;
  expectedStatus: MarketAwarenessStatus;
  nextStatus: MarketAwarenessStatus;
  rejectedAt?: string | null;
  repHrIdAtApproval?: string | null;
  returnedAt?: string | null;
  setActualCost?: boolean;
  actualCost?: number | null;
  setOutcomeNote?: boolean;
  outcomeNote?: string | null;
  stepCode: MarketAwarenessStepCode;
  withdrawnAt?: string | null;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_market_awareness_apply_decision", {
    p_activity_id: input.activityId,
    p_action: input.action,
    p_actor_hr_id: input.actorHrId,
    p_actual_cost: input.actualCost ?? null,
    p_amended_cost: input.amendedCost ?? null,
    p_approved_at: input.approvedAt ?? null,
    p_closed_at: input.closedAt ?? null,
    p_comment: input.comment ?? null,
    p_dm_hr_id_at_approval: input.dmHrIdAtApproval ?? null,
    p_executed_at: input.executedAt ?? null,
    p_expected_status: input.expectedStatus,
    p_next_status: input.nextStatus,
    p_outcome_note: input.outcomeNote ?? null,
    p_rejected_at: input.rejectedAt ?? null,
    p_rep_hr_id_at_approval: input.repHrIdAtApproval ?? null,
    p_returned_at: input.returnedAt ?? null,
    p_set_actual_cost: input.setActualCost ?? false,
    p_set_outcome_note: input.setOutcomeNote ?? false,
    p_step_code: input.stepCode,
    p_withdrawn_at: input.withdrawnAt ?? null,
  });
  if (error) throw toQueryError(error);

  const result = (data ?? null) as { applied?: boolean; currentStatus?: string } | null;
  if (!result?.applied) {
    // Somebody decided first. Say what happened rather than "something went wrong" — the person is
    // looking at a screen that still shows the old state and needs to know to refresh it.
    throw new MarketAwarenessError(
      `Somebody has already acted on this — it is now ${result?.currentStatus ?? "in another state"}. Refresh to see where it stands.`,
      409,
    );
  }
}

/**
 * Apply one GROUP decision — its slot, the activity's status, the parallel gate and the audit row —
 * as a single database statement.
 *
 * Separate from `applyDecisionAtomically`, which still serves the CEO step untouched. New capability
 * ships beside the working thing rather than being folded into it, so the CEO path's behaviour is
 * unchanged and provably so.
 */
async function applyGroupDecisionAtomically(input: {
  action: Extract<MarketAwarenessDecisionAction, "approve" | "reject" | "return" | "hold" | "release">;
  activityId: string;
  actorHrId: string;
  comment?: string | null;
  expectedStatus: MarketAwarenessStatus;
  slotId?: number | null;
}): Promise<{ groupComplete: boolean }> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_market_awareness_apply_group_decision", {
    p_activity_id: input.activityId,
    p_action: input.action,
    p_actor_hr_id: input.actorHrId,
    p_comment: input.comment ?? null,
    p_expected_status: input.expectedStatus,
    p_slot_id: input.slotId ?? null,
  });
  if (error) throw toQueryError(error);

  const result = (data ?? null) as
    | { applied?: boolean; currentStatus?: string; groupComplete?: boolean; reason?: string }
    | null;

  if (!result?.applied) {
    if (result?.reason === "slot_already_decided") {
      throw new MarketAwarenessError(
        "Your answer on this one is already recorded. Refresh to see where it stands.",
        409,
      );
    }
    // Somebody decided first. Say what happened rather than "something went wrong" — the person is
    // looking at a screen that still shows the old state and needs to know to refresh it.
    throw new MarketAwarenessError(
      `Somebody has already acted on this — it is now ${result?.currentStatus ?? "in another state"}. Refresh to see where it stands.`,
      409,
    );
  }

  return { groupComplete: Boolean(result.groupComplete) };
}

/**
 * Lift a hold and put the request back in front of the group.
 *
 * WHO MAY: whoever froze it, the CEO, and Super Admin — `canReleaseHold`. Deliberately not every
 * approver: a hold any peer can undo is not a hold. The CEO is in the list because a hold nobody is
 * left to lift is a request that has quietly died.
 *
 * The clock the group is judged on is advanced by exactly how long it sat frozen, inside the same
 * statement, so a hold stops the clock rather than hiding a breach that had already accrued.
 */
async function releaseActivityHold(
  access: AccessContext,
  activityId: string,
  existing: MarketAwarenessActivity,
): Promise<MarketAwarenessActivity> {
  if (existing.status !== "on_hold") {
    throw new MarketAwarenessError("That activity is not on hold.");
  }
  if (!canReleaseHold({ access, heldByHrId: existing.heldByHrId })) {
    throw new MarketAwarenessError(
      `Only ${existing.heldByName ?? "whoever put this on hold"} or the CEO can release it.`,
      403,
    );
  }
  if (!access.hrId?.trim()) {
    throw new MarketAwarenessError(
      "Your account has no HR id, so a decision could not be attributed to you.",
      403,
    );
  }

  await applyGroupDecisionAtomically({
    action: "release",
    activityId,
    actorHrId: hrIdForStorage(access.hrId) as string,
    comment: existing.holdReason ?? null,
    expectedStatus: "on_hold",
  });

  const released = await getActivity(access, activityId);

  // The people who still owe an answer are being asked again, and nothing else would tell them the
  // request had started moving. Best-effort, like every other notification here.
  await notifyDecisionPending({
    activity: released,
    actionUrl: "/employee-portals/market-awareness/inbox",
    ceoHrIds: [],
    step: "group",
  });

  return released;
}

export async function decideActivity(
  access: AccessContext,
  activityId: string,
  input: {
    action: Extract<
      MarketAwarenessDecisionAction,
      "approve" | "reject" | "return" | "hold" | "release"
    >;
    comment?: string | null;
    amendedCost?: number | null;
    /** Which slot is being answered. Only meaningful for somebody holding more than one. */
    slotId?: number | null;
  },
): Promise<MarketAwarenessActivity> {
  await assertPermission(access, "market_awareness", "approve");
  const existing = await getActivity(access, activityId);

  // A release acts on a FROZEN activity, which by design is waiting on nobody — `currentStep`
  // answers null for it. So it is settled before the step is resolved, or the guard below would
  // refuse the one action that can unfreeze it.
  if (input.action === "release") {
    return releaseActivityHold(access, activityId, existing);
  }

  const step = currentStep(existing.status);
  if (!step) {
    if (existing.status === "on_hold") {
      throw new MarketAwarenessError(
        `This is on hold${existing.heldByName ? ` — ${existing.heldByName} froze it` : ""}. It has to be released before anyone can decide on it.`,
      );
    }
    throw new MarketAwarenessError("That activity is not waiting on a decision.");
  }

  const actorLineId = await loadActorLineIdIfNeeded(access);

  if (!canDecideStep({ access, step, actorLineId, approvers: existing.approvers, managerHrId: existing.managerHrId })) {
    throw new MarketAwarenessError("This decision is not yours to make.", 403);
  }
  if (input.action === "return" && !input.comment?.trim()) {
    throw new MarketAwarenessError("A return has to say why.");
  }
  if (input.action === "hold" && !input.comment?.trim()) {
    throw new MarketAwarenessError("A hold has to say why, so the requester knows what it waits on.");
  }
  if (input.action === "hold" && step !== "group") {
    // The owner gave Hold to the group — the Marketing Manager and the National Sales Managers. The
    // CEO's answers are approve, reject and return, as they have always been.
    throw new MarketAwarenessError("Only the marketing and sales approvers can put this on hold.");
  }

  // BEFORE ANY MUTATION, because the two writes below are not one transaction.
  //
  // `canDecideStep` clears the CEO step on ROLE alone, so an account holding CEO or Super Admin with
  // no hr_id passes it — the `admin-HR` canary is deliberately hr_id NULL, and Super Admin clears
  // every step unconditionally. The status update then succeeds (updated_by_hr_id accepts null)
  // and the decision insert fails on actor_hr_id NOT NULL, leaving an APPROVED spending request
  // with no record of who approved it. Reproduced on staging 2026-09-07: status `approved`,
  // approved_at set, one decision row where there should have been two, and a 500 the approver
  // reads as "it did not go through".
  //
  // Refusing here is the cheap half of the fix. The expensive half — making the status change and
  // its audit row one statement — is a real transaction and is not attempted in this change.
  if (!access.hrId?.trim()) {
    throw new MarketAwarenessError(
      "Your account has no HR id, so a decision could not be attributed to you.",
      403,
    );
  }

  const now = new Date().toISOString();
  let movedTo: MarketAwarenessStatus;

  if (step === "group") {
    // Which of his slots he is answering. A real approver has exactly one; Super Admin can hold
    // several, and answers them one at a time rather than having several silently filled under one
    // press. `slotId` is validated against HIS pending set, never trusted from the request.
    const mine = pendingSlotsFor({ access, actorLineId, slots: existing.approvers });
    const slot = input.slotId
      ? mine.find((candidate) => candidate.id === Number(input.slotId))
      : mine[0];

    // Hold and release act on the whole request rather than on one slot, so they do not need one.
    if (!slot && input.action !== "hold") {
      throw new MarketAwarenessError("This decision is not yours to make.", 403);
    }

    const { groupComplete } = await applyGroupDecisionAtomically({
      action: input.action,
      activityId,
      actorHrId: hrIdForStorage(access.hrId) as string,
      comment: input.comment ?? null,
      expectedStatus: existing.status,
      slotId: slot?.id ?? null,
    });

    movedTo =
      input.action === "approve"
        ? groupComplete
          ? "pending_ceo"
          : "pending_group"
        : input.action === "reject"
          ? "rejected"
          : input.action === "hold"
            ? "on_hold"
            : "returned";
  } else {
    const transition = findTransition(existing.status, input.action);
    if (!transition) {
      throw new MarketAwarenessError(`Cannot ${input.action} an activity that is ${existing.status}.`);
    }

    // An amended amount is the CEO's alone. Accepting one at the group step would let the people
    // below change what the CEO is asked to approve, without his decision recording it.
    const amendedCost = input.action === "approve" ? input.amendedCost ?? null : null;
    if (amendedCost !== null && !(amendedCost > 0)) {
      throw new MarketAwarenessError("An amended amount has to be greater than zero.");
    }

    // Freeze the seat holders as they are at approval. The screen shows today's holder; this is what
    // lets it say the original was replaced. Resolved BEFORE the write so a lookup failure cannot
    // land between the status change and its audit row.
    const area =
      transition.to === "approved"
        ? await findArea(existing.primaryLine.lineCode, existing.areaCode)
        : null;

    // ONE decision row, written under the identity of the person who actually acted, in the same
    // statement as the status change. Never a second row on behalf of a skipped step or a system
    // actor — that is what made three NSMs appear to have approved as the CEO on the weekly plans,
    // and the transition carries a skip on its own.
    await applyDecisionAtomically({
      action: input.action,
      activityId,
      actorHrId: hrIdForStorage(access.hrId) as string,
      amendedCost,
      approvedAt: transition.to === "approved" ? now : null,
      comment: input.comment ?? null,
      dmHrIdAtApproval: area?.dmHrId ? hrIdForStorage(area.dmHrId) : null,
      expectedStatus: existing.status,
      nextStatus: transition.to,
      rejectedAt: transition.to === "rejected" ? now : null,
      repHrIdAtApproval: area?.repHrId ? hrIdForStorage(area.repHrId) : null,
      returnedAt: transition.to === "returned" ? now : null,
      stepCode: step,
    });

    movedTo = transition.to;
  }

  const decided = await getActivity(access, activityId);

  // On CEO approval, tell the three roles the owner named: the NSM, the SFE Manager and Finance.
  // District managers and the area's own medical rep were both on that list until 2026-09-12 and
  // neither is any more — the owner hid the module from the DMs and then from the rep ("no hide
  // from medical rep"), and neither holds a market_awareness grant, so the announcement would have
  // pointed each of them at a page that redirects. Best-effort by contract — notifyActivityApproved
  // swallows and logs, because an undelivered notification must never undo a decision the CEO made.
  // Moving on to the CEO is a hand-off like any other: somebody new has to act, so somebody new has
  // to be told. This is the owner's "once the two or three of them approve, the CEO is informed".
  if (movedTo === "pending_ceo") {
    await notifyDecisionPending({
      activity: decided,
      actionUrl: "/employee-portals/market-awareness/inbox",
      ceoHrIds: await loadRoleHolderHrIds(["CEO"]),
      step: "ceo",
    });
  }

  // Frozen. The requester cannot see a queue, so without this he watches a request stop moving with
  // no reason given anywhere — the same failure a return with no comment produces.
  if (movedTo === "on_hold") {
    await notifyActivityHeld({
      activity: decided,
      actionUrl: `/employee-portals/market-awareness?activity=${decided.id}`,
      holderName: await nameOfHrId(access.hrId),
      reason: input.comment?.trim() || null,
    });
  }

  // Sent back or refused: the requester is the only person who can act next, and until now nothing
  // told them their request had stopped moving.
  if (movedTo === "returned" || movedTo === "rejected") {
    await notifyActivityReturned({
      activity: decided,
      actionUrl: `/employee-portals/market-awareness?activity=${decided.id}`,
      comment: input.comment?.trim() || null,
      deciderName: await nameOfHrId(access.hrId),
      rejected: movedTo === "rejected",
    });
  }

  if (movedTo === "approved") {
    await notifyActivityApproved({
      activity: decided,
      actionUrl: `/employee-portals/market-awareness?activity=${decided.id}`,
      roleRecipientHrIds: await loadRoleHolderHrIds([
        "National Sales Manager",
        "SFE Manager",
        "Finance Manager",
      ]),
    });
  }

  return decided;
}

export async function withdrawActivity(
  access: AccessContext,
  activityId: string,
): Promise<MarketAwarenessActivity> {
  const existing = await getActivity(access, activityId);
  if (!canWithdrawActivity(access, existing)) {
    throw new MarketAwarenessError(
      existing.status === "approved"
        ? "An approved activity cannot be withdrawn."
        : "You cannot withdraw that activity.",
      403,
    );
  }

  // The same atomicity as a decision: withdrawing is a state change with an audit row, and the two
  // must not be separable. It was the same two-write shape.
  if (!access.hrId?.trim()) {
    throw new MarketAwarenessError(
      "Your account has no HR id, so a withdrawal could not be attributed to you.",
      403,
    );
  }
  await applyDecisionAtomically({
    action: "withdraw",
    activityId,
    actorHrId: hrIdForStorage(access.hrId) as string,
    expectedStatus: existing.status,
    nextStatus: "withdrawn",
    stepCode: currentStep(existing.status) ?? "manager",
    withdrawnAt: new Date().toISOString(),
  });

  return getActivity(access, activityId);
}

export async function closeActivity(
  access: AccessContext,
  activityId: string,
  input: { executedAt?: string | null; actualCost?: number | null; outcomeNote?: string | null },
): Promise<MarketAwarenessActivity> {
  const existing = await getActivity(access, activityId);
  if (!canCloseActivity(access, existing)) {
    throw new MarketAwarenessError("You cannot close that activity.", 403);
  }

  const goingToExecuted = existing.status === "approved";
  const now = new Date().toISOString();

  // This path was the worst of the three: its decision insert had NO error check at all, so a failed
  // audit row was swallowed silently rather than even surfacing as a 500. Both writes are now one
  // statement, and the optional fields are still written ONLY when supplied — writing `?? null`
  // unconditionally is a silent erase of whatever was there.
  if (!access.hrId?.trim()) {
    throw new MarketAwarenessError(
      "Your account has no HR id, so this could not be attributed to you.",
      403,
    );
  }
  await applyDecisionAtomically({
    action: goingToExecuted ? "execute" : "close",
    activityId,
    actorHrId: hrIdForStorage(access.hrId) as string,
    actualCost: input.actualCost ?? null,
    closedAt: goingToExecuted ? null : now,
    comment: input.outcomeNote ?? null,
    executedAt: input.executedAt ?? existing.executedAt ?? cairoToday(),
    expectedStatus: existing.status,
    nextStatus: goingToExecuted ? "executed" : "closed",
    outcomeNote: input.outcomeNote ?? null,
    setActualCost: input.actualCost !== undefined,
    setOutcomeNote: input.outcomeNote !== undefined,
    stepCode: "manager",
  });

  return getActivity(access, activityId);
}

export async function markFinancePaid(
  access: AccessContext,
  activityId: string,
  paid: boolean,
): Promise<MarketAwarenessActivity> {
  await assertPermission(access, "market_awareness", "update");
  const existing = await getActivity(access, activityId);
  if (!canMarkFinancePaid(access, existing)) {
    throw new MarketAwarenessError("Only Finance can mark an approved activity paid.", 403);
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("market_awareness_activities")
    .update({
      finance_paid: paid,
      finance_marked_at: new Date().toISOString(),
      finance_marked_by_hr_id: hrIdForStorage(access.hrId),
      updated_by_hr_id: hrIdForStorage(access.hrId),
    })
    .eq("id", activityId);
  if (error) throw toQueryError(error);

  return getActivity(access, activityId);
}

/** The Tracking tab for one activity. */
export async function loadActivityTracking(
  access: AccessContext,
  activityId: string,
): Promise<MarketAwarenessTracking> {
  const activity = await getActivity(access, activityId);

  const productCodesByLineId = new Map<number, string[]>();
  for (const product of activity.products) {
    const lineId = product.lineId ?? activity.primaryLine.id;
    const bucket = productCodesByLineId.get(lineId);
    if (bucket) bucket.push(product.productCode);
    else productCodesByLineId.set(lineId, [product.productCode]);
  }

  return buildTracking({
    lines: activity.lines,
    areaCode: activity.areaCode,
    brickIds: activity.bricks.map((brick) => brick.brickId),
    productCodesByLineId,
    startPeriod: periodOf(activity.startDate),
    baselineMonths: activity.baselineMonths,
    durationMonths: activity.durationMonths,
  });
}

export async function loadActivityTypes() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("market_awareness_activity_types")
    .select("*")
    .eq("active", true)
    .order("sort_order");
  if (error) throw toQueryError(error);
  return ((data as Array<Record<string, unknown>> | null) ?? []).map((row) => ({
    id: Number(row.id),
    code: String(row.code),
    name: String(row.name),
    description: (row.description as string | null) ?? null,
    sortOrder: Number(row.sort_order ?? 0),
    active: Boolean(row.active),
  }));
}
