/**
 * Production Planner — what a stock report actually stores.
 *
 * ── The owner's ruling, 2026-10-06 ──────────────────────────────────────────────────────────────
 *
 * He had 43 kg of ivy extract at EGPI, supplied 100 kg more, recorded it as a **Delivery** of 100,
 * and the planner then read **100 kg** instead of 143. Nothing was lost — every report is appended
 * and the newest one IS the current figure — but the one source whose plain meaning is "how much I
 * sent" was being stored as "what the balance is now".
 *
 * Asked which way it should read, he chose: **a delivery ADDS**. So `delivery` is the single
 * movement source — he types what he sent and the balance goes up by it — and `factory_report`,
 * `own_count` and `adjustment` stay what they have always been: a balance somebody counted, stored
 * exactly as typed.
 *
 * ── Why the arithmetic lives here and not in the service ────────────────────────────────────────
 *
 * So it can be tested without a database, and so the screen can show the same sum before saving
 * that the service will store. `tests/production-planning-stock-delivery.test.ts` pins both halves.
 */

/** Every value the `prodplan_stock_entries.source` CHECK allows, in the order the form lists them. */
export const STOCK_SOURCES = ["factory_report", "own_count", "delivery", "adjustment"] as const;

export type StockSource = (typeof STOCK_SOURCES)[number];

/** The one source that means a movement rather than a count. */
export const STOCK_MOVEMENT_SOURCE: StockSource = "delivery";

export function isStockSource(value: unknown): value is StockSource {
  return typeof value === "string" && (STOCK_SOURCES as readonly string[]).includes(value);
}

/**
 * Is this source a movement (added to what is held) rather than a balance (stored as typed)?
 *
 * Deliberately a function over the constant rather than `=== "delivery"` scattered about: the
 * service, the screen and the test all have to agree, and a second spelling is how they stop
 * agreeing.
 */
export function isStockMovement(source: StockSource): boolean {
  return source === STOCK_MOVEMENT_SOURCE;
}

/**
 * What goes in the `qty` column, given what was typed and what was already held.
 *
 * `previousQty` is the balance in force for that material at that location — zero when nothing has
 * ever been reported there. Both are base units (grams or pieces) in micro, as everything in this
 * module is.
 */
export function storedStockQty(args: {
  readonly source: StockSource;
  readonly typedQty: bigint;
  readonly previousQty: bigint;
}): bigint {
  return isStockMovement(args.source) ? args.previousQty + args.typedQty : args.typedQty;
}

/** The newest report standing on one lot. */
export type StandingLot = {
  readonly qty: bigint;
  readonly asOfDate: string;
};

/**
 * The two rows that move a lot to another expiry date.
 *
 * The expiry date is part of a lot's key, so a new report carrying the corrected date opens a SECOND
 * lot beside the old one and the held figure counts the material twice. Moving it therefore closes
 * the old lot at zero and opens the new one, in one insert, and the old report stays in the history.
 *
 * Each row carries a date no older than the report it must supersede. The load reads the newest
 * `as_of_date`, then the newest `created_at`, so a tie goes to these rows. If a lot already stands on
 * the new date the quantities add, because they are then one balance.
 */
export function expiryChangeRows(args: {
  readonly fromExpiryDate: string | null;
  readonly toExpiryDate: string | null;
  readonly from: StandingLot;
  readonly target: StandingLot | null;
}): { readonly expiryDate: string | null; readonly qty: bigint; readonly asOfDate: string }[] {
  const { from, target } = args;
  const asOfDate = target && target.asOfDate > from.asOfDate ? target.asOfDate : from.asOfDate;
  return [
    { asOfDate: from.asOfDate, expiryDate: args.fromExpiryDate, qty: BigInt(0) },
    { asOfDate, expiryDate: args.toExpiryDate, qty: from.qty + (target?.qty ?? BigInt(0)) },
  ];
}
