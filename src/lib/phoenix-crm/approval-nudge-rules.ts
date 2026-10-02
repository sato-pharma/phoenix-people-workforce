/**
 * Phoenix CRM — the daily nudge to a slow approver, composed. No I/O.
 *
 * Owner, 2026-10-02. Three things in the module wait on a person before they count or happen, each at a
 * district manager's step and then at the SFE step:
 *
 *   - a LIST REQUEST — a grade change (the territory's reviewer alone), a drop, an add or a bring-back
 *     (the reviewer, then SFE) — `phoenix_crm_list_requests`, status `pending`, step read from `stage`;
 *   - an OFF-PLAN VISIT — counts in nothing until the reviewer and then SFE approve it —
 *     `phoenix_crm_unplanned_visits`, status `manager_pending` / `sfe_pending`;
 *   - a REQUEST TO EDIT A SENT WEEK — the reviewer, then SFE, then HR —
 *     `phoenix_crm_plan_edit_requests`, status `manager_pending` / `sfe_pending` (HR's own step is the
 *     owner's, and is not nudged).
 *
 * Each is told to its approver ONCE, when it is raised. Nothing reminded anybody after that, so an
 * item could sit at one step for days while the rep it belongs to waited. Once a day, at 09:57 Cairo,
 * whoever has something waiting on him for MORE THAN 24 HOURS at his step gets ONE message naming the
 * counts by kind — "3 list requests, 1 off-plan visit and 1 request to edit a week have waited more
 * than a day" — in-app, by Telegram and to the phone, never by email, opening Team.
 *
 * WHO IS TOLD is the decide rule itself, never a second copy of it (server/access.ts): the manager step
 * is the territory's reviewer (`territoryReviewer`, as `canDecideUnplannedVisit` and
 * `canDecidePlanEdit` read it — the nearest occupied manager seat above the territory, never the CEO,
 * never the rep himself); the SFE step is every SFE Manager, through the resolver the plan-edit
 * notices use (`sfeManagerHrIds`). Only a territory in an open line counts, as the Team tab shows only
 * those. An item with nobody at its step — a vacant chain, no SFE Manager on file — is counted as
 * unaddressed and told to nobody, exactly as its first notice was.
 *
 * WHEN IT STARTED WAITING is when it reached the step it is on: the raise for the first step, the
 * manager's yes for the SFE step (or the raise, for an item that started at SFE because the chain was
 * vacant). So an item the manager approved an hour ago is not yet SFE's to be nudged about.
 *
 * Nobody hears about something already decided: the run reads what is waiting at the moment it runs,
 * real entries only (`is_test = false`). One message per approver per Cairo day — the key carries both.
 */

import { personKey, TERRITORY_TIER, territoryReviewer, type OrgIndex } from "@/lib/phoenix-crm/scope";

export const APPROVAL_NUDGE_JOB_SLUG = "phoenix-crm-approval-nudge";

/** 09:57 Cairo, every day. On :57 at 9, a minute no other job holds. */
export const APPROVAL_NUDGE_CRON = "57 9 * * *";

/** Waiting at one step for MORE than this is waiting too long. */
export const APPROVAL_NUDGE_AFTER_MS = 24 * 60 * 60 * 1000;

export type ApprovalKind = "list_request" | "unplanned_visit" | "plan_edit";

export type ApprovalStage = "manager" | "sfe";

/** The order the message names them in. */
export const APPROVAL_KINDS: readonly ApprovalKind[] = ["list_request", "unplanned_visit", "plan_edit"];

const KIND_WORDS: Record<ApprovalKind, readonly [one: string, many: string]> = {
  list_request: ["list request", "list requests"],
  unplanned_visit: ["off-plan visit", "off-plan visits"],
  plan_edit: ["request to edit a week", "requests to edit a week"],
};

export type WaitingApproval = {
  kind: ApprovalKind;
  seatId: string;
  stage: ApprovalStage;
  /** When it reached the step it is waiting at (`waitingSinceOf`). */
  waitingSince: string;
};

/** A list request's step from its row: none (a grade change) and "manager" are the reviewer's; "sfe" is SFE's. */
export function listRequestStage(stage: unknown): ApprovalStage {
  return stage === "sfe" ? "sfe" : "manager";
}

/** An off-plan visit's or a week-edit request's step from its status; null for any other status. */
export function pendingStage(status: unknown): ApprovalStage | null {
  if (status === "manager_pending") return "manager";
  if (status === "sfe_pending") return "sfe";
  return null;
}

