"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Undo2, X } from "lucide-react";

import {
  PortalEmptyState,
  PortalMetricCard,
  PortalRecordFields,
  PortalSection,
  portalInputClassName,
} from "@/components/employee-portal/portal-primitives";
import { DirectOrderCollectionControl } from "@/components/direct-orders/direct-order-collection-control";
import { DirectOrderSalesMonthControl } from "@/components/direct-orders/direct-order-sales-month-control";
import { EvidenceReading } from "@/components/direct-orders/evidence-reading";
import {
  buildDirectOrderApprovalNarrative,
  buildDirectOrderDetailFields,
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

const money = (value: number) => `${Math.round(value).toLocaleString("en-US")} EGP`;
const units = (value: number) => value.toLocaleString("en-US");

// Shown elsewhere on this screen already, so a second copy in the field list reads as a second
// fact. Mirrors the admin window's GRID_HIDDEN_LABELS — the codes ride inside the Product/Pharmacy
// values, the rest are metric cards or the tracker above.
// Four verdicts, four looks — "not checked" must never be able to pass for "agrees".
const PORTAL_VERDICT_TONE: Record<DirectOrderGeographyVerdict, string> = {
  match: "bg-emerald-100 text-emerald-800",
  mismatch: "bg-rose-100 text-rose-800",
  unknown: "bg-slate-200 text-slate-600",
  not_checkable: "bg-slate-200 text-slate-600",
};
const PORTAL_VERDICT_LABEL: Record<DirectOrderGeographyVerdict, string> = {
  match: "agrees",
  mismatch: "disagrees",
  unknown: "not checked",
  not_checkable: "nothing to check",
};

const PORTAL_HIDDEN_LABELS = new Set([
  "Sato product code",
  "Sato pharmacy code",
  "Discount %",
  "Pharmacy price",
  "Public price",
  "Sales value",
  "Quantity",
  "Collection date",
  "Status",
]);

// The same three clusters the admin window uses, so the two screens describe an order in the same
// order and a reader moving between them is not re-learning the layout.
const PORTAL_PRODUCT_GROUP = new Set(["Line", "Product", "Deal type"]);
const PORTAL_PHARMACY_GROUP = new Set([
  "Pharmacy",
  "Doctor",
  "Brick",
  "Area",
  "Region",
  "Medical rep",
  "Pharmacy status",
  "Pharmacy registered by",
]);

/**
 * A named field cluster: a real two-column table on desktop, the portal's own cards on a phone.
 *
 * The owner asked for these groups to be "premium polished tables", and the standing admin-shell
 * rule is that mobile never gets a table. Both hold here because the portal already formalises this
 * split (PortalResponsiveDataList) — the table is the desktop rendering of the same rows.
 */
function PortalFieldGroup({ rows, title }: { rows: Array<{ label: string; value: ReactNode }>; title: string }) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-3 first:mt-0">
      <p className="mb-1.5 border-b border-slate-100 pb-1 text-[10px] font-black uppercase tracking-[0.16em] text-orange-600">
        {title}
      </p>
      <div className="hidden sm:block">
        <table className="w-full border-collapse text-sm">
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.label} className={index % 2 ? "bg-slate-50/60" : "bg-white"}>
                <th
                  scope="row"
                  className="w-[34%] whitespace-nowrap border-b border-slate-100 px-2.5 py-1.5 text-left align-top text-[10px] font-black uppercase tracking-wider text-slate-400"
                >
                  {row.label}
                </th>
                <td className="border-b border-slate-100 px-2.5 py-1.5 align-top">
                  <div className="min-w-0 break-words font-semibold text-slate-900">{row.value}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Phone: the portal's own cards. PortalRecordFields wraps by design (break-words) — the
          deliberate mobile exception to the never-wrap rule, since nowrap here would give a phone a
          horizontally-scrolling screen. */}
      <div className="sm:hidden">
        <PortalRecordFields fields={rows} />
      </div>
    </div>
  );
}

