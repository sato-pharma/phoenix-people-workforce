/**
 * The weights a product SHOWS — its batch in the large unit and its tablet in the small one — when the
 * paper's figures cannot be the engine's integer geometry.
 *
 * Owner, 2026-11-11, on Royafloxacin 500 at Medizen: 80,000 tablets, a 847.6 mg tablet (Medizen's
 * paper; the email's 845.6 was the typo) and a batch "equivalent" of 70 kg, chosen as a multiple
 * choice: "847.6 mg, 70 kg as stated". The engine counts `run_volume_ml / dose_ml`, both INTEGERS
 * with `run_volume_ml % dose_ml = 0` behind them, so a 847.6 mg tablet cannot be stored and 80,000 of
 * them are 67.808 kg, not 70. The count therefore stays on the core (80,000 × 815 mg) and these two
 * columns carry the figures he reads: `prodplan_products.batch_weight_display` (kg) and
 * `unit_weight_display` (mg), from `20261111133400`.
 *
 * 🔴 They are LABELS ONLY. Nothing that counts may read them: every formula line is per tablet, per
 * box, per strip or per sample, never per kilogram of batch, which is exactly why showing 70 kg
 * moves no quantity. A null shows the geometry, so every product without them reads as it always did.
 *
 * STRING arithmetic through the module's micro units, never floating point: 847.6 × 2 in doubles is
 * 1695.2 today and something else for the next figure.
 */
import { formatQty, parseQty } from "./rules";

export type DisplayWeightSource = {
  readonly doseMl: string;
  readonly goodUnitMl: string;
  readonly sampleUnitMl: string;
  readonly batchWeightDisplay?: string | null;
  readonly unitWeightDisplay?: string | null;
};

/** The dose, the saleable unit and the sample as he reads them, in the small unit. */
export function shownUnitWeights(product: DisplayWeightSource): { dose: string; goodUnit: string; sampleUnit: string } {
  if (!product.unitWeightDisplay) {
    return { dose: product.doseMl, goodUnit: product.goodUnitMl, sampleUnit: product.sampleUnitMl };
  }
  const perDose = parseQty(product.unitWeightDisplay, "unitWeightDisplay");
  const dose = BigInt(product.doseMl);
  // Scaled by how many doses each one holds: a tablet is one dose, Royafloxacin's sample box two.
  const scaled = (geometry: string) => formatQty((perDose * BigInt(geometry)) / dose);
  return {
    dose: formatQty(perDose),
    goodUnit: scaled(product.goodUnitMl),
    sampleUnit: scaled(product.sampleUnitMl),
  };
}

/** One batch as he reads it, in the large unit — the stated figure, or the geometry's own. */
export function shownBatchWeight(product: DisplayWeightSource, fromGeometry: string): string {
  return product.batchWeightDisplay ? formatQty(parseQty(product.batchWeightDisplay, "batchWeightDisplay")) : fromGeometry;
}

/** A whole number of batches as he reads it — the stated batch times the runs, or the geometry's own. */
export function shownTotalWeight(product: DisplayWeightSource, runs: bigint | string, fromGeometry: string): string {
  if (!product.batchWeightDisplay) return fromGeometry;
  return formatQty(parseQty(product.batchWeightDisplay, "batchWeightDisplay") * BigInt(runs));
}
