/**
 * THE WHATSAPP REMINDER TO A SLOW APPROVER, AS PURE RULES (owner, 3 Nov 2026).
 *
 * Once a working day, about 10:00 Cairo, each approver holding something that has waited more than three days at
 * THEIR step gets one WhatsApp message from a number of its own: a count and a link, no names and no reasons. His
 * words: all 25 approvers, on a new third number. It is not a general channel, and nothing else may use it.
 *
 * 🔴 IT COUNTS WHAT THE PERSON CAN DECIDE TODAY, READ THROUGH THE CHAINS' OWN RULES. A later rung reads `pending` too,
 * and leftover pending steps sit on rejected and cancelled requests (on 3 Nov: 123 pending direct-order steps, not one
 * on an open order). So leave asks `evaluateStepAction` and direct orders ask `resolveActiveStep`, and only requests in
 * an open status are looked at. Getting this wrong nags someone for ever about something nobody can decide.
 *
 * 🔴 THE CLOCK STARTS WHEN THE STEP REACHED THAT PERSON, never when the request was raised. Otherwise a request that
 * took two days at the first rung reaches the second already "late".
 *
 * 🔴 NOTHING IS DROPPED IN SILENCE. An open request nobody can be told about is counted as `unaddressed`, and a person
 * with no readable number is recorded as `no_number`.
 *
 * 🔴 THE THIRD NUMBER DOES NOT READ REPLIES. {@link splitApprovalsLineDelivery} takes its webhook traffic out before the
 * inbox, the applicant bot or Talent Acquisition can see any of it.
 *
 * Pure: no database, no network, no clock of its own. Environment reads live in `@/lib/whatsapp-inbox/lines`.
 */

import { canonicalPersonHrId } from "@/lib/auth/identity-aliases";
import type { PhoenixRole } from "@/lib/auth/permissions";
import { resolveActiveStep } from "@/lib/direct-orders/approval-flow";
import type { DirectOrderStepState } from "@/lib/direct-orders/types";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { toWhatsAppNumber } from "@/lib/reports/organogram-whatsapp";
import { evaluateStepAction } from "@/lib/vacation/approval-flow";
import type { VacationApprovalStepState, VacationApprovalStepStatus, VacationWorkflowStepKey } from "@/lib/vacation/types";

export const APPROVAL_REMINDER_JOB_SLUG = "phoenix-approval-whatsapp-reminders";
export const APPROVAL_REMINDER_SWITCH = "approval_whatsapp_reminder" as const;
export const APPROVAL_REMINDER_EVENT = "approval_whatsapp_reminder";

/** "More than three days", in elapsed hours at the step. */
export const APPROVAL_WAITING_HOURS = 72;

/**
 * The most sent in one tick. Five ticks a morning at this cap is 40, and he counted 25 approvers. A bounded run stays
 * inside the route's time limit, and whoever is left is picked up by the next tick.
 */
export const APPROVAL_REMINDER_CAP_PER_RUN = 8;

export const APPROVAL_REMINDER_TEMPLATE_NAME = "phx_approvals_waiting";
export const APPROVAL_REMINDER_TEMPLATE_LANGUAGE = "en";
export const APPROVAL_REMINDER_OPEN_URL = "https://phoenix-hr.satopharma.com/";

/** The body exactly as submitted to Meta. Worded so it reads correctly for a count of one, since Meta has no plural. */
export const APPROVAL_REMINDER_TEMPLATE_BODY =
  "Phoenix: approvals waiting on you for more than three days: {{count}}. " +
  `Open Phoenix to decide: ${APPROVAL_REMINDER_OPEN_URL} This number does not read replies.`;

export const LEAVE_OPEN_STATUSES = ["pending_manager", "pending_hr"] as const;
export const EXCUSE_OPEN_STATUSES = ["pending_manager"] as const;
export const MARKETING_OPEN_STATUSES = ["pending_approval"] as const;
export const DIRECT_ORDER_OPEN_STATUSES = ["pending_approval"] as const;

