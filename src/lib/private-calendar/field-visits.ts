// Private calendar: a rep's OWN CRM field visits as a coverage source.
//
// Why this exists: derivePrivateCalendarExceptions treats a CRM Double Visit as
// self-proving attendance ("no fingerprint needed"), but only the double-visit
// feed was ever wired in. A solo visit proves the same thing — the rep was out
// doing field work — and field reps are not enrolled on fingerprint devices at
// all (see attendance-cross-check.ts), so CRM is their ONLY possible proof.
//
// Measured on July 2026 production data before this existed: of 1,992 rep-days
// carrying real logged visits, 1,709 were solo-only, and 1,700 of those had no
// punch, no approved leave and no double visit — 15,429 genuine customer visits
// across 101 employees, every one reading as "No Activity Recorded".
//
// Read-only. Never mutates CRM, attendance or deduction data.

import { mergeDayMapVisitPages } from "@/lib/attendance/crm-day-maps";
import { collapseDuplicateVisitSubmissions, CRM_DOUBLE_VISIT_TYPE_CODES, queryVisits, scanVisitsForRange } from "@/lib/crm/reads.ts";
import { addVisitToSplit, emptyVisitCountSplit, visitCountBucket, type VisitCountSplit } from "@/lib/crm/visit-count-buckets";
import { CRM_VISITS_UNIFIED_VIEW } from "@/lib/crm/tables";
import { CRM_LEAVE_VISIT_TYPE_CODES } from "@/lib/crm/visit-type-meaning";
import { resolveVisitTypeLabel } from "@/lib/crm/visit-types";
import { hrIdLookupKeys } from "@/lib/hr-id";
import {
  privateCalendarActivityKindLabels,
  privateCalendarVisitKind,
  visitCategoryOfType,
  type PrivateCalendarActivityKind,
} from "@/lib/private-calendar/activity-kinds";
import { privateCalendarTileCountsText } from "@/lib/private-calendar/day-tile";
import type { PrivateCalendarItem } from "@/lib/private-calendar/logic";

// `contact_name`, never `customer_name`: the mirror leaves customer_name empty on 100% of rows
// (0 of 75,682 populated over the last 120 days in production), which is what made every chip read
// "Unnamed customers". contact_name is populated on 55,610 of the 55,630 regular visits (type 0) and
// is blank by construction on every other type, where the contact id is a shared vendor sentinel and
// the real identity only exists in free-text `comment` — parsing that would repeat the mistake the
// duplicate-collapse comment rule already cost us (see crm/reads.ts), so unnamed days show a count.
export type FieldVisitRow = {
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  agent_name: string | null;
  ampm: string | null;
  comment: string | null;
  contact_crm_id: number | null;
  contact_name: string | null;
  crm_save_date: string | null;
  crm_visit_id: number | null;
  double_crm_id: number | null;
  double_hr_id: string | null;
  double_name: string | null;
  /** The chain visit's SECOND manager's name. Nothing decides a KIND from it — `hasRealPartner`
   * already answers true off slot 1, which slot 2 can never be filled without. */
  double2_name: string | null;
  source: string | null;
  speciality: string | null;
  visit_date: string | null;
  visit_type: number | null;
  visit_type_description: string | null;
};

function normalizedKey(value: string | null | undefined): string | null {
  const keys = hrIdLookupKeys(String(value ?? ""));
  return keys.length > 0 ? keys[0] : null;
}

/** The CRM's canonical double-visit test (see the `doubleOnly` predicate in crm/reads.ts): a real
 * partner crm id — not the vendor's `0` sentinel — or, on a Phoenix native row, a partner hr id. */
function hasRealPartner(row: Pick<FieldVisitRow, "double_crm_id" | "double_hr_id" | "source">): boolean {
  if (row.source === "phoenix" && row.double_hr_id) return true;
  return row.double_crm_id !== null && row.double_crm_id !== undefined && Number(row.double_crm_id) !== 0;
}

/** The Double Visit feed's own visit types — a partnered visit of
 * these types is shown by that feed, never here. */
