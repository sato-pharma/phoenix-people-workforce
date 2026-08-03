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

const money = (value: number | null | undefined): string => {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} EGP` : DASH;
};
const units = (value: number | null | undefined): string => {
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
  "Status",
  "Pharmacy",
  "Doctor",
  "Brick",
  "Area",
  "Region",
  "Medical rep",
  "Collection date",
  "Sales month",
  "Pharmacy address",
  "Distributor codes",
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
    { label: "Status", value: request.status.replace(/_/g, " ") },
    { label: "Quantity", value: units(request.qty) },
    { label: "Sales value", value: money(request.salesValue) },
    { label: "Factory price", value: money(request.factoryPriceSnapshot) },
  ];

  // Bonus deals price on the pharmacy price; discount deals on the public price. Show the one
  // that actually determined this row's value, and say so plainly when it fell back.
  if (request.dealType === "bonus") {
    fields.push({
      label: "Pharmacy price",
      value:
        request.pharmacyPriceSnapshot == null
          ? `${DASH} (not set — valued at the factory price)`
          : money(request.pharmacyPriceSnapshot),
    });
  } else {
    fields.push({ label: "Public price", value: money(request.publicPriceSnapshot) });
  }

  fields.push(
    { label: "Pharmacy", value: codeNameLabel(pharmacy?.pharmacyName, pharmacy?.phoenixPharmacyCode) },
    { label: "Doctor", value: text(pharmacy?.doctorName) },
    // Three separate fields, never a combined "Brick / Area" cell — cramming two geographies
    // into one value is what forced the bare-code "a / b" format this replaces.
    { label: "Brick", value: codeNameLabel(geo.brick?.name, geo.brick?.code) },
    { label: "Area", value: codeNameLabel(geo.area?.name, geo.area?.code) },
    { label: "Region", value: codeNameLabel(geo.region?.name, geo.region?.code) },
    { label: "Medical rep", value: formatMedicalRep(medicalRep) },
    { label: "Collection date", value: dateOnly(request.collectionDate) },
    { label: "Sales month", value: request.salesMonth ?? `${DASH} (set on final approval)` },
    { label: "Submitted", value: dateOnly(request.createdAt) },
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
    { label: "Distributor codes", value: text(ctx.distributorCodesText) },
    { label: "Collection date", value: dateOnly(request.collectionDate) },
  ];
}