export type ApprovalChain = "leave" | "excuse" | "marketing" | "direct_order";
export type ApprovalCounts = Record<ApprovalChain, number>;

/** One open request at one step, whoever it waits on. Both approver fields null means nobody can be told. */
export type WaitingApprovalItem = {
  chain: ApprovalChain;
  requestId: string;
  approverHrId: string | null;
  approverRole: string | null;
  reachedAt: string | null;
};

export type ParentRow = { id: string; status: string | null };

export type LeaveStepRow = {
  request_id: string;
  step_key: string;
  step_order: number | null;
  approver_hr_id: string | null;
  status: string | null;
  decided_at: string | null;
  updated_at: string | null;
};

export type ExcuseRow = {
  id: string;
  status: string | null;
  manager_hr_id: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type MarketingStepRow = {
  request_id: string;
  assigned_hr_id: string | null;
  status: string | null;
  is_cc: boolean | null;
  updated_at: string | null;
};

export type DirectStepRow = {
  request_id: string;
  step_order: number | null;
  approver_kind: string | null;
  approver_role: string | null;
  approver_hr_id: string | null;
  status: string | null;
  decided_at: string | null;
  updated_at: string | null;
};

function normalizedStatus(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function openIds(parents: readonly ParentRow[], open: readonly string[]): string[] {
  return parents.filter((parent) => open.includes(normalizedStatus(parent.status))).map((parent) => parent.id);
}

function groupByRequest<T extends { request_id: string }>(rows: readonly T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.request_id) ?? [];
    list.push(row);
    map.set(row.request_id, list);
  }
  return map;
}

function latestInstant(values: ReadonlyArray<string | null | undefined>): string | null {
  let best = Number.NEGATIVE_INFINITY;
  let bestIso: string | null = null;
  for (const value of values) {
    const at = value ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(at) && at > best) {
      best = at;
      bestIso = value ?? null;
    }
  }
  return bestIso;
}

function nobody(chain: ApprovalChain, requestId: string): WaitingApprovalItem {
  return { chain, requestId, approverHrId: null, approverRole: null, reachedAt: null };
}

/** The step a leave request waits on, by the decide rule itself: only a step that could be approved right now counts. */
export function waitingLeaveItems(parents: readonly ParentRow[], steps: readonly LeaveStepRow[]): WaitingApprovalItem[] {
  const byRequest = groupByRequest(steps);
  const items: WaitingApprovalItem[] = [];
  for (const id of openIds(parents, LEAVE_OPEN_STATUSES)) {
    const rows = byRequest.get(id) ?? [];
    const state: VacationApprovalStepState[] = rows.map((row) => ({
      order: Number(row.step_order),
      status: normalizedStatus(row.status) as VacationApprovalStepStatus,
      stepKey: row.step_key as VacationWorkflowStepKey,
    }));
    const active = rows.filter(
      (row) =>
        normalizedStatus(row.status) === "pending" &&
        evaluateStepAction({
          actorStep: { order: Number(row.step_order), stepKey: row.step_key as VacationWorkflowStepKey },
          decision: "approve",
          steps: state,
        }).allowed,
    );
    if (active.length === 0) {
      items.push(nobody("leave", id));
      continue;
    }
    for (const row of active) {
      const earlierDecisions = rows.filter((other) => Number(other.step_order) < Number(row.step_order)).map((other) => other.decided_at);
      items.push({
        approverHrId: row.approver_hr_id,
        approverRole: null,
        chain: "leave",
        reachedAt: latestInstant([row.updated_at, ...earlierDecisions]),
        requestId: id,
      });
    }
  }
  return items;
}

