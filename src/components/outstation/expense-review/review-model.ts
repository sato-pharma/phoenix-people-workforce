import {
  type BulkApprovalCandidate,
  expenseApprovalQueueRank,
  expenseApprovalState,
  expenseDecisionChanged,
  isAdjustedAmount,
  isRejectedStatus,
  planBulkApproval,
} from "@/lib/outstation/approval-state";
import {
  type ExpenseApprovalSort,
  type ExpenseTripTriageFilter,
  compareExpenseApprovalTrips,
  expenseTripTriage,
} from "@/lib/outstation/expense-approval-triage";
import { isImportedHistoryTrip } from "@/lib/outstation/imported-history";
import {
  OFFICIAL_OUTSTATION_MINIMUM_DISTANCE_KM,
  TOLERANCE_OUTSTATION_MINIMUM_DISTANCE_KM,
  classifyOutstationExpenseEligibility,
} from "@/lib/outstation/classification";
import type { ExpenseTripRecord } from "@/lib/payroll/types";

/**
 * Expense review — the rules of the screen, with no React in them.
 *
 * Rebuilt from scratch on 2026-11-07 in the Phoenix CRM identity (owner: "RETIRE THE CURRENT EXPENSE
 * APPROVAL AND REBUILD FROM SCRATCH SAME PHOENIX CRM IDENTITY"). Everything here is a pure function
 * of the loaded trips and the decisions on screen, so the tab a trip sits in, every count the page
 * prints, the next trip after a decision and the reasons the reviewer is offered are each decided
 * ONCE and tested directly (tests/outstation-expense-review-model.test.ts) — never re-derived in a
 * component.
 *
 * Two rules carry over from the old screen unchanged, and they are why this file reads the STORED
 * decision for some things and the LIVE one for others:
 *
 *  - A ROW NEVER MOVES WHEN IT IS DECIDED (owner, 2026-09-08 — "it vanished" is what made him distrust
 *    the old tabs). Which tab a trip sits in is read from the STORED decision. Approving a trip in
 *    "Needs a look" leaves it right there wearing its new pill; it moves on the next load, which is
 *    after Save, the one moment a reviewer expects movement.
 *  - EVERY COUNT DESCRIBES WHAT IS ON SCREEN RIGHT NOW. The stat tiles count the LIVE decisions, so a
 *    trip approved a moment ago and not yet saved is already counted as approved.
 */

export type LoadedRecord = ExpenseTripRecord & {
  approvedAmount?: number | null;
  hrApproved?: boolean;
  hrComment?: string;
  reportId?: string | null;
  sourceFileName?: string;
};

/** A trip's days with no field activity, as its field-work read found them. */
export type TripIdleDays = { idleDays: number; tripDays: number };

export type Decision = { approvedAmount: number; hrApproved: boolean; hrComment: string; status: string };

/** A row the server declined to write, and why (see the POST route's `requestDecisions`). */
export type SkippedDecision = { reason: string; tripId: string };

/** What is stored on the row — the decision the page opened with. */
export function savedDecision(record: LoadedRecord): Decision {
  return {
    approvedAmount: typeof record.approvedAmount === "number" ? record.approvedAmount : record.total,
    hrApproved: Boolean(record.hrApproved),
    hrComment: record.hrComment ?? "",
    status: record.status ?? "",
  };
}

/**
 * How a trip's distance reads against the outstation distance floor — through the shared classifier,
 * never a literal `< 58`, so the flag tracks the SAME rule the module enforces (60 km official, 58 km
 * tolerance). It reads the built-in policy defaults: this page never loads the policy table, so a
 * custom rule that moves the floor would have to be threaded in here.
 */
export function distanceFlag(km: number): { label: string; tone: "fail" | "none" | "warn" } {
  if (!Number.isFinite(km) || km <= 0) return { label: "", tone: "none" };
  const { classification } = classifyOutstationExpenseEligibility({
    actualDistanceKm: km,
    policy: {
      officialMinimumDistanceKm: OFFICIAL_OUTSTATION_MINIMUM_DISTANCE_KM,
      toleranceMinimumDistanceKm: TOLERANCE_OUTSTATION_MINIMUM_DISTANCE_KM,
    },
  });
  if (classification === "not_eligible") {
    return { label: `Under the ${TOLERANCE_OUTSTATION_MINIMUM_DISTANCE_KM} km outstation floor`, tone: "fail" };
  }
  if (classification === "tolerance_eligible") {
    return { label: `Within tolerance but under the official ${OFFICIAL_OUTSTATION_MINIMUM_DISTANCE_KM} km`, tone: "warn" };
  }
  return { label: "", tone: "none" };
}

