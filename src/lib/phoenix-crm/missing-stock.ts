/**
 * Phoenix CRM — the missing-stock board: which pharmacies said they do not have which product, as each
 * pharmacy last answered for that product. No I/O.
 *
 * Owner, 2026-10-02, one of the five reports he picked that day. Before it, the answers a rep records
 * at a pharmacy ("does this pharmacy have these products?", answered product by product since
 * 2026-09-24) were read in one place only — the customer's own card on the List, through
 * `groupCustomerPharmacies` (server/list.ts). This board reads the SAME grouping for a whole team: the
 * server feeds it one product at a time, keyed by territory and product, so the answer here is exactly
 * the answer the card would show — the latest visit wins, two spellings of one pharmacy are one
 * pharmacy, and the name shown is the latest spelling. Nothing about stock is decided twice.
 *
 * ## 🔴 A PHARMACY IS COUNTED AS A PHARMACY
 *
 * Never inside AM or PM, and never as a contact (the AM · PM · Pharmacies rule). Its answer was taken
 * on an AM or a PM visit, and which one does not change what is on the pharmacy's shelf.
 *
 * ## No sales figure, ever
 *
 * This is what the field SAW on the shelf. It reads no closing, no distributor file and no price —
 * every sales figure in Phoenix comes from the Monthly Closing and from nowhere else, and a shelf
 * answer beside a sales number would invite a reader to treat one as evidence for the other.
 *
 * ## "Chase the pharmacy stock"
 *
 * The next step a rep can commit to at the door (visit-outcome.ts). Each one is listed with when he
 * meant to do it, and a pharmacy short of a product shows when somebody has already promised to chase
 * it — a commitment, never a mark against anybody.
 */

import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";

/** One pharmacy's latest answer for one product, in one territory — `groupCustomerPharmacies`' output. */
export type StockAnswer = {
  seatId: string;
  product: string;
  /** The pharmacy as most recently spelled. */
  pharmacy: string;
  /** The grouping key (`normalizePharmacyName`), so a chase can find its pharmacy. */
  pharmacyKey: string;
  answer: "has" | "missing";
  /** When this product was last answered at this pharmacy (ISO instant). */
  lastReportedAt: string;
  /** How many visits answered this product at this pharmacy. */
  reports: number;
};

/** A visit whose next step was "Chase the pharmacy stock". */
export type StockChase = {
  /** The visit's own id — a row's key, never shown: two chases can share a day, a customer and a pharmacy. */
  visitId: string;
  seatId: string;
  visitDate: string;
  /** The day he meant to do it, when he gave one. */
  dueOn: string | null;
  /** The pharmacy the visit took its stock answers from, when it named one. */
  pharmacy: string | null;
  pharmacyKey: string | null;
  customerName: string;
  listType: PhoenixCrmListType;
};

export type MissingStockPharmacy = {
  seatId: string;
  territoryName: string;
  pharmacy: string;
  lastReportedAt: string;
  reports: number;
  /** Somebody already committed to chase this pharmacy's stock. */
  chasePromised: boolean;
};

export type MissingStockProduct = {
  product: string;
  /** The pharmacies whose latest answer is that they do not have it. */
  missing: MissingStockPharmacy[];
  /** The pharmacies whose latest answer is that they have it. */
  inStock: number;
};

export type MissingStockResult = {
  /** Products short somewhere first, the most pharmacies short first; then the products in stock everywhere asked. */
  products: MissingStockProduct[];
  chases: Array<StockChase & { territoryName: string }>;
  summary: {
    /** Pharmacies that answered for at least one product — each pharmacy once per territory. */
    pharmacies: number;
    /** Pharmacy and product pairs whose latest answer is "does not have it". */
    gaps: number;
    /** Products at least one pharmacy is short of. */
    productsShort: number;
    chases: number;
  };
};

export function buildMissingStock(
  answers: ReadonlyArray<StockAnswer>,
  chases: ReadonlyArray<StockChase>,
  territoryName: (seatId: string) => string,
): MissingStockResult {
  const promised = new Set(chases.filter((chase) => chase.pharmacyKey).map((chase) => `${chase.seatId}|${chase.pharmacyKey}`));
  const byProduct = new Map<string, MissingStockProduct>();
  const pharmacies = new Set<string>();
  let gaps = 0;

  for (const answer of answers) {
    pharmacies.add(`${answer.seatId}|${answer.pharmacyKey}`);
    const product: MissingStockProduct = byProduct.get(answer.product) ?? { product: answer.product, missing: [], inStock: 0 };
    if (answer.answer === "has") {
      product.inStock += 1;
    } else {
      gaps += 1;
      product.missing.push({
        seatId: answer.seatId,
        territoryName: territoryName(answer.seatId),
        pharmacy: answer.pharmacy,
        lastReportedAt: answer.lastReportedAt,
        reports: answer.reports,
        chasePromised: promised.has(`${answer.seatId}|${answer.pharmacyKey}`),
      });
    }
    byProduct.set(answer.product, product);
  }

  const products = [...byProduct.values()]
    .map((product) => ({
      ...product,
      // The latest answer first: a pharmacy that said so yesterday is the one to chase today.
      missing: [...product.missing].sort(
        (left, right) =>
          right.lastReportedAt.localeCompare(left.lastReportedAt) ||
          left.territoryName.localeCompare(right.territoryName) ||
          left.pharmacy.localeCompare(right.pharmacy),
      ),
    }))
    .sort((left, right) => right.missing.length - left.missing.length || left.product.localeCompare(right.product));

  return {
    products,
    chases: chases
      .map((chase) => ({ ...chase, territoryName: territoryName(chase.seatId) }))
      .sort(
        (left, right) =>
          (left.dueOn ?? "9999-12-31").localeCompare(right.dueOn ?? "9999-12-31") ||
          right.visitDate.localeCompare(left.visitDate) ||
          left.territoryName.localeCompare(right.territoryName),
      ),
    summary: {
      pharmacies: pharmacies.size,
      gaps,
      productsShort: products.filter((product) => product.missing.length > 0).length,
      chases: chases.length,
    },
  };
}
