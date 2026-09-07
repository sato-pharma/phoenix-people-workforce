import { randomUUID } from "node:crypto";

import type { AccessContext } from "@/lib/auth/permissions";
import { assertPermission } from "@/lib/auth/permissions";
import { canonicalHrIdKey, hrIdForStorage } from "@/lib/hr-id";
import { findLineById, loadMarketAwarenessLines } from "@/lib/market-awareness/lines";
import type { MarketAwarenessLine } from "@/lib/market-awareness/lines";
import { findArea, loadRegionManagers } from "@/lib/market-awareness/geography";
import { notifyConversationMessage } from "@/lib/conversations/notify";
import {
  notifyActivityApproved,
  notifyActivityReturned,
  notifyDecisionPending,
} from "@/lib/market-awareness/notifications";
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
  MarketAwarenessTracking,
} from "@/lib/market-awareness/types";
import {
  canDecideStep,
  currentStep,
  findTransition,
  resolveManagerStep,
  statusAfterResubmit,
} from "@/lib/market-awareness/workflow";
import { logError } from "@/lib/observability/log";
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

type EmployeeRow = { hr_id: string; full_name: string | null; manager_hr_id: string | null; job_title: string | null };

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
      .select("hr_id, full_name, manager_hr_id, job_title")
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

/** Is this HR id the CEO — i.e. is there no approval step above them? */
async function isCeo(hrId: string | null): Promise<boolean> {
  if (!hrId) return false;
  const map = await loadEmployees([hrId]);
  const key = canonicalHrIdKey(hrId);
  const row = key ? map.get(key) : undefined;
  if (!row) return false;
  return !row.manager_hr_id?.trim();
}

type ActivityRow = Record<string, unknown>;

