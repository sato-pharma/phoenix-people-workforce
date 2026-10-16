import type { DoubleVisitExpenseWorkloadEvidence } from "@/lib/double-visit-analytics/types";
import type { RepVisitWorkload } from "@/lib/crm/visit-workload";

/**
 * The match statuses `outstation_expense_requests.workload_match_status` accepts
 * (`outstation_workload_match_status_check`). `unmapped` is NOT one of them.
 */
export type StoredWorkloadMatchStatus = "manual" | "matched" | "partial" | "no_activity" | "manual_override" | "stale_import";

/**
 * A rep with no CRM id and no visits under his HR id reads `unmapped` — his visits can't be matched,
 * which is not evidence he did nothing. The column's check constraint refuses that word, and the
 * refusal surfaced to the rep on submit as "violates check constraint
 * outstation_workload_match_status_check". It is stored as `manual` (nothing was judged, a person
 * reads the trip); the evidence snapshot beside it still carries `unmapped` and its label.
 */
export function storedWorkloadMatchStatus(status: DoubleVisitExpenseWorkloadEvidence["matchStatus"]): StoredWorkloadMatchStatus {
  return status === "unmapped" ? "manual" : status;
}

/**
 * Combines the two workload sources the outstation decision engine needs.
 *
 * They answer different questions and MUST NOT be conflated:
 *
 * - "Did this rep actually work these days?" → the CRM visits read (`repWorkload`), which counts
 *   every field visit where the rep is the primary agent OR the double-visit partner. The
 *   double-visit mirror cannot see a rep's SOLO field days, so it reported worked days as
 *   "no activity" and the engine judged real trips against a workload of zero.
 *
 * - "How many campaign DOUBLE-visits were there?" → the double-visit mirror, kept as-is.
 *   The campaign-cap rule rejects on `campaignVisits > MAX` and on `totalDvVisits <= 0`.
 *   Feeding it the CRM read would break it in both directions: a rep's solo campaign visits
 *   would inflate `campaignVisits` into spurious auto-rejections, and solo visits would satisfy
 *   the `totalDvVisits > 0` test — silently fail-opening a live rejection rule.
 *
 * A null `repWorkload` means the corrected read failed; the previous (under-counting) evidence is
 * returned unchanged rather than blocking an expense submission.
 */
export function mergeWorkloadEvidence(
  doubleVisitEvidence: DoubleVisitExpenseWorkloadEvidence,
  repWorkload: RepVisitWorkload | null,
): DoubleVisitExpenseWorkloadEvidence {
  if (!repWorkload) return doubleVisitEvidence;

  return {
    ...doubleVisitEvidence,
    // From the corrected CRM read: how much the rep actually worked.
    // THE AM · PM · PHARMACIES GOLDEN RULE: pharmacies are their own figure, never inside AM/PM.
    amWorkload: repWorkload.amWorkload,
    pharmacyWorkload: repWorkload.pharmacyWorkload,
    pmWorkload: repWorkload.pmWorkload,
    matchStatus: repWorkload.matchStatus,
    matchedDates: repWorkload.matchedDates,
    missingDates: repWorkload.idleDates,
    // Compact projection — the stored snapshot must stay small, so the per-visit and
    // per-check-in detail the workload panel renders is deliberately not persisted. The
    // doctor/pharmacy/institution split (3 ints/day) is small enough to keep: it lets the
    // portal dashboard show the mix without a live CRM re-read.
    dateBreakdown: repWorkload.dateBreakdown.map((day) => ({
      am: day.am,
      date: day.date,
      doctor: day.doctor,
      evidenceRows: day.total,
      institution: day.institution,
      pharmacy: day.pharmacy,
      pharmacies: day.pharmacies,
      pm: day.pm,
      total: day.total,
    })),
    doctorVisits: repWorkload.doctorVisits,
    institutionVisits: repWorkload.institutionVisits,
    pharmacyVisits: repWorkload.pharmacyVisits,
    sourceLabel: `${repWorkload.sourceLabel} Campaign/regular counts remain from: ${doubleVisitEvidence.sourceLabel}`,
    // campaignVisits, regularVisits, source and importId deliberately fall through from
    // doubleVisitEvidence via the spread above. Do not "unify" them onto the CRM read.
  };
}
