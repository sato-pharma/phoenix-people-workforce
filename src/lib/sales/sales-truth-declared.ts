// ─────────────────────────────────────────────────────────────────────────────
// THE DIFFERENCES THE SALES TRUTH CHECK IS TOLD TO EXPECT — and nothing wider.
//
// The sales truth check (sales-truth-report.ts) compares every surface with Monthly Closing, area by
// area, for every month that has a closing. Run over all twelve months on 14 Nov 2026 it found Source
// of Sales equal to the closing everywhere, and Sales vs Target different in eight months. Every one of
// those eight was explained, and none of them is a defect anyone means to fix:
//
//   1. Before January 2026 Sales vs Target holds nothing. Its engine starts at 2026-01
//      (SALES_HISTORY_FLOOR in vs-target.ts), so 2025-08 reads as the whole closing missing
//      — 2,635,763.44 EGP on 14 Nov 2026. Only a MISSING area is expected there; a value Sales vs
//      Target does print for such a month is still a finding.
//   2. January to June 2026 were closed by hand before areas were unified (unification began in July
//      2026 — owner rule `closing-reconcile-per-customer-product-not-area-pre-july`). Area rows there
//      disagree even when the sales are identical, so an area difference is expected as long as the
//      LINE total still agrees. A line whose total moved is still a finding.
//      One line total is itself declared: March 2026 CNS, where Sales vs Target is 520.10 EGP short.
//      The hand-reconciled closing books 12 units the distributor CP filed as Tebofortine 40 mg
//      (TE003, 81.00 EGP) as Tebofortin 120 mg Intens (TE005, 124.34 EGP); the import rows and the
//      roll-up keep them as Tebofortine 40 mg. Units agree on every other CNS product. Read 14 Nov 2026.
//   3. September 2026 keeps its published Assuit 1 / Assuit 2 store split (owner, 26 Oct 2026: "leave
//      September's Assuit split as published"). Sales vs Target reads that frozen split; the live
//      closing re-splits. Exactly four rows, each declared by line, area and amount below.
//
// Every declaration is as narrow as the fact behind it — a month, a line, an area, an amount — so the
// day any OTHER money moves, the check still reports it. Widening one to make a red check green is
// the one thing this file must never be used for: say what changed and ask the owner instead.
//
// PURE: no imports that reach a database, so the test can drive it with hand-made reports.
// ─────────────────────────────────────────────────────────────────────────────

import {
  SALES_TRUTH_TOLERANCE_EGP,
  type SalesTruthFinding,
  type SalesTruthReport,
} from "@/lib/sales/sales-truth-reconciliation";

/** The surface every declaration in this file is about. sales-truth-report.ts re-exports it. */
export const SURFACE_VS_TARGET = "Sales vs Target";

/** Sales vs Target's engine holds nothing before this month (vs-target.ts, SALES_HISTORY_FLOOR). */
export const VS_TARGET_HISTORY_START = "2026-01";

/** Areas were unified from this month; before it, only line totals are comparable. */
export const AREAS_UNIFIED_FROM = "2026-07";

/**
 * How close a pre-July LINE total must come to agreeing, in EGP. A line total here is the sum of its
 * areas' differences, and each of those is rounded to the piastre (an area within one piastre is not
 * a difference at all), so two dozen areas add up to a few piastres of nothing: April and May 2026
 * CNS read 0.02 EGP on 14 Nov 2026 with the money identical. One pound is far below any real move
 * and far above that rounding.
 */
export const LINE_TOTAL_TOLERANCE_EGP = 1;

export type DeclaredLineTotal = {
  period: string;
  lineCode: string;
  /** Sales vs Target minus Monthly Closing, summed over the line, in EGP. */
  netDiff: number;
  reason: string;
};

export type DeclaredAreaDifference = {
  period: string;
  lineCode: string;
  areaCode: string;
  /** Sales vs Target minus Monthly Closing for this one area, in EGP. */
  diff: number;
  reason: string;
};

export const DECLARED_LINE_TOTALS: readonly DeclaredLineTotal[] = [
  {
    period: "2026-03",
    lineCode: "cns",
    netDiff: -520.1,
    reason:
      "March 2026 CNS: the hand-reconciled closing books 12 CP units of Tebofortine 40 mg as Tebofortin 120 mg Intens, so Sales vs Target is 520.10 EGP short on the line",
  },
];

const SEPTEMBER_ASSUIT_SPLIT =
  "September 2026 keeps its published Assuit 1 / Assuit 2 store split (owner, 26 Oct 2026)";

