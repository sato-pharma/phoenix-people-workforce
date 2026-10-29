/**
 * KPIs — coverage and frequency per brick, for one rep's list or a whole team (owner, 2026-10-29: "a
 * brick view for managers across all their reps" and "frequency by brick … beside the coverage
 * table").
 *
 * A doctor's brick is the one the doctor's validated live photo was filed in (kpis-doctor-bricks.ts); this
 * module only counts. It imports types and the dependency-free doctor filters alone, so the view and
 * the XLSX export build the very same rows from the very same lists.
 *
 * ## How it counts
 *
 *   - Planned: +1 for every doctor on a rep's list, per rep — a doctor two reps both plan counts twice,
 *     exactly as the team tiles and `plannedDoctors` count him. Covered: +1 when that rep saw him.
 *   - The frequency columns are the Frequency report's own definitions: a doctor is judged unless he is
 *     ungraded or not due yet; "on plan" is Exact or At norm; Below, Above and Not visited are the
 *     rest. So `onPlan + below + above + notVisited === judged` in every row.
 *   - A doctor whose brick was never read (the read failed) is in no row, so a failed read builds no
 *     table rather than a table that calls everyone "not validated".
 */

import type { DoctorFrequencyStatus } from "@/lib/crm/phoenix-kpi-rules";
import {
  KPI_DOCTOR_BRICK_NONE,
  KPI_DOCTOR_BRICK_NONE_LABEL,
  KPI_DOCTOR_NOT_VALIDATED,
  KPI_DOCTOR_NOT_VALIDATED_LABEL,
  kpiDoctorBrickValue,
  type KpiDoctorFilterable,
  type KpiDoctorStatus,
} from "@/lib/crm/kpis-doctor-filters";
import { ACTIVITY_LABEL } from "@/lib/crm/reps-list-activity";

/**
 * The words on a frequency verdict, shared by the Frequency report and the XLSX export. The first
 * three are the owner's own (ACTIVITY_LABEL, "change vocab to below exact above"); the rest are the
 * Phoenix grade-norm words and the two states a count cannot judge.
 */
export const KPI_FREQUENCY_STATUS_LABEL: Record<DoctorFrequencyStatus, string> = {
  exact: ACTIVITY_LABEL.on_plan,
  below: ACTIVITY_LABEL.under,
  above: ACTIVITY_LABEL.over,
  "not-visited": "Not visited",
  "not-due": ACTIVITY_LABEL.not_due,
  "at-norm": "At norm",
  ungraded: "Ungraded",
};

/** The doctor as the brick table reads him — `KpiCoverageDoctor` satisfies it structurally. */
export type KpiBrickDoctor = Pick<KpiDoctorFilterable, "brick" | "placeValidated" | "visits"> & {
  frequency?: { status: string } | undefined;
};

/** One brick's line. `brick` is the Brick filter's value for it, so a row can link to its doctors. */
export type KpiBrickRow = {
  brick: string;
  label: string;
  /** How many of the lists counted hold at least one doctor in this brick. */
  reps: number;
  planned: number;
  covered: number;
  /** Doctors the frequency verdict judges: everyone but the ungraded and the not due yet. */
  judged: number;
  /** Exact or At norm. */
  onPlan: number;
  below: number;
  above: number;
  notVisited: number;
  ungraded: number;
};

/**
 * The three frequency columns of a brick line, in the board's own words for the rules that scored it:
 * Exact, Below and Above (the owner's, ACTIVITY_LABEL) or At norm, Below norm and No grade. Never "On
 * plan" or "Over plan". A doctor never seen is short of what was asked, so Below counts him too — as
 * the rep row's own Below does. Each column names the verdicts it counts, which are also the Verdict
 * filter a count on screen links to. The screen and the XLSX export both read this one list.
 */
export type KpiBrickFrequencyColumn = {
  label: string;
  sub: string;
  count: (row: KpiBrickRow) => number;
  statuses: KpiDoctorStatus[];
};

export function kpiBrickFrequencyColumns(phoenix: boolean): KpiBrickFrequencyColumn[] {
  const passing: KpiDoctorStatus[] = ["exact", "at-norm"];
  const short: KpiDoctorStatus[] = ["below", "not-visited"];
  const shortCount = (row: KpiBrickRow) => row.below + row.notVisited;
  return phoenix
    ? [
        { label: "At norm", sub: "The pass", count: (row) => row.onPlan, statuses: passing },
        { label: "Below norm", sub: "Short, or never seen", count: shortCount, statuses: short },
        { label: "No grade", sub: "Left out", count: (row) => row.ungraded, statuses: ["ungraded"] },
      ]
    : [
        { label: ACTIVITY_LABEL.on_plan, sub: "The only pass", count: (row) => row.onPlan, statuses: passing },
        { label: ACTIVITY_LABEL.under, sub: "Short, or never seen", count: shortCount, statuses: short },
        { label: ACTIVITY_LABEL.over, sub: "Also a deviation", count: (row) => row.above, statuses: ["above"] },
      ];
}

const SENTINEL_RANK: Record<string, number> = { [KPI_DOCTOR_BRICK_NONE]: 1, [KPI_DOCTOR_NOT_VALIDATED]: 2 };

function brickLabel(value: string): string {
  if (value === KPI_DOCTOR_BRICK_NONE) return KPI_DOCTOR_BRICK_NONE_LABEL;
  if (value === KPI_DOCTOR_NOT_VALIDATED) return KPI_DOCTOR_NOT_VALIDATED_LABEL;
  return value;
}

/**
 * The per-brick lines of the given lists, one list per rep. Biggest brick first, then A to Z; the
 * validated-with-no-brick line second to last and "Not validated yet" last.
 */
export function buildKpiBrickRows(lists: ReadonlyArray<ReadonlyArray<KpiBrickDoctor>>): KpiBrickRow[] {
  const rows = new Map<string, KpiBrickRow>();
  for (const list of lists) {
    const seenHere = new Set<string>();
    for (const doctor of list) {
      const value = kpiDoctorBrickValue(doctor);
      if (value === undefined) continue;
      // Bricks match whatever their case and spacing, as the Brick filter matches them.
      const key = value.trim().toLowerCase();
      const row =
        rows.get(key) ??
        ({ brick: value, label: brickLabel(value), reps: 0, planned: 0, covered: 0, judged: 0, onPlan: 0, below: 0, above: 0, notVisited: 0, ungraded: 0 } satisfies KpiBrickRow);
      rows.set(key, row);
      if (!seenHere.has(key)) {
        seenHere.add(key);
        row.reps += 1;
      }
      row.planned += 1;
      if (doctor.visits > 0) row.covered += 1;
      const status = doctor.frequency?.status;
      if (status === "ungraded") row.ungraded += 1;
      if (status === undefined || status === "ungraded" || status === "not-due") continue;
      row.judged += 1;
      if (status === "exact" || status === "at-norm") row.onPlan += 1;
      else if (status === "below") row.below += 1;
      else if (status === "above") row.above += 1;
      else row.notVisited += 1;
    }
  }
  return [...rows.values()].sort(
    (left, right) =>
      (SENTINEL_RANK[left.brick] ?? 0) - (SENTINEL_RANK[right.brick] ?? 0) ||
      right.planned - left.planned ||
      left.label.localeCompare(right.label),
  );
}
