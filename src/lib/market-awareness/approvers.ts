import type { AccessContext } from "@/lib/auth/permissions";
import { canonicalHrIdKey } from "@/lib/hr-id";
import type { MarketAwarenessLine } from "@/lib/market-awareness/lines";

/**
 * Market Awareness — the parallel approval group, and every rule about it that does not need a
 * database.
 *
 * THE CHAIN THE OWNER ASKED FOR (2026-09-09). A Product Manager or the Group Product Manager
 * submits. It then goes to the Marketing Manager AND the National Sales Manager of the primary line
 * AT THE SAME TIME — and to the NSM of every further line the activity targets. Once all of them
 * have approved, it moves to the CEO, who still decides and is still the only person who may approve
 * at a different amount.
 *
 * WHY A SLOT IS A ROLE AND A LINE, NEVER A PERSON. The step this replaces was identity-based, for a
 * good reason: "his direct manager" names one person and a role check would have let any Group
 * Product Manager approve any Product Manager's activity. The owner's new rule names ROLES instead —
 * the Marketing Manager, the line's National Sales Manager — so the slot carries the role and the
 * line, and the holder is resolved from the directory. That difference is load-bearing: the
 * Marketing Manager was on leave with the Group Product Manager covering him for a fortnight in
 * August, and a slot frozen to one person deadlocks the whole queue for the length of a holiday.
 * The holder resolved at submit is still stored, because the notification and the screen both need a
 * name, but it is who the slot was SENT to, never who is allowed to answer it.
 *
 * NSM PER LINE, NOT PER COMPANY. "National Sales Manager" is held by three people, one per line —
 * Magdy El Senosey on Anti Infective, Ali Elsayed on Pedia, Amr Elsebaey on CNS. A role check with
 * no line in it would put all three on every activity.
 */

/** What kind of approval a slot is. */
export const MARKET_AWARENESS_APPROVER_ROLES = ["marketing_manager", "nsm"] as const;
export type MarketAwarenessApproverRole = (typeof MARKET_AWARENESS_APPROVER_ROLES)[number];

/**
 * What one member of the group answered. `null` means they have not answered yet.
 *
 * HOLD IS ABSENT ON PURPOSE. A hold is not an answer to "do you approve" — it freezes the whole
 * request, and it is recorded on the activity and in the decision trail. Writing it into a slot
 * would make a paused approver indistinguishable from one who had answered, and the gate below
 * counts answers.
 */
export const MARKET_AWARENESS_APPROVER_DECISIONS = ["approve", "reject", "return"] as const;
export type MarketAwarenessApproverDecision = (typeof MARKET_AWARENESS_APPROVER_DECISIONS)[number];

/** The role name as it is spelled in `app_auth_users.role`, which is free text. */
export const MARKETING_MANAGER_ROLE = "Marketing Manager";
export const NATIONAL_SALES_MANAGER_ROLE = "National Sales Manager";

/** One person holding one of the two approver roles, as the directory returns them. */
export type ApproverDirectoryEntry = {
  hrId: string;
  name: string | null;
  /** Normalized to one of the two approver roles by the caller. */
  approverRole: MarketAwarenessApproverRole;
  /** `employees.line_id`. Null for the Marketing Manager, who is not on a sales line. */
  lineId: number | null;
};

/** One required approval on one activity. */
export type MarketAwarenessApproverSlot = {
  id: number;
  approverRole: MarketAwarenessApproverRole;
  /** The line this slot answers for. Null for the Marketing Manager slot. */
  lineId: number | null;
  lineName: string | null;
  isPrimaryLine: boolean;
  /** Who it was routed to at submit. Display and notification only — never the permission check. */
  assignedHrId: string | null;
  assignedName: string | null;
  decision: MarketAwarenessApproverDecision | null;
  /** Who actually answered, which is the assigned holder unless somebody is covering for them. */
  decidedByHrId: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  comment: string | null;
};