/** An excuse has one step, the manager. `updated_at` moves when it is resubmitted or handed to another manager. */
export function waitingExcuseItems(rows: readonly ExcuseRow[]): WaitingApprovalItem[] {
  return rows
    .filter((row) => (EXCUSE_OPEN_STATUSES as readonly string[]).includes(normalizedStatus(row.status)))
    .map((row) => ({
      approverHrId: row.manager_hr_id,
      approverRole: null,
      chain: "excuse" as const,
      reachedAt: latestInstant([row.updated_at, row.created_at]),
      requestId: row.id,
    }));
}

/**
 * A marketing step reads `current` only while it holds the request. Read live on 3 Nov, its `updated_at` is the moment
 * the rung before it decided, to the second, so that is when it reached this person. A CC step never blocks anything.
 */
export function waitingMarketingItems(parents: readonly ParentRow[], steps: readonly MarketingStepRow[]): WaitingApprovalItem[] {
  const byRequest = groupByRequest(steps);
  const items: WaitingApprovalItem[] = [];
  for (const id of openIds(parents, MARKETING_OPEN_STATUSES)) {
    const current = (byRequest.get(id) ?? []).filter((row) => normalizedStatus(row.status) === "current" && row.is_cc !== true);
    if (current.length === 0) {
      items.push(nobody("marketing", id));
      continue;
    }
    for (const row of current) {
      items.push({ approverHrId: row.assigned_hr_id, approverRole: null, chain: "marketing", reachedAt: row.updated_at, requestId: id });
    }
  }
  return items;
}

/** The rung a direct order waits on, by the chain's own rule. A role rung names no person until someone decides it. */
export function waitingDirectOrderItems(parents: readonly ParentRow[], steps: readonly DirectStepRow[]): WaitingApprovalItem[] {
  const byRequest = groupByRequest(steps);
  const items: WaitingApprovalItem[] = [];
  for (const id of openIds(parents, DIRECT_ORDER_OPEN_STATUSES)) {
    const rows = byRequest.get(id) ?? [];
    const state: DirectOrderStepState[] = rows.map((row) => ({
      approverHrId: row.approver_hr_id,
      kind: String(row.approver_kind ?? "person") === "role" ? "role" : "person",
      label: "",
      order: Number(row.step_order),
      role: row.approver_role ? (row.approver_role as PhoenixRole) : null,
      status: (["pending", "approved", "rejected"].includes(normalizedStatus(row.status))
        ? normalizedStatus(row.status)
        : "pending") as DirectOrderStepState["status"],
    }));
    const active = resolveActiveStep(state);
    if (!active) {
      items.push(nobody("direct_order", id));
      continue;
    }
    const ownRow = rows.find((row) => Number(row.step_order) === active.order);
    const earlierDecisions = rows.filter((row) => Number(row.step_order) < active.order).map((row) => row.decided_at);
    items.push({
      approverHrId: active.kind === "person" ? active.approverHrId : null,
      approverRole: active.kind === "role" ? active.role : null,
      chain: "direct_order",
      reachedAt: latestInstant([ownRow?.updated_at, ...earlierDecisions]),
      requestId: id,
    });
  }
  return items;
}

export type ApproverPersonRow = { hrId: string; active: boolean; mobileNumber: string | null };
export type ApproverLoginRow = { hrId: string; role: string; isActive: boolean };

export type ApproverDue = {
  hrId: string;
  counts: ApprovalCounts;
  total: number;
  /** Dialable number, or null when the stored one cannot be read. */
  waId: string | null;
};

export type ApproverTally = {
  due: ApproverDue[];
  /** Open and past three days, with nobody who can be told. */
  unaddressed: number;
  /** Open, but not yet three days at its step. */
  notYetDue: number;
};

function personKey(hrId: string | null | undefined): string {
  return canonicalHrIdKey(canonicalPersonHrId(hrId) ?? hrId ?? "");
}

function emptyCounts(): ApprovalCounts {
  return { direct_order: 0, excuse: 0, leave: 0, marketing: 0 };
}

