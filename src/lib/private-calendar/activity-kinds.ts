// The Private Calendar's colour key (owner, 2026-09-21): every CRM visit is coloured by WHO went —
// single (alone), double (with a manager) or chain (with a manager and a senior manager). Three visit
// colours, beside the non-visit sources (attendance, vacation, excuse, national holiday) and "Other CRM
// activity" (meetings, training, admin work and the rest). Every visit count is AM · PM · Pharmacies
// apart — see src/lib/crm/visit-count-buckets.ts, THE golden-rule helper.
//
// 🔴 PHOENIX WORDS, NEVER THE VENDOR'S (owner, 2026-10-29: "what is double regular, double campaign? … write
// double visit with Hana Abdelaziz"). Regular and campaign are iReports360's visit types ("Regular Visit",
// "Campaign (Prospection)"); Phoenix CRM calls a visit Single, Double or Chain, planned or unplanned. So the kind
// is WHO went and nothing else, named as Phoenix CRM names it (PHOENIX_VISIT_KIND_LABELS), and a campaign visit
// joins its day's entry instead of making a second one beside it. The ids keep their `_regular` ending so a saved
// filter or link still resolves. Regular/campaign survives only inside the chain pairing below, where it is a
// matching key, never a word on screen.
//
// Pure: no database, so the pairing below is unit-tested on plain rows.

import { hasSecondDoubleVisitor } from "@/lib/double-visit-analytics/chain-visitors";
import { normalizeHrIdForAccess } from "@/lib/hr-id";
import {
  addBucketToSplit,
  emptyVisitCountSplit,
  mergeVisitCountSplits,
  visitCountBucket,
  type VisitCountBucket,
  type VisitCountSplit,
} from "@/lib/crm/visit-count-buckets";
import { CAMPAIGN_TYPE, REGULAR_TYPE, UNLABELED_FIELD_VISIT_TYPE } from "@/lib/crm/visit-types";
import { PHOENIX_VISIT_KIND_LABELS } from "@/lib/phoenix-crm/visit-kind-labels";
import type { PrivateCalendarItem, PrivateCalendarSource } from "@/lib/private-calendar/logic";

export type PrivateCalendarVisitCompanion = "single" | "double" | "chain";
export type PrivateCalendarVisitCategory = "regular" | "campaign";
/** Who went. The `_regular` ending is a legacy of the retired regular/campaign split, kept so stored ids resolve. */
export type PrivateCalendarVisitKind = `${PrivateCalendarVisitCompanion}_regular`;
export type PrivateCalendarActivityKind =
  | Exclude<PrivateCalendarSource, "double_visit" | "field_visit">
  | PrivateCalendarVisitKind
  | "other_crm";

export const privateCalendarVisitKinds = [
  "single_regular",
  "double_regular",
  "chain_regular",
] as const satisfies readonly PrivateCalendarVisitKind[];

export const privateCalendarActivityKinds = [
  "attendance",
  "vacation",
  "excuse",
  "holiday",
  "plan",
  ...privateCalendarVisitKinds,
  "other_crm",
  "outstation",
  "interview",
  "correction",
] as const satisfies readonly PrivateCalendarActivityKind[];

export const privateCalendarActivityKindLabels: Record<PrivateCalendarActivityKind, string> = {
  attendance: "Attendance",
  vacation: "Vacation",
  excuse: "Excuse",
  holiday: "National holiday",
  plan: "Approved plan",
  single_regular: PHOENIX_VISIT_KIND_LABELS.single,
  double_regular: PHOENIX_VISIT_KIND_LABELS.double,
  chain_regular: PHOENIX_VISIT_KIND_LABELS.chain,
  other_crm: "Other CRM activity",
  outstation: "Outstation trip",
  interview: "Interview",
  correction: "Admin-verified correction",
};

export function isPrivateCalendarVisitKind(kind: PrivateCalendarActivityKind): kind is PrivateCalendarVisitKind {
  return (privateCalendarVisitKinds as readonly string[]).includes(kind);
}

/** The kind of a visit: who went, and nothing else (see the header — regular or campaign is not a kind). */
export function privateCalendarVisitKind(companion: PrivateCalendarVisitCompanion): PrivateCalendarVisitKind {
  return `${companion}_regular`;
}

/** The companion a visit kind names: "single", "double" or "chain". */
export function privateCalendarVisitCompanion(kind: PrivateCalendarVisitKind): PrivateCalendarVisitCompanion {
  return kind.slice(0, kind.indexOf("_")) as PrivateCalendarVisitCompanion;
}

/** Regular for a regular call (0) and for the unlabelled field visit (-30), which the CRM domain
 * counts "in its normal place" as a regular visit; campaign for -8; null for everything else.
 * Read as "is this row a customer visit at all" and as the chain pairing's key — never printed. */
