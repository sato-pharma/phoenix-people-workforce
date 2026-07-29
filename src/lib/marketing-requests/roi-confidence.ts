// ─────────────────────────────────────────────────────────────────────────────
// How much a request's ROI number can be trusted, as a number.
//
// "Can I trust this figure?" was previously a judgement call made per request by whoever happened
// to open it. The inputs were always on screen — unverified pharmacy codes, missing targets, a
// window the sales data has not reached — but a reader had to assemble them mentally, every time.
//
// This scores confidence in the MEASUREMENT, never in the campaign's performance. A campaign that
// genuinely failed can score 100: the number is trustworthy, the result is just bad. Conversely a
// campaign showing a healthy return with unverified pharmacy codes scores poorly — the figure
// cannot be relied on either way. Keeping those two ideas apart is the whole point.
//
// Grounded in a measured production fact: a pharmacy code the reference database cannot find has
// no sales 27.9% of the time versus 1.3% for a matched code — roughly 21x worse. That is why code
// health carries the heaviest weight.
// ─────────────────────────────────────────────────────────────────────────────

import type { RoiTrackerRow } from "@/lib/marketing-requests/roi-tracker-service";

export type RoiConfidenceBand = "high" | "medium" | "low";

export type RoiConfidenceFactor = {
  key: "pharmacy_codes" | "sales_coverage" | "targets" | "products";
  label: string;
  /** 0..1 — how well this factor scored. */
  ratio: number;
  weight: number;
  /** Plain-English statement of what was actually found. */
  detail: string;
};

export type RoiConfidence = {
  /** 0..100. */
  score: number;
  band: RoiConfidenceBand;
  factors: RoiConfidenceFactor[];
  /** The single most damaging factor, or null when nothing is holding the score back. */
  weakest: RoiConfidenceFactor | null;
};

const WEIGHTS = { pharmacy_codes: 40, products: 15, sales_coverage: 30, targets: 15 } as const;

function bandOf(score: number): RoiConfidenceBand {
  if (score >= 80) return "high";
  if (score >= 50) return "medium";
  return "low";
}

export function roiConfidenceOf(row: RoiTrackerRow): RoiConfidence {
  const pharmacyCount = row.pharmacies.length;
  const verified = pharmacyCount - row.suspectPharmacyCount;

  // A request with no target pharmacies at all cannot attribute anything, ever. That is a total
  // failure of the input rather than a partial one, so it scores zero rather than "no news".
  const codeRatio = pharmacyCount === 0 ? 0 : Math.max(0, verified) / pharmacyCount;

  const coverageRatio =
    row.dataCoverage === "complete" ? 1 : row.dataCoverage === "partial_pending" ? 0.5 : 0;

  const forecastUnits = row.products.reduce((sum, product) => sum + product.forecastQty, 0);

  const factors: RoiConfidenceFactor[] = [
    {
      detail:
        pharmacyCount === 0
          ? "No target pharmacies recorded — nothing can attribute."
          : row.suspectPharmacyCount > 0
            ? `${row.suspectPharmacyCount} of ${pharmacyCount} pharmacy code(s) could not be verified.`
            : `All ${pharmacyCount} pharmacy code(s) verified against the reference database.`,
      key: "pharmacy_codes",
      label: "Pharmacy codes",
      ratio: codeRatio,
      weight: WEIGHTS.pharmacy_codes,
    },
    {
      detail:
        coverageRatio === 1
          ? "Validated sales cover the whole measurement window."
          : coverageRatio === 0.5
            ? "Validated sales cover only part of the window — the figure will still move."
            : "No validated sales cover this window yet — nothing has been measured.",
      key: "sales_coverage",
      label: "Sales data coverage",
      ratio: coverageRatio,
      weight: WEIGHTS.sales_coverage,
    },
    {
      detail: row.payDate
        ? `Measurement window ${row.roiWindow ?? "—"} is set.`
        : "No pay date, so the measurement window has not opened.",
      key: "targets",
      label: "Window defined",
      ratio: row.payDate && row.roiWindow ? 1 : 0,
      weight: WEIGHTS.targets,
    },
    {
      detail:
        row.products.length === 0
          ? "No promoted products recorded."
          : forecastUnits <= 0
            ? `${row.products.length} product(s) recorded, but no forecast quantity to measure against.`
            : `${row.products.length} product(s) with a forecast of ${Math.round(forecastUnits)} units.`,
      key: "products",
      label: "Products & forecast",
      ratio: row.products.length === 0 ? 0 : forecastUnits > 0 ? 1 : 0.5,
      weight: WEIGHTS.products,
    },
  ];

  const score = Math.round(factors.reduce((sum, factor) => sum + factor.ratio * factor.weight, 0));

  // The weakest factor is the one costing the most points, not simply the lowest ratio — a small
  // gap on a heavy factor matters more than a total gap on a light one.
  const weakest = factors
    .filter((factor) => factor.ratio < 1)
    .sort((left, right) => (right.weight * (1 - right.ratio)) - (left.weight * (1 - left.ratio)))[0] ?? null;

  return { band: bandOf(score), factors, score, weakest };
}
