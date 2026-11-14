/**
 * The weekly rows after re-pricing and de-cumulation, worked out ONCE per cached load and price list,
 * and handed to every viewer as their own copies.
 *
 * 🔴 WHY (12 Nov 2026, 14:33 Cairo, read from production's logs on 14 Nov): nine Medical Reps opened
 * Weekly Stock within six seconds and the server froze for 3.1 s. The raw rows came from the in-process
 * cache (row-cache.ts), but every one of the nine then re-priced, de-cumulated and gap-checked the same
 * 66,526 rows — the same answer nine times, measured at ~1 s of unbroken work for six of them back to
 * back on the laptop. Re-pricing and de-cumulation depend on nothing about the viewer: only on the rows
 * and the Product Master prices. So the result is kept beside the cached rows it came from and reused
 * while the prices are the same.
 *
 * What keeps it correct:
 *   • It is keyed on the cached load ITSELF (the array row-cache.ts stores), so a write, a new batch,
 *     the 60 s lifetime or an eviction — anything that gives the rows cache a new entry — gives this a
 *     new key. Held in a WeakMap: when the rows cache lets go of an entry, this lets go too.
 *   • It is checked against a fingerprint of exactly what re-pricing reads (each product's code and
 *     factory price, and every dated price), so a price edit re-derives at once, as before.
 *   • Every caller gets fresh shallow copies of the rows and the gaps, the same contract the rows cache
 *     keeps, because callers downstream may write to a row.
 *   • Callers that arrive while the work runs wait for that same work instead of starting their own.
 */

import type { DepotWeekGap } from "@/lib/sales/weekly/decumulate";

export type DerivedWeeklyRows<Row> = { realRows: Row[]; depotGaps: DepotWeekGap[] };

type Remembered = { fingerprint: string; pending: Promise<DerivedWeeklyRows<object>> };

const remembered = new WeakMap<object, Remembered>();

/** What re-pricing reads from the Product Master, as one string. Small: a few hundred products. */
export function weeklyPriceFingerprint(
  products: readonly { productCode: unknown; factoryPrice: unknown }[] | null,
  overrides: readonly { productCode: unknown; effectivePeriod: unknown; factoryPrice: unknown }[] | null,
): string {
  if (!products) return "no-master";
  const base = products.map((product) => `${String(product.productCode ?? "")}=${String(product.factoryPrice ?? "")}`).sort();
  const dated = (overrides ?? [])
    .map((row) => `${String(row.productCode ?? "")}@${String(row.effectivePeriod ?? "")}=${String(row.factoryPrice ?? "")}`)
    .sort();
  return `${base.join(";")}#${dated.join(";")}`;
}

/**
 * Run `derive` once per cached load and price fingerprint; every caller gets its own copies. A derive
 * that throws is forgotten, so the next caller tries again.
 */
export async function shareDerivedWeeklyRows<Row extends object>(
  source: object,
  fingerprint: string,
  derive: () => Promise<DerivedWeeklyRows<Row>>,
): Promise<DerivedWeeklyRows<Row> & { shared: boolean }> {
  let entry = remembered.get(source);
  let shared = true;
  if (!entry || entry.fingerprint !== fingerprint) {
    shared = false;
    const pending = derive() as Promise<DerivedWeeklyRows<object>>;
    const mine: Remembered = { fingerprint, pending };
    entry = mine;
    remembered.set(source, mine);
    pending.catch(() => {
      if (remembered.get(source) === mine) remembered.delete(source);
    });
  }
  const result = (await entry.pending) as DerivedWeeklyRows<Row>;
  return {
    realRows: result.realRows.map((row) => ({ ...row })),
    depotGaps: result.depotGaps.map((gap) => ({ ...gap })),
    shared,
  };
}