export function visitCategoryOfType(visitType: number | null | undefined): PrivateCalendarVisitCategory | null {
  if (visitType === CAMPAIGN_TYPE) return "campaign";
  if (visitType === REGULAR_TYPE || visitType === UNLABELED_FIELD_VISIT_TYPE) return "regular";
  return null;
}

/** The colour an item wears. Items built before the kinds existed fall back by source. */
export function privateCalendarItemKind(item: Pick<PrivateCalendarItem, "activityKind" | "source">): PrivateCalendarActivityKind {
  if (item.activityKind) return item.activityKind;
  if (item.source === "double_visit") return "double_regular";
  if (item.source === "field_visit") return "single_regular";
  return item.source;
}

/**
 * One physical visit behind a double or chain item, and the bucket it counts in. `phoenix` marks a
 * Phoenix CRM visit, which logs no pharmacy — so a summary of them says its pharmacy figure was never
 * recorded rather than printing a zero (src/lib/crm/visit-count-buckets.ts).
 */
export type PrivateCalendarVisitRecord = { bucket: VisitCountBucket; id: string; phoenix?: boolean };

export type PrivateCalendarVisitSummary = Record<PrivateCalendarVisitKind, VisitCountSplit> & { all: VisitCountSplit };

export function emptyPrivateCalendarVisitSummary(): PrivateCalendarVisitSummary {
  return {
    all: emptyVisitCountSplit(),
    chain_regular: emptyVisitCountSplit(),
    double_regular: emptyVisitCountSplit(),
    single_regular: emptyVisitCountSplit(),
  };
}

/**
 * The visits on these items, AM · PM · Pharmacies apart, per kind and in all. A double or chain
 * visit sits on the calendar of EVERY person on it — the rep's "received", each manager's
 * "performed" — so its items carry the physical visit's record id and it is counted ONCE here
 * however many of those people the view holds. A single visit belongs to one person only and
 * carries its counts directly.
 */
export function summarizePrivateCalendarVisits(
  items: Array<Pick<PrivateCalendarItem, "activityKind" | "source" | "visitCounts" | "visitRecords">>,
): PrivateCalendarVisitSummary {
  const summary = emptyPrivateCalendarVisitSummary();
  const seen = new Set<string>();
  for (const item of items) {
    const kind = privateCalendarItemKind(item);
    if (!isPrivateCalendarVisitKind(kind)) continue;
    if (item.visitRecords && item.visitRecords.length > 0) {
      for (const record of item.visitRecords) {
        if (seen.has(record.id)) continue;
        seen.add(record.id);
        addBucketToSplit(summary[kind], record.bucket, 1, record.phoenix === true);
        addBucketToSplit(summary.all, record.bucket, 1, record.phoenix === true);
      }
    } else if (item.visitCounts) {
      mergeVisitCountSplits(summary[kind], item.visitCounts);
      mergeVisitCountSplits(summary.all, item.visitCounts);
    }
  }
  return summary;
}

// ── Double and chain visits ────────────────────────────────────────────────────────────────────
//
// iReports360 keeps ONE partner per visit row, so a chain visit — a rep, their manager and a
// senior manager at one customer — lands as two rows on the same day: the rep's row naming the
// manager, and the manager's row naming the senior manager. resolveDoubleVisitChains (double-visit
// analytics) re-attributes that second row to the rep and flags it `resolved_via_chain`. Left like
// that, the rep's calendar counts every chain stop twice (once per row) and calls half of them a
// plain double visit. Pairing the two halves makes the stop ONE chain visit for everyone on it.
//
// The halves are paired by COUNT inside (day, rep, manager, regular/campaign, bucket) — not by
// customer: measured 2026-08-01 to 2026-09-20, only 74 of 112 senior rows share a contact id with
// the rep's row (campaign rows all share one vendor sentinel contact), while the resolver has
// already proved both halves are the same outing. A senior row with no rep row to pair keeps its
// own record and still counts once, as a chain visit.

export type PairableDoubleVisitRow = {
  activity_date: string;
  chain_hinge_hr_id?: string | null;
  chain_hinge_name?: string | null;
  double_visitor_hr_id: string | null;
  double_visitor_name: string | null;
  /** A Phoenix CRM chain visit's second manager, on the SAME row (chain-visitors.ts). */
  double_visitor2_hr_id?: string | null;
  double_visitor2_name?: string | null;
  /** A Phoenix CRM visit (a started team's), which logs no pharmacy — see visit-count-buckets.ts. */
  from_phoenix?: boolean;
  id: string;
  period: "AM" | "PM" | "UNKNOWN";
  resolved_via_chain?: boolean;
  speciality?: string | null;
  visit_type: number | null;
  visited_employee_hr_id: string | null;
  visited_employee_name: string | null;
};