export function tallyApprovers(input: {
  items: readonly WaitingApprovalItem[];
  people: readonly ApproverPersonRow[];
  logins: readonly ApproverLoginRow[];
  now: Date;
  /** Whether a role holds excuse authority at all. District and Regional Managers do not. */
  roleCanDecideExcuse: (role: string) => boolean;
}): ApproverTally {
  const people = new Map<string, { hrId: string; active: boolean; waId: string | null }>();
  for (const row of input.people) {
    const key = personKey(row.hrId);
    if (!key) continue;
    const waId = toWhatsAppNumber(row.mobileNumber);
    const known = people.get(key);
    // One person can hold two rows through an alias: an active row with a number outranks any other.
    if (known && (known.active && !row.active || (known.active === row.active && (known.waId || !waId)))) continue;
    people.set(key, { active: row.active, hrId: canonicalPersonHrId(row.hrId) ?? row.hrId, waId });
  }

  const rolesByPerson = new Map<string, string[]>();
  const holdersByRole = new Map<string, Set<string>>();
  for (const login of input.logins) {
    if (!login.isActive) continue;
    const key = personKey(login.hrId);
    if (!key) continue;
    rolesByPerson.set(key, [...(rolesByPerson.get(key) ?? []), login.role]);
    holdersByRole.set(login.role, (holdersByRole.get(login.role) ?? new Set<string>()).add(key));
  }

  const due = new Map<string, ApproverDue>();
  let unaddressed = 0;
  let notYetDue = 0;
  const thresholdMs = APPROVAL_WAITING_HOURS * 3_600_000;

  for (const item of input.items) {
    const reached = item.reachedAt ? Date.parse(item.reachedAt) : Number.NaN;
    if (!Number.isFinite(reached)) {
      unaddressed += 1;
      continue;
    }
    if (input.now.getTime() - reached <= thresholdMs) {
      notYetDue += 1;
      continue;
    }

    const candidates = item.approverHrId
      ? [personKey(item.approverHrId)]
      : item.approverRole
        ? [...(holdersByRole.get(item.approverRole) ?? [])]
        : [];
    let told = 0;
    for (const key of new Set(candidates)) {
      const person = people.get(key);
      const roles = rolesByPerson.get(key) ?? [];
      // A departed person, someone with no working login and a legacy excuse naming a role with no authority are all
      // people who could not act on the message, so telling them would only nag.
      if (!person || !person.active || roles.length === 0) continue;
      if (item.chain === "excuse" && !roles.some(input.roleCanDecideExcuse)) continue;
      const entry = due.get(key) ?? { counts: emptyCounts(), hrId: person.hrId, total: 0, waId: person.waId };
      entry.counts[item.chain] += 1;
      entry.total += 1;
      due.set(key, entry);
      told += 1;
    }
    if (told === 0) unaddressed += 1;
  }

  return { due: [...due.values()].sort((a, b) => a.hrId.localeCompare(b.hrId)), notYetDue, unaddressed };
}

// ── When, and the locks ──

const CAIRO_DAY = new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone: "Africa/Cairo", year: "numeric" });
const CAIRO_CLOCK = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Africa/Cairo", weekday: "short" });

export function cairoReminderDay(now: Date): string {
  return CAIRO_DAY.format(now);
}

/** Sunday to Thursday, 10:00 to 11:59 Cairo. A stray tick or a hand-pressed run outside it sends nothing. */
export function reminderTimeRefusal(now: Date): string | null {
  const parts = CAIRO_CLOCK.formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  if (weekday === "Fri" || weekday === "Sat") return "It is not a working day in Cairo.";
  if (hour !== 10 && hour !== 11) return "It is outside the morning reminder window in Cairo.";
  return null;
}

/** The locks that need no call to Meta, in the order they are read. Any one of them keeps the job silent. */
export function reminderLockReason(input: { switchOn: boolean; production: boolean; lineConfigured: boolean }): string | null {
  if (!input.switchOn) return "The switch on the recipients screen is off.";
  if (!input.production) return "Only production sends these reminders.";
  if (!input.lineConfigured) return "The third WhatsApp number is not set up.";
  return null;
}

