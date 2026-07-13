// Probation DV-Day detection (Phase 3, P3-T02).
//
// Turns raw CRM double-visit rows (dv-source.ts) into candidate DV-Days. A DV-Day is the unit the
// probation requirement counts — one field day per (evaluator, employee, date) — regardless of how
// many individual customer visits happened that day (8, 10, 12+ all collapse to ONE DV-Day with a
// visit_count). Detection is PURE grouping only: it does no identity/role/window validation
// (P3-T04..T06) and writes nothing (P3-T03/T09). Invalid-looking rows are not silently dropped —
// rows lacking the keys needed to form a day are surfaced separately so the caller can route them
// to the review queue (P3-T08).

import {
  dvDayKey,
  loadDoubleVisitRows,
  mapRawDvVisit,
  type RawDvVisitRow,
  type SourceDvVisit,
} from "./dv-source";

import type { SupabaseClient } from "@supabase/supabase-js";

export type DetectedDvDay = {
  /** Grouping key (evaluator|employee|date), case-insensitive. */
  key: string;
  employeeHrId: string;
  evaluatorHrId: string;
  dvDate: string;
  /** Number of individual CRM visits collapsed into this one DV-Day. */
  visitCount: number;
  /** Distinct AM/PM markers seen across the day's visits. */
  periods: Array<"AM" | "PM">;
  /** CRM source ids for dedup + traceability + resync. */
  crmVisitIds: number[];
  /** The underlying per-visit detail (attached to probation_dv_visits in P3-T07). */
  visits: SourceDvVisit[];
};

export type DvDetectionResult = {
  dvDays: DetectedDvDay[];
  /**
   * Rows that could not be grouped into a DV-Day because they lack an employee or evaluator or a
   * valid CRM id. Surfaced (not dropped) so P3-T08 can queue them for review with a reason.
   */
  unresolved: Array<{ crmVisitId: number | null; reason: string; visit: SourceDvVisit }>;
};

function isPresent(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Pure detection: group mapped double-visit rows into DV-Days.
 * A row must have an employee, an evaluator, a date, and a CRM visit id to form/join a day;
 * anything missing those is returned in `unresolved` with a reason.
 */
export function detectDvDays(rows: RawDvVisitRow[]): DvDetectionResult {
  const byKey = new Map<string, DetectedDvDay>();
  const seenCrmIds = new Set<number>();
  const unresolved: DvDetectionResult["unresolved"] = [];

  for (const raw of rows) {
    const visit = mapRawDvVisit(raw);

    if (!Number.isFinite(visit.crmVisitId) || visit.crmVisitId <= 0) {
      unresolved.push({ crmVisitId: null, reason: "missing_crm_visit_id", visit });
      continue;
    }
    if (!isPresent(visit.employeeHrId)) {
      unresolved.push({ crmVisitId: visit.crmVisitId, reason: "unresolved_employee", visit });
      continue;
    }
    if (!isPresent(visit.evaluatorHrId)) {
      unresolved.push({ crmVisitId: visit.crmVisitId, reason: "unresolved_evaluator", visit });
      continue;
    }
    if (!isPresent(visit.dvDate)) {
      unresolved.push({ crmVisitId: visit.crmVisitId, reason: "missing_visit_date", visit });
      continue;
    }

    // A CRM activity can belong to exactly ONE DV-Day — ignore a repeated crm_visit_id (dedup
    // within a single detection pass; the DB unique on crm_visit_id is the durable guard, P3-T03).
    if (seenCrmIds.has(visit.crmVisitId)) continue;
    seenCrmIds.add(visit.crmVisitId);

    const key = dvDayKey(visit.evaluatorHrId, visit.employeeHrId, visit.dvDate);
    const existing = byKey.get(key);
    if (existing) {
      existing.visitCount += 1;
      existing.crmVisitIds.push(visit.crmVisitId);
      existing.visits.push(visit);
      if (visit.ampm && !existing.periods.includes(visit.ampm)) existing.periods.push(visit.ampm);
    } else {
      byKey.set(key, {
        key,
        employeeHrId: visit.employeeHrId,
        evaluatorHrId: visit.evaluatorHrId,
        dvDate: visit.dvDate,
        visitCount: 1,
        periods: visit.ampm ? [visit.ampm] : [],
        crmVisitIds: [visit.crmVisitId],
        visits: [visit],
      });
    }
  }

  // Stable ordering: by date, then employee, then evaluator.
  const dvDays = Array.from(byKey.values()).sort(
    (a, b) =>
      a.dvDate.localeCompare(b.dvDate) ||
      a.employeeHrId.localeCompare(b.employeeHrId) ||
      a.evaluatorHrId.localeCompare(b.evaluatorHrId),
  );

  return { dvDays, unresolved };
}

/** Load + detect DV-Days for a date window (inclusive), optionally scoped to a set of employees. */
export async function detectDvDaysForWindow(
  supabase: SupabaseClient,
  dateFrom: string,
  dateTo: string,
  employeeHrIds?: string[],
): Promise<DvDetectionResult> {
  const rows = await loadDoubleVisitRows(supabase, dateFrom, dateTo, employeeHrIds);
  return detectDvDays(rows);
}
