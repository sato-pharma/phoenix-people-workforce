/**
 * Native rep plans — the RULES, with no I/O (CRM phase 4, the pilot).
 *
 * Pure on purpose, like rules.ts: the planner on the phone and the server both apply these, and the
 * tests exercise them without a database. Nothing here imports the Supabase client.
 *
 * The owner's decisions this file carries (numbers from the CRM audit):
 *   2  AM/PM is the contact's list, exactly as for a visit.
 *   15 A rep plans a WEEK: rep × doctor × day.
 *   16 The rep's district manager verifies the plan or returns it, with a note. The system never
 *      verifies, and nobody verifies on the manager's behalf.
 *   17 One line for one week — the same pilot row the visit form reads — until the CRM cutover date,
 *      from which every line plans here at once (the owner, 2026-09-13).
 *
 * And the audit's §6.3 trap: a vendor re-save issues NEW entry ids, so `plannedCalls` counted entries.
 * A native item has ONE row, and one id, per rep, doctor and day for good. Dropping a doctor marks the
 * row removed; planning him again brings the same row back.
 */

import { addDaysIso } from "@/lib/crm/dates";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { isNativeEntryDay, nativeVisitShiftRefusal, type NativeEntryGate, type NativeVisitShift } from "@/lib/crm/native-visits/rules";

export type NativePlanStatus = "draft" | "submitted" | "verified" | "returned";
export type NativePlanDecision = "verified" | "returned";
export type NativePlanAction = "save" | "submit" | "reopen";

export const NATIVE_PLAN_ITEMS_PER_DAY_MAX = 30;
export const NATIVE_PLAN_NOTE_MAX = 500;

const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function nativePlanStatusLabel(status: NativePlanStatus | null): string {
  if (status === "submitted") return "Waiting for your manager";
  if (status === "verified") return "Verified";
  if (status === "returned") return "Returned for changes";
  if (status === "draft") return "Draft";
  return "Not started";
}

// ── The field week ──────────────────────────────────────────────────────────────────────────────

/** 0 = Sunday … 6 = Saturday, read from the calendar date itself (no clock, no zone). */
function dayOfWeek(isoDay: string): number {
  return new Date(`${isoDay}T12:00:00Z`).getUTCDay();
}

/**
 * The field-force week (plan-v1.ts FIELD_WORKWEEK): Saturday to Wednesday, plus Thursday morning.
 * Keyed by its Saturday. A Friday belongs to the week that ends the day before it.
 */
export function nativePlanWeekStart(isoDay: string): string {
  const offset = (dayOfWeek(isoDay) - 6 + 7) % 7;
  return addDaysIso(isoDay, -offset);
}

export function isNativePlanWeekStart(value: string): boolean {
  return ISO_DAY_PATTERN.test(value) && dayOfWeek(value) === 6;
}

/** Saturday, Sunday, Monday, Tuesday, Wednesday, Thursday — never Friday. */
export function nativePlanWeekDays(weekStart: string): string[] {
  return [0, 1, 2, 3, 4, 5].map((offset) => addDaysIso(weekStart, offset));
}

/** Thursday is a morning only in the field week. */
export function nativePlanDayShifts(isoDay: string): NativeVisitShift[] {
  return dayOfWeek(isoDay) === 4 ? ["AM"] : ["AM", "PM"];
}

/**
 * The weeks a rep may open: this field week and the next one, and only where they still have an open
 * day ahead — a pilot day, or a day on or after the CRM cutover. A week that has fully passed is never
 * offered. So the first cutover week can be planned throughout the week before it.
 */
export function nativePlanOpenWeeks(gate: NativeEntryGate, cairoToday: string): string[] {
  const thisWeek = nativePlanWeekStart(cairoToday);
  return [thisWeek, addDaysIso(thisWeek, 7)].filter((weekStart) => nativePlanEditableDays(gate, weekStart, cairoToday).length > 0);
}

/** The days of a week a rep may still change: open days from today on. A past day is fixed. */
export function nativePlanEditableDays(gate: NativeEntryGate, weekStart: string, cairoToday: string): string[] {
  if (!isNativePlanWeekStart(weekStart)) return [];
  return nativePlanWeekDays(weekStart).filter((day) => day >= cairoToday && isNativeEntryDay(gate, day));
}

// ── Items ───────────────────────────────────────────────────────────────────────────────────────

export type NativePlanItemDraft = {
  planDate: string;
  contactCrmId: number;
  shift: NativeVisitShift;
};

