// Private calendar: one person's day as ONE Plan | Actual table.
//
// Owner, 2026-10-29, on Ahmed Sharaf's October: "put in a table, put each point beside the point". The approved plan
// used to come as its own cards beside the day's records — 27 Oct read an attendance card and then two separate
// APPROVED PLAN cards, AM Office and PM Office — so the reader matched them up by eye. Here each planned half-day sits
// on one row with what was recorded for it and a ✓ or ✗, and whatever was recorded that no plan entry asked for gets a
// row of its own, "Not on the plan".
//
// 🔴 A DISPLAY COMPARISON ONLY. A plan never excuses a day and never clears a deduction (owner, 2026-10-12, see
// plan-items.ts); nothing here feeds coverage, the exceptions engine or a KPI.
//
// What proves what, per half (PrivateCalendarPlanActivity):
//   · visit  ↔ the day's visit entry: AM by its AM figure, PM by its PM and PH figures, a whole day by any. A plan that
//              names who to go with matches only a visit made with that person; with someone else it is ✗.
//   · office ↔ an office punch.
//   · leave  ↔ a vacation, an excuse or a national holiday.
//   · travel ↔ an outstation trip. On a field day the trip is that day's travel and sits in the visit row it served.
//   · other  ↔ a CRM activity or a verified correction, else an office punch (a meeting or training in the building).
//
// Pure and client-safe — the day panel imports it. It reads structured fields only (`planActivity`, the visit tile),
// never a title.

import type { VisitCountSplit } from "@/lib/crm/visit-count-buckets";
import { isPrivateCalendarVisitKind, privateCalendarItemKind, type PrivateCalendarActivityKind } from "@/lib/private-calendar/activity-kinds";
import { PRIVATE_CALENDAR_TILE_FIGURE_LABELS, privateCalendarDayTile, privateCalendarTileHeadline, type PrivateCalendarDayTile } from "@/lib/private-calendar/day-tile";
import type { PrivateCalendarItem, PrivateCalendarPlanActivity } from "@/lib/private-calendar/logic";

export type DayPlanActualHalf = PrivateCalendarPlanActivity["half"];

export type DayPlanActualRow = {
  /** What was recorded for this half, each line said once. Empty when nothing was. */
  actual: string[];
  half: DayPlanActualHalf;
  key: string;
  /** `match` ✓, `miss` ✗, `unplanned` — recorded, but no plan entry asked for it (neutral, never a ✗). */
  match: "match" | "miss" | "unplanned";
  /** Why a ✗ is a ✗: "Nothing recorded", "No office punch", "Not with Hassan Mohamed". Null otherwise. */
  note: string | null;
  plan: PrivateCalendarPlanActivity | null;
};

export const DAY_PLAN_ACTUAL_NOT_ON_PLAN = "Not on the plan";
export const DAY_PLAN_ACTUAL_NOTHING_RECORDED = "Nothing recorded";

const HALF_ORDER: Record<DayPlanActualHalf, number> = { "Full day": 0, AM: 1, PM: 2 };

/** A plan item's activity, or the plain fallback for one built before the field existed. */
export function planActivityOf(item: PrivateCalendarItem): PrivateCalendarPlanActivity {
  return item.planActivity ?? { half: "Full day", label: item.title, place: null, signedOffBy: null, type: "other", withName: null };
}

