// S1 Business Review — read-only service layer, multi-line (Pedia, CNS, ...).
// Loads the bundled, verified per-line dataset and exposes incentive-curve helpers.
// Incentive tiers come from the LOCKED 2026 scheme (imported, never modified).

import { calculateIncentive2026 } from "@/lib/incentives/scheme-2026";
import pediaData from "./data/pedia-s1.json";
import cnsData from "./data/cns-s1.json";
import antiData from "./data/anti-s1.json";
import companyData from "./data/company-s1.json";
import type { AreaSummary, DmSummary, ProductRow, S1Company, S1Dataset } from "./types";

export type S1Line = "pedia" | "cns" | "anti";
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

const DATASETS: Record<S1Line, S1Dataset> = {
  pedia: pediaData as unknown as S1Dataset,
  cns: cnsData as unknown as S1Dataset,
  anti: antiData as unknown as S1Dataset,
};

export function getS1Dataset(line: S1Line = "pedia"): S1Dataset {
  return DATASETS[line];
}

/** Cross-line company rollup — same for every line, drives the All Company tab. */
export function getS1Company(): S1Company {
  return companyData as unknown as S1Company;
}

/** Every area across all three lines, tagged with the line it belongs to. Derived
 * from the per-line datasets rather than duplicated into company-s1.json, so a line
 * fix can never drift from the consolidated view. */
export function getS1CompanyAreas(): (AreaSummary & { line: string; lineId: S1Line })[] {
  return S1_LINES.flatMap(({ id, label }) =>
    DATASETS[id].areas.map((a) => ({ ...a, line: label, lineId: id })),
  );
}

/** Every DM seat across all three lines. `keyProducts`/`families` come from that DM's
 * own line, since the product catalogue differs per line. Target-less catch-all
 * buckets ("Others") are excluded — they are unmanaged areas, not managers. */
export function getS1CompanyDms(): (DmSummary & {
  line: string;
  lineId: S1Line;
  keyProducts: string[];
  families: string[];
  visitsAvailable: boolean;
})[] {
  return S1_LINES.flatMap(({ id, label }) => {
    const ds = DATASETS[id];
    const keyProducts = ds.products.filter((p) => p.include).map((p) => p.product);
    const families = Array.from(new Set(ds.products.filter((p) => p.include).map((p) => p.family)));
    return ds.dms
      .filter((d) => d.allProducts.target > 0)
      .map((d) => ({ ...d, line: label, lineId: id, keyProducts, families, visitsAvailable: ds.visits.available }));
  });
}

/** Per-line product tables for the consolidated Deep Analysis. Kept per line (not
 * merged) because the three lines sell entirely different catalogues — merging their
 * product rows would imply a shared product set that does not exist. */
export function getS1CompanyProductTables(): { id: S1Line; label: string; products: ProductRow[] }[] {
  return S1_LINES.map(({ id, label }) => ({
    id,
    label,
    products: DATASETS[id].products.filter((p) => p.total.target > 0 || p.total.sales > 0),
  }));
}

/** Shared fail thresholds. Verified identical across all three lines (20% / 50%); if a
 * line ever diverges this throws rather than silently applying one line's rule to all. */
export function getS1CompanyThresholds(): { repFailBelow: number; dsmFailBelow: number } {
  const all = S1_LINES.map(({ id }) => DATASETS[id].meta.thresholds);
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
