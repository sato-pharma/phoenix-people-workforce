import { codeNameLabel } from "@/lib/direct-orders/geo-names";
import type {
  DirectOrderApprovalDetail,
  DirectOrderAreaRep,
  DirectOrderPharmacyGeo,
  DirectOrderRequest,
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
  "Pharmacy",
  "Sato pharmacy code",
  "Doctor",
  "Brick",
  "Area",
  "Region",
  "Medical rep",
  "Collection date",
  "Sales month",
  "Pharmacy address",
  "Distributor codes",
  "Pharmacy registered by",
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

  const fields: DirectOrderDetailField[] = [
    { label: "Request ID", value: request.id },
    { label: "Requester", value: `${requesterName} · ${request.requesterHrId} · ${request.requesterRole}` },
    { label: "Line", value: text(request.line) },
    { label: "Product", value: codeNameLabel(request.productName, request.productCode) },
    // The company's own product code, given its own field rather than left in a parenthesis —
    // the owner reads it as a value in its own right, not as a decoration on the name.
    { label: "Sato product code", value: text(request.productCode) },
    { label: "Status", value: request.status.replace(/_/g, " ") },
    { label: "Deal type", value: request.dealType === "discount" ? "Discount" : "Bonus" },
    { label: "Quantity", value: units(request.qty) },
    { label: "Sales value", value: money(request.salesValue) },
  ];

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
    { label: "Pharmacy", value: codeNameLabel(pharmacy?.pharmacyName, pharmacy?.phoenixPharmacyCode) },
    { label: "Sato pharmacy code", value: text(pharmacy?.phoenixPharmacyCode) },
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
    { label: "Pharmacy registered by", value: text(pharmacy?.createdByHrId) },
    { label: "Pharmacy status", value: pharmacy ? (pharmacy.active ? "Active" : "Inactive") : DASH },
    {
      label: "Geography check",
      value: pharmacy
        ? pharmacy.geoVarianceResolved
          ? "Resolved"
          : "Not flagged"
        : DASH,
    },
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
    { label: "Pharmacy address", value: text(pharmacy?.pharmacyAddress), layout: "full" },
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
  const parts = [
    `${ctx.requesterName} submitted ${request.productName} × ${units(request.qty)}`,
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
    { label: "Pharmacy", value: codeNameLabel(ctx.pharmacyName, ctx.pharmacyCode) },
    { label: "Brick", value: codeNameLabel(ctx.geo.brick?.name, ctx.geo.brick?.code) },
    { label: "Area", value: codeNameLabel(ctx.geo.area?.name, ctx.geo.area?.code) },
    { label: "Region", value: codeNameLabel(ctx.geo.region?.name, ctx.geo.region?.code) },
    { label: "Medical rep", value: repLabel(ctx.medicalRep) },
    // Not `text(...)`: a bare dash here reads as "the email failed to include the distributor".
    // Since codes became optional (2026-08-04) an empty list is a normal state, and the approver
    // reading this on a phone has nothing else to tell them which of the two it is.
    { label: "Distributor codes", value: ctx.distributorCodesText.trim() || "none on file — distributor sales cannot be linked to this pharmacy" },
    { label: "Collection date", value: dateOnly(request.collectionDate) },
  ];
}