// ── The tabs ─────────────────────────────────────────────────────────────────────────────────────

export type ReviewTab = "look" | "clean" | "awaiting" | "approved" | "adjusted" | "rejected" | "history" | "all" | "employees";

/** The tabs that hold trips, in the order the tablist shows them. "By employee" is a view, not a set. */
export const TRIP_TABS = ["look", "clean", "awaiting", "approved", "adjusted", "rejected", "history", "all"] as const satisfies ReadonlyArray<ReviewTab>;
export type TripTab = (typeof TRIP_TABS)[number];

export const REVIEW_TAB_LABELS: Record<ReviewTab, string> = {
  adjusted: "Adjusted",
  all: "All trips",
  approved: "Approved",
  awaiting: "All awaiting",
  clean: "Clean",
  employees: "By employee",
  history: "Before July",
  look: "Needs a look",
  rejected: "Rejected",
};

/** One sentence under each list's title — what the tab holds and what deciding one does. */
export const REVIEW_TAB_DESCRIPTIONS: Record<TripTab, string> = {
  adjusted:
    "Trips paid below what was claimed. Each one carries the reason the employee reads with the decision.",
  all: "Every trip in one list: undecided first, then approved, then rejected. A trip keeps its place until you save.",
  approved: "Approved trips, newest decision first in its order. Unapprove puts one back in the waiting list when you save.",
  awaiting:
    "Every trip still waiting for your decision, the clean ones and the ones that need a look together. Approve and Reject are held on this screen until you press Save.",
  clean:
    "The system found nothing to question: visits on every day and a departure photo with its position. These can be approved together.",
  history:
    "Trips before 1 July 2026 were decided outside Phoenix. They are shown with their values and are never decided here.",
  look:
    "The system found something to look at first: days with no field activity, visits it could not verify, or a departure photo that is flagged or has no position.",
  rejected: "Rejected trips. Undo rejection puts one back in the waiting list when you save.",
};

/**
 * Whether a trip belongs in a tab — read from the STORED decision, so a row never leaves the list it
 * is being decided in (see the file comment). Imported history is only ever in "Before July" and
 * "All trips": it is values only (imported-history.ts) and never waits on anybody.
 */
export function inReviewTab(record: LoadedRecord, tab: TripTab): boolean {
  if (tab === "all") return true;
  const imported = isImportedHistoryTrip(record.date);
  const stored = savedDecision(record);
  const state = expenseApprovalState(stored);
  if (tab === "history") return imported;
  if (imported) return false;
  if (tab === "approved") return state === "approved";
  if (tab === "rejected") return state === "rejected";
  if (tab === "adjusted") return state !== "rejected" && isAdjustedAmount(stored.approvedAmount, record.total);
  if (state !== "pending") return false;
  if (tab === "awaiting") return true;
  return expenseTripTriage(record)?.triage === tab;
}

/** How many trips each tab holds, over the records given (already narrowed by the filters). */
export function countReviewTabs(records: ReadonlyArray<LoadedRecord>): Record<TripTab, number> {
  const counts = Object.fromEntries(TRIP_TABS.map((tab) => [tab, 0])) as Record<TripTab, number>;
  for (const record of records) {
    for (const tab of TRIP_TABS) if (inReviewTab(record, tab)) counts[tab] += 1;
  }
  return counts;
}

/**
 * The tab's rows, in the order the reviewer works them. "All trips" ranks undecided first, then
 * approved, then rejected — on the STORED decision, never the live one (owner, 2026-09-08: one list,
 * and a row does not jump the moment it is decided). Inside a rank, and in every other tab, the
 * reviewer's own order: biggest first or oldest first.
 */
export function tabRows(records: ReadonlyArray<LoadedRecord>, tab: TripTab, sort: ExpenseApprovalSort | undefined): LoadedRecord[] {
  const order = compareExpenseApprovalTrips(sort);
  const rank = (record: LoadedRecord) => expenseApprovalQueueRank(expenseApprovalState(savedDecision(record)));
  return records
    .filter((record) => inReviewTab(record, tab))
    .sort((left, right) => (tab === "all" ? rank(left) - rank(right) : 0) || order(left, right));
}

/** The triage the export should carry for a tab, so the file holds what the tab shows. */
export function exportTriageForTab(tab: ReviewTab): ExpenseTripTriageFilter {
  return tab === "look" || tab === "clean" ? tab : "";
}

