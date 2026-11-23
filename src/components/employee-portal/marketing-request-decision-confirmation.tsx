"use client";

import { useMemo, useState } from "react";

import { MarketingSalesEvidencePanel } from "@/components/marketing-requests/marketing-sales-evidence-panel";
import {
  buildMarketingDecisionConfirmPrompt,
  buildMarketingDecisionRequestBody,
} from "@/lib/marketing-requests/decision-confirm-prompt";
import type {
  MarketingRequestDecision,
  MarketingRequestDecisionSummary,
} from "@/lib/marketing-requests/service";
import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";
import { PharmacyLicenseEvidence } from "@/components/venues/pharmacy-license-evidence";
import { phxTextareaClassName } from "@/components/ui/form-tokens";
import { stableCurrencyFormatter } from "@/lib/format/stable-currency";
import { cn } from "@/lib/utils";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { approvalActionClassName } from "@/components/approvals-hub/approval-action-kit";
import { LANDING_FOCUS, LANDING_INK, LandingTick, LandingTitle } from "@/components/employee-portal/landing-kit";
import { forecastRoiStatusLabel } from "@/lib/marketing-requests/roi-labels";
import { NotOnCrmListFlag } from "@/components/marketing-requests/not-on-crm-list-flag";
import { SamePharmacyCrossUseNotice } from "@/components/approvals-hub/same-pharmacy-cross-use-flag";

/** The small-capital label above a value (the landing kit). */
const FACT_LABEL_CLASS = "text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500";

/**
 * One labelled field, on the hairline grid of its section — never a tinted tile. An absent value
 * renders "Not captured" rather than an empty cell — a blank reads as "this is nothing", which is a
 * different claim from "this was never recorded".
 */
function DetailField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="min-w-0 border-b border-r border-slate-200 bg-white px-3 py-2.5">
      <p className={FACT_LABEL_CLASS}>{label}</p>
      <p className={`mt-0.5 break-words text-phx-md font-semibold ${value ? LANDING_INK : "text-slate-500"}`} dir="auto">
        {value || "Not captured"}
      </p>
    </div>
  );
}

/**
 * The hairline grid the detail fields sit on. The cells draw their own right and bottom hairlines
 * and the grid is pulled 1px under the clipped frame, so an odd count leaves white, not a grey hole.
 */
function DetailGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="@container mt-2 overflow-hidden border border-slate-200">
      <div className="-mb-px -mr-px grid grid-cols-1 @md:grid-cols-2">{children}</div>
    </div>
  );
}

/** A section title inside the review sheet: the kit's tick and navy capitals, nothing under it. */
function SheetTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-6">
      <LandingTitle>{children}</LandingTitle>
    </div>
  );
}

function fallbackLabel(decision: MarketingRequestDecision) {
  if (decision === "approve") return "Approve";
  if (decision === "reject") return "Reject";
  return "Return for edit";
}