async function hydrate(
  rows: ActivityRow[],
  lines: MarketAwarenessLine[],
): Promise<MarketAwarenessActivity[]> {
  if (rows.length === 0) return [];
  const supabase = getSupabaseAdmin();
  const ids = rows.map((row) => String(row.id));

  const [types, lineRows, productRows, brickRows, costRows, decisionRows] = await Promise.all([
    supabase.from("market_awareness_activity_types").select("*"),
    supabase.from("market_awareness_activity_lines").select("*").in("activity_id", ids),
    supabase.from("market_awareness_activity_products").select("*").in("activity_id", ids),
    supabase.from("market_awareness_activity_bricks").select("*").in("activity_id", ids),
    supabase.from("market_awareness_cost_items").select("*").in("activity_id", ids).order("sort_order"),
    supabase.from("market_awareness_decisions").select("*").in("activity_id", ids).order("created_at"),
  ]);

  for (const result of [types, lineRows, productRows, brickRows, costRows, decisionRows]) {
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

  const peopleWanted = rows.flatMap((row) => [
    row.requester_hr_id as string | null,
    row.manager_hr_id as string | null,
    row.rep_hr_id_at_approval as string | null,
    row.dm_hr_id_at_approval as string | null,
  ]);
  for (const list of decisionsByActivity.values()) {
    for (const decision of list) peopleWanted.push(decision.actor_hr_id as string | null);
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
    // Both casings, because HR ids are stored mixed-case and a single `.eq` under-returns.
    query = query.or(
      `requester_hr_id.eq.${visibility.hrId},requester_hr_id.eq.${visibility.hrId.toUpperCase()},requester_hr_id.eq.${visibility.hrId.toLowerCase()}`,
    );
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
export async function listDecisionInbox(
  access: AccessContext,
): Promise<MarketAwarenessActivity[]> {
  await assertPermission(access, "market_awareness", "read");

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("market_awareness_activities")
    .select("*")
    .in("status", ["pending_manager", "pending_ceo"])
    .order("submitted_at", { ascending: true })
    .limit(500);
  if (error) throw toQueryError(error);

  const lines = await loadMarketAwarenessLines();
  const pending = await hydrate((data as ActivityRow[] | null) ?? [], lines);

  return pending.filter((activity) => {
    const step = currentStep(activity.status);
    if (!step) return false;
    return canDecideStep({ access, managerHrId: activity.managerHrId, step });
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
 * Submit. Resolves the manager step from the requester's reporting line and freezes it, then routes
 * to the manager — or straight to the CEO when the requester reports to him.
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

  const requesterKey = canonicalHrIdKey(existing.requesterHrId);
  const requester = requesterKey
    ? (await loadEmployees([existing.requesterHrId])).get(requesterKey)
    : undefined;
  const managerHrId = requester?.manager_hr_id ?? null;
  const resolution = resolveManagerStep({
    requesterHrId: existing.requesterHrId,
    requesterManagerHrId: managerHrId,
    managerIsCeo: await isCeo(managerHrId),
  });

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("market_awareness_activities")
    .update({
      status: statusAfterResubmit(resolution.skipManagerStep),
      manager_hr_id: resolution.managerHrId ? hrIdForStorage(resolution.managerHrId) : null,
      submitted_at: new Date().toISOString(),
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

export async function decideActivity(
  access: AccessContext,
  activityId: string,
  input: {
    action: Extract<MarketAwarenessDecisionAction, "approve" | "reject" | "return">;
    comment?: string | null;
    amendedCost?: number | null;
  },
): Promise<MarketAwarenessActivity> {
  await assertPermission(access, "market_awareness", "approve");
  const existing = await getActivity(access, activityId);

  const step = currentStep(existing.status);
  if (!step) throw new MarketAwarenessError("That activity is not waiting on a decision.");

  if (!canDecideStep({ access, step, managerHrId: existing.managerHrId })) {
    throw new MarketAwarenessError("This decision is not yours to make.", 403);
  }
  if (input.action === "return" && !input.comment?.trim()) {
    throw new MarketAwarenessError("A return has to say why.");
  }

  const transition = findTransition(existing.status, input.action);
  if (!transition) {
    throw new MarketAwarenessError(`Cannot ${input.action} an activity that is ${existing.status}.`);
  }

  // An amended amount is the CEO's alone. Accepting one at the manager step would let the step
  // below change what the CEO is asked to approve, without his decision recording it.
  const amendedCost =
    step === "ceo" && input.action === "approve" ? input.amendedCost ?? null : null;
  if (amendedCost !== null && !(amendedCost > 0)) {
    throw new MarketAwarenessError("An amended amount has to be greater than zero.");
  }

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    status: transition.to,
    updated_by_hr_id: hrIdForStorage(access.hrId),
  };
  if (transition.to === "approved") {
    patch.approved_at = now;
    if (amendedCost !== null) patch.amended_cost = amendedCost;
    // Freeze the seat holders as they are at approval. The screen shows today's holder; this is what
    // lets it say the original was replaced.
    const area = await findArea(existing.primaryLine.lineCode, existing.areaCode);
    patch.rep_hr_id_at_approval = area?.repHrId ? hrIdForStorage(area.repHrId) : null;
    patch.dm_hr_id_at_approval = area?.dmHrId ? hrIdForStorage(area.dmHrId) : null;
  }
  if (transition.to === "rejected") patch.rejected_at = now;
  if (transition.to === "returned") patch.returned_at = now;

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("market_awareness_activities")
    .update(patch)
    .eq("id", activityId);
  if (error) throw toQueryError(error);

  // ONE decision row, written under the identity of the person who actually acted. Never a second
  // row on behalf of a skipped step or a system actor — that is what made three NSMs appear to have
  // approved as the CEO on the weekly plans, and the transition carries a skip on its own.
  const { error: decisionError } = await supabase.from("market_awareness_decisions").insert({
    activity_id: activityId,
    step_code: step,
    actor_hr_id: hrIdForStorage(access.hrId),
    action: input.action,
    comment: input.comment?.trim() || null,
    amended_cost: amendedCost,
  });
  if (decisionError) throw toQueryError(decisionError);

  const decided = await getActivity(access, activityId);

  // On CEO approval, tell everyone the owner named: every district manager in the region for this
  // line, the NSM, the SFE Manager, the area's medical rep and Finance. Best-effort by contract —
  // notifyActivityApproved swallows and logs, because an undelivered notification must never undo
  // a decision the CEO actually made.
  // Moving on to the CEO is a hand-off like any other: somebody new has to act, so somebody new has
  // to be told. This is the step the CEO was never notified of.
  if (transition.to === "pending_ceo") {
    await notifyDecisionPending({
      activity: decided,
      actionUrl: "/employee-portals/market-awareness/inbox",
      ceoHrIds: await loadRoleHolderHrIds(["CEO"]),
      step: "ceo",
    });
  }

  // Sent back or refused: the requester is the only person who can act next, and until now nothing
  // told them their request had stopped moving.
  if (transition.to === "returned" || transition.to === "rejected") {
    const actorKey = canonicalHrIdKey(access.hrId);
    const deciderName = actorKey
      ? (await loadEmployees([access.hrId])).get(actorKey)?.full_name ?? null
      : null;
    await notifyActivityReturned({
      activity: decided,
      actionUrl: `/employee-portals/market-awareness?activity=${decided.id}`,
      comment: input.comment?.trim() || null,
      deciderName,
      rejected: transition.to === "rejected",
    });
  }

  if (transition.to === "approved") {
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

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("market_awareness_activities")
    .update({
      status: "withdrawn",
      withdrawn_at: new Date().toISOString(),
      updated_by_hr_id: hrIdForStorage(access.hrId),
    })
    .eq("id", activityId);
  if (error) throw toQueryError(error);

  await supabase.from("market_awareness_decisions").insert({
    activity_id: activityId,
    step_code: currentStep(existing.status) ?? "manager",
    actor_hr_id: hrIdForStorage(access.hrId),
    action: "withdraw",
    comment: null,
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
  const patch: Record<string, unknown> = {
    status: goingToExecuted ? "executed" : "closed",
    executed_at: input.executedAt ?? existing.executedAt ?? cairoToday(),
    updated_by_hr_id: hrIdForStorage(access.hrId),
  };
  // Optional fields are written ONLY when supplied. Writing `?? null` unconditionally is a silent
  // erase of whatever was there.
  if (input.actualCost !== undefined) patch.actual_cost = input.actualCost;
  if (input.outcomeNote !== undefined) patch.outcome_note = input.outcomeNote;
  if (!goingToExecuted) patch.closed_at = now;

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("market_awareness_activities")
    .update(patch)
    .eq("id", activityId);
  if (error) throw toQueryError(error);

  await supabase.from("market_awareness_decisions").insert({
    activity_id: activityId,
    step_code: "manager",
    actor_hr_id: hrIdForStorage(access.hrId),
    action: goingToExecuted ? "execute" : "close",
    comment: input.outcomeNote?.trim() || null,
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