/** The first tab with something in it, Needs a look first — where the page opens. */
export function openingTab(counts: Record<TripTab, number>): TripTab {
  for (const tab of ["look", "clean", "awaiting", "approved", "all"] as const) if (counts[tab] > 0) return tab;
  return "look";
}

// ── The six stat tiles ──────────────────────────────────────────────────────────────────────────

export type ReviewStats = {
  adjusted: number;
  adjustedDelta: number;
  approved: number;
  approvedValue: number;
  clean: number;
  look: number;
  pending: number;
  pendingValue: number;
  rejected: number;
};

/**
 * The six tiles — awaiting, needs a look, clean, approved, adjusted, rejected — over the LIVE
 * decisions. Imported history (before July) is in NONE of them: it has its own tab, and counting it
 * read "Approved 453" over a tab of 129 (live tour of d67cacc, 2026-11-07).
 *
 * Called twice by the page: once over the trips the filters leave, once over the whole queue, so
 * every tile can say "95 of 129" when narrowed. On the old page the adjusted figure alone had no
 * "of" (live tour of 636f0fc, 2026-11-07: "8 adjusted" beside "95 of 129 awaiting").
 */
export function computeReviewStats(records: ReadonlyArray<LoadedRecord>, decisionFor: (record: LoadedRecord) => Decision): ReviewStats {
  const stats: ReviewStats = {
    adjusted: 0,
    adjustedDelta: 0,
    approved: 0,
    approvedValue: 0,
    clean: 0,
    look: 0,
    pending: 0,
    pendingValue: 0,
    rejected: 0,
  };
  for (const record of records) {
    const decision = decisionFor(record);
    const state = expenseApprovalState(decision);
    if (isImportedHistoryTrip(record.date)) continue;
    if (state === "pending") {
      stats.pending += 1;
      stats.pendingValue += decision.approvedAmount;
      const triage = expenseTripTriage(record)?.triage;
      if (triage === "look") stats.look += 1;
      if (triage === "clean") stats.clean += 1;
    } else if (state === "approved") {
      stats.approved += 1;
      stats.approvedValue += decision.approvedAmount;
    } else {
      stats.rejected += 1;
    }
    if (state !== "rejected" && isAdjustedAmount(decision.approvedAmount, record.total)) {
      stats.adjusted += 1;
      stats.adjustedDelta += record.total - decision.approvedAmount;
    }
  }
  return stats;
}

/** "95 of 129" when narrowed and the two differ, "95" otherwise — never "129 of 129". */
export function countOutOf(value: number, overall: number | null): { of: number | null; value: number } {
  return { of: overall !== null && overall !== value ? overall : null, value };
}

// ── Moving through the trips ────────────────────────────────────────────────────────────────────

/**
 * The trip to open after a decision: the next one in the list as it stands that is still waiting,
 * else the first waiting one anywhere in it, else none. Read on the LIVE decisions, so a trip just
 * approved is never offered again.
 */
export function nextAwaitingTrip(
  rows: ReadonlyArray<LoadedRecord>,
  fromTripId: string,
  decisionFor: (record: LoadedRecord) => Decision,
): string | null {
  const awaiting = (record: LoadedRecord) =>
    record.tripId !== fromTripId && !isImportedHistoryTrip(record.date) && expenseApprovalState(decisionFor(record)) === "pending";
  const index = rows.findIndex((record) => record.tripId === fromTripId);
  const after = rows.slice(index + 1).find(awaiting);
  return (after ?? rows.find(awaiting))?.tripId ?? null;
}

/** Where a trip sits in a list, for "4 of 37" and Back / Next. */
export function positionIn(rows: ReadonlyArray<{ tripId: string }>, tripId: string | null): { index: number; total: number } | null {
  if (!tripId) return null;
  const index = rows.findIndex((record) => record.tripId === tripId);
  return index < 0 ? null : { index: index + 1, total: rows.length };
}

// ── Approving without opening the trip ──────────────────────────────────────────────────────────

/**
 * A trip as the batch rule reads it (planBulkApproval): the decision on screen, the claim, the
 * allowance and the field-work reading — the LIVE day-by-day one once the trip was opened
 * (withLiveWorkloadStatus), so a conference day that turned out worked no longer holds it back.
 */
export function bulkCandidate(record: LoadedRecord, decision: Decision): BulkApprovalCandidate {
  return {
    allowance: record.allowance,
    approvedAmount: decision.approvedAmount,
    claimedTotal: record.total,
    hrApproved: decision.hrApproved,
    hrComment: decision.hrComment,
    status: decision.status,
    tripId: record.tripId,
    workloadMatchStatus: record.workloadMatchStatus,
  };
}