/** When it reached its step: the SFE step from the manager's yes, else the raise. */
export function waitingSinceOf(stage: ApprovalStage, raisedAt: string, managerDecidedAt: string | null | undefined): string {
  return stage === "sfe" && managerDecidedAt ? managerDecidedAt : raisedAt;
}

/** More than 24 hours at its step. An unreadable time is never overdue — nobody is nudged on a guess. */
export function isOverdue(waitingSince: string, now: Date): boolean {
  const at = Date.parse(waitingSince);
  return Number.isFinite(at) && now.getTime() - at > APPROVAL_NUDGE_AFTER_MS;
}

export type ApprovalCounts = Record<ApprovalKind, number>;

function emptyCounts(): ApprovalCounts {
  return { list_request: 0, unplanned_visit: 0, plan_edit: 0 };
}

/** "a", "a and b", "a, b and c". */
function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** "3 list requests, 1 off-plan visit and 1 request to edit a week" — the kinds with something waiting, in order. */
export function approvalCountsText(counts: ApprovalCounts): string {
  return joinWords(
    APPROVAL_KINDS.filter((kind) => counts[kind] > 0).map((kind) => {
      const [one, many] = KIND_WORDS[kind];
      return `${counts[kind]} ${counts[kind] === 1 ? one : many}`;
    }),
  );
}

export type ApprovalNudgeNotice = {
  hrId: string;
  counts: ApprovalCounts;
  title: string;
  message: string;
  idempotencyKey: string;
};

export const APPROVAL_NUDGE_TITLE = "Waiting on you for more than a day";

/** The one message to one approver for one Cairo day, or null when nothing of his is overdue. */
export function approvalNudgeNotice(input: { hrId: string; counts: ApprovalCounts; cairoToday: string }): ApprovalNudgeNotice | null {
  const total = APPROVAL_KINDS.reduce((sum, kind) => sum + input.counts[kind], 0);
  if (total === 0) return null;
  return {
    hrId: input.hrId,
    counts: input.counts,
    title: APPROVAL_NUDGE_TITLE,
    message: `${approvalCountsText(input.counts)} ${total === 1 ? "has" : "have"} waited more than a day. Open Team in Phoenix CRM to decide ${total === 1 ? "it" : "them"}.`,
    idempotencyKey: `phoenix_crm:approval_nudge:${input.hrId}:${input.cairoToday}`,
  };
}

export type ApprovalNudgePlan = {
  notices: ApprovalNudgeNotice[];
  /** Items waiting more than a day at their step. */
  overdue: number;
  /** Overdue with nobody at the step to tell: a vacant chain, no SFE Manager, a territory not open or gone. */
  unaddressed: number;
};

/** Who decides this item's step right now — the decide rule's own people. Empty when nobody does. */
export function approversFor(item: Pick<WaitingApproval, "seatId" | "stage">, org: OrgIndex, sfeHrIds: readonly string[]): string[] {
  if (item.stage === "sfe") return [...sfeHrIds];
  const reviewer = territoryReviewer(org, item.seatId);
  return reviewer ? [reviewer.hrId] : [];
}

export function composeApprovalNudges(input: {
  org: OrgIndex;
  items: readonly WaitingApproval[];
  sfeHrIds: readonly string[];
  openLines: ReadonlySet<string>;
  now: Date;
  cairoToday: string;
}): ApprovalNudgePlan {
  const byPerson = new Map<string, { hrId: string; counts: ApprovalCounts }>();
  let overdue = 0;
  let unaddressed = 0;
  for (const item of input.items) {
    if (!isOverdue(item.waitingSince, input.now)) continue;
    overdue += 1;
    const seat = input.org.seats.get(item.seatId);
    const open = Boolean(seat && seat.tier === TERRITORY_TIER && seat.lineCode && input.openLines.has(seat.lineCode));
    // One person, one message, and one count per item however often his id is listed: keyed by the
    // person, in the stored form every notice is addressed by.
    const approvers: string[] = open ? approversFor(item, input.org, input.sfeHrIds) : [];
    const people = new Set(approvers.map((hrId) => personKey(hrId)).filter((key): key is string => key !== null));
    if (people.size === 0) {
      unaddressed += 1;
      continue;
    }
    for (const key of people) {
      const entry = byPerson.get(key) ?? { hrId: key, counts: emptyCounts() };
      entry.counts[item.kind] += 1;
      byPerson.set(key, entry);
    }
  }
  const notices = [...byPerson.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entry]) => approvalNudgeNotice({ hrId: entry.hrId, counts: entry.counts, cairoToday: input.cairoToday }))
    .filter((notice): notice is ApprovalNudgeNotice => notice !== null);
  return { notices, overdue, unaddressed };
}