export function reminderTemplateRefusal(status: "approved" | "pending" | "rejected" | "missing"): string | null {
  if (status === "approved") return null;
  if (status === "missing") return "The message has not been submitted to Meta.";
  if (status === "pending") return "Meta has not approved the message yet.";
  return "Meta rejected the message.";
}

// ── The third number's webhook traffic ──

export type ApprovalsLineStatus = { wamid: string; status: string; errorCode: string | null };

export type ApprovalsLineSplit = {
  /** The delivery with this number's traffic removed. The very same object when there was none. */
  payload: unknown;
  droppedChanges: number;
  droppedMessages: number;
  statuses: ApprovalsLineStatus[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Takes everything Meta delivered for the third number out of a webhook delivery, per change and not per delivery: the
 * number sits under the recruitment business account, so one delivery can carry an applicant's CV beside a reply to a
 * reminder, and the CV must still reach the pipeline. Never throws on a strange body: it hands it back untouched.
 */
export function splitApprovalsLineDelivery(payload: unknown, approvalsPhoneNumberId: string | null): ApprovalsLineSplit {
  const untouched: ApprovalsLineSplit = { droppedChanges: 0, droppedMessages: 0, payload, statuses: [] };
  const id = approvalsPhoneNumberId?.trim();
  const root = asRecord(payload);
  if (!id || !root || !Array.isArray(root.entry)) return untouched;

  let droppedChanges = 0;
  let droppedMessages = 0;
  const statuses: ApprovalsLineStatus[] = [];
  const entry = root.entry.map((rawEntry) => {
    const entryRecord = asRecord(rawEntry);
    if (!entryRecord || !Array.isArray(entryRecord.changes)) return rawEntry;
    const kept = entryRecord.changes.filter((rawChange) => {
      const value = asRecord(asRecord(rawChange)?.value);
      if (String(asRecord(value?.metadata)?.phone_number_id ?? "").trim() !== id) return true;
      droppedChanges += 1;
      if (Array.isArray(value?.messages)) droppedMessages += value.messages.length;
      for (const rawStatus of Array.isArray(value?.statuses) ? value.statuses : []) {
        const status = asRecord(rawStatus);
        const wamid = typeof status?.id === "string" ? status.id : null;
        if (!wamid) continue;
        const firstError = Array.isArray(status?.errors) ? asRecord(status.errors[0]) : null;
        statuses.push({
          errorCode: firstError?.code === undefined || firstError?.code === null ? null : String(firstError.code),
          status: String(status?.status ?? "").toLowerCase(),
          wamid,
        });
      }
      return false;
    });
    return kept.length === entryRecord.changes.length ? rawEntry : { ...entryRecord, changes: kept };
  });

  if (droppedChanges === 0) return untouched;
  return { droppedChanges, droppedMessages, payload: { ...root, entry }, statuses };
}

export type ApprovalReminderStatusPatch = {
  status: "delivered" | "read" | "failed";
  failureReason: string | null;
  /** The statuses this update may move on from, so a late "delivered" never overwrites "read" or "failed". */
  from: readonly string[];
};

/** What one delivery tick from Meta does to the ledger row. "Accepted" only ever meant Meta took the message. */
export function approvalReminderStatusPatch(status: ApprovalsLineStatus): ApprovalReminderStatusPatch | null {
  if (status.status === "delivered") return { failureReason: null, from: ["accepted"], status: "delivered" };
  if (status.status === "read") return { failureReason: null, from: ["accepted", "delivered"], status: "read" };
  if (status.status === "failed") {
    return {
      failureReason: status.errorCode ? `Meta could not deliver it (code ${status.errorCode})` : "Meta could not deliver it",
      from: ["accepted", "delivered"],
      status: "failed",
    };
  }
  return null;
}
