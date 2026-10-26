// Private calendar: what a visit entry says INSIDE its day tile in the month grid.
//
// Owner, 2026-10-23: "in the calendar tile itself show the count of the AM and the count of PM and the count of
// pharmacies, and if it is a double or a single visit … the area. But the visit details, show it in the table down
// … regular or campaign, planned or unplanned … if double, show the medical rep, the brick … don't mention names
// [of pharmacies or customers]. When I press on the day, the details appear down."
//
// So the tile is a SUMMARY and never a list of customers: the kind (Single · Double · Chain), the category (Regular ·
// Campaign), whether the visits were on the plan, the three figures apart, who the visit was made with, and where.
// Every customer, address and per-visit card stays in the Daily Timeline table under the grid.
//
// Pure and client-safe — the grid imports it. It reads only structured fields of the item (`activityKind`,
// `visitCounts`, `managerVisits`, `tileWith`, `tileWithPeople`, `tileAreas`, `employeeAreaName`), never `chipLines`, which are text for the
// surfaces that print lines (an export, a dispute view).

import { visitCountBucketForListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { emptyVisitCountSplit, visitCountSplitTotal, type VisitCountSplit } from "@/lib/crm/visit-count-buckets";
import {
  isPrivateCalendarVisitKind,
  privateCalendarItemKind,
  type PrivateCalendarVisitCategory,
  type PrivateCalendarVisitCompanion,
} from "@/lib/private-calendar/activity-kinds";
import type { PrivateCalendarItem } from "@/lib/private-calendar/logic";

export type PrivateCalendarDayTile = {
  areas: string[];
  bricks: string[];
  category: PrivateCalendarVisitCategory;
  companion: PrivateCalendarVisitCompanion;
  /** Of the Phoenix CRM visits behind the entry, how many were on the plan. Null when no visit says (an iReports360 day). */
  plan: { planned: number; unplanned: number } | null;
  split: VisitCountSplit;
  total: number;
  /** The people the visits were made with (a double or chain visit's other side), by name, each once. */
  withNames: string[];
};

export const PRIVATE_CALENDAR_COMPANION_LABELS: Record<PrivateCalendarVisitCompanion, string> = {
  chain: "Chain",
  double: "Double",
  single: "Single",
};

export const PRIVATE_CALENDAR_CATEGORY_LABELS: Record<PrivateCalendarVisitCategory, string> = {
  campaign: "Campaign",
  regular: "Regular",
};

/** Each text once, in the order met, compared without case or stray spaces. */
function distinctTexts(values: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = String(value ?? "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/** One HR id key, hyphen- and case-insensitive ("B-110", "b110"). */
function personKey(hrId: string | null | undefined): string {
  return String(hrId ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Each person once. The loader's list (the visit mirror's spelling) and the Phoenix visits' own people (Phoenix's
 * nickname-aware name) name the SAME person differently — "Hana Abdelaziz Samir Abdelaziz" and "Hana Abdelaziz" —
 * so a text-only dedupe printed her twice (audit, 2026-10-26). People are matched on their HR id first; one name is
 * kept per person, and the Phoenix visit's name wins because it is the one every other screen prints. A name that
 * arrives with no HR id is still dropped when it is the same text as one already kept. Order is first met.
 */
export function distinctTilePeople(
  loaderPeople: ReadonlyArray<{ hrId: string | null; name: string }>,
  visitPeople: ReadonlyArray<{ hrId?: string | null; name: string }>,
): string[] {
  const kept: Array<{ key: string | null; name: string; fromVisit: boolean }> = [];
  const add = (hrId: string | null | undefined, rawName: string, fromVisit: boolean) => {
    const name = String(rawName ?? "").trim();
    if (!name) return;
    const key = personKey(hrId) || null;
    const sameText = (entry: { name: string }) => entry.name.toLowerCase() === name.toLowerCase();
    const existing = key ? kept.find((entry) => entry.key === key) : kept.find(sameText);
    if (existing) {
      if (fromVisit && !existing.fromVisit) {
        existing.name = name;
        existing.fromVisit = true;
      }
      return;
    }
    const twin = kept.find(sameText);
    if (twin) {
      // The same text met first without an id: it is this person, so it takes the id for anyone after.
      if (key && !twin.key) twin.key = key;
      return;
    }
    kept.push({ key, name, fromVisit });
  };
  for (const person of loaderPeople) add(person.hrId, person.name, false);
  for (const person of visitPeople) add(person.hrId, person.name, true);
  // A rename can leave two kept entries reading the same; print each text once.
  return distinctTexts(kept.map((entry) => entry.name));
}

/** The split an entry carries, else the one its Phoenix visits add up to (their `bucket` is the AM · PM · Pharmacy list). */
function splitOf(item: PrivateCalendarItem): VisitCountSplit | null {
  if (item.visitCounts) return item.visitCounts;
  const visits = item.managerVisits ?? [];
  if (visits.length === 0) return null;
  const split = emptyVisitCountSplit();
  for (const visit of visits) {
    // A visit to a customer not validated yet counts in no figure, as on the rep's own row.
    if (visit.awaitingValidation) continue;
    // By the customer's list through the golden rule's helper, so a pharmacy is never filed among the doctors — his own
    // visit too; only a customer of his own list, which carries no list, falls back to the half it was planned in.
    const bucket = visit.listType === null ? (visit.bucket === "Pharmacy" ? "Pharmacies" : visit.bucket) : visitCountBucketForListType(visit.listType);
    if (bucket === "AM") split.am += 1;
    else if (bucket === "PM") split.pm += 1;
    else split.pharmacies += 1;
  }
  return split;
}

/**
 * The tile of a visit entry, or null for every other entry (attendance, vacation, an excuse, a holiday, other CRM
 * activity) — those keep their own short chip, which never held a customer.
 */
export function privateCalendarDayTile(item: PrivateCalendarItem): PrivateCalendarDayTile | null {
  const kind = privateCalendarItemKind(item);
  if (!isPrivateCalendarVisitKind(kind)) return null;
  const split = splitOf(item);
  if (!split) return null;
  const [companion, category] = kind.split("_") as [PrivateCalendarVisitCompanion, PrivateCalendarVisitCategory];
  const visits = item.managerVisits ?? [];

  // Where: the visits' own brick and area win, then what the loader knew of the entry, then the employee's own area.
  const visitAreas = distinctTexts(visits.map((visit) => visit.areaName));
  const areas = visitAreas.length > 0
    ? visitAreas
    : distinctTexts(item.tileAreas && item.tileAreas.length > 0 ? item.tileAreas : [item.employeeAreaName]);

  // Who: the loader's list (a double visit's other side), plus the people on each Phoenix visit beside the person —
  // each PERSON once, by HR id (distinctTilePeople).
  const withNames = distinctTilePeople(
    item.tileWithPeople ?? (item.tileWith ?? []).map((name) => ({ hrId: null, name })),
    visits.flatMap((visit) => visit.withPeople),
  );

  const planned = visits.filter((visit) => visit.planned).length;
  return {
    areas,
    bricks: distinctTexts(visits.map((visit) => visit.brickName)),
    category,
    companion,
    plan: visits.length > 0 ? { planned, unplanned: visits.length - planned } : null,
    split,
    total: visitCountSplitTotal(split),
    withNames,
  };
}

/** "Planned", "Unplanned" or "2 planned · 1 unplanned" — null when no Phoenix visit says. */
export function privateCalendarPlanText(plan: PrivateCalendarDayTile["plan"]): string | null {
  if (!plan) return null;
  if (plan.planned > 0 && plan.unplanned === 0) return "Planned";
  if (plan.unplanned > 0 && plan.planned === 0) return "Unplanned";
  if (plan.planned === 0 && plan.unplanned === 0) return null;
  return `${plan.planned} planned · ${plan.unplanned} unplanned`;
}
