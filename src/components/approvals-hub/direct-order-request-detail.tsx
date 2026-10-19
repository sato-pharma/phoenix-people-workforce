import Link from "next/link";

import { adminPanelClassName, adminPanelHeaderClassName, adminSoftPanelClassName } from "@/components/admin/admin-design-tokens";
import { DecisionActions } from "@/components/approvals-hub/decision-actions";
import { RecordConversationThread } from "@/components/conversations/record-conversation-thread";
import {
  ApprovalTracker,
  Field,
  FieldTable,
  HeroStat,
  PanelSection,
  PriceUsageField,
  PricingBreakdownFact,
} from "@/components/approvals-hub/direct-order-detail-primitives";
import { DirectOrderCollectionControl } from "@/components/direct-orders/direct-order-collection-control";
import { DirectOrderServiceFeeControl } from "@/components/direct-orders/direct-order-service-fee-control";
import { DirectOrderCorrectResubmit } from "@/components/direct-orders/direct-order-correct-resubmit";
import { DirectOrderSalesMonthControl } from "@/components/direct-orders/direct-order-sales-month-control";
import { DirectOrderStatusPill } from "@/components/direct-orders/direct-order-status-pill";
import { EvidenceReading } from "@/components/direct-orders/evidence-reading";
import {
  buildDirectOrderApprovalNarrative,
  buildDirectOrderDetailFields,
  buildDirectOrderSalesMatrix,
  computeDirectOrderPricingBreakdown,
  dealFieldLabel,
  DIRECT_ORDER_STATUS_BANNER_CLASSES,
  formatDealValue,
  resolveDirectOrderStatusBanner,
  type DirectOrderApprovalNarrativeStep,
} from "@/lib/direct-orders/approval-fields";
import { describeResolvedAddressPlace, type DirectOrderGeographyVerdict } from "@/lib/direct-orders/geography-check";
import { describeDirectOrderAutoLinkRefusal } from "@/lib/direct-orders/hold-decision";
import type { DirectOrderApprovalDetail } from "@/lib/direct-orders/types";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";
import { PharmacyLicenseEvidence } from "@/components/venues/pharmacy-license-evidence";
import { DirectOrderInvoiceEvidence } from "@/components/direct-orders/direct-order-invoice-evidence";
import { AttachDirectOrderInvoice } from "@/components/direct-orders/attach-direct-order-invoice";
import { ValidatedEvidenceLink } from "@/components/validation/validated-evidence-link";
import { NotFieldValidatedLine } from "@/components/validation/not-field-validated-line";
import { directOrderInvoiceSlotLabel } from "@/lib/direct-orders/invoice-evidence";
import { pharmacyLicenseVerdictLabel } from "@/lib/venues/pharmacy-license";

const money = (value: number) => `${Math.round(value).toLocaleString("en-US")} EGP`;

const cairoStamp = (iso: string | null | undefined) =>
  iso
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Cairo",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(iso))
    : null;

// Four verdicts, four looks. "Not checked" must never be able to pass for "agrees" — that
// equivalence is the whole reason the old single "Not flagged" field was worthless.
const VERDICT_TONE: Record<DirectOrderGeographyVerdict, string> = {
  match: "bg-emerald-100 text-emerald-800",
  mismatch: "bg-rose-100 text-rose-800",
  unknown: "bg-slate-200 text-slate-600",
  not_checkable: "bg-slate-200 text-slate-600",
};
const VERDICT_LABEL: Record<DirectOrderGeographyVerdict, string> = {
  match: "agrees",
  mismatch: "disagrees",
  unknown: "not checked",
  not_checkable: "nothing to check",
};

const NARRATIVE_TONE: Record<DirectOrderApprovalNarrativeStep["state"], string> = {
  done: "bg-emerald-500",
  rejected: "bg-rose-500",
  current: "bg-amber-400",
  waiting: "bg-slate-300",
};

// Order-details grouping (2026-08-08 restyle): the flat 24-field grid gave every fact equal
// weight — a decision's headline numbers sat no differently than "Geography check". These three
// buckets, plus HeroStat for the numbers that matter most, are display-only groupings over the
// SAME buildDirectOrderDetailFields() output — the domain field list itself is untouched.
const HERO_LABELS = new Set(["Sales value", "Quantity"]);
// Present elsewhere on screen already, in a form that makes the plain-grid copy redundant rather
// than informative: the code rides in the Product/Venue field's own "(CODE)" suffix
// (codeNameLabel), Discount % repeats the hero tile above verbatim, and the two prices get their
// own colour-coded PriceUsageField instead of a plain grid row. Still present in
// buildDirectOrderDetailFields()'s OWN output — the notification email and the completeness test
// (DIRECT_ORDER_CORE_FIELD_LABELS) both need them as their own fields; this hides them from THIS
// screen's grid only.
const GRID_HIDDEN_LABELS = new Set([
  "Sato product code",
  "Sato venue code",
  "Discount %",
  "Pharmacy price",
  "Public price",
  // Hero tiles above the tables carry these three; leaving them in the grid printed each twice.
  "Sales value",
  "Quantity",
  "Collection date",
  // The header pill and the approval tracker both state it — a third copy read as a third fact.
  "Status",
]);
const PRODUCT_GROUP_LABELS = new Set([
  "Line",
  "Product",
  "Sato product code",
  "Deal type",
  "Pharmacy price",
  "Public price",
  "Discount %",
]);
const VENUE_GROUP_LABELS = new Set([
  "Venue",
  "Sato venue code",
  "Doctor",
  "Brick",
  "Area",
  "Region",
  "Medical rep",
  "Venue status",
  "Venue registered by",
]);

