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

/**
 * The two rows that MOVE an amount from one lot to another — between two stores, or from a material
 * it was entered on by mistake to the right one (owner, 2026-11-11, after both happened in one night:
 * Saginkgo's stock went to the factory and the rest to Sato's store, and 576.885 kg of Saginkgo's foil
 * sat on Guamusin's sachet film).
 *
 * Append-only like every stock report: the source lot is written again with what is left, the target
 * with what it held plus the amount, and both old reports stay in the history. Each row is dated no
 * earlier than the newest report standing on EITHER lot, because the load reads the newest
 * `as_of_date` first and an older-dated row would lose to the report it means to replace.
 *
 * `null` when there is nothing to move: a zero, or more than the source lot holds. Moving more than
 * is there would invent stock in the target and leave a negative nobody counted in the source.
 */
export function moveStockRows(args: {
  readonly from: StandingLot;
  readonly target: StandingLot | null;
  readonly qty: bigint;
  readonly asOfDate: string;
}): { readonly from: StandingLot; readonly to: StandingLot } | null {
  const { from, target, qty } = args;
  if (qty <= BigInt(0) || qty > from.qty) return null;
  const asOfDate = [args.asOfDate, from.asOfDate, target?.asOfDate ?? ""].reduce((latest, date) =>
    date > latest ? date : latest,
  );
  return {
    from: { asOfDate, qty: from.qty - qty },
    to: { asOfDate, qty: (target?.qty ?? BigInt(0)) + qty },
  };
}

// ── Reversing one wrong entry (owner, 2026-11-24) ────────────────────────────────────────────────
//
// Dr. Sahar asked how she could put right an entry she typed by mistake — the 576 kg of foil at
// Sato's warehouse needed a database write to undo. A reversal is a NEW row that puts the lot back
// to the balance it held before that entry: nothing is deleted, and the wrong entry stays readable.
//
// Three entries cannot be reversed this way, each for a reason a person can act on:
//   - one written by a PRODUCTION — the production is cancelled from the Execution tab instead, which
//     gives back every lot it drew on at once;
//   - one written TOGETHER with another row (a move between stores, a change of expiry date, a
//     production's lots): those rows share one insert and one timestamp, and reversing one half
//     would leave the other standing — the move is made back instead;
//   - one that is no longer the NEWEST row of its lot: a later count has already replaced it, so
//     "before it" is no longer what the lot holds — a new count is typed instead;
//   - a COUNT typed right after a production: going back would land on the production's own row and
//     leave that production's opening figure standing on the count — a new count is typed instead,
//     which asks whether it is from before the production or after it. A delivery is fine: it only
//     added on top of the production's balance.

export type StockHistoryRow = {
  readonly id: string;
  readonly materialId: string;
  readonly locationId: string;
  readonly expiryDate: string | null;
  readonly qty: bigint;
  readonly asOfDate: string;
  readonly source: string;
  readonly createdAt: string;
};

export type StockReversalRefusal = "notFound" | "production" | "paired" | "notNewest" | "afterProduction";

export type StockReversal =
  | { readonly ok: true; readonly restoreQty: bigint }
  | { readonly ok: false; readonly reason: StockReversalRefusal };

function newestFirst(a: StockHistoryRow, b: StockHistoryRow): number {
  if (a.asOfDate !== b.asOfDate) return a.asOfDate < b.asOfDate ? 1 : -1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return 0;
}

/** Whether `entryId` can be reversed, and the balance its lot goes back to. Rows may come in any order. */
export function stockReversal(rows: readonly StockHistoryRow[], entryId: string): StockReversal {
  const entry = rows.find((row) => row.id === entryId);
  if (!entry) return { ok: false, reason: "notFound" };
  if (entry.source === "production") return { ok: false, reason: "production" };
  if (rows.some((row) => row.id !== entry.id && row.createdAt === entry.createdAt)) {
    return { ok: false, reason: "paired" };
  }
  const lot = rows
    .filter(
      (row) =>
        row.materialId === entry.materialId &&
        row.locationId === entry.locationId &&
        row.expiryDate === entry.expiryDate,
    )
    .slice()
    .sort(newestFirst);
  if (lot[0]?.id !== entry.id) return { ok: false, reason: "notNewest" };
  if (lot[1]?.source === "production" && entry.source !== STOCK_MOVEMENT_SOURCE) {
    return { ok: false, reason: "afterProduction" };
  }
  return { ok: true, restoreQty: lot[1]?.qty ?? BigInt(0) };
}
