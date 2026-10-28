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
import { cn } from "@/lib/utils";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { NotOnCrmListFlag } from "@/components/marketing-requests/not-on-crm-list-flag";
import { SamePharmacyCrossUseNotice } from "@/components/approvals-hub/same-pharmacy-cross-use-flag";

/**
 * One labelled field. An absent value renders "Not captured" rather than an empty cell — a blank
 * reads as "this is nothing", which is a different claim from "this was never recorded".
 */
function DetailField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="bg-slate-50 px-3 py-2.5">
      <p className="text-phx-2xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`text-phx-md font-medium ${value ? "text-slate-950" : "text-slate-400"}`}>
        {value || "Not captured"}
      </p>
    </div>
  );
}

function fallbackLabel(decision: MarketingRequestDecision) {
  if (decision === "approve") return "Approve";
  if (decision === "reject") return "Reject";
  return "Return for edit";
}

function egp(value: number) {
  return `EGP ${Math.round(Number.isFinite(value) ? value : 0).toLocaleString("en-US")}`;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

function stepStateClasses(step: { isCurrent: boolean; status: string }) {
  if (step.isCurrent) return "bg-orange-500 text-white";
  if (step.status === "approved") return "bg-slate-900 text-white";
  if (step.status === "rejected" || step.status === "returned") return "bg-rose-100 text-rose-700";
  return "bg-slate-100 text-slate-500";
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
        <div className="bg-slate-950 px-6 py-5">
          <p className="text-phx-xs font-semibold uppercase tracking-[0.18em] text-orange-400">Marketing · action required</p>
          <h1 className="mt-1 text-xl font-semibold text-white">Review marketing request</h1>
        </div>

        <div className="px-6 py-5">
          <div className="flex items-center gap-3 border-b border-slate-200 pb-4">
            <div className="flex h-11 w-11 items-center justify-center bg-orange-50 text-sm font-semibold text-orange-700">
              {initials(summary.requesterName)}
            </div>
            <div className="flex-1">
              <p className="text-phx-lg font-medium text-slate-950">{summary.requesterName}</p>
              <p className="text-xs text-slate-500">
                {summary.requesterHrId}
                {summary.lineName ? ` · ${summary.lineName} line` : ""}
              </p>
            </div>
            <div className="text-right">
              <p className="font-mono text-xs text-slate-700">{summary.requestCode}</p>
              <span className="mt-1 inline-block bg-amber-100 px-2.5 py-1 text-phx-xs font-medium text-amber-800">
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

          <p className="mt-4 text-phx-xs font-semibold uppercase tracking-wider text-slate-400">What&apos;s being requested</p>
          {summary.products.length > 0 ? (
            <>
              {/* Mobile: card list (tables are desktop-only) */}
              <div className="mt-2 space-y-2 md:hidden">
                {summary.products.map((product, index) => (
                  <div className={`border border-slate-200 bg-white px-3 py-2.5 ${adminSoftDepthClassName}`} key={`m-${product.name}-${index}`}>
                    <p className="text-phx-md font-medium text-slate-950">{product.name}</p>
                    <div className="mt-1.5 flex items-center justify-between text-xs">
                      <span className="text-slate-500">
                        Qty <span className="font-semibold text-slate-800">{product.quantity}</span>
                      </span>
                      <span className="font-medium text-slate-950">{egp(product.value)}</span>
                    </div>
                  </div>
                ))}
              </div>
              {/* Desktop: table */}
              <table className="mt-2 hidden w-full border-collapse text-sm md:table">
                <thead>
                  <tr className="bg-slate-950 text-white">
                    <th className="px-3 py-2 text-left font-medium">Product</th>
                    <th className="px-3 py-2 text-right font-medium">Qty</th>
                    <th className="px-3 py-2 text-right font-medium">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.products.map((product, index) => (
                    <tr key={`${product.name}-${index}`} className="border-b border-orange-100">
                      <td className="px-3 py-2 text-slate-950">{product.name}</td>
                      <td className="px-3 py-2 text-right text-slate-600">{product.quantity}</td>
                      <td className="px-3 py-2 text-right text-slate-950">{egp(product.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p className="mt-2 text-sm text-slate-500">No products listed on this request.</p>
          )}

          <div className="mt-4 grid grid-cols-2 gap-2">
            <div className="bg-slate-50 px-3 py-2.5">
              <p className="text-phx-2xs uppercase tracking-wide text-slate-400">Estimated cost</p>
              <p className="text-base font-medium text-slate-950">{egp(summary.estimatedCost)}</p>
            </div>
            <div className="bg-orange-50 px-3 py-2.5">
              <p className="text-phx-2xs uppercase tracking-wide text-orange-700">
                Required ROI{summary.roiDurationMonths ? ` · ${summary.roiDurationMonths} mo` : ""}
              </p>
              <p className="text-base font-medium text-orange-800">{egp(summary.requiredRoiValue)}</p>
            </div>
            <div className="bg-slate-50 px-3 py-2.5">
              <p className="text-phx-2xs uppercase tracking-wide text-slate-400">Customer{summary.pharmacyCount ? ` · ${summary.pharmacyCount} pharmacy` : ""}</p>
              <p className="whitespace-nowrap text-phx-md font-medium text-slate-950">{summary.customerName ?? "—"}</p>
              <NotOnCrmListFlag compact flag={summary.customerCrmListFlag} />
            </div>
            <div className="bg-slate-50 px-3 py-2.5">
              <p className="text-phx-2xs uppercase tracking-wide text-slate-400">Pay date{summary.roiWindow ? ` · ROI ${summary.roiWindow}` : ""}</p>
              <p className="text-phx-md font-medium text-slate-950">{summary.payDate}</p>
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
          <p className="mt-5 text-phx-xs font-semibold uppercase tracking-wider text-slate-400">Customer detail</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <DetailField label="Customer code" value={summary.customerCode} />
            <DetailField label="Customer name" value={summary.customerName} />
            <DetailField label="Type" value={summary.customerType} />
            <DetailField label="Type detail" value={summary.customerSpeciality} />
            <DetailField label="Contact" value={summary.customerContactName} />
            <DetailField label="Contact mobile" value={summary.customerContactMobile} />
            <DetailField label="Area" value={summary.customerArea} />
            <DetailField label="Governorate" value={summary.customerGovernorate} />
          </div>
          {summary.customerAddress ? (
            <p className={`mt-2 border border-slate-200 bg-white px-3 py-2 text-phx-sm font-medium leading-5 text-slate-600 ${adminSoftDepthClassName}`}>
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
              <figcaption className="border-t border-emerald-200 px-3 py-1.5 text-phx-xs font-semibold text-emerald-700">
                Live capture photo on file{summary.evidencePhotoName ? ` · ${summary.evidencePhotoName}` : ""}
              </figcaption>
            </figure>
          ) : summary.evidencePhotoName ? (
            <p className="mt-2 text-phx-xs font-semibold text-amber-700">
              Live capture photo recorded as {summary.evidencePhotoName}, but no image was retained for this customer. Treat the premises as unverified.
            </p>
          ) : (
            <p className="mt-2 text-phx-xs font-semibold text-amber-700">No live capture photo on file for this customer.</p>
          )}

          <p className="mt-5 text-phx-xs font-semibold uppercase tracking-wider text-slate-400">
            Target pharmacies{summary.targetPharmacies.length ? ` · ${summary.targetPharmacies.length}` : ""}
          </p>
          {summary.targetPharmacies.length > 0 ? (
            <div className="mt-2 space-y-2">
              {summary.targetPharmacies.map((pharmacy, index) => (
                <div className={`border border-slate-200 bg-white px-3 py-2.5 ${adminSoftDepthClassName}`} key={`${pharmacy.pharmacyCode}-${index}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-phx-md font-medium text-slate-950">{pharmacy.pharmacyName}</p>
                    <span
                      className={`px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-wide ${
                        pharmacy.referenceStatus === "matched"
                          ? "bg-emerald-100 text-emerald-800"
                          : "bg-amber-100 text-amber-800"
                      }`}
                    >
                      {pharmacy.referenceStatus}
                    </span>
                  </div>
                  <p className="mt-1 text-phx-xs font-semibold text-slate-500">
                    {pharmacy.distributorName} · vendor code {pharmacy.distributorPharmacyCode} · pharmacy {pharmacy.pharmacyCode}
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
                    <p className="mt-1 text-phx-xs font-medium text-slate-600">{pharmacy.notes}</p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-sm text-slate-500">
              No target pharmacies were attached to this request — nothing can be attributed to it.
            </p>
          )}

          <p className="mt-5 text-phx-xs font-semibold uppercase tracking-wider text-slate-400">Request detail</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
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
                  : `${Math.round(summary.roiCoverageRatio * 100)}%${summary.roiStatus ? ` · ${summary.roiStatus.replace(/_/g, " ")}` : ""}`
              }
            />
            <DetailField label="Direct sales tracked" value={summary.trackDirectSales ? "Yes" : "No"} />
          </div>
          {summary.notes ? (
            <>
              <p className="mt-4 text-phx-xs font-semibold uppercase tracking-wider text-slate-400">Requester notes</p>
              <p className={`mt-1 border border-slate-200 bg-white px-3 py-2 text-phx-sm font-medium leading-5 text-slate-700 ${adminSoftDepthClassName}`}>
                {summary.notes}
              </p>
            </>
          ) : null}

          {summary.chain.length > 0 ? (
            <>
              <p className="mt-5 text-phx-xs font-semibold uppercase tracking-wider text-slate-400">Approval progress</p>
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {summary.chain.map((step, index) => (
                  <span key={`${step.stepName}-${index}`} className="flex items-center gap-1">
                    <span className={`px-2.5 py-1 text-phx-xs font-medium ${stepStateClasses(step)}`}>
                      {step.stepName}
                      {step.isCurrent ? " · you" : ""}
                    </span>
                    {index < summary.chain.length - 1 ? <span className="text-slate-300">›</span> : null}
                  </span>
                ))}
              </div>
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
            <div className="mt-6 border border-rose-300 bg-rose-50 p-3">
              <p className="text-sm font-semibold text-rose-900">
                {summary.twinOf.length === 1
                  ? "This looks like a second copy of an earlier request"
                  : `This looks like a copy of ${summary.twinOf.length} earlier requests`}
              </p>
              <ul className="mt-1 flex flex-col gap-1">
                {summary.twinOf.map((twin) => (
                  <li className="text-xs text-rose-900" key={twin.requestCode}>
                    <span className="font-semibold">{twin.requestCode}</span> · {twin.statusLabel} · submitted {twin.submittedDay}.{" "}
                    {twin.description}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-rose-800">
                Check the earlier request before you decide. If this is the same activity, return or reject this copy.
              </p>
            </div>
          ) : null}

          {summary.contestedBy.length > 0 ? (
            <div className="mt-6 border border-amber-300 bg-amber-50 p-3">
              <p className="text-sm font-semibold text-amber-900">
                The same sales would be counted for {summary.contestedBy.length === 1 ? "another request" : `${summary.contestedBy.length} other requests`}
              </p>
              <ul className="mt-1 flex flex-col gap-1">
                {summary.contestedBy.map((overlap) => (
                  <li className="text-xs text-amber-900" key={overlap.requestCode}>
                    {overlap.description}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-amber-800">
                Approve only if this overlap is intended. Otherwise return it for edit so the targets or the
                measurement window can be separated.
              </p>
            </div>
          ) : null}

          <div className="mt-6 border-t border-slate-200 pt-4">
            <p className="text-sm font-medium text-slate-950">Your decision</p>
            <p className="mt-0.5 text-xs text-slate-500">
              Confirm inside Phoenix. Total requested value {egp(totalValue || summary.estimatedCost)}.
            </p>

            <textarea
              className={cn(phxTextareaClassName, "mt-3 min-h-24")}
              disabled={isPending || decided}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Add a note — required to return or reject (saved to audit history)…"
              value={comment}
            />

            {error ? (
              <p className="mt-3 border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">{error}</p>
            ) : null}
            {success ? (
              <p className="mt-3 border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-700">{success}</p>
            ) : null}

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                className="bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                disabled={isPending || decided}
                onClick={() => requestDecision("approve")}
                type="button"
              >
                {isPending && activeDecision === "approve" ? "Submitting…" : labelFor("approve")}
              </button>
              {summary.allowReturn ? (
                <button
                  className="border border-amber-400 bg-white px-4 py-2 text-sm font-medium text-amber-800 disabled:opacity-50"
                  disabled={isPending || decided}
                  onClick={() => requestDecision("return")}
                  type="button"
                >
                  {isPending && activeDecision === "return" ? "Submitting…" : labelFor("return")}
                </button>
              ) : null}
              {summary.allowReject ? (
                <button
                  className="border border-rose-300 bg-white px-4 py-2 text-sm font-medium text-rose-700 disabled:opacity-50"
                  disabled={isPending || decided}
                  onClick={() => requestDecision("reject")}
                  type="button"
                >
                  {isPending && activeDecision === "reject" ? "Submitting…" : labelFor("reject")}
                </button>
              ) : null}
            </div>

            {needsReason ? (
              <p className="mt-3 text-phx-xs text-slate-500">
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
            className="w-full max-w-md border border-slate-200 bg-white shadow-xl"
            ref={dialogRef}
            role="dialog"
          >
            <div className="px-5 py-4">
              <h2 className="text-base font-semibold text-slate-950" id="marketing-decision-confirm-title">
                {confirmPrompt.title}
              </h2>
              <p className="mt-2 text-sm text-slate-700">{confirmPrompt.body}</p>
              <p className="mt-2 text-sm font-medium text-slate-950">{confirmPrompt.consequence}</p>
            </div>
            <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 px-5 py-3">
              <button
                className={`border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 ${adminSoftDepthClassName}`}
                onClick={() => setPendingConfirm(null)}
                type="button"
              >
                {confirmPrompt.cancelLabel}
              </button>
              <button
                className={`px-4 py-2 text-sm font-medium text-white ${
                  pendingConfirm === "reject"
                    ? "bg-rose-600"
                    : pendingConfirm === "return"
                      ? "bg-amber-600"
                      : "bg-emerald-600"
                }`}
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
