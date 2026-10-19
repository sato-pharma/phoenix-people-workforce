import { priceBasketLine } from "@/lib/direct-orders/basket-value";
import { codeNameLabel } from "@/lib/direct-orders/geo-names";
import { describeReturnedDirectOrderWait } from "@/lib/direct-orders/status-labels";
import { venueRequiresDistributorCode, venueTypeLabel } from "@/lib/venues/venue-type";
import type {
  DirectOrderApprovalDetail,
  DirectOrderAreaRep,
  DirectOrderPharmacyGeo,
  DirectOrderRequest,
  DirectOrderRequestItem,
  DirectOrderRetailHistoryRow,
  DirectOrderStepState,
} from "@/lib/direct-orders/types";

// ─────────────────────────────────────────────────────────────────────────────
// THE field list for the Direct Order approval window, and the matching notification text.
//
// This lives in the domain, not in a component, for a concrete reason: the admin approval
// screen and the employee-portal approval screen each hand-maintained their own field array,
// which is exactly how BOTH ended up printing raw brick/area codes. One list, two renderers.
//
// Values are plain strings — framework-free and trivially testable. The only field a component
// still owns is Bonus/Discount, which needs an over-cap colour treatment.
// ─────────────────────────────────────────────────────────────────────────────

export type DirectOrderDetailField = {
  label: string;
  value: string;
  /** "full" = render below the grid, full width (long free text or a sub-table). */
  layout?: "full";
};

const DASH = "—";

/**
 * Money, with NULL rendered as a dash rather than as zero.
 *
 * The null check is explicit and comes FIRST because `Number(null)` is `0`, which passes
 * `Number.isFinite` — so the obvious one-liner prints an unset price as "0 EGP". On the screen
 * where an order is approved, "0 EGP" and "not set" are completely different statements, and
 * this shipped that way once (an unset public price read as zero on a live bonus order).
 */