export const DECLARED_AREA_DIFFERENCES: readonly DeclaredAreaDifference[] = [
  { period: "2026-09", lineCode: "cns", areaCode: "UE3", diff: 779.23, reason: SEPTEMBER_ASSUIT_SPLIT },
  { period: "2026-09", lineCode: "cns", areaCode: "UE4", diff: -779.23, reason: SEPTEMBER_ASSUIT_SPLIT },
  { period: "2026-09", lineCode: "anti_infective", areaCode: "UE3", diff: 222.3, reason: SEPTEMBER_ASSUIT_SPLIT },
  { period: "2026-09", lineCode: "anti_infective", areaCode: "UE4", diff: -222.3, reason: SEPTEMBER_ASSUIT_SPLIT },
];

export type DeclaredFinding = SalesTruthFinding & { reason: string };

export type ClassifiedSurface = {
  surface: string;
  declared: DeclaredFinding[];
  unexplained: SalesTruthFinding[];
};

export type ClassifiedSalesTruthReport = {
  period: string;
  surfaces: ClassifiedSurface[];
  unreadableLines: string[];
  /** True when nothing is left that a person has not already been told about. */
  ok: boolean;
};

function sameMoney(left: number, right: number, tolerance = SALES_TRUTH_TOLERANCE_EGP): boolean {
  return Math.abs(Math.round((left - right) * 100) / 100) <= tolerance;
}

function lower(value: string): string {
  return value.trim().toLowerCase();
}

function upper(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * Split each surface's findings into the ones declared above and the ones nobody has explained.
 *
 * Order matters: the exact area declarations go first, then the pre-2026 floor, then the pre-July
 * line test — so a declared September row can never be counted inside a line total, and a line's
 * total is judged on what is left of it.
 */
export function classifySalesTruthReport(
  report: SalesTruthReport,
  declarations: {
    lineTotals?: readonly DeclaredLineTotal[];
    areaDifferences?: readonly DeclaredAreaDifference[];
  } = {},
): ClassifiedSalesTruthReport {
  const lineTotals = declarations.lineTotals ?? DECLARED_LINE_TOTALS;
  const areaDifferences = declarations.areaDifferences ?? DECLARED_AREA_DIFFERENCES;
  const period = report.period;

  const surfaces = report.surfaces.map((surface): ClassifiedSurface => {
    if (surface.surface !== SURFACE_VS_TARGET) {
      return { surface: surface.surface, declared: [], unexplained: [...surface.findings] };
    }

    const declared: DeclaredFinding[] = [];
    let remaining: SalesTruthFinding[] = [];

    for (const finding of surface.findings) {
      const exact = areaDifferences.find(
        (entry) =>
          entry.period === period &&
          lower(entry.lineCode) === lower(finding.lineCode) &&
          upper(entry.areaCode) === upper(finding.areaCode) &&
          sameMoney(entry.diff, finding.diff),
      );
      if (exact) {
        declared.push({ ...finding, reason: exact.reason });
        continue;
      }
      if (period < VS_TARGET_HISTORY_START && finding.kind === "missing-on-surface") {
        declared.push({
          ...finding,
          reason: "Sales vs Target holds no month before January 2026",
        });
        continue;
      }
      remaining.push(finding);
    }

    if (period >= VS_TARGET_HISTORY_START && period < AREAS_UNIFIED_FROM) {
      const byLine = new Map<string, SalesTruthFinding[]>();
      for (const finding of remaining) {
        const key = lower(finding.lineCode);
        byLine.set(key, [...(byLine.get(key) ?? []), finding]);
      }
      remaining = [];
      for (const [lineCode, findings] of byLine) {
        const net = findings.reduce((sum, finding) => sum + finding.diff, 0);
        const declaredTotal = lineTotals.find((entry) => entry.period === period && lower(entry.lineCode) === lineCode);
        if (sameMoney(net, declaredTotal?.netDiff ?? 0, LINE_TOTAL_TOLERANCE_EGP)) {
          const reason = declaredTotal
            ? `${declaredTotal.reason}; areas before July 2026 are not unified`
            : "areas before July 2026 are not unified, and the line total agrees";
          for (const finding of findings) declared.push({ ...finding, reason });
        } else {
          remaining.push(...findings);
        }
      }
    }

    return { surface: surface.surface, declared, unexplained: remaining };
  });

  return {
    period,
    surfaces,
    unreadableLines: [...report.unreadableLines],
    ok: report.unreadableLines.length === 0 && surfaces.every((surface) => surface.unexplained.length === 0),
  };
}
