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

/**
 * The same judgement, applied WHILE the request is still being written.
 *
 * Deliberately scores only what the requester can still change. Sales-data coverage is the
 * heaviest factor after submission, but at submission it is both unknowable and not their fault —
 * a campaign paid next month cannot possibly have covering sales today. Including it would show
 * every single request a permanent 70/100, and a score that never reaches 100 no matter what you
 * do is a score people learn to ignore. That would be worse than showing nothing.
 *
 * So the weights are renormalised over the three things a requester controls before pressing
 * submit. Pharmacy codes still dominate, for the same measured reason as the post-submission
 * score: a code the reference database cannot find has no sales ~21x more often.
 *
 * Shares RoiConfidence/RoiConfidenceFactor with roiConfidenceOf on purpose. One vocabulary, one
 * band scale, one idea of "weakest" — a second, subtly different score would be exactly the
 * disagreement this module family exists to prevent.
 */
const DRAFT_WEIGHTS = { pharmacy_codes: 60, products: 20, window: 20 } as const;

export type DraftCaptureInput = {
  /** One entry per chosen pharmacy; true when its code is unverified (`not_found`/`ambiguous`). */
  pharmacySuspect: boolean[];
  /** Total forecast units across the promoted products. */
  forecastUnits: number;
  productCount: number;
  /** A pay date has been chosen — without one there is no measurement window at all. */
  hasPayDate: boolean;
};

export function draftCaptureConfidence(input: DraftCaptureInput): RoiConfidence {
  const pharmacyCount = input.pharmacySuspect.length;
  const suspect = input.pharmacySuspect.filter(Boolean).length;
  const codeRatio = pharmacyCount === 0 ? 0 : (pharmacyCount - suspect) / pharmacyCount;
  const productRatio = input.productCount === 0 ? 0 : input.forecastUnits > 0 ? 1 : 0.5;

  // Every message is phrased as the next action, not as a complaint. The whole point of moving
  // this earlier is that the requester can still fix it in seconds.
  const factors: RoiConfidenceFactor[] = [
    {
      detail:
        pharmacyCount === 0
          ? "Add at least one target pharmacy — without one, no sale can ever be matched to this request."
          : suspect > 0
            ? `${suspect} of ${pharmacyCount} pharmacy code(s) are unverified. Sales at those pharmacies will not count towards this request.`
            : `All ${pharmacyCount} pharmacy code(s) are verified.`,
      key: "pharmacy_codes",
      label: "Pharmacy codes",
      ratio: codeRatio,
      weight: DRAFT_WEIGHTS.pharmacy_codes,
    },
    {
      detail: input.hasPayDate
        ? "Pay date set — the measurement window has a start."
        : "Set a pay date so the measurement window has a start.",
      key: "targets",
      label: "Pay date",
      ratio: input.hasPayDate ? 1 : 0,
      weight: DRAFT_WEIGHTS.window,
    },
    {
      detail:
        input.productCount === 0
          ? "Add at least one promoted product."
          : input.forecastUnits > 0
            ? `${input.productCount} product(s), ${Math.round(input.forecastUnits)} units forecast.`
            : "Add a forecast quantity — without one there is nothing to measure the result against.",
      key: "products",
      label: "Products & forecast",
      ratio: productRatio,
      weight: DRAFT_WEIGHTS.products,
    },
  ];

  const score = Math.round(factors.reduce((sum, factor) => sum + factor.ratio * factor.weight, 0));
  const weakest = factors
    .filter((factor) => factor.ratio < 1)
    .sort((left, right) => (right.weight * (1 - right.ratio)) - (left.weight * (1 - left.ratio)))[0] ?? null;

  return { band: bandOf(score), factors, score, weakest };
}

/**
 * The narrow slice of a tracker row `roiConfidenceOf` actually reads.
 *
 * Declared structurally so the score can be computed SERVER-side from facts a caller has already
 * assembled (the Case File builds its own product and target-pharmacy lists) without first
 * materialising a full `RoiTrackerRow`. Every `RoiTrackerRow` satisfies it, so no caller changes.
 */
export type RoiConfidenceInput = {
  dataCoverage: RoiTrackerRow["dataCoverage"];
  payDate: string | null;
  /** Only `.length` is read — one entry per target pharmacy. */
  pharmacies: readonly unknown[];
  products: ReadonlyArray<{ forecastQty: number }>;
  roiWindow: string | null;
  suspectPharmacyCount: number;
};

export function roiConfidenceOf(row: RoiConfidenceInput): RoiConfidence {
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