const money = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return DASH;
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} EGP` : DASH;
};
/** Same null-before-Number ordering as `money`, for the same reason. */
const units = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return DASH;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : DASH;
};
const text = (value: string | null | undefined): string => (value ?? "").trim() || DASH;
const dateOnly = (value: string | null | undefined): string => (value ? String(value).slice(0, 10) : DASH);

/**
 * How a medical rep reads on screen.
 *
 * The three outcomes are genuinely different and must not be collapsed: an unresolved (line,
 * area) means the seat model cannot answer, which is "—". A seat that exists with nobody in it
 * is a real, reportable vacancy. Only an occupied seat yields a name.
 */
export function formatMedicalRep(rep: DirectOrderAreaRep | null | undefined): string {
  if (!rep || !rep.resolved) return DASH;
  if (rep.isVacant || !rep.repName) return "Vacant";
  return rep.repName;
}

/** The deal line — the one field a component re-renders itself so it can colour an over-cap value. */
export function formatDealValue(request: Pick<DirectOrderRequest, "dealType" | "discountPct" | "bonus">): string {
  return request.dealType === "discount"
    ? `${(request.discountPct ?? 0).toLocaleString("en-US")}%`
    : units(request.bonus);
}

/** Label for that field. */
export function dealFieldLabel(request: Pick<DirectOrderRequest, "dealType">): string {
  return request.dealType === "discount" ? "Discount" : "Bonus";
}

/**
 * The deal figure carrying its OWN kind — for tables, where one fixed column header cannot.
 *
 * A detail view pairs dealFieldLabel with formatDealValue, so it always reads "Discount: 20%".
 * A table has a single header, and both approval lists headed theirs "Bonus" while feeding a
 * discount deal's PERCENTAGE into it — so a 20% discount rendered as "20%" under the word Bonus
 * and read as a 20% giveaway. The number and its kind must therefore travel together here.
 */
export function formatDealValueLabelled(
  request: Pick<DirectOrderRequest, "dealType" | "discountPct" | "bonus">,
): string {
  return request.dealType === "discount"
    ? `${formatDealValue(request)} discount`
    : `${formatDealValue(request)} bonus`;
}

/**
 * What the order is, in one line: every product with ITS OWN quantity.
 *
 * A basket's request row is line 1 only, so the approval window's header read "Lacto Advanced 1 ×
 * 240" over an order that was also asking for 240 of Advanced 2 — the approver saw half the order as
 * the whole (code review, 19 Oct 2026). The units are listed per product and never summed: units of
 * different products are never added (owner rule).
 */
export function describeDirectOrderProducts(
  request: Pick<DirectOrderRequest, "productName" | "qty">,
  items?: readonly { productName: string; qty: number }[] | null,
): string {
  return items && items.length > 1
    ? items.map((item) => `${item.productName} × ${units(item.qty)}`).join(" + ")
    : `${request.productName} × ${units(request.qty)}`;
}

/** One basket line as the approval window's tiles and price rows state it. */
export type DirectOrderBasketLineView = {
  lineNo: number;
  productName: string;
  qty: number;
  /** "40 bonus" / "20% discount" — the number with its kind, because a basket's lines can mix. */
  deal: string;
  overCap: boolean;
  /**
   * Each price as THIS line knows it, and whether it priced THIS line. A null value on the basis
   * that did not price the line means "not used", never "not set" — a discount line stores no
   * pharmacy price at all.
   */
  pharmacyPrice: { value: number | null; used: boolean };
  publicPrice: { value: number | null; used: boolean };
};

/**
 * The basket's lines for the approval window — null for a one-product order, which keeps the
 * request-level tiles it always had.
 *
 * The window's Quantity and Deal tiles and its two price rows read the request row, which on a
 * basket is line 1 only: a Lacto Advanced 1 + 2 order showed line 1's quantity, deal and prices as
 * if they were the whole order. Each line now speaks for itself. The product's CURRENT price is
 * loaded for the request's own product alone, so only that line can fall back to it.
 */
export function describeDirectOrderBasketLines(
  detail: Pick<DirectOrderApprovalDetail, "request" | "items" | "productPharmacyPrice" | "productPublicPrice">,
): DirectOrderBasketLineView[] | null {
  const items = detail.items ?? [];
  if (items.length <= 1) return null;
  return items.map((item) => {
    const isRequestProduct = item.productCode === detail.request.productCode;
    return {
      lineNo: item.lineNo,
      productName: item.productName,
      qty: item.qty,
      deal: formatDealValueLabelled(item),
      overCap: item.overCap,
      pharmacyPrice: {
        value: item.pharmacyPriceSnapshot ?? (isRequestProduct ? detail.productPharmacyPrice : null),
        used: item.dealType === "bonus",
      },
      publicPrice: {
        value: item.publicPriceSnapshot ?? (isRequestProduct ? detail.productPublicPrice : null),
        used: item.dealType === "discount",
      },
    };
  });
}

/**
 * Labels the approval window must ALWAYS carry.
 *
 * This is the machine-checked completeness bar: the approved-order email has always shown the
 * full picture while the approval window — the screen where the decision is actually made —
 * showed a subset. A test asserts every label here appears in the built field list, so the two
 * can never drift apart again.
 */
export const DIRECT_ORDER_CORE_FIELD_LABELS: readonly string[] = [
  "Request ID",
  "Requester",
  "Line",
  "Product",
  "Sato product code",
  "Status",
  "Deal type",
  "Venue",
  "Sato venue code",
  "Doctor",
  "Brick",
  "Area",
  "Region",
  "Medical rep",
  "Collection date",
  "Sales month",
  "Venue address",
  "Distributor codes",
  "Venue registered by",
] as const;

/**
 * Every detail an approver needs, in reading order.
 *
 * Short scalars first (they render in a grid); long free text and the distributor list are
 * marked `layout: "full"` so a component can place them below it rather than blowing the grid.
 * Finance fields appear only once they hold a value — an approver should not read three empty
 * rows on a request that has not been collected yet.
 */
export function buildDirectOrderDetailFields(detail: DirectOrderApprovalDetail): DirectOrderDetailField[] {
  const { request, requesterName, pharmacy, geo, medicalRep } = detail;

  // A BASKET is more than one line. The singular fields on the request describe line 1 only, so
  // showing them alone to an approver deciding a multi-line order would hide money they are
  // approving. `items` always holds at least one line, so a one-line order takes the same path.
  const items = detail.items ?? [];
  const isBasket = items.length > 1;

  // EVERY core label is emitted on both paths. DIRECT_ORDER_CORE_FIELD_LABELS is the machine-checked
  // completeness bar between this window and the approved-order email, and an earlier cut of this
  // change swapped "Product" / "Sato product code" / "Deal type" out for a basket — which the suite
  // did not catch, because no fixture builds a basket. Summarising them is right; dropping them is
  // how the two surfaces drift apart again.
  const productSummary = isBasket
    ? items.map((item) => item.productName).join(" + ")
    : codeNameLabel(request.productName, request.productCode);
  const codeSummary = isBasket ? items.map((item) => item.productCode).join(" + ") : text(request.productCode);
  // A one-line order reads its deal type from the REQUEST, exactly as it always did. Deriving it
  // from the line instead looked equivalent — the service writes both from the same resolved line —
  // but it is not: it makes this function disagree with the request whenever the two are out of
  // step, and the suite caught precisely that. Only a basket needs the derived answer, because only
  // a basket can mix.
  const dealTypes = new Set(items.map((item) => item.dealType));
  const dealTypeLabel = !isBasket
    ? request.dealType === "discount"
      ? "Discount"
      : "Bonus"
    : dealTypes.size > 1
      ? "Mixed"
      : items[0].dealType === "discount"
        ? "Discount"
        : "Bonus";

  const fields: DirectOrderDetailField[] = [
    { label: "Request ID", value: request.id },
    { label: "Requester", value: `${requesterName} · ${request.requesterHrId} · ${request.requesterRole}` },
    { label: "Line", value: text(request.line) },
    { label: "Product", value: productSummary },
    // The company's own product code, given its own field rather than left in a parenthesis —
    // the owner reads it as a value in its own right, not as a decoration on the name.
    { label: "Sato product code", value: codeSummary },
    { label: "Status", value: request.status.replace(/_/g, " ") },
    { label: "Deal type", value: dealTypeLabel },
    // A basket's lines each carry their own quantity, so one number cannot stand for them; the
    // per-line block below is where those live. A single-line order keeps the field it always had.
    ...(isBasket ? [] : [{ label: "Quantity", value: units(request.qty) }]),
    { label: isBasket ? "Sales value (total)" : "Sales value", value: money(request.salesValue) },
  ];

  if (isBasket) {
    // One row per line, each with its own quantity, deal and money — because each of those can
    // differ between concentrations. The count is in the label so an approver reading quickly
    // cannot mistake the first line for the whole order.
    fields.push({
      label: `Products (${items.length})`,
      value: items
        .map((item) => {
          const deal =
            item.dealType === "discount" ? `${item.discountPct ?? 0}% discount` : `${units(item.bonus)} bonus`;
          const flag = item.overCap ? " · over cap" : "";
          return `${codeNameLabel(item.productName, item.productCode)} — ${units(item.qty)} · ${deal} · ${money(item.salesValue)}${flag}`;
        })
        .join("\n"),
      layout: "full",
    });
  }

  // BOTH prices are always shown, not just the one that priced this deal. Which basis was used
  // is stated explicitly, so an approver never has to infer it from which field is present.
  //
  // "not set" and "0 EGP" must never be confused: a price that was never entered is a data gap,
  // a price of zero would be a free product. `priceWithNote` keeps those distinct on every branch.
  const priceWithNote = (value: number | null | undefined, note: string): string =>
    value == null ? `${DASH} (not set — ${note})` : `${money(value)} (${note})`;

  /**
   * The basis that did NOT price this deal.
   *
   * A null snapshot here means "not applicable", NOT "no price exists" — and conflating those
   * shipped a real bug: a discount order read "Pharmacy price — not set" for a product whose
   * pharmacy price was 281.688, telling the owner the price he had just saved had vanished.
   * Fall back to the product's CURRENT price so a saved price is always visible, and reserve
   * "not set" for a product that genuinely has none.
   */
  const unusedPrice = (snapshot: number | null, current: number | null, why: string): string => {
    const value = snapshot ?? current;
    if (value == null) return `${DASH} (not set — ${why})`;
    return `${money(value)} (on file, ${why})`;
  };

  fields.push({
    label: "Pharmacy price",
    value:
      request.dealType !== "bonus"
        ? unusedPrice(request.pharmacyPriceSnapshot, detail.productPharmacyPrice, "not used — discount deal")
        : request.pharmacyPriceSnapshot == null
          ? `${DASH} (not set)`
          : `${money(request.pharmacyPriceSnapshot)} (used for this deal)`,
  });
  fields.push({
    label: "Public price",
    value:
      request.dealType === "discount"
        ? priceWithNote(request.publicPriceSnapshot, "used for this deal")
        : unusedPrice(request.publicPriceSnapshot, detail.productPublicPrice, "not used — bonus deal"),
  });
  if (request.dealType === "discount") {
    fields.push({ label: "Discount %", value: `${(request.discountPct ?? 0).toLocaleString("en-US")}%` });
  }

  fields.push(
    { label: "Venue", value: codeNameLabel(pharmacy?.pharmacyName, pharmacy?.phoenixPharmacyCode) },
    { label: "Sato venue code", value: text(pharmacy?.phoenixPharmacyCode) },
    { label: "Doctor", value: text(pharmacy?.doctorName) },
    // Three separate fields, never a combined "Brick / Area" cell — cramming two geographies
    // into one value is what forced the bare-code "a / b" format this replaces.
    { label: "Brick", value: codeNameLabel(geo.brick?.name, geo.brick?.code) },
    { label: "Area", value: codeNameLabel(geo.area?.name, geo.area?.code) },
    { label: "Region", value: codeNameLabel(geo.region?.name, geo.region?.code) },
    { label: "Medical rep", value: formatMedicalRep(medicalRep) },
    { label: "Collection date", value: dateOnly(request.collectionDate) },
    // Finance books this now, so the old "(set on final approval)" copy was stale the moment
    // the month stopped being derived from the approval date.
    { label: "Sales month", value: request.salesMonth ?? `${DASH} (not booked into a month yet)` },
    { label: "Submitted", value: dateOnly(request.createdAt) },
    // A name, not the bare HR-ID (owner rule) — falls back to the id only if the directory has
    // no name for it, same fallback shape as requesterName.
    { label: "Venue registered by", value: text(detail.pharmacyRegisteredByName ?? pharmacy?.createdByHrId) },
    { label: "Venue status", value: pharmacy ? (pharmacy.active ? "Active" : "Inactive") : DASH },
    // "Geography check" was REMOVED here on 2026-08-08, not merely hidden by one screen.
    //
    // It read `geoVarianceResolved` and printed "Resolved" or "Not flagged" — one string covering
    // three opposite situations: checked and agreeing, never checked, and not checkable at all.
    // "Not flagged" reads as a pass and most often meant nobody had looked.
    //
    // It is replaced by `DirectOrderApprovalDetail.geographyCheck` (see geography-check.ts), which
    // actually compares the distributor's own recorded brick/area against the brick/area declared on
    // the request and against the typed address, and returns four distinct verdicts.
    //
    // Deleted from the shared field list rather than filtered out by the admin component, because
    // the PORTAL renders this same list — so hiding it in one place left District/Regional/National
    // Sales Managers still reading "Not flagged" on the screen they actually work in.
  );

  // Conditional — only once they carry a value.
  if (request.decidedAt) fields.push({ label: "Decided", value: dateOnly(request.decidedAt) });
  if (request.paymentDate) fields.push({ label: "Payment date", value: dateOnly(request.paymentDate) });
  if (request.paidAmount != null) fields.push({ label: "Paid", value: money(request.paidAmount) });
  if (request.remainingAmount != null) fields.push({ label: "Remaining", value: money(request.remainingAmount) });
  if (request.marketingRequestId) fields.push({ label: "Marketing request", value: request.marketingRequestId });
  if (request.reversalOfRequestId) fields.push({ label: "Reversal of", value: request.reversalOfRequestId });
  if (request.reversedByRequestId) fields.push({ label: "Reversed by", value: request.reversedByRequestId });
  if (request.sosBatchId) fields.push({ label: "Sales batch", value: request.sosBatchId });

  // Full-width: the long free text, and the distributor list (a component renders the pairs as
  // a sub-table; this string is the accessible/plain-text form of the same data).
  fields.push(
    { label: "Venue address", value: text(pharmacy?.pharmacyAddress), layout: "full" },
    { label: "Distributor codes", value: text(detail.distributorCodesText), layout: "full" },
  );

  return fields;
}

// ── Notification text ────────────────────────────────────────────────────────

export type DirectOrderNotifyContext = {
  request: DirectOrderRequest;
  requesterName: string;
  pharmacyName: string;
  pharmacyCode: string;
  geo: DirectOrderPharmacyGeo;
  medicalRep: DirectOrderAreaRep | null;
  /** "Ibn Sina: 1234567; Overseas: 7654321" — the full pairs, for the email table. */
  distributorCodesText: string;
  /** "Ibn Sina · Overseas" — names only, for the length-bounded one-liner. */
  distributorNames: string;
  /**
   * The request's lines, when the caller has them.
   *
   * OPTIONAL, and that is a deliberate trade rather than laziness. Several notify sites build this
   * context from a request row they already hold and would otherwise pay an extra read per order —
   * the held-notice sweep runs over every held order at once. When absent the one-liner falls back
   * to the request's own product, which is exactly right for the one-line orders those sweeps
   * actually cover. The SUBMIT path, where a basket is first seen by an approver, passes them.
   */
  items?: readonly { productName: string; qty: number }[];
};

/**
 * The upper bound for a notification `message`.
 *
 * Telegram is the binding constraint, not email: `cleanTelegramText` collapses ALL whitespace
 * to single spaces and then hard-slices at 900 characters with no ellipsis and no warning, and
 * the transport prepends a "Module: Direct orders" line of its own. So the body must be one
 * dense line with real headroom — hence names-only distributors here, with the full
 * distributor→customer-code pairs carried by the email metrics table instead.
 */
export const DIRECT_ORDER_NOTIFICATION_MAX_CHARS = 700;

function repLabel(rep: DirectOrderAreaRep | null): string {
  return formatMedicalRep(rep ?? undefined);
}

function geoSentence(geo: DirectOrderPharmacyGeo): string {
  const brick = geo.brick?.name || geo.brick?.code || DASH;
  const area = geo.area?.name || geo.area?.code || DASH;
  const region = geo.region?.name || geo.region?.code || DASH;
  return `Brick ${brick} · Area ${area} · Region ${region}`;
}

function dealSummary(request: DirectOrderRequest): string {
  return request.dealType === "discount"
    ? `discount ${request.discountPct ?? 0}%`
    : `bonus ${units(request.bonus)} units`;
}

/** One dense line naming the pharmacy, its geography, its rep and its distributors. */
export function buildDirectOrderNotificationLine(ctx: DirectOrderNotifyContext): string {
  const { request } = ctx;
  // A basket names every product, because "Lacto Advanced 1 × 100" for an order that is also
  // buying Advanced 2 tells the approver something false about what they are being asked to
  // approve. Bounded by DIRECT_ORDER_NOTIFICATION_MAX_CHARS below, as the whole line always was.
  const productSummary = describeDirectOrderProducts(request, ctx.items);

  const parts = [
    `${ctx.requesterName} submitted ${productSummary}`,
    `for ${codeNameLabel(ctx.pharmacyName, ctx.pharmacyCode)}`,
    `— ${money(request.salesValue)}, ${dealSummary(request)}.`,
    `${geoSentence(ctx.geo)} · Medical rep ${repLabel(ctx.medicalRep)}.`,
    ctx.distributorNames ? `Distributors: ${ctx.distributorNames}.` : "",
    "Needs your approval.",
  ].filter(Boolean);
  return parts.join(" ").slice(0, DIRECT_ORDER_NOTIFICATION_MAX_CHARS);
}

/** The same context as a label/value table for the notification EMAIL (full pairs included). */
export function buildDirectOrderNotificationMetrics(
  ctx: DirectOrderNotifyContext,
): Array<{ label: string; value: string }> {
  const { request } = ctx;
  return [
    { label: "Requester", value: `${ctx.requesterName} · ${request.requesterRole}` },
    { label: "Product", value: codeNameLabel(request.productName, request.productCode) },
    { label: "Quantity", value: units(request.qty) },
    { label: dealFieldLabel(request), value: formatDealValue(request) },
    { label: "Sales value", value: money(request.salesValue) },
    { label: "Venue", value: codeNameLabel(ctx.pharmacyName, ctx.pharmacyCode) },
    { label: "Brick", value: codeNameLabel(ctx.geo.brick?.name, ctx.geo.brick?.code) },
    { label: "Area", value: codeNameLabel(ctx.geo.area?.name, ctx.geo.area?.code) },
    { label: "Region", value: codeNameLabel(ctx.geo.region?.name, ctx.geo.region?.code) },
    { label: "Medical rep", value: repLabel(ctx.medicalRep) },
    // Not `text(...)`: a bare dash here reads as "the email failed to include the distributor".
    // Since codes became optional (2026-08-04) an empty list is a normal state, and the approver
    // reading this on a phone has nothing else to tell them which of the two it is.
    { label: "Distributor codes", value: ctx.distributorCodesText.trim() || "none on file — distributor sales cannot be linked to this venue" },
    { label: "Collection date", value: dateOnly(request.collectionDate) },
  ];
}

// ── The sales-history matrix (owner request, 2026-08-08) ──────────────────────────────────────
//
// "show it like a table products/months in rows or columns, every cell then shows units sold in
// this product in this month from which distributor."
//
// RETAIL ONLY, deliberately. A direct order carries no distributor of its own, so per-cell
// distributor attribution on that side would be invented — and until 2026-08-08 it literally was:
// each order was fanned across every code the pharmacy had, counting it N times at full value.
// Direct sales keep their own section, without a distributor column.
//
// Pure: the rows are already filtered for confidentiality and line scope server-side before they
// reach here (resolveHistoryVisibility), so this only reshapes what the viewer is allowed to see.

export type DirectOrderMatrixCell = {
  units: number;
  bonus: number;
  /** Which distributor(s) supplied it that month — the owner asked for this per cell. */
  distributors: string[];
};

export type DirectOrderSalesMatrix = {
  /** Months oldest → newest, so the eye reads a trend left to right. */
  months: string[];
  /** One row per product, ordered by total units desc — the biggest relationship first. */
  products: Array<{
    productCode: string;
    productName: string;
    /** Same length and order as `months`; null where that product had no sales that month. */
    cells: Array<DirectOrderMatrixCell | null>;
    totalUnits: number;
  }>;
  /** Column totals, same order as `months`. */
  monthTotals: number[];
  grandTotalUnits: number;
};

/**
 * Pivot flat retail rows into products × months.
 *
 * Units are the raw `qty` — the same column the monthly closing sums into `total_qty`, NOT
 * `effective_units`. Bonus is carried separately and never folded into units: they are different
 * things and merging them would overstate what the pharmacy actually bought.
 */
export function buildDirectOrderSalesMatrix(
  rows: ReadonlyArray<DirectOrderRetailHistoryRow>,
): DirectOrderSalesMatrix {
  const months = [...new Set(rows.map((row) => row.month).filter(Boolean))].sort();
  const monthIndex = new Map(months.map((month, index) => [month, index]));

  const byProduct = new Map<
    string,
    { productCode: string; productName: string; cells: Array<DirectOrderMatrixCell | null>; totalUnits: number }
  >();

  for (const row of rows) {
    const index = monthIndex.get(row.month);
    if (index === undefined) continue;
    const existing =
      byProduct.get(row.productCode) ??
      {
        productCode: row.productCode,
        productName: row.productName || row.productCode,
        cells: months.map(() => null),
        totalUnits: 0,
      };
    const cell = existing.cells[index] ?? { units: 0, bonus: 0, distributors: [] };
    cell.units += row.qty;
    cell.bonus += row.bonus;
    // Named, not counted: "which distributor" is the question the owner asked the cell to answer,
    // and two distributors supplying the same product in one month is a real and interesting case.
    const distributorLabel = row.distributorName || row.distributorCode;
    if (distributorLabel && !cell.distributors.includes(distributorLabel)) cell.distributors.push(distributorLabel);
    existing.cells[index] = cell;
    existing.totalUnits += row.qty;
    byProduct.set(row.productCode, existing);
  }

  const products = [...byProduct.values()].sort(
    (a, b) => b.totalUnits - a.totalUnits || a.productName.localeCompare(b.productName),
  );
  const monthTotals = months.map((_, index) =>
    products.reduce((sum, product) => sum + (product.cells[index]?.units ?? 0), 0),
  );

  return {
    months,
    products,
    monthTotals,
    grandTotalUnits: products.reduce((sum, product) => sum + product.totalUnits, 0),
  };
}

// ── Pricing breakdown (the "show your working" the approval window never showed) ──────────────

/** One product line's working, as the Pricing row prints it. */
export type DirectOrderPricingLine = {
  lineNo: number;
  productName: string;
  basis: "bonus" | "discount";
  qty: number;
  /** The price the basis actually prices at — pharmacy price for bonus, public price for discount. */
  unitPrice: number | null;
  bonusUnits: number | null;
  discountPct: number | null;
  /** The locked formula on this line's own prices. Null when the basis price was never set — the
   *  same "not set" a missing price means everywhere else here. */
  computedValue: number | null;
};

export type DirectOrderPricingBreakdown = {
  /** Every line, in entry order. A one-product order has one. */
  lines: DirectOrderPricingLine[];
  /** The lines' values summed and rounded once, as the server stores the order's total. Null when
   *  any line's basis price was never set, because a total with a line missing is not the total. */
  computedValue: number | null;
  salesValue: number;
};

/** The fields of one `direct_order_request_items` row the working needs. */
export type DirectOrderPricingItem = Pick<
  DirectOrderRequestItem,
  "lineNo" | "productName" | "dealType" | "qty" | "discountPct" | "publicPriceSnapshot" | "pharmacyPriceSnapshot"
> & { bonus?: number | null };

/**
 * Re-derives the working behind `request.salesValue`, purely for display — an approver sees
 * "288 × 240.9 = 69,379.2 EGP" instead of a bare total with nothing to check it against.
 *
 * EVERY LINE, and each on its OWN row (owner, 2026-10-19: "fix the direct-order approval panel to
 * show every line's pricing"). This used to price the order row, which since baskets holds line one
 * only: a Lacto Advanced 1 + 2 order printed line one's 24,750 working beside a 47,250 total, and
 * the row keeps the discount to 3 decimals where the line keeps 4, so a one-product Ivyronc order at
 * 68.8889% printed 6,999.98 beside 7,000.00. The nightly reconciliation check
 * `direct-orders-approval-panel-working-equals-the-order-value` calls this same function.
 *
 * Each line is priced by `priceBasketLine` — the locked formulas and the normalisation the server
 * prices with — so the working cannot drift from the money. Nothing here changes how `salesValue`
 * is computed or stored. With no lines (a caller that did not load them), the order row stands in
 * as its single line, which is complete for a one-product order.
 */
export function computeDirectOrderPricingBreakdown(
  request: Pick<
    DirectOrderRequest,
    "dealType" | "qty" | "bonus" | "pharmacyPriceSnapshot" | "publicPriceSnapshot" | "discountPct" | "salesValue"
  > & { productName?: string | null },
  items?: readonly DirectOrderPricingItem[] | null,
): DirectOrderPricingBreakdown {
  const source: readonly DirectOrderPricingItem[] =
    items && items.length > 0
      ? [...items].sort((a, b) => a.lineNo - b.lineNo)
      : [
          {
            lineNo: 1,
            productName: (request.productName ?? "").trim(),
            dealType: request.dealType,
            qty: request.qty,
            bonus: request.bonus,
            discountPct: request.discountPct,
            publicPriceSnapshot: request.publicPriceSnapshot,
            pharmacyPriceSnapshot: request.pharmacyPriceSnapshot,
          },
        ];

  const lines = source.map((item): DirectOrderPricingLine => {
    const priced = priceBasketLine({
      productCode: "",
      productName: item.productName,
      dealType: item.dealType,
      qty: item.qty,
      discountPct: item.discountPct ?? 0,
      publicPrice: item.publicPriceSnapshot,
      pharmacyPrice: item.pharmacyPriceSnapshot,
    });
    const isDiscount = item.dealType === "discount";
    return {
      lineNo: item.lineNo,
      productName: item.productName,
      basis: isDiscount ? "discount" : "bonus",
      qty: priced.qty,
      unitPrice: priced.basisPrice,
      bonusUnits: isDiscount ? null : (item.bonus ?? null),
      discountPct: isDiscount ? priced.discountPct : null,
      computedValue: priced.basisPrice == null ? null : priced.salesValue,
    };
  });

  const anyUnpriced = lines.some((line) => line.computedValue == null);
  return {
    lines,
    computedValue: anyUnpriced
      ? null
      : Math.round(lines.reduce((sum, line) => sum + (line.computedValue ?? 0), 0) * 100) / 100,
    salesValue: request.salesValue,
  };
}

// ── Approval-chain narrative (the bare status-dot list, given a sentence per rung) ─────────────

export type DirectOrderApprovalNarrativeStep = DirectOrderStepState & {
  approverName: string | null;
  decidedByName: string | null;
  state: "done" | "current" | "waiting" | "rejected";
  sentence: string;
  /**
   * What the progress bar prints under this rung: the rung's own label, except the open rung of a
   * RETURNED order, which reads "Returned — waiting for <requester>" (owner, 2026-09-14).
   */
  trackerLabel: string;
};

/** The request-level facts a rung cannot know from its own row. */
export type DirectOrderApprovalNarrativeContext = {
  requestStatus?: string | null;
  requesterName?: string | null;
  /** Who sent it back — the return is an EVENT, so the step row never records it. */
  returnedByName?: string | null;
};

/**
 * Turns the ordered step list into one sentence per rung, borrowing the narrative-stepper IDEA
 * from the Outstation portal's own submission tracker (not its code — steps here carry different
 * fields). Only the FIRST not-yet-decided step reads "current"; the raw data has no such
 * distinction on its own (every undecided rung is stored as `status: "pending"`), so that's tracked
 * here rather than re-derived by each renderer.
 *
 * A RETURN leaves the returning rung `pending` too, so without the request's status that rung read
 * "Waiting on SFE Manager now" while the order sat with its requester — and the approver it named
 * went looking for an Approve button a returned order never has.
 */
export function buildDirectOrderApprovalNarrative(
  steps: Array<DirectOrderStepState & { approverName: string | null; decidedByName: string | null }>,
  context: DirectOrderApprovalNarrativeContext = {},
): DirectOrderApprovalNarrativeStep[] {
  const returned = context.requestStatus === "returned";
  let currentAssigned = false;
  return steps.map((step) => {
    const who = step.approverName ?? step.label;
    if (step.status === "rejected") {
      return {
        ...step,
        state: "rejected",
        trackerLabel: step.label,
        sentence: step.decisionComment
          ? `${step.decidedByName ?? who} rejected this request: "${step.decisionComment}"`
          : `${step.decidedByName ?? who} rejected this request.`,
      };
    }
    if (step.status === "approved") {
      return { ...step, state: "done", trackerLabel: step.label, sentence: `${step.decidedByName ?? who} approved this rung.` };
    }
    if (!currentAssigned) {
      currentAssigned = true;
      if (returned) {
        const requester = context.requesterName?.trim() || "the person who raised it";
        return {
          ...step,
          state: "current",
          trackerLabel: describeReturnedDirectOrderWait(context.requesterName),
          sentence: `${context.returnedByName?.trim() || who} returned this order — waiting for ${requester} to correct and resubmit.`,
        };
      }
      return { ...step, state: "current", trackerLabel: step.label, sentence: `Waiting on ${who} now.` };
    }
    return { ...step, state: "waiting", trackerLabel: step.label, sentence: `Will move to ${who} next.` };
  });
}

// ── Status banner (one function, so the admin and portal screens can no longer disagree) ───────

export type DirectOrderStatusBannerTone =
  | "held"
  | "expired"
  | "pharmacy-rejected"
  | "pharmacy-pending-review"
  | "finance-pending";

export type DirectOrderStatusBanner = { tone: DirectOrderStatusBannerTone; message: string };

/** Tailwind classes per tone — the SAME for every shell that renders a banner (admin, portal). */
export const DIRECT_ORDER_STATUS_BANNER_CLASSES: Record<
  DirectOrderStatusBannerTone,
  { container: string; text: string }
> = {
  held: { container: "bg-orange-50", text: "text-orange-900" },
  expired: { container: "bg-slate-100", text: "text-slate-700" },
  "pharmacy-rejected": { container: "bg-rose-100", text: "font-black text-rose-900" },
  "pharmacy-pending-review": { container: "bg-rose-50", text: "text-rose-900" },
  "finance-pending": { container: "bg-amber-50", text: "text-amber-900" },
};

/**
 * Which status banner (if any) belongs above this request's fields.
 *
 * Extracted from what used to be five conditionals hand-written inline in the ADMIN detail
 * component only — which is exactly why the portal detail screen (the one District/Regional/
 * National Sales Managers actually reach, per resolveNavigationMode) showed just one of the five.
 * One function, both screens, so they cannot drift apart again.
 */
export function resolveDirectOrderStatusBanner(
  detail: Pick<DirectOrderApprovalDetail, "request" | "pharmacy">,
): DirectOrderStatusBanner | null {
  const { request, pharmacy } = detail;
  // Say what the venue IS. An approver reading "REJECTED PHARMACY" over a nursery is the same
  // defect one rung further up the chain: a screen naming a venue as something it is not.
  // Falls back to the neutral word rather than to "pharmacy" when there is no venue to read.
  const venueWord = pharmacy ? venueTypeLabel(pharmacy.venueType).toLowerCase() : "venue";
  if (request.status === "held") {
    return {
      tone: "held",
      message:
        `HELD — this request stands outside the approval flow. Its ${venueWord} is not in the ` +
        "master database, so no approver has it as work and nothing can be approved here. It " +
        `moves only when the ${venueWord} passes validation, and an untouched held request ` +
        "expires after 14 days.",
    };
  }
  if (request.status === "expired") {
    return {
      tone: "expired",
      message:
        `EXPIRED — this request stayed held for 14 days without its ${venueWord} passing ` +
        `validation, and closed automatically. Resubmit with a ${venueWord} from the master ` +
        "database.",
    };
  }
  // Proven false, not merely unreviewed. An approver must never see this as "awaiting a look" — the
  // pharmacy was refused, and the strongest thing this screen can do is say so before anyone
  // considers acting on the order.
  if (pharmacy?.verificationStatus === "rejected") {
    return {
      tone: "pharmacy-rejected",
      message:
        `REJECTED ${venueWord.toUpperCase()} — this ${venueWord} was examined and found not to ` +
        `be real. The order behind it must not be approved, and the ${venueWord} cannot be used ` +
        "again.",
    };
  }
  if (pharmacy?.verificationStatus === "pending_review") {
    return {
      tone: "pharmacy-pending-review",
      // The distributor-code half of this warning is true ONLY OF A PHARMACY. A nursery holds no
      // distributor account, so warning that its code might be wrong describes a code it cannot
      // have — and hides the real reason it is unconfirmed: nobody has looked at its evidence yet.
      message:
        pharmacy && !venueRequiresDistributorCode(pharmacy.venueType)
          ? `New ${venueWord} — Phoenix has not confirmed it yet. A ${venueWord} has no ` +
            "distributor account, so there is no code to check and no distributor sales will " +
            `ever appear for it. What identifies it is the location and the live photo the rep ` +
            "captured, and an admin has not looked at them yet. Until that decision this order " +
            "cannot be finalized."
          : `New ${venueWord} — Phoenix has not confirmed it yet. It was typed in by hand ` +
            "instead of being picked from the list, so nobody has checked that its distributor " +
            `code is real. That code is what Phoenix uses to find the sales of this ` +
            `${venueWord} at the distributor, and a wrong one would pull the sales of another ` +
            `${venueWord} in here. The SFE Manager confirms the ${venueWord} at their own rung; ` +
            "until then this order cannot be finalized.",
    };
  }
  // The golden rule, stated where the money is judged (spec C2): CEO approval is a commercial
  // decision, not an accounting event. Until Finance books a month, this order sits in NO month's
  // numbers — and that absence must be readable, not implied.
  if (request.status === "approved" && !request.salesMonth) {
    return {
      tone: "finance-pending",
      message:
        "Approved — awaiting Finance month. The sales are NOT in any month's numbers yet: they " +
        "inject only when the Finance Manager books this order into a month.",
    };
  }
  return null;
}