/** Name tokens, lower-case — "Hana  Abdelaziz" and "hana abdelaziz" are one. */
function nameTokens(name: string): string[] {
  return name.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * The same person under two spellings: one name is the start of the other. The plan names a rep the way Phoenix does
 * ("Hana Abdelaziz") and an iReports360 day by their full name ("Hana Abdelaziz Samir Abdelaziz").
 */
export function samePersonName(left: string, right: string): boolean {
  const a = nameTokens(left);
  const b = nameTokens(right);
  if (a.length === 0 || b.length === 0) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.every((token, index) => long[index] === token);
}

function halfFigures(split: VisitCountSplit, half: DayPlanActualHalf): number {
  if (half === "AM") return split.am;
  if (half === "PM") return split.pm + split.pharmacies;
  return split.am + split.pm + split.pharmacies;
}

function halfCountsText(split: VisitCountSplit, half: DayPlanActualHalf): string {
  const keys = half === "AM" ? (["am"] as const) : half === "PM" ? (["pm", "pharmacies"] as const) : (["am", "pm", "pharmacies"] as const);
  return keys.map((key) => `${PRIVATE_CALENDAR_TILE_FIGURE_LABELS[key]} ${split[key]}`).join(" · ");
}

/** "Double visit with Hassan Mohamed · AM 1" — the visit entry's share of one half. */
function visitText(tile: PrivateCalendarDayTile, half: DayPlanActualHalf): string {
  return `${privateCalendarTileHeadline(tile)} · ${halfCountsText(tile.split, half)}`;
}

/** What a recorded entry says in the Actual cell: its month-grid lines, joined — the words the tile already shows. */
function recordedText(item: PrivateCalendarItem): string {
  const lines = (item.chipLines && item.chipLines.length > 0 ? item.chipLines : [item.title]).map((line) => line.trim()).filter(Boolean);
  return lines.join(" · ");
}

/** The half a recorded entry belongs to when no plan claims it: a half-day leave or excuse by its own words, else the day. */
function recordedHalf(item: PrivateCalendarItem): DayPlanActualHalf {
  const time = String(item.time ?? "").trim();
  if (/^AM\b/i.test(time)) return "AM";
  if (/^PM\b/i.test(time)) return "PM";
  return "Full day";
}

function hasOfficePunch(item: PrivateCalendarItem): boolean {
  return privateCalendarItemKind(item) === "attendance" && /^Office\b/.test(item.chipLines?.[0] ?? item.title);
}

const LEAVE_KINDS = new Set<PrivateCalendarActivityKind>(["vacation", "excuse", "holiday"]);

type VisitEntry = { claimed: Set<DayPlanActualHalf>; item: PrivateCalendarItem; tile: PrivateCalendarDayTile };

/**
 * The day's plan entries beside what was recorded, for ONE person on ONE day. `planItems` are that day's `plan` items;
 * `actualItems` every other entry of the day. Rows run Full day, AM, PM; within a half the planned row comes first.
 */
export function buildDayPlanActual(planItems: readonly PrivateCalendarItem[], actualItems: readonly PrivateCalendarItem[]): DayPlanActualRow[] {
  const visits: VisitEntry[] = [];
  const others: PrivateCalendarItem[] = [];
  for (const item of actualItems) {
    const kind = privateCalendarItemKind(item);
    if (kind === "plan") continue;
    const tile = isPrivateCalendarVisitKind(kind) ? privateCalendarDayTile(item) : null;
    if (tile) visits.push({ claimed: new Set(), item, tile });
    else others.push(item);
  }
  const claimedOthers = new Set<string>();
  const rows: DayPlanActualRow[] = [];

  for (const planItem of planItems) {
    const plan = planActivityOf(planItem);
    const row: DayPlanActualRow = { actual: [], half: plan.half, key: planItem.id, match: "miss", note: DAY_PLAN_ACTUAL_NOTHING_RECORDED, plan };

    if (plan.type === "visit") {
      const inHalf = visits.filter((entry) => halfFigures(entry.tile.split, plan.half) > 0);
      const withThem = plan.withName
        ? inHalf.filter((entry) => entry.tile.withNames.some((name) => samePersonName(name, plan.withName as string)))
        : inHalf;
      const shown = withThem.length > 0 ? withThem : inHalf;
      for (const entry of shown) entry.claimed.add(plan.half);
      row.actual = shown.map((entry) => visitText(entry.tile, plan.half));
      if (withThem.length > 0) {
        row.match = "match";
        row.note = null;
      } else if (shown.length > 0) {
        row.note = `Not with ${plan.withName}`;
      }
    } else {
      const fits = (item: PrivateCalendarItem) => {
        const kind = privateCalendarItemKind(item);
        if (plan.type === "office") return kind === "attendance";
        if (plan.type === "leave") return LEAVE_KINDS.has(kind);
        if (plan.type === "travel") return kind === "outstation";
        return kind === "other_crm" || kind === "correction";
      };
      let found = others.filter(fits);
      // A meeting or a training held in the building leaves an office punch and nothing else.
      if (found.length === 0 && plan.type === "other") found = others.filter(hasOfficePunch);
      for (const item of found) claimedOthers.add(item.id);
      row.actual = found.map(recordedText);
      if (plan.type === "office" && found.length > 0 && !found.some(hasOfficePunch)) {
        row.note = "No office punch";
      } else if (found.length > 0) {
        row.match = "match";
        row.note = null;
      }
    }
    rows.push(row);
  }

  // An outstation trip on a field day is that field day's travel: it sits in the visit row it served, never as a "Not on
  // the plan" row of its own (28 Oct on production: "With Hassan Mohamed" in Mahalla, and the Mahalla trip claim).
  const fieldRow = rows.find((row) => row.plan?.type === "visit" && row.match === "match")
    ?? rows.find((row) => row.plan?.type === "visit" && row.actual.length > 0);
  if (fieldRow) {
    for (const item of others) {
      if (claimedOthers.has(item.id) || privateCalendarItemKind(item) !== "outstation") continue;
      claimedOthers.add(item.id);
      fieldRow.actual.push(recordedText(item));
    }
  }

  // What was recorded that no plan entry asked for — the whole of an unclaimed entry, or the half of a visit entry the
  // plan did not reach (a planned AM with a rep, then six PM visits beside an Office afternoon).
  for (const entry of visits) {
    const { claimed, item, tile } = entry;
    const halves: DayPlanActualHalf[] =
      claimed.size === 0 ? ["Full day"]
        : claimed.has("Full day") || (claimed.has("AM") && claimed.has("PM")) ? []
          : claimed.has("AM") ? ["PM"] : ["AM"];
    for (const half of halves) {
      if (halfFigures(tile.split, half) === 0 && claimed.size > 0) continue;
      rows.push({ actual: [visitText(tile, half)], half, key: `${item.id}:${half}`, match: "unplanned", note: null, plan: null });
    }
  }
  for (const item of others) {
    if (claimedOthers.has(item.id)) continue;
    rows.push({ actual: [recordedText(item)], half: recordedHalf(item), key: item.id, match: "unplanned", note: null, plan: null });
  }

  return rows
    .map((row, index) => ({ index, row }))
    .sort((left, right) =>
      HALF_ORDER[left.row.half] - HALF_ORDER[right.row.half]
      || Number(left.row.plan === null) - Number(right.row.plan === null)
      || left.index - right.index)
    .map(({ row }) => row);
}