const DOUBLE_VISIT_FEED_TYPES: ReadonlySet<number> = new Set<number>(CRM_DOUBLE_VISIT_TYPE_CODES);

/**
 * Which colour a CRM row wears on this calendar, or null when the Double Visit feed shows it.
 *
 * A partnered regular or campaign visit is the Double Visit feed's (it sits on the manager's
 * calendar AND the rep's, paired into a chain when a senior manager joined), so it is never
 * counted here as well. Everything else the rep logged is theirs alone: a single visit, a
 * partnered -30 field visit the Double Visit feed does not read, a CRM leave day, or any other
 * CRM activity (meetings, training, admin work, a public holiday worked in the field).
 */
export function fieldVisitActivityKind(
  row: Pick<FieldVisitRow, "double_crm_id" | "double_hr_id" | "source" | "visit_type">,
): PrivateCalendarActivityKind | null {
  const type = row.visit_type ?? null;
  const partnered = hasRealPartner(row);
  if (partnered && type !== null && DOUBLE_VISIT_FEED_TYPES.has(type)) return null;
  if (type !== null && CRM_LEAVE_VISIT_TYPE_CODES.has(type)) return "vacation";
  if (!visitCategoryOfType(type)) return "other_crm";
  return privateCalendarVisitKind(partnered ? "double" : "single");
}

type FieldVisitGroup = {
  activities: Map<string, number>;
  /** One line per customer visited, in the order the rows came: "AM · Dr X · ENT". Never shortened to "+N more". */
  customers: Set<string>;
  date: string;
  hrId: string;
  kind: PrivateCalendarActivityKind;
  name: string | null;
  partners: Set<string>;
  split: VisitCountSplit;
};

function countedList(counts: Map<string, number>): string {
  return [...counts.entries()].map(([label, count]) => `${label} ${count}`).join(" · ");
}

const FIELD_VISIT_COLUMNS =
  "visit_date,agent_hr_id,agent_name,agent_crm_id,contact_name,contact_crm_id,crm_visit_id,crm_save_date,double_crm_id,double_hr_id,double_name,double2_name,source,visit_type,visit_type_description,ampm,speciality,comment";

/** Above this many employees one company-wide window scan is cheaper than reading each person's own
 * visits by index — the attendance day maps' bound (DAY_MAP_PUSHDOWN_MAX_IDS in
 * attendance/crm-day-maps.ts), for the same reason. One employee's calendar and a district's team sit
 * far below it; the whole-roster No Activity engine sits far above it and keeps the scan. */
const FIELD_VISIT_PUSHDOWN_MAX_IDS = 40;

/** A directory CRM account as the id the visits carry: digits only, never the vendor's `0`
 * "no partner" sentinel — which, as a participant id, would match every solo visit in the company. */