/** Portal twin of the admin PriceUsageField: green + tick for the basis that priced this deal, red
 *  and struck through for the one that did not. */
function PortalPriceUsage({ used, value }: { used: boolean; value: number | null }) {
  if (value == null) return <span className="text-slate-400">Not set</span>;
  const label = `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} EGP`;
  return used ? (
    <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 font-black text-emerald-800">
      <span aria-hidden>✓</span>
      {label}
    </span>
  ) : (
    <span className="inline-block rounded bg-rose-50 px-1.5 py-0.5 font-semibold text-rose-700 line-through decoration-rose-400 decoration-1">
      {label}
    </span>
  );
}

const NARRATIVE_TONE: Record<DirectOrderApprovalNarrativeStep["state"], string> = {
  done: "bg-emerald-500",
  rejected: "bg-rose-500",
  current: "bg-amber-400",
  waiting: "bg-slate-300",
};

type DecisionAction = "approve" | "reject" | "return";
type Pending = DecisionAction | null;

const LABEL: Record<DecisionAction, string> = {
  approve: "Approve",
  reject: "Reject",
  return: "Return with comment",
};
const REASON_REQUIRED: Record<DecisionAction, boolean> = {
  approve: false,
  reject: true,
  return: true,
};

function DirectOrderPortalDecisionActions({
  requestId,
  actions,
  backHref,
}: {
  requestId: string;
  actions: { approve?: boolean; reject?: boolean; return?: boolean };
  backHref: string;
}) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  const [pending, setPending] = useState<Pending>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = (["approve", "return", "reject"] as DecisionAction[]).filter((action) => actions[action]);
  if (available.length === 0) return null;

  function start(action: DecisionAction) {
    setError(null);
    setReason("");
    setPending(action);
  }

  async function confirm() {
    if (!pending) return;
    if (REASON_REQUIRED[pending] && !reason.trim()) {
      setError("A reason is required for this action.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/direct-orders/${encodeURIComponent(requestId)}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: pending, comment: reason.trim() || null }),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) {
        setError(data.message || "This request could not be updated. It may have already been decided.");
        setBusy(false);
        return;
      }
      router.push(backHref);
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
      setBusy(false);
    }
  }

  const toneClass: Record<DecisionAction, string> = {
    approve: "bg-emerald-600 hover:bg-emerald-700 text-white",
    return: "border border-amber-400 text-amber-700 hover:bg-amber-50",
    reject: "border border-rose-400 text-rose-700 hover:bg-rose-50",
  };
  const icon: Record<DecisionAction, typeof Check> = { approve: Check, reject: X, return: Undo2 };

  const primaryButtons = (compact: boolean) =>
    available.map((action) => {
      const Icon = icon[action];
      return (
        <button
          key={action}
          type="button"
          onClick={() => start(action)}
          className={`flex h-11 flex-1 items-center justify-center gap-2 rounded text-sm font-bold transition ${toneClass[action]}`}
        >
          <Icon className="h-4 w-4" />
          {compact ? action[0].toUpperCase() + action.slice(1) : LABEL[action]}
        </button>
      );
    });

  return (
    <>
      <PortalSection eyebrow="Decision" title="Your response">
        <div className="space-y-3 p-4 sm:p-5">
          {pending === null ? (
            <div className="flex flex-wrap gap-2">{primaryButtons(false)}</div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm font-bold text-slate-900">
                {pending === "approve" ? `Confirm: ${LABEL[pending]} this request?` : `${LABEL[pending]} -- provide a reason`}
              </p>
              {REASON_REQUIRED[pending] ? (
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  autoFocus
                  placeholder="Type the reason the requester will see..."
                  className={portalInputClassName + " h-auto py-2"}
                />
              ) : null}
              {error ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={confirm}
                  disabled={busy}
                  className="h-11 flex-1 rounded bg-orange-600 text-sm font-bold text-white transition hover:bg-orange-700 disabled:opacity-60"
                >
                  {busy ? "Submitting..." : `Confirm ${LABEL[pending].split(" ")[0]}`}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPending(null);
                    setError(null);
                  }}
                  disabled={busy}
                  className="h-11 flex-1 rounded border border-slate-300 text-sm font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-60"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {error && pending === null ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}
        </div>
      </PortalSection>

      {/* Sticky mobile action bar -- same state machine, thumb-reachable on a phone. */}
      {mounted
        ? createPortal(
            <div
              className="fixed inset-x-0 z-30 flex gap-2 border-t border-slate-200 bg-white/95 px-4 pb-3 pt-3 backdrop-blur md:hidden"
              style={{ bottom: "calc(56px + env(safe-area-inset-bottom))" }}
            >
              {pending === null ? (
                primaryButtons(true)
              ) : (
                <>
                  <button
                    type="button"
                    onClick={confirm}
                    disabled={busy}
                    className="h-12 flex-1 rounded bg-orange-600 text-sm font-black text-white transition disabled:opacity-60"
                  >
                    {busy ? "Submitting..." : `Confirm`}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPending(null);
                      setError(null);
                    }}
                    disabled={busy}
                    className="h-12 flex-1 rounded border border-slate-300 bg-white text-sm font-black text-slate-600 disabled:opacity-60"
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export function DirectOrderPortalDetail({
  detail,
  backHref,
  // Serves both the approver and the requester tracking their own order — only the return path
  // differs. See the admin component for the reasoning.
  backLabel = "Back to Direct Orders Approvals",
}: {
  detail: DirectOrderApprovalDetail | null;
  backHref: string;
  backLabel?: string;
}) {
  if (!detail) {
    return (
      <div className="space-y-4">
        <Link href={backHref} className="inline-flex items-center gap-1 text-sm font-bold text-orange-600 hover:text-orange-700">
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>
        <PortalEmptyState title="Request not found" message="This direct order request was not found, or you do not have access to it." />
      </div>
    );
  }

  const {
    request,
    distributors,
    pharmacyHistory,
    retailHistory,
    retailUnmatchable,
    canSetSalesMonth,
    canRecordCollection,
    steps,
    availableActions,
    bonusOverCap,
    pharmacyEvidence,
    possibleDistributorMatches,
    autoLinkRefusal,
    retailLoadFailed,
    hiddenConfidentialCount,
    geographyCheck,
    productPharmacyPrice,
    productPublicPrice,
  } = detail;
  // Same fallback the domain draws: the basis that did NOT price this deal falls back to the
  // product's CURRENT price, so a saved price stays visible and "not set" means genuinely none.
  const pharmacyPriceValue = request.pharmacyPriceSnapshot ?? productPharmacyPrice;
  const publicPriceValue = request.publicPriceSnapshot ?? productPublicPrice;
  // Same shared field list the admin approval screen renders — see approval-fields.ts for why
  // it lives in the domain rather than being hand-maintained twice.
  const allFields = buildDirectOrderDetailFields(detail);
  const gridFields = allFields.filter((field) => field.layout !== "full");
  const addressField = allFields.find((field) => field.label === "Pharmacy address");
  // Everything the three grouped tables below draw from, with the duplicates already removed.
  const visibleFields = gridFields.filter(
    (field) => field.label !== "Pharmacy address" && !PORTAL_HIDDEN_LABELS.has(field.label),
  );
  const statusBanner = resolveDirectOrderStatusBanner(detail);
  const pricingBreakdown = computeDirectOrderPricingBreakdown(request);
  const narrativeSteps = buildDirectOrderApprovalNarrative(steps);
  const currentStep = narrativeSteps.find((step) => step.state === "current");
  // Read once, so the Distributor FIELDS and the callout beneath them can never describe
  // different things — which is exactly how they came to contradict each other.
  const candidateMatch = possibleDistributorMatches[0] ?? null;

  return (
    <div className="space-y-5 pb-24 md:pb-0">
      <Link href={backHref} className="inline-flex items-center gap-1 text-sm font-bold text-orange-600 hover:text-orange-700">
        <ArrowLeft className="h-4 w-4" /> {backLabel}
      </Link>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <PortalMetricCard accent="orange" label="Sales value" value={money(request.salesValue)} />
        <PortalMetricCard
          accent="slate"
          label="Current step"
          value={currentStep ? currentStep.approverName ?? currentStep.label : request.status.replace(/_/g, " ")}
        />
        <PortalMetricCard
          accent={bonusOverCap ? "rose" : "sky"}
          label={dealFieldLabel(request)}
          value={formatDealValue(request)}
          note={bonusOverCap ? "over cap" : undefined}
        />
        <PortalMetricCard
          accent="emerald"
          label="Collection date"
          value={request.collectionDate ? String(request.collectionDate).slice(0, 10) : "—"}
        />
      </div>

      {/* The workflow as a bar, not the words "pending approval" — parity with the admin window,
          reading the same narrative state machine so the two can never disagree about which rung
          holds it. A held request has NO chain, and says so rather than drawing an empty bar. */}
      <div className="rounded border border-slate-200 bg-white p-3">
        {narrativeSteps.length === 0 ? (
          <p className="text-[12px] font-semibold text-slate-600">
            {request.status === "held" || request.status === "expired"
              ? "Not in the approval chain — a held request enters it only once its pharmacy passes validation."
              : "No approval steps recorded for this request."}
          </p>
        ) : (
          <div className="flex gap-2">
            {narrativeSteps.map((step) => (
              <div key={step.order} className="min-w-0 flex-1">
                <div className={`h-1.5 w-full rounded ${NARRATIVE_TONE[step.state]}`} />
                <p
                  className={`mt-1.5 truncate text-[10px] uppercase tracking-wide ${
                    step.state === "current"
                      ? "font-black text-amber-800"
                      : step.state === "done"
                        ? "text-emerald-700"
                        : step.state === "rejected"
                          ? "font-black text-rose-700"
                          : "text-slate-400"
                  }`}
                  title={step.label}
                >
                  {step.label}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      <PortalSection>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-900 px-4 py-3.5 sm:px-5">
          <h2 className="text-base font-black text-white">
            {request.productName} x {request.qty.toLocaleString("en-US")}
          </h2>
          <span className="text-lg font-black text-orange-400">{money(request.salesValue)}</span>
        </div>
        {statusBanner ? (
          <div className={`border-b border-slate-100 px-4 py-2.5 sm:px-5 ${DIRECT_ORDER_STATUS_BANNER_CLASSES[statusBanner.tone].container}`}>
            <p className={`text-[12px] font-bold ${DIRECT_ORDER_STATUS_BANNER_CLASSES[statusBanner.tone].text}`}>
              {statusBanner.message}
            </p>
          </div>
        ) : null}
        {bonusOverCap ? (
          <div className="space-y-1 border-b border-slate-100 bg-amber-50 px-4 py-2.5 sm:px-5">
            <p className="text-[12px] font-bold text-amber-900">
              Over cap -- this {request.dealType} exceeds its product cap. Flagged for your attention, not blocked.
            </p>
          </div>
        ) : null}
        <div className="p-4 sm:p-5">
          {/* PortalRecordFields wraps by design (break-words). That is the deliberate mobile
              exception to the never-wrap rule: forcing nowrap here would give a phone a
              horizontally-scrolling screen. Desktop tables never wrap; mobile cards do. */}
          {/* Three named clusters, matching the admin window, instead of one flat wall of fields. */}
          <PortalFieldGroup
            title="Product & deal"
            rows={[
              ...visibleFields
                .filter((field) => PORTAL_PRODUCT_GROUP.has(field.label))
                .map((field) => ({ label: field.label, value: field.value as ReactNode })),
              // Colour-coded, not captioned — parity with the admin window. The used basis is green
              // with a tick, the unused one red and struck through, instead of the sentence
              // "(on file, not used - discount deal)" trailing the number.
              {
                label: "Pharmacy price",
                value: <PortalPriceUsage used={request.dealType === "bonus"} value={pharmacyPriceValue} />,
              },
              {
                label: "Public price",
                value: <PortalPriceUsage used={request.dealType === "discount"} value={publicPriceValue} />,
              },
            ]}
          />
          <PortalFieldGroup
            title="Pharmacy & geography"
            rows={visibleFields
              .filter((field) => PORTAL_PHARMACY_GROUP.has(field.label))
              .map((field) => ({ label: field.label, value: field.value as ReactNode }))}
          />
          <PortalFieldGroup
            title="Request & timeline"
            rows={visibleFields
              .filter((field) => !PORTAL_PRODUCT_GROUP.has(field.label) && !PORTAL_PHARMACY_GROUP.has(field.label))
              .map((field) => ({ label: field.label, value: field.value as ReactNode }))}
          />
          {addressField ? (
            <div className="mt-3 border-t border-slate-100 pt-3">
              <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Pharmacy address</p>
              <p className="mt-0.5 text-sm font-semibold text-slate-800">{addressField.value}</p>
            </div>
          ) : null}
          {/* "Show your working" for the sales value above — qty x price (x discount), so the
              figure is never just a bare total with nothing to check it against. */}
          <div className="mt-3 border-t border-slate-100 pt-3">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Pricing</p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-700">
              <span>{units(pricingBreakdown.qty)} units</span>
              <span className="text-slate-400">x</span>
              <span>{pricingBreakdown.unitPrice == null ? "—" : money(pricingBreakdown.unitPrice)}</span>
              {pricingBreakdown.basis === "discount" ? (
                <>
                  <span className="text-slate-400">x</span>
                  <span>(1 - {pricingBreakdown.discountPct ?? 0}%)</span>
                </>
              ) : null}
              <span className="text-slate-400">=</span>
              <span className="font-bold text-slate-900">
                {pricingBreakdown.computedValue == null ? "—" : money(pricingBreakdown.computedValue)}
              </span>
              {pricingBreakdown.basis === "bonus" && pricingBreakdown.bonusUnits ? (
                <span className="text-[11px] font-semibold text-slate-500">
                  (+{units(pricingBreakdown.bonusUnits)} bonus units, not counted in value)
                </span>
              ) : null}
            </p>
          </div>
          {/* One row per distributor pair — byte-identical treatment to the distributor block
              on the sibling portal submit page, so this matches the portal's established look. */}
          <div className="mt-3 border-t border-slate-100 pt-3">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Distributors</p>
            {distributors.length === 0 ? (
              // Owner rule (2026-08-08): Distributor / Distributor code stay on screen even when
              // empty — and when a candidate WAS found they must show it rather than reading
              // "Not provided" directly above a block naming that very distributor and code.
              // Same twin fix as the admin window.
              <>
                <div className="mt-1">
                  <PortalRecordFields
                    fields={[
                      {
                        label: "Distributor",
                        value: candidateMatch ? (
                          <span>
                            {candidateMatch.distributorName}
                            <span className="ml-1 text-[11px] font-semibold text-amber-700">found, not linked</span>
                          </span>
                        ) : (
                          <span className="text-slate-400">Not provided</span>
                        ),
                      },
                      {
                        label: "Distributor code",
                        value: candidateMatch ? (
                          <span>
                            {candidateMatch.customerCode}
                            <span className="ml-1 text-[11px] font-semibold text-amber-700">found, not linked</span>
                          </span>
                        ) : (
                          <span className="text-slate-400">Not provided</span>
                        ),
                      },
                    ]}
                  />
                </div>
                {/* Three states, never two contradicting blocks — see the admin window's twin
                    comment for why this must stay mutually exclusive. */}
                {possibleDistributorMatches.length === 0 ? (
                  <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-3 py-2">
                    <p className="text-[12px] font-bold text-amber-900">
                      No distributor customer code on file for this pharmacy.
                    </p>
                    <p className="mt-0.5 text-[12px] text-amber-800">
                      None was entered — nothing failed to load. Phoenix matches a pharmacy&apos;s
                      distributor sales on that code, so until one is added those sales cannot be linked
                      to it. The direct order itself is unaffected.
                    </p>
                  </div>
                ) : (
                  // Refused by the auto-link rule, not merely unnoticed — twin of the admin window.
                  <div className="mt-2 rounded border border-amber-300 bg-amber-50 px-3 py-2">
                    <p className="text-[12px] font-black text-amber-900">
                      This pharmacy&apos;s NAME is a real distributor customer code — and Phoenix did not
                      link it automatically.
                    </p>
                    {autoLinkRefusal ? (
                      <p className="mt-0.5 text-[12px] text-amber-800">
                        {describeDirectOrderAutoLinkRefusal(autoLinkRefusal)}
                      </p>
                    ) : null}
                    <ul className="mt-1.5 space-y-1">
                      {possibleDistributorMatches.map((match) => (
                        <li
                          key={match.distributorCode}
                          className="rounded border border-amber-200 bg-white px-2 py-1 text-[12px] text-amber-900"
                          dir="auto"
                        >
                          {match.distributorName} · {match.customerCode} · {match.customerName}
                          {match.areaCode ? ` · area ${match.areaCode}` : ""}
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
                  </div>
                )}
              </>
            ) : (
              <div className="mt-1.5 space-y-2 rounded border border-slate-100 bg-slate-50 p-3">
                {distributors.map((row) => (
                  <div key={`${row.distributorCode}-${row.customerCode}`} className="space-y-0.5">
                    <div className="text-xs font-bold text-slate-800">
                      {row.distributorName}
                      {row.distributorCode ? ` (${row.distributorCode})` : ""}
                    </div>
                    <div className="text-[11px] text-slate-600">Customer code: {row.customerCode}</div>
                    <div className="text-[11px] text-slate-500">
                      Mapped: {row.mappedBrickName ?? "not mapped"} / {row.mappedAreaName ?? "not mapped"} /{" "}
                      {row.mappedRegionName ?? "not mapped"}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
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
          {request.bonusOverrideReason ? (
            <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">Note: {request.bonusOverrideReason}</p>
          ) : null}
        </div>
      </PortalSection>

      {geographyCheck ? (
        <PortalSection eyebrow="Check" title="Submitter's details vs the master database">
          {/* Cards, not a table — the portal is mobile-first, and each compared field has to keep
              its two values stacked together to be readable. Same data and same verdicts as the
              admin window, rendered through the shared comparator so the two cannot disagree. */}
          <div className="space-y-2 p-4 sm:p-5">
            {[
              { label: "Brick", declared: geographyCheck.brick.declared ?? "—", master: geographyCheck.brick.master ?? "—", verdict: geographyCheck.brick.verdict },
              { label: "Area", declared: geographyCheck.area.declared ?? "—", master: geographyCheck.area.master ?? "—", verdict: geographyCheck.area.verdict },
              {
                label: "Typed address",
                declared: detail.pharmacy?.pharmacyAddress || "—",
                // Never blank (golden rule) — see the admin window's twin comment.
                master: describeResolvedAddressPlace(geographyCheck.address),
                verdict: geographyCheck.address.verdict,
              },
            ].map((row) => (
              <div key={row.label} className="rounded border border-slate-100 bg-slate-50 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">{row.label}</p>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wide ${PORTAL_VERDICT_TONE[row.verdict]}`}>
                    {PORTAL_VERDICT_LABEL[row.verdict]}
                  </span>
                </div>
                <p className="mt-1 break-words text-sm font-semibold text-slate-900" dir="auto">
                  Submitter: {row.declared}
                </p>
                <p className="mt-0.5 break-words text-[12px] text-slate-600" dir="auto">
                  Master: {row.master}
                </p>
              </div>
            ))}
            <p
              className={`rounded border px-3 py-2 text-[12px] font-bold ${
                geographyCheck.brick.verdict === "mismatch" || geographyCheck.area.verdict === "mismatch"
                  ? "border-rose-300 bg-rose-50 text-rose-900"
                  : geographyCheck.address.verdict === "mismatch"
                    ? "border-amber-300 bg-amber-50 text-amber-900"
                    : geographyCheck.brick.verdict === "match"
                      ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                      : "border-slate-300 bg-slate-50 text-slate-700"
              }`}
            >
              {geographyCheck.summary}
            </p>
          </div>
        </PortalSection>
      ) : null}

      {pharmacyEvidence ? (
        <PortalSection eyebrow="Evidence" title="Pharmacy evidence">
          <div className="grid grid-cols-1 gap-4 p-4 sm:p-5 md:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
            <div>
              {pharmacyEvidence.photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={pharmacyEvidence.photoUrl} alt="Storefront evidence" className="w-full rounded border border-slate-100" />
              ) : (
                <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] font-semibold text-amber-800">
                  No photo on file for this claim.
                </p>
              )}
              {/* ADVISORY ONLY (spec D4). Absent for the requester's own view (owner rule,
                  2026-08-08): service.ts strips evidenceCheck to null for that viewer. */}
              <EvidenceReading check={pharmacyEvidence.evidenceCheck} claimedName={pharmacyEvidence.claimedPharmacyName} />
              {pharmacyEvidence.capturedLatitude != null ? (
                <a
                  className="mt-1 block text-[11px] font-bold text-orange-600 underline"
                  href={`https://www.google.com/maps?q=${pharmacyEvidence.capturedLatitude},${pharmacyEvidence.capturedLongitude}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open the pin on the map
                </a>
              ) : null}
            </div>
            <PortalRecordFields
              fields={[
                { label: "Why not in the master database", value: <span dir="auto">{pharmacyEvidence.claimedReason ?? "—"}</span> },
                {
                  label: "Distance from their area",
                  value:
                    pharmacyEvidence.areaDistanceKm == null
                      ? "distance unknown"
                      : `${pharmacyEvidence.areaDistanceKm} km${pharmacyEvidence.gpsInsideRequesterArea ? "" : " — outside their area"}`,
                },
              ]}
            />
          </div>
        </PortalSection>
      ) : null}

      {/* What this pharmacy normally takes. The request being decided is excluded, so the
          baseline never contains the number under judgement. Card-per-bucket on a phone,
          matching the portal's list idiom rather than forcing a wide table onto it. */}
      {/* RETAIL and DIRECT are separate sections, never one merged total: they are different
          channels and adding them together would double count. */}
      <PortalSection eyebrow="Context" title="Retail sales - from the distributors">
        <div className="p-4 sm:p-5">
          {hiddenConfidentialCount > 0 ? (
            <p className="mb-2 rounded border border-slate-300 bg-slate-50 px-3 py-2 text-[12px] font-semibold text-slate-600">
              {hiddenConfidentialCount} confidential product{hiddenConfidentialCount === 1 ? "" : "s"} hidden from this
              view. Figures below exclude {hiddenConfidentialCount === 1 ? "it" : "them"}.
            </p>
          ) : null}
          {retailLoadFailed ? (
            // A failed read is not an empty result — see the admin window's twin comment.
            <p className="text-sm font-bold text-rose-700">
              These sales could not be loaded — the query failed. This is NOT &quot;no sales&quot;;
              nothing is known either way right now.
            </p>
          ) : retailUnmatchable ? (
            <p className="text-sm text-slate-500">
              This pharmacy has no distributor customer code on file, so its retail sales cannot be
              matched. Register it against the distributor that supplies it to see them here.
            </p>
          ) : retailHistory.length === 0 ? (
            <p className="text-sm text-slate-500">No distributor sales found for this pharmacy&apos;s customer codes.</p>
          ) : (
            <div className="space-y-2">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                By month, product and distributor - all months on record
              </p>
              {retailHistory.map((row) => (
                <div
                  key={`${row.month}-${row.productCode}-${row.distributorCode}`}
                  className="rounded border border-slate-100 bg-slate-50 p-3"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-xs font-black text-slate-900">{row.month}</span>
                    <span className="text-xs font-black text-slate-900">{money(row.salesValue)}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] font-bold text-slate-700">
                    {row.productName} ({row.productCode})
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {row.distributorName} ({row.distributorCode}) - customer {row.customerCode}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-600">
                    qty {row.qty.toLocaleString("en-US")} - bonus {row.bonus.toLocaleString("en-US")}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </PortalSection>

      <PortalSection eyebrow="Context" title="Direct sales - from Phoenix direct orders">
        <div className="p-4 sm:p-5">
          {pharmacyHistory.length === 0 ? (
            <p className="text-sm text-slate-500">
              No other direct orders recorded for this pharmacy yet - this is its first.
            </p>
          ) : (
            <div className="space-y-2">
              {/* No distributor here: a direct order carries none. This list used to print one by
                  fanning each order across the pharmacy's linked pairs, which also counted every
                  order once per pair at full value. */}
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                By month and product - excludes this request
              </p>
              {pharmacyHistory.map((row) => (
                <div key={`${row.month}-${row.productCode}`} className="rounded border border-slate-100 bg-slate-50 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-xs font-black text-slate-900">
                      {row.month}
                      {row.monthIsProvisional ? (
                        <span className="ml-1.5 text-[10px] font-bold uppercase text-amber-700">not final</span>
                      ) : null}
                    </span>
                    <span className="text-xs font-black text-slate-900">{money(row.salesValue)}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] font-bold text-slate-700">
                    {row.productName} ({row.productCode})
                  </div>
                  <div className="mt-1 text-[11px] text-slate-600">
                    {row.orders} order{row.orders === 1 ? "" : "s"} - qty {row.qty.toLocaleString("en-US")} - bonus{" "}
                    {row.bonus.toLocaleString("en-US")}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </PortalSection>

      <PortalSection eyebrow="Chain" title="Approval chain">
        {narrativeSteps.length === 0 ? (
          <p className="px-4 py-4 text-sm text-slate-500 sm:px-5">
            {request.status === "held" || request.status === "expired"
              ? "No approval chain — a held request enters the chain only after its pharmacy passes validation."
              : "No approval steps recorded for this request."}
          </p>
        ) : (
          <ol className="divide-y divide-slate-100">
            {narrativeSteps.map((step) => (
              <li key={step.order} className="px-4 py-3 sm:px-5">
                <div className="flex items-center gap-3">
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${NARRATIVE_TONE[step.state]}`} />
                  <span className="w-6 shrink-0 text-xs font-bold text-slate-400">{step.order}</span>
                  <span className="min-w-0 flex-1 text-sm font-semibold text-slate-800">
                    {step.sentence}
                    <span className="ml-2 text-[11px] font-normal text-slate-400">{step.label}</span>
                  </span>
                </div>
                {step.decidedAt || step.decidedByName || step.decisionComment ? (
                  <div className="mt-1 pl-[34px]">
                    <p className="text-[11px] text-slate-500">
                      {step.decidedByName ? <span className="font-bold text-slate-600">{step.decidedByName}</span> : null}
                    </p>
                    {step.decisionComment ? (
                      <p className="mt-0.5 break-words border-l-2 border-slate-200 pl-2 text-[12px] italic text-slate-600" dir="auto">
                        “{step.decisionComment}”
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </PortalSection>

      <DirectOrderPortalDecisionActions requestId={request.id} actions={availableActions} backHref={backHref} />
    </div>
  );
}