/** A slot as it is about to be written, before it has an id. */
export type PlannedApproverSlot = {
  approverRole: MarketAwarenessApproverRole;
  lineId: number | null;
  isPrimaryLine: boolean;
  assignedHrId: string | null;
};

export type ApproverPlan = {
  slots: PlannedApproverSlot[];
  /**
   * Lines whose National Sales Manager seat has nobody in it. Submission REFUSES on these rather
   * than shipping a request that no living person can approve — a queue with an unfillable slot in
   * it looks exactly like a queue somebody is being slow about.
   */
  linesWithoutNsm: MarketAwarenessLine[];
  /**
   * Slots dropped because the requester holds them himself. Nobody approves his own spending, and
   * the Marketing Manager may raise these (he is a creator role), so this is a real case rather
   * than a defensive one.
   */
  droppedForRequester: MarketAwarenessApproverRole[];
};

/**
 * Build the approval group for one activity.
 *
 * PURE. Every input is passed in, so the rule can be asserted without a database — the same reason
 * `resolvePendingDecisionRecipients` is pure. A routing rule whose only test is "the query looks
 * right" is a routing rule nobody has ever watched route anything.
 *
 * The Marketing Manager slot is one, whoever holds the role. The NSM slots are one per DISTINCT
 * line on the activity, the primary line first. A line appearing twice cannot produce two slots and
 * neither can one person holding two of these roles: `dedupeKey` collapses them, because a person
 * asked to approve the same request twice is a deadlock dressed as a control.
 */
export function planApproverSlots(input: {
  requesterHrId: string;
  primaryLine: MarketAwarenessLine;
  lines: MarketAwarenessLine[];
  directory: ApproverDirectoryEntry[];
}): ApproverPlan {
  const requesterKey = canonicalHrIdKey(input.requesterHrId);
  const droppedForRequester: MarketAwarenessApproverRole[] = [];
  const linesWithoutNsm: MarketAwarenessLine[] = [];
  const slots: PlannedApproverSlot[] = [];
  const seen = new Set<string>();

  const add = (slot: PlannedApproverSlot) => {
    // One slot per role-and-line, and never two slots pointing at the same human being.
    const roleKey = `${slot.approverRole}:${slot.lineId ?? "-"}`;
    const personKey = slot.assignedHrId ? `person:${canonicalHrIdKey(slot.assignedHrId)}` : null;
    if (seen.has(roleKey)) return;
    if (personKey && seen.has(personKey)) return;
    seen.add(roleKey);
    if (personKey) seen.add(personKey);
    slots.push(slot);
  };

  const marketingManager = input.directory.find(
    (entry) => entry.approverRole === "marketing_manager",
  );
  if (marketingManager && canonicalHrIdKey(marketingManager.hrId) === requesterKey) {
    droppedForRequester.push("marketing_manager");
  } else if (marketingManager) {
    add({
      approverRole: "marketing_manager",
      lineId: null,
      isPrimaryLine: false,
      assignedHrId: marketingManager.hrId,
    });
  } else {
    // No holder at all. The slot is still created so the request cannot complete without one being
    // appointed, and `assignedHrId` null is what the screen renders as the seat being empty.
    add({
      approverRole: "marketing_manager",
      lineId: null,
      isPrimaryLine: false,
      assignedHrId: null,
    });
  }

  // Primary line first, then the rest in the order they were chosen. `orderedLines` is what decides
  // which NSM the screen lists first, and the primary line is the one the whole geography hangs off.
  const orderedLines: MarketAwarenessLine[] = [
    input.primaryLine,
    ...input.lines.filter((line) => line.id !== input.primaryLine.id),
  ];

  for (const line of orderedLines) {
    const nsm = input.directory.find(
      (entry) => entry.approverRole === "nsm" && Number(entry.lineId) === Number(line.id),
    );
    if (!nsm) {
      linesWithoutNsm.push(line);
      continue;
    }
    if (canonicalHrIdKey(nsm.hrId) === requesterKey) {
      droppedForRequester.push("nsm");
      continue;
    }
    add({
      approverRole: "nsm",
      lineId: line.id,
      isPrimaryLine: line.id === input.primaryLine.id,
      assignedHrId: nsm.hrId,
    });
  }

  return { slots, linesWithoutNsm, droppedForRequester };
}