/** A stored item, removed or not. The row — and its id — outlives being dropped from the plan. */
export type NativePlanStoredItem = NativePlanItemDraft & { id: string; removed: boolean };

export type NativePlanRuleResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function nativePlanItemKey(planDate: string, contactCrmId: number): string {
  return `${planDate}|${contactCrmId}`;
}

/** The shape of a submitted item list. Duplicates of one doctor on one day collapse to the first. */
export function parseNativePlanItems(raw: unknown): NativePlanRuleResult<NativePlanItemDraft[]> {
  if (!Array.isArray(raw)) return { ok: false, error: "The plan has no list of doctors. Reload the planner." };
  const seen = new Set<string>();
  const out: NativePlanItemDraft[] = [];
  for (const entry of raw) {
    const body = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const planDate = String(body.planDate ?? "").trim();
    if (!ISO_DAY_PATTERN.test(planDate)) return { ok: false, error: "A planned doctor has no day. Reload the planner." };
    const contactCrmId = Number(body.contactCrmId);
    if (!Number.isInteger(contactCrmId) || contactCrmId <= 0) {
      return { ok: false, error: "A planned doctor is missing. Reload the planner." };
    }
    if (contactCrmId === 100000) {
      return { ok: false, error: "That entry is the CRM's catch-all, not a doctor. Choose the doctor from your list." };
    }
    const shift = String(body.shift ?? "").trim().toUpperCase();
    if (shift !== "AM" && shift !== "PM") return { ok: false, error: "Every planned doctor needs AM or PM." };
    const key = nativePlanItemKey(planDate, contactCrmId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ planDate, contactCrmId, shift });
  }
  return { ok: true, value: out };
}

/**
 * Whether one item fits THIS week for THIS rep. `listTypes` is the rep's open lists holding the
 * contact, as for a visit: a doctor off the rep's AM and PM lists cannot be planned.
 */
export function nativePlanItemRefusal(
  item: NativePlanItemDraft,
  context: { weekStart: string; listTypes: readonly string[] },
): string | null {
  if (!nativePlanWeekDays(context.weekStart).includes(item.planDate)) return "A planned doctor falls outside this week.";
  if (!nativePlanDayShifts(item.planDate).includes(item.shift)) return "Thursday is a morning only, so it takes AM doctors only.";
  return nativeVisitShiftRefusal({ contactCrmId: item.contactCrmId, shift: item.shift }, context.listTypes);
}

export function nativePlanDayLoadRefusal(items: readonly NativePlanItemDraft[]): string | null {
  const perDay = new Map<string, number>();
  for (const item of items) perDay.set(item.planDate, (perDay.get(item.planDate) ?? 0) + 1);
  for (const [day, count] of perDay) {
    if (count > NATIVE_PLAN_ITEMS_PER_DAY_MAX) {
      return `At most ${NATIVE_PLAN_ITEMS_PER_DAY_MAX} doctors can be planned for one day (${day}).`;
    }
  }
  return null;
}

export type NativePlanItemDiff<T extends NativePlanStoredItem> = {
  /** A doctor and day never planned before: a new row, a new id. */
  insert: NativePlanItemDraft[];
  /** Planned, and no longer wanted: the row is marked removed, never deleted. */
  remove: T[];
  /** Removed earlier and wanted again: the SAME row comes back, with the same id. */
  restore: Array<{ row: T; shift: NativeVisitShift }>;
  /** Still planned, on the other half-day: the same row, the same id. */
  reshift: Array<{ row: T; shift: NativeVisitShift }>;
  keep: T[];
};

/** What the rep now sends against what is stored, keyed by (doctor, day). */
export function diffNativePlanItems<T extends NativePlanStoredItem>(
  stored: readonly T[],
  wanted: readonly NativePlanItemDraft[],
): NativePlanItemDiff<T> {
  const storedByKey = new Map(stored.map((row) => [nativePlanItemKey(row.planDate, row.contactCrmId), row]));
  const wantedKeys = new Set(wanted.map((item) => nativePlanItemKey(item.planDate, item.contactCrmId)));
  const diff: NativePlanItemDiff<T> = { insert: [], remove: [], restore: [], reshift: [], keep: [] };
  for (const item of wanted) {
    const existing = storedByKey.get(nativePlanItemKey(item.planDate, item.contactCrmId));
    if (!existing) diff.insert.push(item);
    else if (existing.removed) diff.restore.push({ row: existing, shift: item.shift });
    else if (existing.shift !== item.shift) diff.reshift.push({ row: existing, shift: item.shift });
    else diff.keep.push(existing);
  }
  diff.remove = stored.filter((row) => !row.removed && !wantedKeys.has(nativePlanItemKey(row.planDate, row.contactCrmId)));
  return diff;
}