function egp(value: number) {
  return `EGP ${stableCurrencyFormatter("en-US", { maximumFractionDigits: 0 }).format(Math.round(Number.isFinite(value) ? value : 0))}`;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

/**
 * The approval-progress rail: state shown by the rail's colour, never a filled pill — amber where
 * it waits (this step, yours), emerald approved, rose rejected or returned, slate not reached.
 * Whole literals, so Tailwind ships every one.
 */
function stepRailClass(step: { isCurrent: boolean; status: string }) {
  if (step.isCurrent) return "border-l-amber-400";
  if (step.status === "approved") return "border-l-emerald-500";
  if (step.status === "rejected" || step.status === "returned") return "border-l-rose-500";
  return "border-l-slate-300";
}

export function MarketingRequestDecisionConfirmation({
  summary,
}: {
  summary: MarketingRequestDecisionSummary;
}) {
  const [activeDecision, setActiveDecision] = useState<MarketingRequestDecision>(summary.decision);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  /**
   * The decision the approver has clicked but not yet confirmed. Nothing is sent while this is set
   * — the buttons open the prompt, and only the prompt's own confirm button calls the API.
   */
  const [pendingConfirm, setPendingConfirm] = useState<MarketingRequestDecision | null>(null);

  const needsReason = activeDecision === "reject" || activeDecision === "return";
  const labelFor = (decision: MarketingRequestDecision) =>
    summary.decisionLabels?.[decision] ?? fallbackLabel(decision);
  const totalValue = useMemo(
    () => summary.products.reduce((sum, product) => sum + (product.value || 0), 0),
    [summary.products],
  );
  /** Who holds the request next if this one is approved — named in the prompt so it is not abstract. */
  const nextStepName = useMemo(() => {
    const currentIndex = summary.chain.findIndex((step) => step.isCurrent);
    if (currentIndex < 0) return null;
    return summary.chain[currentIndex + 1]?.stepName ?? null;
  }, [summary.chain]);
  const confirmPrompt = pendingConfirm
    ? buildMarketingDecisionConfirmPrompt({
        customerName: summary.customerName,
        decision: pendingConfirm,
        decisionLabel: labelFor(pendingConfirm),
        estimatedCost: totalValue || summary.estimatedCost,
        nextStepName,
        requestCode: summary.requestCode,
        requesterName: summary.requesterName,
      })
    : null;

  const dialogRef = useDialogA11y<HTMLDivElement>({
    onClose: () => setPendingConfirm(null),
    open: pendingConfirm !== null,
  });

  /**
   * A click on Approve/Return/Reject no longer decides anything — it asks. The note requirement is
   * still checked here rather than inside the prompt, so a reject with no note shows the same
   * inline error it always did instead of failing behind a dialog the approver just confirmed.
   */
  function requestDecision(decision: MarketingRequestDecision) {
    setError(null);
    setSuccess(null);
    setActiveDecision(decision);
    if ((decision === "reject" || decision === "return") && !comment.trim()) {
      setError(`${labelFor(decision)} note is required.`);
      return;
    }
    setPendingConfirm(decision);
  }

  function confirmPending() {
    const decision = pendingConfirm;
    setPendingConfirm(null);
    if (decision) void submitDecision(decision);
  }

  async function submitDecision(decision: MarketingRequestDecision) {
    setError(null);
    setSuccess(null);
    setActiveDecision(decision);
    const decisionComment = comment.trim();
    if ((decision === "reject" || decision === "return") && !decisionComment) {
      setError(`${labelFor(decision)} note is required.`);
      return;
    }

    setIsPending(true);
    try {
      const response = await fetch(`/api/marketing-requests/${encodeURIComponent(summary.requestId)}/decision`, {
        body: JSON.stringify(buildMarketingDecisionRequestBody({ comment: decisionComment, decision })),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.message === "string" ? payload.message : "Marketing request decision failed.");
      }
      setSuccess(
        `Marketing request ${decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "returned for edit"} successfully.`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Marketing request decision failed.");
    } finally {
      setIsPending(false);
    }
  }

  const decided = Boolean(success);

  return (
    <section className="mx-auto w-full max-w-3xl px-4 py-8">
      <div className={`border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
        {/* The sheet's own head: the kit's tick over a navy title on white — the black band and its
            orange eyebrow are gone. */}
        <header className="border-b border-slate-200 px-4 py-4 sm:px-6">
          <p className="flex items-center gap-2 text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-500">
            <LandingTick />
            Marketing · action required
          </p>
          <h1 className={`mt-1.5 break-words text-[22px] font-bold leading-tight tracking-[-0.01em] ${LANDING_INK}`}>
            Review marketing request
          </h1>
        </header>

        <div className="px-4 py-5 sm:px-6">
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 pb-4">
            <div aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center bg-[#08111f] text-phx-sm font-bold tracking-[0.04em] text-white">
              {initials(summary.requesterName)}
            </div>
            <div className="min-w-0 flex-1">
              <p className={`break-words text-phx-lg font-bold ${LANDING_INK}`} dir="auto">{summary.requesterName}</p>
              <p className="break-words text-phx-xs font-medium text-slate-500">
                {summary.requesterHrId}
                {summary.lineName ? ` · ${summary.lineName} line` : ""}
              </p>
            </div>
            <div className="min-w-0 text-right">
              <p className="break-words font-mono text-phx-xs text-slate-600">{summary.requestCode}</p>
              <span className="mt-1 inline-block text-phx-xs font-bold uppercase tracking-[0.08em] text-amber-700">
                Pending your approval
              </span>
            </div>
          </div>

          {/* Evidence sits ABOVE the ask on purpose: the SFE Validation step exists to judge whether
              this customer is worth spending on, and that judgement should be made before reading
              what is being spent — not after. Inline so the approver never navigates away
              mid-decision (see the shell-redirect bug this replaced). */}
          <div className="mt-4">
            <MarketingSalesEvidencePanel requestId={summary.requestId} />
          </div>

          <SheetTitle>What&apos;s being requested</SheetTitle>
          {summary.products.length > 0 ? (
            <>
              {/* Mobile: one hairline list (tables are desktop-only) — never a card per line */}
              <ul className="mt-2 divide-y divide-slate-200 border border-slate-200 md:hidden">
                {summary.products.map((product, index) => (
                  <li className="px-3 py-2.5" key={`m-${product.name}-${index}`}>
                    <p className={`break-words text-phx-md font-semibold ${LANDING_INK}`}>{product.name}</p>
                    <div className="mt-1.5 flex items-center justify-between gap-3 text-phx-xs">
                      <span className="text-slate-500">
                        Qty <span className={`font-bold tabular-nums ${LANDING_INK}`}>{product.quantity}</span>
                      </span>
                      <span className={`font-bold tabular-nums ${LANDING_INK}`}>{egp(product.value)}</span>
                    </div>
                  </li>
                ))}
              </ul>
              {/* Desktop: table */}
              <table className="mt-2 hidden w-full table-fixed border-collapse border border-slate-200 text-phx-sm md:table">
                <colgroup>
                  <col className="w-[60%]" />
                  <col className="w-[15%]" />
                  <col className="w-[25%]" />
                </colgroup>
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="px-3 py-2.5 text-left text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500" scope="col">Product</th>
                    <th className="px-3 py-2.5 text-right text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500" scope="col">Qty</th>
                    <th className="px-3 py-2.5 text-right text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500" scope="col">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.products.map((product, index) => (
                    <tr key={`${product.name}-${index}`} className="border-b border-slate-200 transition-colors last:border-b-0 hover:bg-slate-50 motion-reduce:transition-none">
                      <td className={`min-w-0 break-words px-3 py-2.5 font-semibold ${LANDING_INK}`}>{product.name}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{product.quantity}</td>
                      <td className={`px-3 py-2.5 text-right font-bold tabular-nums ${LANDING_INK}`}>{egp(product.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p className="mt-2 text-phx-sm text-slate-500">No products listed on this request.</p>
          )}

          {/* The four figures on hairlines — no tinted tiles, no orange box. */}
          <div className="mt-4 grid grid-cols-2 gap-px border border-slate-200 bg-slate-200">
            <div className="min-w-0 bg-white px-3 py-2.5">
              <p className={FACT_LABEL_CLASS}>Estimated cost</p>
              <p className={`mt-1 break-words text-phx-lg font-bold tabular-nums ${LANDING_INK}`}>{egp(summary.estimatedCost)}</p>
            </div>
            <div className="min-w-0 bg-white px-3 py-2.5">
              <p className={FACT_LABEL_CLASS}>
                Required ROI{summary.roiDurationMonths ? ` · ${summary.roiDurationMonths} mo` : ""}
              </p>
              <p className={`mt-1 break-words text-phx-lg font-bold tabular-nums ${LANDING_INK}`}>{egp(summary.requiredRoiValue)}</p>
            </div>
            <div className="min-w-0 bg-white px-3 py-2.5">
              <p className={FACT_LABEL_CLASS}>Customer{summary.pharmacyCount ? ` · ${summary.pharmacyCount} pharmacy` : ""}</p>
              {/* Wraps: a long pharmacy name takes a second line rather than pushing the page sideways. */}
              <p className={`mt-1 break-words text-phx-md font-semibold ${LANDING_INK}`} dir="auto">{summary.customerName ?? "—"}</p>
              <NotOnCrmListFlag compact flag={summary.customerCrmListFlag} />
            </div>
            <div className="min-w-0 bg-white px-3 py-2.5">
              <p className={FACT_LABEL_CLASS}>Pay date{summary.roiWindow ? ` · ROI ${summary.roiWindow}` : ""}</p>
              <p className={`mt-1 break-words text-phx-md font-semibold tabular-nums ${LANDING_INK}`}>{summary.payDate}</p>
            </div>
          </div>

          {/* ── Everything the requester actually submitted (owner instruction, 2026-08-04) ──
              This screen previously showed a customer NAME and a pharmacy COUNT, and asked the
              approver to commit real money on that. Every field below was captured at submission
              and simply never carried through. A field with no value says "Not captured" rather
              than rendering blank, so absent data never reads as a value of nothing. */}
          {summary.customerCrmListFlag ? (
            <div className="mt-4">
              <NotOnCrmListFlag flag={summary.customerCrmListFlag} />
            </div>
          ) : null}
          <SheetTitle>Customer detail</SheetTitle>
          <DetailGrid>
            <DetailField label="Customer code" value={summary.customerCode} />
            <DetailField label="Customer name" value={summary.customerName} />
            <DetailField label="Type" value={summary.customerType} />
            <DetailField label="Type detail" value={summary.customerSpeciality} />
            <DetailField label="Contact" value={summary.customerContactName} />
            <DetailField label="Contact mobile" value={summary.customerContactMobile} />
            <DetailField label="Area" value={summary.customerArea} />
            <DetailField label="Governorate" value={summary.customerGovernorate} />
          </DetailGrid>
          {summary.customerAddress ? (
            <p className="mt-2 break-words border-l-2 border-slate-300 py-1 pl-3 text-phx-sm font-medium leading-5 text-slate-600" dir="auto">
              {summary.customerAddress}
            </p>
          ) : null}
          {/* ── The photo, not its filename (2026-08-04) ──
              This block used to print `evidencePhotoName` in green and call it "on file". The
              bytes were never stored, so every approver who read that line was told proof existed
              when nothing had been retained. The image is now shown when it genuinely exists, and
              a name with no image says so plainly instead of passing for evidence. */}
          {summary.evidencePhotoUrl ? (
            <figure className="mt-2 border border-emerald-200 bg-white">
              <ZoomablePhoto
                alt={`Live capture of ${summary.customerName ?? "the customer"} premises`}
                caption={`Live capture · ${summary.customerName ?? "the customer"}`}
                className="h-64 w-full bg-slate-50 object-contain"
                src={summary.evidencePhotoUrl}
              />
              <figcaption className="break-words border-t border-slate-200 px-3 py-1.5 text-phx-xs font-bold uppercase tracking-[0.08em] text-emerald-700">
                Live capture photo on file{summary.evidencePhotoName ? ` · ${summary.evidencePhotoName}` : ""}
              </figcaption>
            </figure>
          ) : summary.evidencePhotoName ? (
            <div className="mt-2 flex min-w-0 gap-3">
              <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-amber-400" />
              <p className="min-w-0 break-words text-phx-xs font-semibold text-amber-800">
                Live capture photo recorded as {summary.evidencePhotoName}, but no image was retained for this customer. Treat the premises as unverified.
              </p>
            </div>
          ) : (
            <div className="mt-2 flex min-w-0 gap-3">
              <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-amber-400" />
              <p className="min-w-0 break-words text-phx-xs font-semibold text-amber-800">No live capture photo on file for this customer.</p>
            </div>
          )}

          <SheetTitle>
            Target pharmacies{summary.targetPharmacies.length ? ` · ${summary.targetPharmacies.length}` : ""}
          </SheetTitle>
          {summary.targetPharmacies.length > 0 ? (
            <ul className="mt-2 divide-y divide-slate-200 border border-slate-200">
              {summary.targetPharmacies.map((pharmacy, index) => (
                <li
                  className={`min-w-0 border-l-[3px] px-3 py-2.5 ${
                    pharmacy.referenceStatus === "matched" ? "border-l-emerald-500" : "border-l-amber-400"
                  }`}
                  key={`${pharmacy.pharmacyCode}-${index}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className={`min-w-0 break-words text-phx-md font-semibold ${LANDING_INK}`} dir="auto">{pharmacy.pharmacyName}</p>
                    <span
                      className={`text-phx-xs font-bold uppercase tracking-[0.08em] ${
                        pharmacy.referenceStatus === "matched" ? "text-emerald-700" : "text-amber-700"
                      }`}
                    >
                      {pharmacy.referenceStatus}
                    </span>
                  </div>
                  <p className="mt-1 break-words text-phx-xs font-semibold text-slate-500">
                    {pharmacy.distributorName} · vendor code {pharmacy.distributorPharmacyCode} · pharmacy {pharmacy.pharmacyCode}
                  </p>
                  {/* Validated WITH this request's customer — the pairing, not the venue (owner,
                      2026-10-31). Sentence resolved on the server; amber whenever it is not a yes. */}
                  <p
                    className={`mt-1 text-phx-xs font-bold ${
                      pharmacy.customerLink.state === "validated" ? "text-emerald-800" : "text-amber-800"
                    }`}
                    dir="auto"
                  >
                    {pharmacy.customerLink.sentence}
                  </p>
                  {/* The pharmacy's own shop front. Captured and stored on the same rule as the
                      customer's, so it must be visible on the same rule too — storing evidence no
                      approver can look at is the defect this whole change exists to end. */}
                  {pharmacy.evidencePhotoUrl ? (
                    <ZoomablePhoto
                      alt={`Live capture of ${pharmacy.pharmacyName}`}
                      caption={`Live capture · ${pharmacy.pharmacyName}`}
                      className="mt-1.5 h-40 w-full border border-slate-200 bg-slate-50 object-contain"
                      src={pharmacy.evidencePhotoUrl}
                    />
                  ) : null}
                  {/* And the trade licence, when one was attached — the same two documents the
                      validation desk compares, in front of the person about to decide. */}
                  <PharmacyLicenseEvidence
                    contentType={pharmacy.licenseContentType}
                    label={pharmacy.pharmacyName}
                    prominent
                    url={pharmacy.licenseUrl}
                  />
                  {/* Read-back, never a control: this is the last screen before the decision, and
                      what belongs here is what was already found, not a fresh question. "Not
                      checked yet" is said in words on purpose — an omitted line would read as a
                      pass to the one person who can no longer go back and look. Rendered only when
                      a licence exists to have a verdict about. */}
                  {pharmacy.licenseUrl ? (
                    <p
                      className={`mt-1 text-phx-xs font-bold ${
                        pharmacy.licenseNameMatchesSign === false ? "text-rose-700" : "text-slate-600"
                      }`}
                    >
                      Licence name vs shop sign:{" "}
                      {pharmacy.licenseNameMatchesSign === true
                        ? "confirmed to match"
                        : pharmacy.licenseNameMatchesSign === false
                          ? "does NOT match"
                          : "not checked yet"}
                    </p>
                  ) : null}
                  {pharmacy.notes ? (
                    <p className="mt-1 break-words text-phx-xs font-medium text-slate-600" dir="auto">{pharmacy.notes}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-phx-sm text-slate-500">
              No target pharmacies were attached to this request — nothing can be attributed to it.
            </p>
          )}

          <SheetTitle>Request detail</SheetTitle>
          <DetailGrid>
            <DetailField label="Request code" value={summary.requestCode} />
            <DetailField label="Request type" value={summary.requestType} />
            <DetailField label="Request date" value={summary.requestDate} />
            <DetailField label="Requester" value={summary.requesterName} />
            <DetailField label="Line" value={summary.lineName} />
            <DetailField label="Area" value={summary.areaName} />
            <DetailField label="Expected ROI" value={egp(summary.expectedRoiValue)} />
            <DetailField
              label="ROI coverage"
              value={
                summary.roiCoverageRatio === null
                  ? null
                  : `${Math.round(summary.roiCoverageRatio * 100)}%${summary.roiStatus ? ` · ${forecastRoiStatusLabel(summary.roiStatus)}` : ""}`
              }
            />
            <DetailField label="Direct sales tracked" value={summary.trackDirectSales ? "Yes" : "No"} />
          </DetailGrid>
          {summary.notes ? (
            <>
              <SheetTitle>Requester notes</SheetTitle>
              <p className="mt-2 break-words border-l-2 border-slate-300 py-1 pl-3 text-phx-sm font-medium leading-5 text-slate-700" dir="auto">
                {summary.notes}
              </p>
            </>
          ) : null}

          {summary.chain.length > 0 ? (
            <>
              <SheetTitle>Approval progress</SheetTitle>
              {/* One vertical rail, the step's state in the rail's colour — never a filled pill. */}
              <ol className="mt-2 space-y-1">
                {summary.chain.map((step, index) => (
                  <li
                    className={`border-l-[3px] py-1 pl-3 text-phx-sm font-semibold ${stepRailClass(step)} ${LANDING_INK}`}
                    key={`${step.stepName}-${index}`}
                  >
                    {step.stepName}
                    {step.isCurrent ? " · you" : ""}
                  </li>
                ))}
              </ol>
            </>
          ) : null}

          {/*
            Double-count warning, placed immediately above the decision buttons so it cannot be
            scrolled past. Deliberately a warning and not a block: overlapping campaigns are
            sometimes intentional, and only the approver can tell a deliberate double-push from an
            accidental double-count. "Return for edit" right below is the intended response.
          */}
          {/*
            Twin warning — the same requester, customer, request type and cost is already live in
            another request (twin-request.ts). A possible double PAYMENT, so it sits above the
            double-count warning. Named, never decided: the approver still approves, returns or rejects.
          */}
          {/* Same pharmacy, same person, both modules (owner, 2026-10-28) — the requester also raised a
              direct order to a pharmacy this request targets. Named, never decided. */}
          <SamePharmacyCrossUseNotice className="mt-6" flag={summary.samePharmacyDirectOrders} />

          {summary.twinOf.length > 0 ? (
            <div className="mt-6 flex min-w-0 gap-3" role="alert">
              <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-rose-500" />
              <div className="min-w-0">
                <p className="break-words text-phx-sm font-bold text-rose-800">
                  {summary.twinOf.length === 1
                    ? "This looks like a second copy of an earlier request"
                    : `This looks like a copy of ${summary.twinOf.length} earlier requests`}
                </p>
                <ul className="mt-1 flex flex-col gap-1">
                  {summary.twinOf.map((twin) => (
                    <li className="break-words text-phx-xs text-slate-700" key={twin.requestCode}>
                      <span className={`font-bold ${LANDING_INK}`}>{twin.requestCode}</span> · {twin.statusLabel} · submitted {twin.submittedDay}.{" "}
                      {twin.description}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 break-words text-phx-xs font-semibold text-slate-700">
                  Check the earlier request before you decide. If this is the same activity, return or reject this copy.
                </p>
              </div>
            </div>
          ) : null}

          {summary.contestedBy.length > 0 ? (
            <div className="mt-6 flex min-w-0 gap-3">
              <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-amber-400" />
              <div className="min-w-0">
                <p className="break-words text-phx-sm font-bold text-amber-800">
                  The same sales would be counted for {summary.contestedBy.length === 1 ? "another request" : `${summary.contestedBy.length} other requests`}
                </p>
                <ul className="mt-1 flex flex-col gap-1">
                  {summary.contestedBy.map((overlap) => (
                    <li className="break-words text-phx-xs text-slate-700" key={overlap.requestCode}>
                      {overlap.description}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 break-words text-phx-xs font-semibold text-slate-700">
                  Approve only if this overlap is intended. Otherwise return it for edit so the targets or the
                  measurement window can be separated.
                </p>
              </div>
            </div>
          ) : null}

          <div className="mt-6 border-t border-slate-200 pt-4">
            <LandingTitle>Your decision</LandingTitle>

            <textarea
              className={cn(phxTextareaClassName, "mt-3 min-h-24")}
              disabled={isPending || decided}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Add a note — required to return or reject (saved to audit history)…"
              value={comment}
            />

            {error ? (
              <div className="mt-3 flex min-w-0 gap-3" role="alert">
                <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-rose-500" />
                <p className="min-w-0 break-words text-phx-sm font-semibold text-rose-800">{error}</p>
              </div>
            ) : null}
            {success ? (
              <div className="mt-3 flex min-w-0 gap-3" role="status">
                <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-emerald-500" />
                <p className="min-w-0 break-words text-phx-sm font-semibold text-emerald-800">{success}</p>
              </div>
            ) : null}

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                className={approvalActionClassName("approve", "regular", `motion-reduce:transition-none ${LANDING_FOCUS}`)}
                disabled={isPending || decided}
                onClick={() => requestDecision("approve")}
                type="button"
              >
                {isPending && activeDecision === "approve" ? "Submitting…" : labelFor("approve")}
              </button>
              {summary.allowReturn ? (
                <button
                  className={approvalActionClassName("return", "regular", `motion-reduce:transition-none ${LANDING_FOCUS}`)}
                  disabled={isPending || decided}
                  onClick={() => requestDecision("return")}
                  type="button"
                >
                  {isPending && activeDecision === "return" ? "Submitting…" : labelFor("return")}
                </button>
              ) : null}
              {summary.allowReject ? (
                <button
                  className={approvalActionClassName("reject", "regular", `motion-reduce:transition-none ${LANDING_FOCUS}`)}
                  disabled={isPending || decided}
                  onClick={() => requestDecision("reject")}
                  type="button"
                >
                  {isPending && activeDecision === "reject" ? "Submitting…" : labelFor("reject")}
                </button>
              ) : null}
            </div>

            {needsReason ? (
              <p className="mt-3 break-words text-phx-xs text-slate-500">
                Returning sends it back to {summary.requesterName} to edit and resubmit — earlier approvals are kept.
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {confirmPrompt ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-4 sm:items-center">
          <div
            aria-labelledby="marketing-decision-confirm-title"
            aria-modal
            className={`w-full max-w-md border border-slate-200 bg-white ${adminSoftDepthClassName}`}
            ref={dialogRef}
            role="dialog"
          >
            <div className="px-5 py-4">
              <h2 className={`flex items-center gap-2 break-words text-phx-base font-bold ${LANDING_INK}`} id="marketing-decision-confirm-title">
                <LandingTick />
                <span className="min-w-0">{confirmPrompt.title}</span>
              </h2>
              <p className="mt-2 break-words text-phx-sm text-slate-700">{confirmPrompt.body}</p>
              <p className={`mt-2 break-words text-phx-sm font-semibold ${LANDING_INK}`}>{confirmPrompt.consequence}</p>
            </div>
            <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 px-5 py-3">
              <button
                className={approvalActionClassName("neutral", "regular", `motion-reduce:transition-none ${LANDING_FOCUS}`)}
                onClick={() => setPendingConfirm(null)}
                type="button"
              >
                {confirmPrompt.cancelLabel}
              </button>
              <button
                className={approvalActionClassName("confirm", "regular", `motion-reduce:transition-none ${LANDING_FOCUS}`)}
                onClick={confirmPending}
                type="button"
              >
                {confirmPrompt.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
