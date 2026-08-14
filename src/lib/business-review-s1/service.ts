// S1 Business Review — read-only service layer, multi-line (Pedia, CNS, Anti-Infective).
//
// Every sales number here now comes from the canonical engine, loaded once per render by
// canonical.ts. This module is what the pages call: it loads that bundle and exposes the
// cross-line views and the incentive-curve helpers on top of it.
//
// Incentive tiers come from the LOCKED 2026 scheme (imported, never modified). Applying
// that curve to a RESTATED semester is why S1_RESTATEMENT_NOTICE exists — see canonical.ts.

import { calculateIncentive2026 } from "@/lib/incentives/scheme-2026";
import {
  loadS1CanonicalBundle,
  S1_RESTATEMENT_NOTICE,
  type S1CanonicalBundle,
  type S1Line,
} from "./canonical";
import type { AreaSummary, DmSummary, ProductRow, S1Company, S1Dataset } from "./types";

export type { S1Line };
export { S1_RESTATEMENT_NOTICE };
export type S1Review = S1CanonicalBundle;

export const S1_LINES: { id: S1Line; label: string }[] = [
  { id: "pedia", label: "Pedia" },
  { id: "cns", label: "CNS" },
  { id: "anti", label: "Anti-Infective" },
];

/** What the top switcher offers: the cross-line company rollup first (and default),
 * then each individual line. */
export type S1View = "company" | S1Line;
export const S1_VIEWS: { id: S1View; label: string }[] = [
  { id: "company", label: "All Company" },
  ...S1_LINES,
];
export const DEFAULT_S1_VIEW: S1View = "company";
export function isS1View(v: string | undefined): v is S1View {
  return !!v && S1_VIEWS.some((x) => x.id === v);
}

/**
 * Load the whole review — all three lines, the company rollup and the provenance block —
 * in ONE canonical range call.
 *
 * Call this once per render and pass the result down. Calling it per line would run the
 * attribution pass three times over the same six months, and every round trip crosses to
 * eu-central-1.
 */
export async function loadS1Review(): Promise<S1Review> {
  return loadS1CanonicalBundle();
}

export function getS1Dataset(review: S1Review, line: S1Line = "pedia"): S1Dataset {
  return review.datasets[line];
}

/** Cross-line company rollup — drives the All Company tab. */
export function getS1Company(review: S1Review): S1Company {
  return review.company;
}

/** Every area across all three lines, tagged with the line it belongs to. Derived from the
 * per-line datasets rather than duplicated into the company rollup, so a line fix can never
 * drift from the consolidated view. */
export function getS1CompanyAreas(review: S1Review): (AreaSummary & { line: string; lineId: S1Line })[] {
  return S1_LINES.flatMap(({ id, label }) =>
    review.datasets[id].areas.map((a) => ({ ...a, line: label, lineId: id })),
  );
}

/** Every DM seat across all three lines. `keyProducts`/`families` come from that DM's own
 * line, since the product catalogue differs per line. Target-less catch-all buckets are
 * excluded — they are unmanaged areas, not managers. */
export function getS1CompanyDms(review: S1Review): (DmSummary & {
  line: string;
  lineId: S1Line;
  keyProducts: string[];
  families: string[];
  visitsAvailable: boolean;
})[] {
  return S1_LINES.flatMap(({ id, label }) => {
    const ds = review.datasets[id];
    const keyProducts = ds.products.filter((p) => p.include).map((p) => p.product);
    const families = Array.from(new Set(ds.products.filter((p) => p.include).map((p) => p.family)));
    return ds.dms
      .filter((d) => d.allProducts.target > 0)
      .map((d) => ({ ...d, line: label, lineId: id, keyProducts, families, visitsAvailable: ds.visits.available }));
  });
}

/** Per-line product tables for the consolidated Deep Analysis. Kept per line (not merged)
 * because the three lines sell entirely different catalogues — merging their product rows
 * would imply a shared product set that does not exist. */
export function getS1CompanyProductTables(review: S1Review): { id: S1Line; label: string; products: ProductRow[] }[] {
  return S1_LINES.map(({ id, label }) => ({
    id,
    label,
    products: review.datasets[id].products.filter((p) => p.total.target > 0 || p.total.sales > 0),
  }));
}

/** Shared fail thresholds. Verified identical across all three lines (20% / 50%); if a line
 * ever diverges this throws rather than silently applying one line's rule to all. */
export function getS1CompanyThresholds(review: S1Review): { repFailBelow: number; dsmFailBelow: number } {
  const all = S1_LINES.map(({ id }) => review.datasets[id].meta.thresholds);
  const first = all[0];
  const same = all.every((t) => t.repFailBelow === first.repFailBelow && t.dsmFailBelow === first.dsmFailBelow);
  if (!same) {
    throw new Error(
      "S1 lines have diverging fail thresholds; the consolidated company view needs an explicit rule: " +
        JSON.stringify(all),
    );
  }
  return first;
}

/** Payout % for an achievement %, straight from the locked 2026 curve. */
export function payoutPercentageFor(achievement: number | null): number {
  if (achievement == null) return 0;
  return calculateIncentive2026({ achievementPercent: achievement }).payoutPercentage;
}

export type IncentiveBand = "not-eligible" | "threshold" | "on-target" | "over-achiever" | "elite";
export function bandFor(achievement: number | null): IncentiveBand {
  if (achievement == null || achievement < 90) return "not-eligible";
  if (achievement < 100) return "threshold";
  if (achievement < 120) return "on-target";
  if (achievement < 150) return "over-achiever";
  return "elite";
}
export const BAND_LABEL: Record<IncentiveBand, string> = {
  "not-eligible": "Below threshold",
  threshold: "Threshold 90–100%",
  "on-target": "On target 100–120%",
  "over-achiever": "Over-achiever 120–150%",
  elite: "Elite 150%+",
};