function changedDays(diff: NativePlanItemDiff<NativePlanStoredItem>): string[] {
  return [
    ...diff.insert.map((item) => item.planDate),
    ...diff.remove.map((row) => row.planDate),
    ...diff.restore.map((change) => change.row.planDate),
    ...diff.reshift.map((change) => change.row.planDate),
  ];
}

export function isNativePlanDiffEmpty(diff: NativePlanItemDiff<NativePlanStoredItem>): boolean {
  return changedDays(diff).length === 0;
}

/** A past day is fixed: nothing on it can be added, dropped, brought back or moved to the other half-day. */
export function nativePlanLockedDayRefusal(
  diff: NativePlanItemDiff<NativePlanStoredItem>,
  editableDays: readonly string[],
): string | null {
  const editable = new Set(editableDays);
  if (changedDays(diff).some((day) => !editable.has(day))) {
    return "A day that has passed, or a day not yet open for planning in Phoenix, cannot be changed.";
  }
  return null;
}

/** A doctor already visited that day stays on the plan: dropping him would hide a kept call. */
export function nativePlanVisitedRemovalRefusal(
  diff: NativePlanItemDiff<NativePlanStoredItem>,
  visitedKeys: ReadonlySet<string>,
): string | null {
  if (diff.remove.some((row) => visitedKeys.has(nativePlanItemKey(row.planDate, row.contactCrmId)))) {
    return "You already visited that doctor on that day, so the doctor stays on your plan.";
  }
  return null;
}

// ── Workflow ────────────────────────────────────────────────────────────────────────────────────

export function parseNativePlanAction(value: unknown): NativePlanAction | null {
  const action = String(value ?? "").trim().toLowerCase();
  return action === "save" || action === "submit" || action === "reopen" ? action : null;
}

/** What the rep may do to the rep's own plan in its current state. */
export function nativePlanRepActionRefusal(action: NativePlanAction, status: NativePlanStatus | null, itemCount: number): string | null {
  if (action === "reopen") {
    if (status === "submitted" || status === "verified") return null;
    return "Only a submitted or verified plan can be reopened for changes.";
  }
  if (status === "submitted") return "This plan is waiting for your manager. Reopen it to make changes.";
  if (status === "verified") return "Your manager verified this plan. Reopen it to make changes, and it goes back to your manager.";
  if (action === "submit" && itemCount === 0) return "Plan at least one doctor before submitting.";
  return null;
}

export function parseNativePlanDecision(value: unknown): NativePlanDecision | null {
  const decision = String(value ?? "").trim().toLowerCase();
  return decision === "verified" || decision === "returned" ? decision : null;
}

/**
 * Whether THIS viewer may decide THIS plan. Only the manager the plan was sent to — the rep's nearest
 * active manager when it was submitted — decides, only while it is submitted, only for a rep beneath
 * that manager. A return always says why. Nothing here, or anywhere, verifies on anyone's behalf.
 */
export function nativePlanDecisionRefusal(input: {
  verifierHrId: string | null;
  viewerHrId: string | null;
  status: NativePlanStatus;
  repInViewerScope: boolean;
  decision: NativePlanDecision;
  note: string | null;
}): string | null {
  const verifierKey = canonicalHrIdKey(input.verifierHrId);
  if (!verifierKey || verifierKey !== canonicalHrIdKey(input.viewerHrId)) {
    return "Only the manager this plan was sent to can verify or return it.";
  }
  if (input.status !== "submitted") return "This plan is not waiting for a decision.";
  if (!input.repInViewerScope) return "This rep is not in your team.";
  if (input.decision === "returned" && !(input.note ?? "").trim()) return "Say what the rep should change when you return a plan.";
  return null;
}

// ── Plan against visits ─────────────────────────────────────────────────────────────────────────

export type NativePlanItemOutcome = "visited" | "missed" | "due_today" | "upcoming";

/** An item is kept by a live native doctor visit to the same doctor on the same day. */
export function nativePlanItemOutcome(input: { planDate: string; cairoToday: string; visited: boolean }): NativePlanItemOutcome {
  if (input.visited) return "visited";
  if (input.planDate < input.cairoToday) return "missed";
  if (input.planDate === input.cairoToday) return "due_today";
  return "upcoming";
}