function positiveCrmId(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * The visit rows the grouping below reads, before the duplicate collapse.
 *
 * READ BY PERSON, NOT BY COMPANY (2026-10-01, "slow to transfer between page and page"): for a
 * bounded set of employees it asks the CRM door for the visits they took part in — by HR id in any
 * casing, or by CRM account, as agent or double — instead of scanning every visit the company logged
 * in the window and discarding nearly all of it. That is a SUPERSET of the rows the grouping keeps
 * (its own filter, on the rep's hr id, stays the authority), and it keeps every duplicate group
 * WHOLE: the collapse picks one survivor among the rows of one CRM account, contact, day and type, so
 * a group read in part could pick differently. Any CRM account on a kept row that was not already
 * asked for is therefore read in full as well, and the pages are merged back into id order — the
 * order the window scan returns — so the collapse and every chip see the rows they always saw, in the
 * same order.
 */
async function readFieldVisitRows(input: {
  employeeCrmIds: ReadonlyArray<string | number | null | undefined>;
  employeeHrIds: string[];
  end: string;
  selected: ReadonlySet<string>;
  start: string;
}): Promise<FieldVisitRow[]> {
  if (input.selected.size > FIELD_VISIT_PUSHDOWN_MAX_IDS) {
    return scanVisitsForRange<FieldVisitRow>({ dateFrom: input.start, dateTo: input.end, columns: FIELD_VISIT_COLUMNS });
  }
  type KeyedFieldVisitRow = FieldVisitRow & { id: string };
  const crmIds = [...new Set(input.employeeCrmIds.map(positiveCrmId).filter((id): id is number => id !== null))];
  const rows = await queryVisits<KeyedFieldVisitRow>({
    columns: FIELD_VISIT_COLUMNS,
    dateFrom: input.start,
    dateTo: input.end,
    participantHrIds: input.employeeHrIds,
    ...(crmIds.length > 0 ? { participantCrmIds: crmIds } : {}),
  });
  const asked = new Set(crmIds);
  const groupAccounts = new Set<number>();
  for (const row of rows) {
    const hrKey = normalizedKey(row.agent_hr_id);
    if (!hrKey || !input.selected.has(hrKey)) continue;
    if (typeof row.agent_crm_id === "number" && !asked.has(row.agent_crm_id)) groupAccounts.add(row.agent_crm_id);
  }
  if (groupAccounts.size === 0) return rows;
  const groupMates = await queryVisits<KeyedFieldVisitRow>({
    agentCrmIds: [...groupAccounts],
    columns: FIELD_VISIT_COLUMNS,
    dateFrom: input.start,
    dateTo: input.end,
  });
  return mergeDayMapVisitPages([rows, groupMates]);
}

/**
 * One item per (employee, day, colour) for the CRM activity the employee logged themselves.
 * Grouped rather than one-per-visit so a 12-visit day is a single calendar chip, matching how
 * the double-visit loader presents its days. Every visit count on it is AM · PM · Pharmacies
 * apart — never a pharmacy inside PM (src/lib/crm/visit-count-buckets.ts).
 *
 * Best-effort by design, mirroring loadDoubleVisitPrivateCalendarItems: if the
 * CRM read fails this returns nothing rather than throwing, because a CRM outage
 * must not take the whole private calendar down with it. Note the direction of
 * that failure — losing coverage can only ever ADD a "No Activity Recorded"
 * flag, never remove one, so a degraded run over-reports rather than silently
 * excusing a real gap.
 */
export async function loadFieldVisitPrivateCalendarItems(
  employeeHrIds: string[],
  start: string,
  end: string,
  /** The same employees' CRM accounts (directory `crmId`), in any order — optional; see readFieldVisitRows. */
  employeeCrmIds: ReadonlyArray<string | number | null | undefined> = [],
): Promise<{ items: PrivateCalendarItem[]; ready: boolean }> {
  try {
    const selected = new Set(
      employeeHrIds.map((value) => normalizedKey(value)).filter((value): value is string => Boolean(value)),
    );
    if (selected.size === 0) return { items: [], ready: true };

    // Neither read collapses on its own, so the chip's count runs through the same canonical
    // read-time collapse DV Analytics and FWC use — otherwise a rep re-saving one stop reads as an
    // extra visit here while every other surface counts it once. The extra columns are the
    // collapse's fingerprint and the AM · PM · Pharmacies bucket's inputs.
    const rows = collapseDuplicateVisitSubmissions(
      await readFieldVisitRows({ employeeCrmIds, employeeHrIds, end, selected, start }),
    );

    // Group by (employee, day, colour). Keyed on the rep's own hr_id — a visit where this
    // employee is the *visited* party (a double visit received) is the other
    // person's field work, not theirs, and is already handled by the double-visit
    // feed.
    const byKey = new Map<string, FieldVisitGroup>();
    for (const row of rows) {
      const hrKey = normalizedKey(row.agent_hr_id);
      if (!hrKey || !selected.has(hrKey)) continue;
      const date = String(row.visit_date ?? "").slice(0, 10);
      if (!date) continue;
      const kind = fieldVisitActivityKind(row);
      if (!kind) continue;
      const key = `${hrKey}|${date}|${kind}`;
      const existing = byKey.get(key) ?? {
        activities: new Map<string, number>(),
        customers: new Set<string>(),
        date,
        hrId: String(row.agent_hr_id ?? ""),
        kind,
        name: row.agent_name ?? null,
        partners: new Set<string>(),
        split: emptyVisitCountSplit(),
      };
      const customer = String(row.contact_name ?? "").trim();
      if (customer) {
        // The half the visit is counted in, then who, then what kind of customer — the detail the mirror holds.
        // A day with seven customers lists seven lines (owner, 2026-10-20: "list them under each other, see full details").
        const speciality = String(row.speciality ?? "").trim();
        existing.customers.add([visitCountBucket(row), customer, speciality].filter(Boolean).join(" · "));
      }
      // `partners` is a Set of NAMES, so naming a chain visit's second manager cannot move a count —
      // it only stops one of the two people on the row going unnamed on the day's card.
      for (const value of [row.double_name, row.double2_name]) {
        const partner = String(value ?? "").trim();
        if (partner && hasRealPartner(row)) existing.partners.add(partner);
      }
      const activity = resolveVisitTypeLabel(row.visit_type, row.visit_type_description, row.comment);
      existing.activities.set(activity, (existing.activities.get(activity) ?? 0) + 1);
      addVisitToSplit(existing.split, row);
      byKey.set(key, existing);
    }

    const items: PrivateCalendarItem[] = [];
    for (const [key, group] of byKey) {
      const kindLabel = privateCalendarActivityKindLabels[group.kind];
      const customerList = [...group.customers];
      // Empty, never a placeholder word: an unnamed day is a day whose visits the CRM does not name,
      // and the count alone is the honest chip. Counting VISITS (not distinct names) also matters —
      // reading the number off the name set showed "? field visits" on every day once customer_name
      // turned out to be empty everywhere.
      const partners = group.partners.size > 0 ? [...group.partners].join(", ") : null;
      const isVisit = group.kind !== "vacation" && group.kind !== "other_crm";
      const counts = isVisit ? privateCalendarTileCountsText(group.split) : countedList(group.activities);
      const headline = group.kind === "vacation" ? "Annual vacation logged in CRM" : kindLabel;
      items.push({
        activityKind: group.kind,
        approvalImpact:
          "CRM field-visit evidence is read-only activity context. It does not mutate attendance, leave, deductions, payroll, or compliance decisions.",
        chipLines: [
          headline,
          ...(group.kind === "vacation" ? [] : [counts]),
          ...(partners ? [`With ${partners}`] : []),
          ...customerList,
        ],
        description: isVisit
          ? "Logged CRM field visits from the live iReports360 visit mirror, AM · PM · PH apart."
          : group.kind === "vacation"
            ? "An annual vacation day the employee logged in CRM, from the live iReports360 visit mirror."
            : "CRM activity other than a customer visit, from the live iReports360 visit mirror.",
        // Said once: the kind is the title, the counts are the time, the partners and customers are the chip.
        detailLines: [],
        employeeDepartmentName: null,
        employeeHrId: group.hrId,
        employeeJobTitle: null,
        employeeLineName: null,
        employeeName: group.name,
        endDate: group.date,
        exceptionFlags: [],
        id: `field-visit-${key}`,
        managerName: null,
        severity: "success",
        source: "field_visit",
        // The read door, not the raw mirror: a started team's days here are its Phoenix CRM visits.
        sourceLabel: "Field visits through the CRM read door",
        sourceRecordId: `field-visit-${key}`,
        sourceSystem: "CRM Field Visits",
        sourceTable: CRM_VISITS_UNIFIED_VIEW,
        startDate: group.date,
        status: "performed",
        tileWith: [...group.partners],
        time: group.kind === "vacation" ? "Full day" : counts,
        title: group.kind === "vacation" ? headline : `${headline}: ${counts}`,
        visitCounts: isVisit ? group.split : null,
      });
    }
    return { items, ready: true };
  } catch {
    return { items: [], ready: false };
  }
}