/**
 * May this person answer this slot?
 *
 * ROLE FIRST, IDENTITY SECOND. Holding the role the slot names — and, for an NSM slot, holding it on
 * that line — is what qualifies somebody, so a stand-in appointed while the Marketing Manager is
 * away can clear the queue without anyone editing a request. The frozen `assignedHrId` also passes,
 * which covers the person the slot was actually sent to even if their role row is edited underneath
 * them mid-flight.
 *
 * Super Admin passes, as everywhere else in this module. Nothing here ever answers a slot on
 * somebody's behalf: whoever presses the button is who the decision row records.
 */
export function canDecideSlot(input: {
  access: Pick<AccessContext, "role" | "hrId">;
  slot: Pick<MarketAwarenessApproverSlot, "approverRole" | "lineId" | "assignedHrId">;
  /** The actor's own `employees.line_id`, needed only for an NSM slot. */
  actorLineId: number | null;
}): boolean {
  if (input.access.role === "Super Admin") return true;

  const actorKey = canonicalHrIdKey(input.access.hrId ?? "");
  if (!actorKey) return false;

  const assignedKey = canonicalHrIdKey(input.slot.assignedHrId ?? "");
  if (assignedKey && assignedKey === actorKey) return true;

  if (input.slot.approverRole === "marketing_manager") {
    return input.access.role === MARKETING_MANAGER_ROLE;
  }

  // An NSM answers for HIS line and no other. Three people hold the title, one per line, so a check
  // without the line in it hands every one of them every other line's spending.
  if (input.access.role !== NATIONAL_SALES_MANAGER_ROLE) return false;
  if (input.slot.lineId == null || input.actorLineId == null) return false;
  return Number(input.slot.lineId) === Number(input.actorLineId);
}

/** Which slots, if any, is this person still being waited on for? */
export function pendingSlotsFor(input: {
  access: Pick<AccessContext, "role" | "hrId">;
  actorLineId: number | null;
  slots: MarketAwarenessApproverSlot[];
}): MarketAwarenessApproverSlot[] {
  return input.slots.filter(
    (slot) =>
      slot.decision === null &&
      canDecideSlot({ access: input.access, actorLineId: input.actorLineId, slot }),
  );
}

/**
 * Has the whole group approved?
 *
 * Positive, never "nothing is outstanding": an empty slot list answers FALSE. A request with no
 * approvers is a routing failure, and reading it as unanimous consent is how one would move itself
 * to the CEO with nobody having looked at it.
 */
export function groupHasApproved(slots: MarketAwarenessApproverSlot[]): boolean {
  if (slots.length === 0) return false;
  return slots.every((slot) => slot.decision === "approve");
}

export type ApproverProgress = {
  approved: number;
  total: number;
  /** Names of the people still being waited on, for the screen and the reminder. */
  waitingOn: string[];
};

export function summarizeApproverProgress(
  slots: MarketAwarenessApproverSlot[],
): ApproverProgress {
  const approved = slots.filter((slot) => slot.decision === "approve").length;
  const waitingOn = slots
    .filter((slot) => slot.decision === null)
    // Human names, never raw HR ids — the id is carried beside a name elsewhere, never in place of
    // one. A slot with no holder says so in words rather than printing a blank.
    .map((slot) => slot.assignedName ?? slot.assignedHrId ?? "nobody in the seat")
    .filter((name, index, all) => all.indexOf(name) === index);
  return { approved, total: slots.length, waitingOn };
}

/** The label a screen or a notification uses for one slot. Human-readable, never a code. */
export function describeSlot(slot: Pick<MarketAwarenessApproverSlot, "approverRole" | "lineName">): string {
  if (slot.approverRole === "marketing_manager") return "Marketing Manager";
  return slot.lineName ? `National Sales Manager — ${slot.lineName}` : "National Sales Manager";
}