/**
 * Why a row's own Approve cannot go as it stands — the batch rule, one trip at a time, so a row and a
 * tick-and-approve never disagree. "reason": a changed amount has no written reason yet. "pre-cut":
 * the trip has days with no visit and no meeting and an allowance, so its Approve carries a pre-cut
 * only the opened trip shows (owner, 2026-11-07: "then don't count 26") — approving it from the list
 * would pay the idle day in full behind his back. Null when it can go.
 */
export function rowApproveBlock(record: LoadedRecord, decision: Decision): "pre-cut" | "reason" | null {
  const plan = planBulkApproval([bulkCandidate(record, decision)]);
  if (plan.needsReasonTripIds.length > 0) return "reason";
  if (plan.needsPreCutTripIds.length > 0) return "pre-cut";
  return null;
}

// ── Unsaved decisions ───────────────────────────────────────────────────────────────────────────

/** How many decisions on screen differ from what is stored — the "Save N" figure. */
export function countUnsaved(records: ReadonlyArray<LoadedRecord>, decisions: Record<string, Decision>): number {
  let count = 0;
  for (const record of records) {
    const local = decisions[record.tripId];
    if (!local || isImportedHistoryTrip(record.date)) continue;
    if (expenseDecisionChanged(local, savedDecision(record))) count += 1;
  }
  return count;
}

/** A draft older than this belongs to a different sitting and is dropped, never silently re-opened. */
export const DECISION_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The stored draft, read back field by field rather than cast: this is the one input to the page that
 * is not the API, and a half-shaped entry would flow straight into a Save payload. The shape is the
 * old screen's exactly (`{ decisions, savedAt }` under `…draft.v2:<HR id>`), so decisions left
 * unsaved on the retired page come back on this one.
 */
export function parseExpenseDecisionDraft(raw: string | null, now: number): Record<string, Decision> | null {
  if (!raw) return null;
  let parsed: { decisions?: unknown; savedAt?: unknown } | null;
  try {
    parsed = JSON.parse(raw) as { decisions?: unknown; savedAt?: unknown } | null;
  } catch {
    return null;
  }
  const savedAt = Number(parsed?.savedAt);
  if (!Number.isFinite(savedAt) || now - savedAt > DECISION_DRAFT_MAX_AGE_MS) return null;
  const entries = parsed?.decisions;
  if (!entries || typeof entries !== "object") return null;
  const draft: Record<string, Decision> = {};
  for (const [tripId, value] of Object.entries(entries as Record<string, unknown>)) {
    const entry = value as Partial<Decision> | null;
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.approvedAmount !== "number" || !Number.isFinite(entry.approvedAmount)) continue;
    if (typeof entry.hrApproved !== "boolean") continue;
    if (typeof entry.hrComment !== "string" || typeof entry.status !== "string") continue;
    draft[tripId] = {
      approvedAmount: entry.approvedAmount,
      hrApproved: entry.hrApproved,
      hrComment: entry.hrComment,
      status: entry.status,
    };
  }
  return Object.keys(draft).length > 0 ? draft : null;
}

/**
 * The draft entries worth bringing back: one per trip still in the queue whose drafted decision
 * differs from what is stored. An entry that now MATCHES the stored row was committed meanwhile, and
 * carrying it would show a permanent phantom "1 unsaved".
 */
export function restorableDraft(records: ReadonlyArray<LoadedRecord>, draft: Record<string, Decision>): Record<string, Decision> {
  const restored: Record<string, Decision> = {};
  for (const record of records) {
    const entry = draft[record.tripId];
    if (entry && expenseDecisionChanged(entry, savedDecision(record))) restored[record.tripId] = entry;
  }
  return restored;
}

// ── What the system found, and the reasons it offers ────────────────────────────────────────────

/** The decision's state as one word for a pill. */
export function decisionStateLabel(decision: Decision, record: LoadedRecord): { label: string; tone: "bad" | "good" | "info" | "neutral" | "orange" | "warn" } {
  if (isImportedHistoryTrip(record.date)) return { label: "Before July · values only", tone: "neutral" };
  if (decision.hrApproved) {
    return isAdjustedAmount(decision.approvedAmount, record.total) ? { label: "Approved · adjusted", tone: "info" } : { label: "Approved", tone: "good" };
  }
  if (isRejectedStatus(decision.status)) return { label: "Rejected", tone: "bad" };
  return { label: "Waiting", tone: "orange" };
}