export function DirectOrderRequestDetail({
  detail,
  backHref,
  // The same component serves an APPROVER (reached from the approvals queue) and the REQUESTER
  // tracking their own order (reached from "My direct orders"). Only the return path differs —
  // sending a requester back to an approvals queue they may not even have would be a dead end.
  backLabel = "Back to Direct Orders Approvals",
}: {
  detail: DirectOrderApprovalDetail | null;
  backHref: string;
  backLabel?: string;
}) {
  if (!detail) {
    return (
      <div className="space-y-4">
        <Link href={backHref} className="text-sm font-bold text-orange-600 hover:text-orange-700">
          ← Back
        </Link>
        <p className={`${adminSoftPanelClassName} px-4 py-6 text-sm text-slate-500`}>
          This direct order request was not found, or you do not have access to it.
        </p>
      </div>
    );
  }

  const {
    request,
    distributors,
    pharmacyHistory,
    retailHistory,
    retailUnmatchable,
    pharmacyStanding,
    canSetSalesMonth,
    canRecordCollection,
    canSettleServiceFee,
    serviceFeeDefaults,
    canCorrectAndResubmit,
    returnComment,
    steps,
    availableActions,
    bonusOverCap,
    missingManagementLine,
    pharmacyEvidence,
    pharmacyValidation = null,
    pharmacyFieldEvidenceGap = null,
    possibleDistributorMatches,
    autoLinkRefusal,
    productPharmacyPrice,
    productPublicPrice,
    retailLoadFailed,
    hiddenConfidentialCount,
    retailMatchedPairs,
    geographyCheck,
    orderInvoice = null,
    invoiceExpected = false,
    canAttachInvoice = false,
  } = detail;
  // The invoice the order was raised on (owner, 2026-09-14: "it must clearly show the invoice pic
  // used"). The order's own copy first; an order raised before invoices were kept falls back to the
  // invoice its pharmacy's validation claim carries, so the SFE Manager sees whichever exists.
  const shownInvoice = orderInvoice
    ? {
        url: orderInvoice.url,
        contentType: orderInvoice.contentType as string | null,
        uploadedAt: orderInvoice.uploadedAt,
        slots: orderInvoice.requesterSlots,
      }
    : pharmacyEvidence?.validationRoute === "invoice"
      ? {
          url: pharmacyEvidence.invoiceUrl,
          contentType: pharmacyEvidence.invoiceContentType as string | null,
          uploadedAt: pharmacyEvidence.invoiceUploadedAt,
          slots: pharmacyEvidence.requesterInvoiceSlots,
        }
      : null;
  // Only when nothing else already holds a slot for this pharmacy — a claim on the desk is inside the
  // count, so "full" would be misread as "this one will not count".
  const invoiceSlotsFull =
    Boolean(orderInvoice) &&
    invoiceExpected &&
    pharmacyEvidence?.validationRoute !== "invoice" &&
    shownInvoice?.slots != null &&
    shownInvoice.slots.used >= shownInvoice.slots.limit;
  const statusBanner = resolveDirectOrderStatusBanner(detail);
  // Every line's working, not the order row's — the row is line one only on a basket.
  const pricingBreakdown = computeDirectOrderPricingBreakdown(request, detail.items);
  const narrativeSteps = buildDirectOrderApprovalNarrative(steps, {
    requestStatus: request.status,
    requesterName: detail.requesterName,
    returnedByName: returnComment?.byName ?? null,
  });
  // Products × months. Built from the ALREADY-scoped retail rows — confidentiality and line
  // filtering happen server-side, so this only reshapes what this viewer may see.
  const salesMatrix = buildDirectOrderSalesMatrix(retailHistory);
  // Same fallback the domain's unusedPrice() draws: the basis that did NOT price this deal falls
  // back to the product's CURRENT price so a saved price is still visible, and "not set" is
  // reserved for a product that genuinely has none — never confused with "0 EGP".
  const pharmacyPriceValue = request.pharmacyPriceSnapshot ?? productPharmacyPrice;
  const publicPriceValue = request.publicPriceSnapshot ?? productPublicPrice;
  const collectionDateLabel = request.collectionDate ? String(request.collectionDate).slice(0, 10) : "—";
  // The one candidate the Distributors block speaks about, read once so the FIELDS and the callout
  // below them can never describe different things — which is exactly how they came to contradict.
  const candidateMatch = possibleDistributorMatches[0] ?? null;
  // Built ONCE and read by both the desktop table and the mobile cards. Two copies of the same
  // three rows is how the retail totals drifted before (#1833) — the same list, reduced twice.
  // The live photo's own GPS territory is listed FIRST and is the primary source of trust (owner,
  // 2026-10-18); the distributor master follows. A photo that cannot speak says why in words.
  const photoReading = geographyCheck?.photo ?? null;
  const photoUnusableText =
    photoReading?.unusableReason === "too_far"
      ? "The photo's pin is too far from any brick centre to name a territory"
      : "No live evidence photo with GPS on this request";
  const photoRows = photoReading
    ? photoReading.unusableReason
      ? [{ label: "Live photo", declared: "—", master: photoUnusableText, verdict: photoReading.area.verdict, source: "photo" as const }]
      : [
          {
            label: "Brick · live photo",
            declared: photoReading.brick.declared ?? "—",
            master: `${photoReading.brick.photo ?? "—"}${photoReading.distanceKm === null ? "" : ` (nearest brick centre to the photo's pin, ${photoReading.distanceKm} km)`}`,
            verdict: photoReading.brick.verdict,
            source: "photo" as const,
          },
          {
            label: "Area · live photo",
            declared: photoReading.area.declared ?? "—",
            master: photoReading.area.photo ?? "—",
            verdict: photoReading.area.verdict,
            source: "photo" as const,
          },
        ]
    : [];
  const comparisonRows = geographyCheck
    ? [
        ...photoRows,
        { label: "Brick", declared: geographyCheck.brick.declared ?? "—", master: geographyCheck.brick.master ?? "—", verdict: geographyCheck.brick.verdict, source: "master" as const },
        { label: "Area", declared: geographyCheck.area.declared ?? "—", master: geographyCheck.area.master ?? "—", verdict: geographyCheck.area.verdict, source: "master" as const },
        {
          label: "Typed address",
          source: "master" as const,
          declared: detail.pharmacy?.pharmacyAddress || "—",
          // Never blank (golden rule): the address is resolved to a place, and the resolution says
          // it was read from the address rather than asserted by the master database.
          master: describeResolvedAddressPlace(geographyCheck.address),
          verdict: geographyCheck.address.verdict,
        },
      ]
    : [];
  // ONE shared field list, built in the domain. The admin screen and the portal screen each
  // used to hand-maintain their own copy, which is how both ended up printing raw brick/area
  // codes — fixing it in one place could never have fixed the other.
  const allFields = buildDirectOrderDetailFields(detail);
  const gridFields = allFields.filter((field) => field.layout !== "full");
  const fullFields = allFields.filter((field) => field.layout === "full" && field.label !== "Distributor codes");

  // Computed ONCE and read by BOTH renderings. #1833 gave the phone its own totals cards, which
  // left the same seven sums written twice — the desktop totals row and the mobile card each
  // reducing the same array. Two expressions that can drift, on the two screens that must agree
  // about what a pharmacy is worth.
  const retailTotals = {
    qty: retailHistory.reduce((sum, row) => sum + row.qty, 0),
    bonus: retailHistory.reduce((sum, row) => sum + row.bonus, 0),
    salesValue: retailHistory.reduce((sum, row) => sum + row.salesValue, 0),
  };
  const directTotals = {
    orders: pharmacyHistory.reduce((sum, row) => sum + row.orders, 0),
    qty: pharmacyHistory.reduce((sum, row) => sum + row.qty, 0),
    bonus: pharmacyHistory.reduce((sum, row) => sum + row.bonus, 0),
    salesValue: pharmacyHistory.reduce((sum, row) => sum + row.salesValue, 0),
  };

  return (
    <div className="space-y-5">
      <Link href={backHref} className="text-sm font-bold text-orange-600 hover:text-orange-700">
        ← {backLabel}
      </Link>

      <section className={adminPanelClassName}>
        <header className={`flex flex-wrap items-center justify-between gap-2 ${adminPanelHeaderClassName} px-4 py-3`}>
          <h2 className="flex flex-wrap items-center gap-2 text-base font-black text-white">
            {request.productName} × {request.qty.toLocaleString("en-US")}
            <DirectOrderStatusPill status={request.status} salesMonth={request.salesMonth} variant="solid" />
          </h2>
          <span className="text-lg font-black text-orange-400">{money(request.salesValue)}</span>
        </header>

        {statusBanner ? (
          <div className={`border-b border-[#eef1f3] px-4 py-2.5 ${DIRECT_ORDER_STATUS_BANNER_CLASSES[statusBanner.tone].container}`}>
            <p className={`text-phx-sm font-bold ${DIRECT_ORDER_STATUS_BANNER_CLASSES[statusBanner.tone].text}`}>
              {statusBanner.message}
            </p>
          </div>
        ) : null}

        {bonusOverCap ? (
          <div className="space-y-1 border-b border-[#eef1f3] bg-amber-50 px-4 py-2.5">
            <p className="text-phx-sm font-bold text-amber-900">
              Over cap — this {request.dealType} exceeds its product cap. Flagged for your attention, not blocked.
            </p>
          </div>
        ) : null}

        {/* Rose, not amber: the over-cap flag says "look closely at this number", this one says
            "the people who should have signed this are not on it". Deliberately worded as an
            instruction, because the approver reading it is the one who can act on it. */}
        {missingManagementLine ? (
          <div className="space-y-1 border-b border-[#eef1f3] bg-rose-50 px-4 py-2.5">
            <p className="text-phx-sm font-bold text-rose-900">
              No sales manager on this chain — it goes straight to the CEO. The requester had no manager on
              their HR record when this was submitted, so their National Sales Manager was never added.
              Flagged for your attention, not blocked — ask HR to set the manager before deciding.
            </p>
          </div>
        ) : null}
      </section>

      {/* The "already validated" stamp (owner, 2026-09-22): when this order stands on a pharmacy
          Phoenix already recognises, say so at the top — who validated it and when — and jump the
          approver to the evidence already lower on this same window (the photo/GPS/licence panel
          when a held-lane claim exists, otherwise the distributor codes). */}
      {pharmacyValidation ? (
        <ValidatedEvidenceLink
          badge={pharmacyValidation}
          href={pharmacyEvidence ? "#do-pharmacy-evidence" : "#do-distributors"}
          venueNoun="pharmacy"
        />
      ) : null}

      {/* And directly under it, what that stamp does NOT say (owner, 2026-09-29): nobody has stood
          in front of this venue with a phone. Not exclusive with the stamp above — a venue can be
          validated by invoice, or off the distributor catalogue, and still hold no live photo and no
          GPS fix. Placed ABOVE the invoice panel on purpose: the invoice is the thing being
          mistaken for venue evidence, so the sentence has to arrive first. */}
      {pharmacyFieldEvidenceGap ? <NotFieldValidatedLine gap={pharmacyFieldEvidenceGap} /> : null}

      {/* Straight under the header, full width: for a new pharmacy this invoice IS what the SFE
          Manager decides on, so it is the first thing on the order, not a thumbnail further down. */}
      {shownInvoice || invoiceExpected || canAttachInvoice ? (
        <PanelSection title="Invoice used for this order">
          {shownInvoice ? (
            <div className="space-y-3">
              <DirectOrderInvoiceEvidence
                contentType={shownInvoice.contentType}
                label={detail.pharmacy?.pharmacyName ?? "this pharmacy"}
                prominent
                url={shownInvoice.url}
              />
              <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Field label="Attached" value={cairoStamp(shownInvoice.uploadedAt) ?? "—"} />
                {shownInvoice.slots ? (
                  <Field label="Requester" value={directOrderInvoiceSlotLabel(shownInvoice.slots)} />
                ) : null}
              </dl>
              {invoiceSlotsFull ? (
                <p className="border border-amber-200 bg-amber-50 px-3 py-2 text-phx-sm font-semibold text-amber-900 shadow-[0_1px_2px_rgba(146,64,14,0.06),0_12px_28px_rgba(146,64,14,0.07)]">
                  The requester already has {shownInvoice.slots?.used} of {shownInvoice.slots?.limit} pharmacies
                  validated by invoice, so approving will not count this one as an invoice validation. Flagged for
                  your attention, not blocked.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="border border-amber-200 bg-amber-50 px-3 py-2 text-phx-sm font-semibold text-amber-900 shadow-[0_1px_2px_rgba(146,64,14,0.06),0_12px_28px_rgba(146,64,14,0.07)]">
              {canAttachInvoice
                ? invoiceExpected
                  ? "No invoice is attached to this order yet. Attach the distributor invoice you used, so the SFE Manager can check the pharmacy on it."
                  : "No invoice is attached to this order yet. Attach the distributor invoice you used, so your approvers see it with the order."
                : "No invoice is attached to this order yet. This is a new pharmacy — the requester can attach the distributor invoice they used while the order waits for the SFE Manager."}
            </p>
          )}
          {canAttachInvoice ? <AttachDirectOrderInvoice hasInvoice={Boolean(orderInvoice)} requestId={request.id} /> : null}
        </PanelSection>
      ) : null}

      <PanelSection title="Order details">
        {/* The four facts a decision actually turns on, first and biggest. */}
        {/* One per row on a phone. Two-up would probably survive here (these values are short),
            but the screen's rule is uniform on purpose — a base-level multi-column grid of nowrap
            values is the defect that made this window unreadable at 375px once already, and
            "this particular grid is fine" is exactly the judgement call that let it back in. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <HeroStat label="Sales value" value={money(request.salesValue)} tone="orange" />
          <HeroStat label="Quantity" value={request.qty.toLocaleString("en-US")} />
          <HeroStat
            label={dealFieldLabel(request)}
            tone={bonusOverCap ? "orange" : "slate"}
            value={
              <span className={bonusOverCap ? "text-rose-600" : undefined}>
                {formatDealValue(request)}
                {bonusOverCap ? " · over cap" : ""}
              </span>
            }
          />
          {/* Promoted out of the field list (owner request) — a collection date buried beside
              "Geography check" was invisible, and it is a commitment somebody has to meet. */}
          <HeroStat label="Collection date" value={collectionDateLabel} />
        </div>

        {/* Where it stands, as a bar rather than the words "pending approval". */}
        <div className="mt-4">
          <ApprovalTracker
            steps={narrativeSteps.map((step) => ({ order: step.order, label: step.trackerLabel, state: step.state }))}
            emptyNote={
              narrativeSteps.length === 0
                ? request.status === "held" || request.status === "expired"
                  ? "Not in the approval chain — a held request enters it only once its pharmacy passes validation."
                  : "No approval steps recorded for this request."
                : null
            }
          />
        </div>

        {/* Everything else, as three real tables instead of one 24-field wall. */}
        <div className="mt-4 space-y-4">
          <FieldTable
            title="Product & deal"
            rows={[
              ...gridFields
                .filter((field) => PRODUCT_GROUP_LABELS.has(field.label) && !GRID_HIDDEN_LABELS.has(field.label))
                .map((field) => ({ label: field.label, value: field.value })),
              {
                label: "Pharmacy price",
                value: (
                  <PriceUsageField
                    label=""
                    used={request.dealType === "bonus"}
                    notSet={pharmacyPriceValue == null}
                    value={pharmacyPriceValue}
                    bare
                  />
                ),
              },
              {
                label: "Public price",
                value: (
                  <PriceUsageField
                    label=""
                    used={request.dealType === "discount"}
                    notSet={publicPriceValue == null}
                    value={publicPriceValue}
                    bare
                  />
                ),
              },
            ]}
          />
          <FieldTable
            title="Pharmacy & geography"
            rows={gridFields
              .filter((field) => VENUE_GROUP_LABELS.has(field.label) && !GRID_HIDDEN_LABELS.has(field.label))
              .map((field) => ({ label: field.label, value: field.value }))}
          />
          <FieldTable
            title="Request & timeline"
            rows={gridFields
              .filter(
                (field) =>
                  !HERO_LABELS.has(field.label) &&
                  !PRODUCT_GROUP_LABELS.has(field.label) &&
                  !VENUE_GROUP_LABELS.has(field.label) &&
                  !GRID_HIDDEN_LABELS.has(field.label),
              )
              .map((field) => ({ label: field.label, value: field.value }))}
          />
        </div>

        {fullFields.map((field) => (
          <dl key={field.label} className="mt-3 border-t border-[#eef1f3] pt-3">
            <dt className="text-phx-2xs font-black uppercase tracking-wider text-slate-400">{field.label}</dt>
            <dd className="mt-0.5 text-sm font-semibold text-slate-900">{field.value}</dd>
          </dl>
        ))}

        <PricingBreakdownFact breakdown={pricingBreakdown} />

        {/* The requester's answer to a return. Rendered here, on the order itself, because a
            correction is an action ON this order — not a separate destination. Absent for everyone
            who cannot act: the flag is ownership + returned-status, computed server-side. */}
        {canCorrectAndResubmit ? (
          <DirectOrderCorrectResubmit
            requestId={request.id}
            dealType={request.dealType === "discount" ? "discount" : "bonus"}
            qty={request.qty}
            bonus={request.bonus}
            discountPct={request.discountPct}
            collectionDate={request.collectionDate}
            productName={request.productName}
            pharmacyName={detail.pharmacy?.pharmacyName ?? "this pharmacy"}
            returnComment={returnComment}
          />
        ) : null}

        <DirectOrderSalesMonthControl
          requestId={request.id}
          salesMonth={request.salesMonth}
          canEdit={canSetSalesMonth}
          status={request.status}
        />

        <DirectOrderCollectionControl
          requestId={request.id}
          salesValue={request.salesValue}
          paidAmount={request.paidAmount}
          paymentDate={request.paymentDate}
          remainingAmount={request.remainingAmount}
          canEdit={canRecordCollection}
          status={request.status}
        />

        {canSettleServiceFee && serviceFeeDefaults ? (
          <DirectOrderServiceFeeControl
            beneficiaryName={serviceFeeDefaults.beneficiaryName}
            outstanding={request.remainingAmount ?? request.salesValue}
            requestId={request.id}
            requesterName={serviceFeeDefaults.requesterName}
            status={request.status}
          />
        ) : null}

        {request.bonusOverrideReason ? (
          <p className="mt-3 border-t border-[#eef1f3] pt-2 text-xs text-slate-500">
            Note: {request.bonusOverrideReason}
          </p>
        ) : null}
      </PanelSection>

      {pharmacyEvidence ? (
        <PanelSection title="Pharmacy evidence" anchorId="do-pharmacy-evidence">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
            <div>
              {/* An invoice claim carries the distributor invoice INSTEAD of a photo and a pin (owner,
                  2026-09-14) — shown to every viewer who can open this order, like the licence. */}
              {pharmacyEvidence.validationRoute === "invoice" ? (
                <DirectOrderInvoiceEvidence
                  contentType={pharmacyEvidence.invoiceContentType}
                  label={pharmacyEvidence.claimedPharmacyName ?? "this pharmacy"}
                  url={pharmacyEvidence.invoiceUrl}
                />
              ) : pharmacyEvidence.photoUrl ? (
                <ZoomablePhoto
                  alt="Storefront evidence"
                  caption="Storefront evidence"
                  className="w-full border border-slate-200"
                  src={pharmacyEvidence.photoUrl}
                />
              ) : (
                <p className="border border-amber-200 bg-amber-50 px-3 py-2 text-phx-sm font-semibold text-amber-800 shadow-[0_1px_2px_rgba(146,64,14,0.06),0_12px_28px_rgba(146,64,14,0.07)]">
                  No photo on file for this claim.
                </p>
              )}
              {/* ADVISORY ONLY (spec D4) — sits beside the evidence, never near the decision
                  buttons below. Absent for the requester's own view (owner rule, 2026-08-08):
                  service.ts strips evidenceCheck to null before it reaches here for that viewer. */}
              {pharmacyEvidence.validationRoute === "invoice" ? null : (
                <EvidenceReading check={pharmacyEvidence.evidenceCheck} claimedName={pharmacyEvidence.claimedPharmacyName} />
              )}
              {pharmacyEvidence.capturedLatitude != null ? (
                <a
                  className="mt-1 block text-phx-xs font-bold text-orange-600 underline"
                  href={`https://www.google.com/maps?q=${pharmacyEvidence.capturedLatitude},${pharmacyEvidence.capturedLongitude}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open the pin on the map
                </a>
              ) : null}
              {/* The pharmacy licence (رخصة الصيدلية), when the rep attached one. Shown to every
                  viewer who can already open this order, on the same owner rule (2026-08-08) that
                  made the storefront photo visible here rather than only on the Super Admin desk —
                  an approver on the chain is deciding the same thing and needs the same evidence. */}
              <PharmacyLicenseEvidence
                contentType={pharmacyEvidence.licenseContentType}
                label={pharmacyEvidence.claimedPharmacyName ?? "this pharmacy"}
                url={pharmacyEvidence.licenseUrl}
              />
            </div>
            <dl className="space-y-2">
              <Field
                label="Why not in the master database"
                value={<span dir="auto">{pharmacyEvidence.claimedReason ?? "—"}</span>}
              />
              {pharmacyEvidence.validationRoute === "invoice" ? (
                <>
                  <Field label="Validated by" value="Distributor invoice — no location or photo asked for" />
                  {pharmacyEvidence.requesterInvoiceSlots ? (
                    <Field
                      label="Requester"
                      value={directOrderInvoiceSlotLabel(pharmacyEvidence.requesterInvoiceSlots)}
                    />
                  ) : null}
                </>
              ) : (
                <Field
                  label="Distance from their area"
                  value={
                    pharmacyEvidence.areaDistanceKm == null
                      ? "distance unknown"
                      : `${pharmacyEvidence.areaDistanceKm} km${pharmacyEvidence.gpsInsideRequesterArea ? "" : " — outside their area"}`
                  }
                />
              )}
              <Field label="Submitted" value={cairoStamp(pharmacyEvidence.requestedAt) ?? "—"} />
              {/* Only rendered when a licence exists to have a verdict about. "Not checked yet" is
                  said out loud rather than left blank — an empty row here would read as a pass. */}
              {pharmacyEvidence.licenseUrl ? (
                <Field
                  label="Licence name vs shop sign"
                  value={pharmacyLicenseVerdictLabel(pharmacyEvidence.licenseNameMatchesSign)}
                />
              ) : null}
            </dl>
          </div>
        </PanelSection>
      ) : null}

      {geographyCheck ? (
        <PanelSection title="Submitter's details vs the live photo and the master database">
          {/* Side by side, because scattered fields hid the problem for months. Live example: the
              submitter had put the customer CODE in the pharmacy-name box and the customer NAME in
              the doctor box, while the typed address named a different governorate than the brick.
              Every one of those was on screen already — just never next to what it contradicts. */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-[#eef1f3] bg-slate-50 text-left text-phx-xs font-black uppercase tracking-wider text-slate-500">
                  <th className="whitespace-nowrap px-3 py-2">Field</th>
                  <th className="whitespace-nowrap px-3 py-2">Submitter entered</th>
                  <th className="whitespace-nowrap px-3 py-2">Photo or master database says</th>
                  <th className="whitespace-nowrap px-3 py-2">Agreement</th>
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map((row) => (
                  <tr key={row.label} className="border-b border-[#eef1f3]">
                    <td className="whitespace-nowrap px-3 py-1.5 text-phx-xs font-black uppercase tracking-wider text-slate-400">
                      {row.label}
                    </td>
                    <td className="px-3 py-1.5 font-semibold text-slate-900" dir="auto">
                      {row.declared}
                    </td>
                    <td className="px-3 py-1.5 text-slate-700" dir="auto">
                      {row.master}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5">
                      <span className={`px-1.5 py-0.5 text-phx-2xs font-black uppercase tracking-wide ${VERDICT_TONE[row.verdict]}`}>
                        {VERDICT_LABEL[row.verdict]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: a card per compared field. A four-column comparison table at 375px is exactly
              what the owner's admin-shell rule forbids — desktop gets tables, mobile gets cards —
              and the two values being compared must stay stacked together to be readable. */}
          <div className="space-y-2 md:hidden">
            {comparisonRows.map((row) => (
              <article key={row.label} className="block border border-phx-line p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-phx-2xs font-black uppercase tracking-wider text-slate-400">{row.label}</p>
                  <span className={`px-1.5 py-0.5 text-phx-2xs font-black uppercase tracking-wide ${VERDICT_TONE[row.verdict]}`}>
                    {VERDICT_LABEL[row.verdict]}
                  </span>
                </div>
                <p className="mt-1 break-words text-sm font-semibold text-slate-900" dir="auto">
                  Submitter: {row.declared}
                </p>
                <p className="mt-0.5 break-words text-phx-sm text-slate-600" dir="auto">
                  {row.source === "photo" ? "Photo" : "Master"}: {row.master}
                </p>
              </article>
            ))}
          </div>
          <p
            className={`mt-3 border px-3 py-2 text-phx-sm font-bold ${
              geographyCheck.photo.area.verdict === "mismatch" ||
              geographyCheck.brick.verdict === "mismatch" ||
              geographyCheck.area.verdict === "mismatch"
                ? "border-rose-300 bg-rose-50 text-rose-900"
                : geographyCheck.photo.brick.verdict === "mismatch" || geographyCheck.address.verdict === "mismatch"
                  ? "border-amber-300 bg-amber-50 text-amber-900"
                  : geographyCheck.brick.verdict === "match"
                    ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                    : "border-slate-300 bg-slate-50 text-slate-700"
            }`}
          >
            {geographyCheck.summary}
          </p>
        </PanelSection>
      ) : null}

      <PanelSection title="Distributors" anchorId="do-distributors">
        {/* Distributors get a row each rather than one joined string: three pairs runs ~80
            characters, which would either wrap or blow the grid. This mirrors the layout the
            pharmacy-variance table already uses for exactly this data, and the mapped-brick
            column surfaces a geography variance right inside the approval window. */}
        <div>
          {distributors.length === 0 ? (
            // Owner rule (2026-08-08): the Distributor / Distributor code fields must stay on
            // screen even when empty — not disappear into a prose-only block. A missing FIELD reads
            // as "the screen forgot to ask"; a field that answers reads as "asked, and here is what
            // is true".
            //
            // And when a candidate WAS found, these fields must show it. They read "Not provided"
            // directly above a block naming that very distributor and code — the same
            // self-contradiction this section was already fixed for once, resurfacing one block
            // higher. "Nothing on file" and "found, waiting to be linked" are different facts.
            <>
              <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field
                  label="Distributor"
                  value={
                    candidateMatch ? (
                      <span>
                        {candidateMatch.distributorName}
                        <span className="ml-1 text-phx-xs font-semibold text-amber-700">found, not linked</span>
                      </span>
                    ) : (
                      <span className="text-slate-400">Not provided</span>
                    )
                  }
                />
                <Field
                  label="Distributor code"
                  value={
                    candidateMatch ? (
                      <span>
                        {candidateMatch.customerCode}
                        <span className="ml-1 text-phx-xs font-semibold text-amber-700">found, not linked</span>
                      </span>
                    ) : (
                      <span className="text-slate-400">Not provided</span>
                    )
                  }
                />
              </dl>
              {/* THREE states, never two stacked blocks that contradict each other.
                  "No code exists anywhere" and "a real code exists but was never linked to this
                  record" demand opposite reactions from an approver, and an earlier version of this
                  screen printed both at once — "none was entered" directly above "possible match
                  found", with two competing calls to action. */}
              {possibleDistributorMatches.length === 0 ? (
                <div className="mt-2 border border-amber-200 bg-amber-50 px-3 py-2 shadow-[inset_0_1px_2px_rgba(146,64,14,0.06)]">
                  <p className="text-phx-sm font-bold text-amber-900">
                    No distributor customer code on file for this pharmacy.
                  </p>
                  <p className="mt-0.5 text-phx-sm text-amber-800">
                    Nothing is missing from this screen — none was entered. Phoenix matches a
                    pharmacy&apos;s distributor sales on that code, so until one is added this
                    pharmacy&apos;s distributor sales cannot be linked to it. The direct order itself is
                    unaffected. Add the code in Direct Orders → Pharmacy Registry.
                  </p>
                </div>
              ) : (
                // Auto-link (owner rule, 2026-08-08) runs at registration and at submit, so anything
                // still visible here was REFUSED by the rule — not merely unnoticed. The block must
                // therefore lead with the refusal, or it shows the reader a match the system plainly
                // saw and says nothing about why it declined to act on it.
                <div className="mt-2 border border-amber-300 bg-amber-50 px-3 py-2 shadow-[inset_0_1px_2px_rgba(146,64,14,0.06)]">
                  <p className="text-phx-sm font-black text-amber-900">
                    This pharmacy&apos;s NAME is a real distributor customer code — and Phoenix did not
                    link it automatically.
                  </p>
                  {autoLinkRefusal ? (
                    <p className="mt-0.5 text-phx-sm text-amber-800">
                      {describeDirectOrderAutoLinkRefusal(autoLinkRefusal)}
                    </p>
                  ) : null}
                  <ul className="mt-1.5 space-y-1">
                    {possibleDistributorMatches.map((match) => (
                      <li
                        key={match.distributorCode}
                        className="border border-amber-200 bg-white px-2 py-1 text-phx-sm text-amber-900"
                        dir="auto"
                      >
                        {match.distributorName} · {match.customerCode} · {match.customerName}
                        {match.areaCode ? ` · area ${match.areaCode}` : ""}
                        {/* NAME the holder. "Owned by another pharmacy" without saying which one
                            leaves the reader with a dead end; with it, the duplicate registration is
                            visible in one line and the fix is obvious. */}
                        {match.ownedByPharmacyCode ? (
                          <span className="ml-1 font-black text-rose-700">
                            {match.ownedByPharmacyCode === "unknown"
                              ? "· ownership could not be checked"
                              : `· already held by ${match.ownedByPharmacyName ?? "another pharmacy"} (${match.ownedByPharmacyCode})`}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-phx-xs text-amber-700">
                    Link the right one in Direct Orders → Pharmacy Registry to unlock this
                    pharmacy&apos;s retail sales history.
                  </p>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="mt-1.5 hidden overflow-x-auto md:block">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-[#eef1f3] text-left text-phx-xs font-black uppercase tracking-wider text-slate-500">
                      <th className="whitespace-nowrap px-2 py-1">Distributor</th>
                      <th className="whitespace-nowrap px-2 py-1">Distributor code</th>
                      <th className="whitespace-nowrap px-2 py-1">Customer code</th>
                      <th className="whitespace-nowrap px-2 py-1">Mapped brick</th>
                      <th className="whitespace-nowrap px-2 py-1">Mapped area</th>
                      <th className="whitespace-nowrap px-2 py-1">Mapped region</th>
                    </tr>
                  </thead>
                  <tbody>
                    {distributors.map((row) => (
                      <tr key={`${row.distributorCode}-${row.customerCode}`} className="border-b border-[#eef1f3]">
                        <td className="whitespace-nowrap px-2 py-1.5 font-semibold text-slate-900">{row.distributorName}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-slate-700">{row.distributorCode || "—"}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-slate-700">{row.customerCode}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-slate-500">{row.mappedBrickName ?? "not mapped"}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-slate-500">{row.mappedAreaName ?? "not mapped"}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-slate-500">{row.mappedRegionName ?? "not mapped"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile: the same six fields as a card. The mapped geography stays on the card
                  rather than being dropped as "detail" — a variance between the pharmacy's area and
                  the distributor's mapping is the single most useful thing in this block, and an
                  approver on a phone is exactly the one who cannot go and look it up. */}
              <div className="mt-1.5 space-y-2 md:hidden">
                {distributors.map((row) => (
                  <article
                    key={`${row.distributorCode}-${row.customerCode}`}
                    className="block border border-phx-line p-3"
                  >
                    <p className="text-sm font-black text-slate-900">{row.distributorName}</p>
                    <p className="mt-0.5 text-phx-xs text-slate-500">
                      {row.distributorCode || "—"} · customer {row.customerCode}
                    </p>
                    <dl className="mt-2 space-y-0.5 text-phx-sm">
                      {(
                        [
                          ["Mapped brick", row.mappedBrickName],
                          ["Mapped area", row.mappedAreaName],
                          ["Mapped region", row.mappedRegionName],
                        ] as const
                      ).map(([label, value]) => (
                        <div key={label} className="flex items-baseline justify-between gap-3">
                          <dt className="text-slate-400">{label}</dt>
                          <dd className="font-semibold text-slate-600">{value ?? "not mapped"}</dd>
                        </div>
                      ))}
                    </dl>
                  </article>
                ))}
              </div>
            </>
          )}
        </div>
      </PanelSection>

      {/* RETAIL — what the distributors invoiced this pharmacy. Kept strictly separate from the
          direct-order history below: they are different channels and summing them would double
          count. Matched on (distributor code + customer code) together, because a customer code
          alone is not unique across distributors. */}
      <PanelSection title="Retail sales — from the distributors">
        <p className="mb-2 text-phx-xs font-bold text-slate-500">
          all months on record
          {retailMatchedPairs > 0 ? ` · matched on ${retailMatchedPairs} distributor code${retailMatchedPairs === 1 ? "" : "s"}` : ""}
        </p>
        {/* Confidential products are withheld from EVERY role, including CEO and Super Admin (owner
            rule). Saying so matters: those products are ~81.5% of sales value, so a silently
            filtered table would read as "this pharmacy barely buys" when the opposite is true. */}
        {hiddenConfidentialCount > 0 ? (
          <p className="mb-2 border border-slate-300 bg-slate-50 px-3 py-2 text-phx-sm font-semibold text-slate-600 shadow-[inset_0_1px_2px_rgba(15,23,42,0.05)]">
            {hiddenConfidentialCount} confidential product{hiddenConfidentialCount === 1 ? "" : "s"} hidden from this
            view. Figures below exclude {hiddenConfidentialCount === 1 ? "it" : "them"}.
          </p>
        ) : null}
        {retailLoadFailed ? (
          // A FAILED READ IS NOT AN EMPTY RESULT. Before this branch existed the catch path returned
          // a bare empty list, so a timeout rendered the trusted sentence "the pharmacy is
          // established, so this means it has not bought" — a confident lie about a query that
          // never ran, on the screen where money is approved.
          <p className="px-4 py-4 text-sm font-bold text-rose-700">
            This pharmacy&apos;s retail sales could not be loaded — the query failed. This is NOT
            &quot;no sales&quot;: nothing is known either way right now. Reload before judging the order
            against its history.
          </p>
        ) : retailUnmatchable ? (
          /* Spec D2. This branch is checked FIRST, so before it carried the trust state it hid it:
             a provisional pharmacy with no distributor code was told only that paperwork was
             missing, never that it had not been proved to exist. Five of the ten live provisional
             pharmacies landed here and read as routine. */
          <p
            className={`px-4 py-4 text-sm ${
              pharmacyStanding && pharmacyStanding.trustState !== "trusted"
                ? "font-semibold text-amber-700"
                : "text-slate-500"
            }`}
          >
            {pharmacyStanding?.noCodeNote ??
              "This pharmacy has no distributor customer code on file, so its retail sales cannot be matched."}
          </p>
        ) : retailHistory.length === 0 ? (
          /* Spec D2: WHY it is empty, not just that it is. A provisional pharmacy and an
             established one that simply has not bought both produce zero rows, and they are
             opposite risks — so the sentence comes from the domain, never from a count here. */
          <p
            className={`px-4 py-4 text-sm ${
              pharmacyStanding && pharmacyStanding.trustState !== "trusted"
                ? "font-semibold text-amber-700"
                : "text-slate-500"
            }`}
          >
            {pharmacyStanding?.noHistoryNote ??
              "No distributor sales found for this pharmacy's customer codes."}
          </p>
        ) : (
          <>
          {/* PRODUCTS × MONTHS (owner request, 2026-08-08). The flat row-per-month-per-product list
              this replaces made "does this pharmacy usually take this much?" — the actual question
              an approver is answering — something you had to reconstruct by eye across 30 rows.
              Each cell carries the units and which distributor supplied them. */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-[#eef1f3] bg-slate-50 text-left text-phx-xs font-black uppercase tracking-wider text-slate-500">
                  <th className="sticky left-0 z-10 bg-slate-50 px-3 py-2">Product</th>
                  {salesMatrix.months.map((month) => (
                    <th key={month} className="whitespace-nowrap px-3 py-2 text-right">
                      {month}
                    </th>
                  ))}
                  <th className="whitespace-nowrap px-3 py-2 text-right">Total units</th>
                </tr>
              </thead>
              <tbody>
                {salesMatrix.products.map((product) => (
                  <tr key={product.productCode} className="border-b border-[#eef1f3]">
                    <th scope="row" className="sticky left-0 z-10 whitespace-nowrap bg-white px-3 py-1.5 text-left font-semibold text-slate-900">
                      {product.productName} <span className="font-normal text-slate-400">({product.productCode})</span>
                    </th>
                    {product.cells.map((cell, index) => (
                      <td
                        key={salesMatrix.months[index]}
                        className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-900"
                      >
                        {cell ? (
                          <>
                            {cell.units.toLocaleString("en-US")}
                            {cell.bonus ? (
                              <span className="ml-1 text-phx-2xs font-semibold text-slate-500">
                                +{cell.bonus.toLocaleString("en-US")}b
                              </span>
                            ) : null}
                            <span className="block text-phx-2xs font-normal text-slate-400">
                              {cell.distributors.join(", ")}
                            </span>
                          </>
                        ) : (
                          // A month with no purchase is a real fact about the relationship, so it
                          // reads as an explicit nothing rather than an empty cell.
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                    ))}
                    <td className="whitespace-nowrap px-3 py-1.5 text-right font-black tabular-nums text-slate-900">
                      {product.totalUnits.toLocaleString("en-US")}
                    </td>
                  </tr>
                ))}
              </tbody>
              {/* The judgement line: what this pharmacy is actually worth across all months on
                  record, so the approver weighs THIS order against THAT total at a glance. */}
              <tfoot>
                <tr className="bg-slate-50">
                  <th scope="row" className="sticky left-0 z-10 whitespace-nowrap bg-slate-50 px-3 py-2 text-left text-phx-xs font-black uppercase tracking-wider text-slate-500">
                    Total units · {money(retailTotals.salesValue)} over {salesMatrix.months.length} month
                    {salesMatrix.months.length === 1 ? "" : "s"}
                  </th>
                  {salesMatrix.monthTotals.map((total, index) => (
                    <td
                      key={salesMatrix.months[index]}
                      className="whitespace-nowrap px-3 py-2 text-right font-bold tabular-nums text-slate-700"
                    >
                      {total.toLocaleString("en-US")}
                    </td>
                  ))}
                  <td className="whitespace-nowrap px-3 py-2 text-right font-black tabular-nums text-slate-900">
                    {salesMatrix.grandTotalUnits.toLocaleString("en-US")}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Mobile: one card per PRODUCT — the matrix's own rows, not the raw feed. A phone cannot
              show a months-wide grid, but it can show the same story: what this pharmacy takes of
              each product, month by month, and from whom. The TOTAL is a card of its own at the end
              rather than a dropped "footer" — it is the judgement line the approver weighs this
              order against, and it is the first thing lost when a table is squeezed onto a phone. */}
          <div className="space-y-2 md:hidden">
            {salesMatrix.products.map((product) => (
              <article key={product.productCode} className="block border border-phx-line p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-black text-slate-900">
                    {product.productName} <span className="font-semibold text-slate-400">({product.productCode})</span>
                  </p>
                  <p className="text-sm font-black tabular-nums text-slate-900">
                    {product.totalUnits.toLocaleString("en-US")} units
                  </p>
                </div>
                <dl className="mt-2 space-y-0.5 text-phx-sm">
                  {product.cells.map((cell, index) =>
                    cell ? (
                      <div key={salesMatrix.months[index]} className="flex items-baseline justify-between gap-3">
                        <dt className="text-slate-500">{salesMatrix.months[index]}</dt>
                        <dd className="text-right font-semibold tabular-nums text-slate-800">
                          {cell.units.toLocaleString("en-US")}
                          {cell.bonus ? <span className="ml-1 text-slate-500">+{cell.bonus.toLocaleString("en-US")}b</span> : null}
                          <span className="ml-1 font-normal text-slate-400">{cell.distributors.join(", ")}</span>
                        </dd>
                      </div>
                    ) : null,
                  )}
                </dl>
              </article>
            ))}
            <article className="block border border-slate-300 bg-slate-50 p-3 shadow-[inset_0_1px_2px_rgba(15,23,42,0.05)]">
              <p className="text-phx-2xs font-black uppercase tracking-wider text-slate-500">
                Total — {salesMatrix.products.length.toLocaleString("en-US")} product
                {salesMatrix.products.length === 1 ? "" : "s"} over {salesMatrix.months.length} month
                {salesMatrix.months.length === 1 ? "" : "s"}
              </p>
              <p className="mt-1 text-sm font-black tabular-nums text-slate-900">
                {retailTotals.qty.toLocaleString("en-US")} qty
                <span className="ml-2 font-bold text-slate-600">
                  {retailTotals.bonus.toLocaleString("en-US")} bonus
                </span>
                <span className="ml-2">
                  {money(retailTotals.salesValue)}
                </span>
              </p>
              {/* The line most likely to catch a phantom, and pure arithmetic on numbers already
                  on this page. An order worth more than everything the pharmacy has ever bought is
                  not necessarily wrong — it is never routine. */}
              {request.salesValue > retailTotals.salesValue ? (
                <p className="mt-2 text-phx-sm font-bold text-amber-700">
                  This single order is larger than everything this pharmacy has ever bought.
                </p>
              ) : null}
            </article>
          </div>
          </>
        )}
      </PanelSection>

      {/* DIRECT — what Phoenix booked from approved direct orders. The request being decided is
          excluded, so the baseline never contains the number under judgement. */}
      <PanelSection title="Direct sales — from Phoenix direct orders">
        <p className="mb-2 text-phx-xs font-bold text-slate-500">excludes this request</p>
        {pharmacyHistory.length === 0 ? (
          <p className="py-2 text-sm text-slate-500">
            No other direct orders recorded for this pharmacy yet — this is its first.
          </p>
        ) : (
          <>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-[#eef1f3] bg-slate-50 text-left text-phx-xs font-black uppercase tracking-wider text-slate-500">
                  <th className="whitespace-nowrap px-3 py-2">Month</th>
                  <th className="whitespace-nowrap px-3 py-2">Product</th>
                  {/* No Distributor column: a direct order carries no distributor of its own. This
                      table used to invent one by fanning every order across the pharmacy's linked
                      pairs — which also counted each order once PER PAIR at full value. */}
                  <th className="whitespace-nowrap px-3 py-2 text-right">Orders</th>
                  <th className="whitespace-nowrap px-3 py-2 text-right">Qty</th>
                  <th className="whitespace-nowrap px-3 py-2 text-right">Bonus</th>
                  <th className="whitespace-nowrap px-3 py-2 text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {pharmacyHistory.map((row) => (
                  <tr key={`${row.month}-${row.productCode}`} className="border-b border-[#eef1f3]">
                    <td className="whitespace-nowrap px-3 py-1.5 font-semibold text-slate-900">
                      {row.month}
                      {row.monthIsProvisional ? (
                        <span className="ml-1.5 text-phx-2xs font-bold uppercase tracking-wide text-amber-700">
                          not final
                        </span>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-slate-800">
                      {row.productName} <span className="text-slate-400">({row.productCode})</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-700">{row.orders}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-900">
                      {row.qty.toLocaleString("en-US")}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-700">
                      {row.bonus.toLocaleString("en-US")}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right font-bold tabular-nums text-slate-900">
                      {money(row.salesValue)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-slate-50">
                  <td colSpan={2} className="whitespace-nowrap px-3 py-2 text-phx-xs font-black uppercase tracking-wider text-slate-500">
                    Total
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-bold tabular-nums text-slate-700">
                    {directTotals.orders.toLocaleString("en-US")}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-black tabular-nums text-slate-900">
                    {directTotals.qty.toLocaleString("en-US")}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-bold tabular-nums text-slate-700">
                    {directTotals.bonus.toLocaleString("en-US")}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-black tabular-nums text-slate-900">
                    {money(directTotals.salesValue)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Mobile. The "not final" flag rides the card exactly as it rides the row: a month that
              Finance has not closed must never be read as settled, and that warning is worth more
              on a phone than any of the numbers beside it. */}
          <div className="space-y-2 md:hidden">
            {pharmacyHistory.map((row) => (
              <article key={`${row.month}-${row.productCode}`} className="block border border-phx-line p-3">
                <p className="text-sm font-black text-slate-900">
                  {row.month}
                  {row.monthIsProvisional ? (
                    <span className="ml-1.5 text-phx-2xs font-bold uppercase tracking-wide text-amber-700">
                      not final
                    </span>
                  ) : null}
                  <span className="font-bold"> · {row.productName}</span>{" "}
                  <span className="font-semibold text-slate-400">({row.productCode})</span>
                </p>
                <p className="mt-2 text-sm font-bold tabular-nums text-slate-900">
                  {row.orders.toLocaleString("en-US")} order{row.orders === 1 ? "" : "s"}
                  <span className="ml-2">{row.qty.toLocaleString("en-US")} qty</span>
                  <span className="ml-2 font-semibold text-slate-500">
                    {row.bonus.toLocaleString("en-US")} bonus
                  </span>
                  <span className="ml-2">{money(row.salesValue)}</span>
                </p>
              </article>
            ))}
            <article className="block border border-slate-300 bg-slate-50 p-3 shadow-[inset_0_1px_2px_rgba(15,23,42,0.05)]">
              <p className="text-phx-2xs font-black uppercase tracking-wider text-slate-500">Total</p>
              <p className="mt-1 text-sm font-black tabular-nums text-slate-900">
                {directTotals.orders.toLocaleString("en-US")} orders
                <span className="ml-2">
                  {directTotals.qty.toLocaleString("en-US")} qty
                </span>
                <span className="ml-2 font-bold text-slate-600">
                  {directTotals.bonus.toLocaleString("en-US")} bonus
                </span>
                <span className="ml-2">
                  {money(directTotals.salesValue)}
                </span>
              </p>
            </article>
          </div>
          </>
        )}
      </PanelSection>

      <PanelSection title="Approval chain">
        {narrativeSteps.length === 0 ? (
          <p className="py-2 text-sm text-slate-500">
            {request.status === "held" || request.status === "expired"
              ? "No approval chain — a held request enters the chain only after its pharmacy passes validation."
              : "No approval steps recorded for this request."}
          </p>
        ) : (
          <ol className="divide-y divide-[#eef1f3]">
            {narrativeSteps.map((step) => (
              <li key={step.order} className="py-2.5">
                <div className="flex items-center gap-3">
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${NARRATIVE_TONE[step.state]}`} />
                  <span className="w-6 shrink-0 text-xs font-bold text-slate-400">{step.order}</span>
                  {/* min-w-0 so a long approver name shrinks instead of shoving the status off the
                      screen, and the rung label drops to its own line on a phone rather than
                      fighting the name for the same one. */}
                  <span dir="auto" className="min-w-0 flex-1 text-sm font-semibold text-slate-800">
                    {step.sentence}
                    <span className="block text-phx-xs font-normal text-slate-400 md:ml-2 md:inline">{step.label}</span>
                  </span>
                </div>
                {/* The decision record (spec D1): who, when — Cairo — and what they wrote. A rung
                    decided by someone other than its named approver (a role rung, or an override)
                    credits the actual decider, never the label. */}
                {step.decidedAt || step.decidedByName || step.decisionComment ? (
                  // The 42px gutter aligns to nothing (dot 10 + gap 12 + w-6 24 + gap 12 = 58) and
                  // eats 12% of a 390px screen in the one block that holds free Arabic text, so it
                  // is desktop-only; the comment's own border-l quote rule is the real visual tie.
                  <div className="mt-1 pl-0 md:pl-[42px]">
                    <p className="text-phx-xs text-slate-500">
                      {step.decidedByName ? <span className="font-bold text-slate-600">{step.decidedByName}</span> : null}
                      {step.decidedAt ? <span>{step.decidedByName ? " · " : ""}{cairoStamp(step.decidedAt)}</span> : null}
                    </p>
                    {step.decisionComment ? (
                      <p className="mt-0.5 break-words border-l-2 border-slate-200 pl-2 text-phx-sm italic text-slate-600" dir="auto">
                        “{step.decisionComment}”
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </PanelSection>

      <DecisionActions
        endpoint={`/api/direct-orders/${encodeURIComponent(request.id)}/decision`}
        commentField="comment"
        actions={availableActions}
        backHref={backHref}
      />

      {/* The conversation — open at ANY status (owner rule, 2026-09-22). Keyed by the order id so it
          remounts fresh when the reader moves to another order. Both the admin and portal detail
          pages render this component, so requester and approvers see the same thread. */}
      <RecordConversationThread
        base={`/api/direct-orders/${encodeURIComponent(request.id)}/conversation`}
        key={request.id}
      />
    </div>
  );
}