export type ClassifiedDoubleVisitRow<T extends PairableDoubleVisitRow> = {
  /** A senior manager's half folded into the rep's row: it counts through that row, never again. */
  absorbed: boolean;
  bucket: VisitCountBucket;
  category: PrivateCalendarVisitCategory;
  companion: "double" | "chain";
  /** The physical visit this row stands for — the rep's row id once the halves are paired. */
  physicalId: string;
  row: T;
  /** On the rep's row of a paired chain: the senior manager who joined. */
  seniorName: string | null;
  /** That senior manager's HR id, where the row carries it. */
  seniorHrId?: string | null;
};

function hrKey(value: string | null | undefined) {
  return normalizeHrIdForAccess(value) ?? "";
}

export function classifyDoubleVisitRows<T extends PairableDoubleVisitRow>(rows: T[]): Array<ClassifiedDoubleVisitRow<T>> {
  const classified = rows.map((row): ClassifiedDoubleVisitRow<T> => ({
    absorbed: false,
    bucket: visitCountBucket({ ampm: row.period === "UNKNOWN" ? null : row.period, speciality: row.speciality }),
    category: visitCategoryOfType(row.visit_type) ?? "regular",
    // A Phoenix CRM chain visit is ONE row carrying both managers, so it is a chain on its own — no
    // halves to pair — and the second manager is named exactly where a vendor chain names its senior.
    companion: row.resolved_via_chain || hasSecondDoubleVisitor(row) ? "chain" : "double",
    physicalId: row.id,
    row,
    seniorName: row.double_visitor2_name ?? null,
    seniorHrId: row.double_visitor2_hr_id ?? null,
  }));

  const exact = new Map<string, number[]>();
  const loose = new Map<string, number[]>();
  classified.forEach((entry, index) => {
    if (entry.row.resolved_via_chain) return;
    const base = `${entry.row.activity_date}|${hrKey(entry.row.visited_employee_hr_id)}|${hrKey(entry.row.double_visitor_hr_id)}|${entry.category}`;
    exact.set(`${base}|${entry.bucket}`, [...(exact.get(`${base}|${entry.bucket}`) ?? []), index]);
    loose.set(base, [...(loose.get(base) ?? []), index]);
  });

  const claimed = new Set<number>();
  const claim = (candidates: number[] | undefined) => candidates?.find((index) => !claimed.has(index));
  classified.forEach((entry) => {
    if (!entry.row.resolved_via_chain) return;
    const hinge = hrKey(entry.row.chain_hinge_hr_id);
    if (!hinge) return;
    const base = `${entry.row.activity_date}|${hrKey(entry.row.visited_employee_hr_id)}|${hinge}|${entry.category}`;
    const partner = claim(exact.get(`${base}|${entry.bucket}`)) ?? claim(loose.get(base));
    if (partner === undefined) return;
    claimed.add(partner);
    const repRow = classified[partner];
    repRow.companion = "chain";
    repRow.seniorName = entry.row.double_visitor_name;
    repRow.seniorHrId = entry.row.double_visitor_hr_id;
    entry.absorbed = true;
    entry.physicalId = repRow.physicalId;
    entry.bucket = repRow.bucket;
  });
  return classified;
}

/** The people who went with the calendar owner, for a double or chain item's "With …" line. */
export function doubleVisitCompanions<T extends PairableDoubleVisitRow>(
  entry: ClassifiedDoubleVisitRow<T>,
  side: "performed" | "received",
): Array<string | null> {
  return doubleVisitCompanionPeople(entry, side).map((person) => person.name);
}

/** The same people as `doubleVisitCompanions`, each with the HR id the row carries for them — the day tile dedupes on it. */
export function doubleVisitCompanionPeople<T extends PairableDoubleVisitRow>(
  entry: ClassifiedDoubleVisitRow<T>,
  side: "performed" | "received",
): Array<{ hrId: string | null; name: string | null }> {
  const { row } = entry;
  const rep = { hrId: row.visited_employee_hr_id, name: row.visited_employee_name };
  const visitor = { hrId: row.double_visitor_hr_id, name: row.double_visitor_name };
  const hinge = { hrId: row.chain_hinge_hr_id ?? null, name: row.chain_hinge_name ?? null };
  const senior = { hrId: entry.seniorHrId ?? null, name: entry.seniorName };
  if (side === "performed") {
    if (entry.companion === "double") return [rep];
    // The senior manager's own row: the rep, and the manager in between.
    if (row.resolved_via_chain) return [rep, hinge];
    // The manager's row of a paired chain: the rep, and the senior manager who joined.
    return [rep, senior];
  }
  if (entry.companion === "double") return [visitor];
  // An unpaired senior row reaches the rep with the manager in between.
  if (row.resolved_via_chain) return [visitor, hinge];
  return [visitor, senior];
}