/** Whether a decision on screen differs from the stored row — the "unsaved" mark on a row. */
export function isUnsaved(record: LoadedRecord, decisions: Record<string, Decision>): boolean {
  const local = decisions[record.tripId];
  return Boolean(local) && !isImportedHistoryTrip(record.date) && expenseDecisionChanged(local, savedDecision(record));
}

export type ReasonChip = { key: string; label: string; text: string };

/**
 * The reasons the decision box offers as one-click chips. Each is a finished sentence the employee
 * can read, built only from what the system found on THIS trip — never a reason that is not true of
 * it. A chip only fills the reason box; Approve and Reject stay his clicks.
 */
export function reasonChipsFor(input: {
  duplicateOf?: ReadonlyArray<string>;
  idle: TripIdleDays | null;
  record: LoadedRecord;
}): ReasonChip[] {
  const { duplicateOf, idle, record } = input;
  const chips: ReasonChip[] = [];
  if (idle && idle.tripDays > 0 && idle.idleDays > 0) {
    chips.push(
      idle.idleDays >= idle.tripDays
        ? {
            key: "no-activity",
            label: "No field activity",
            text:
              idle.tripDays > 1
                ? `No field activity was recorded on any of the ${idle.tripDays} days of this trip.`
                : "No field activity was recorded on the day of this trip.",
          }
        : {
            key: "idle-days",
            label: "Idle days",
            text: `${idle.idleDays} of the ${idle.tripDays} days of this trip had no field activity.`,
          },
    );
  } else if (!idle) {
    const status = String(record.workloadMatchStatus ?? "").trim();
    if (status === "no_activity") {
      chips.push({ key: "no-activity", label: "No field activity", text: "No field activity was recorded for this trip." });
    } else if (status === "partial") {
      chips.push({ key: "idle-days", label: "Idle days", text: "Some days of this trip had no field activity." });
    }
  }
  if (duplicateOf && duplicateOf.length > 0) {
    chips.push({
      key: "duplicate",
      label: "Duplicate of another trip",
      text: `This trip was already claimed as ${duplicateOf.join(", ")} — same employee, same day, same destination.`,
    });
  }
  if (record.km && distanceFlag(record.km).tone === "fail") {
    chips.push({
      key: "distance",
      label: "Under the distance floor",
      text: `The trip is ${record.km} km, under the outstation distance floor.`,
    });
  }
  if (record.departurePhotoFlagged) {
    chips.push({ key: "departure-photo", label: "Departure photo flagged", text: "The departure photo did not pass its check." });
  } else if (record.departurePhotoNoGps) {
    chips.push({ key: "departure-gps", label: "Departure photo without position", text: "The departure photo carries no GPS position." });
  }
  return chips;
}

/**
 * The reason box after a chip is picked: an empty box takes the sentence; a box holding only the
 * system's hold reason or another chip's sentence is replaced; anything he typed himself is kept and
 * the sentence is added after it, on its own line. His own words are never written over.
 */
export function reasonAfterChip(input: { chips: ReadonlyArray<ReasonChip>; current: string; picked: ReasonChip; systemText: string }): string {
  const current = input.current.trim();
  if (!current || current === input.systemText.trim() || input.chips.some((chip) => chip.text === current)) return input.picked.text;
  if (current.includes(input.picked.text)) return input.current;
  return `${current}\n${input.picked.text}`;
}

/**
 * One plain sentence over the list — what is waiting and what can be done about it in one go. Built
 * from the live tiles, so it agrees with them to the trip.
 */
export function reviewAdvice(stats: ReviewStats, formatMoney: (value: number) => string): string {
  if (stats.pending === 0) {
    return stats.approved + stats.rejected > 0 ? "Nothing is waiting — every trip here has been decided." : "Nothing is waiting for a decision.";
  }
  const parts: string[] = [];
  if (stats.clean > 0) {
    parts.push(
      `${stats.clean} clean ${stats.clean === 1 ? "trip" : "trips"} could be approved together in the Clean tab`,
    );
  }
  if (stats.look > 0) parts.push(`${stats.look} ${stats.look === 1 ? "needs" : "need"} a look first`);
  const unread = stats.pending - stats.clean - stats.look;
  if (unread > 0) parts.push(`${unread} ${unread === 1 ? "has" : "have"} no system reading`);
  return `${stats.pending} ${stats.pending === 1 ? "trip is" : "trips are"} waiting, worth ${formatMoney(stats.pendingValue)}: ${parts.join("; ")}.`;
}
