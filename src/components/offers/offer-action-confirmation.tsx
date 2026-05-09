"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";

import type { OfferActionResult, OfferDecisionPreview } from "@/lib/offers/service";

type OfferActionConfirmationProps = {
  actionLabel: string;
  actionPath: string;
  actionTone: "accept" | "reject";
  confirmCopy: string;
  preview: OfferDecisionPreview;
};

function cardIcon(tone: "accept" | "reject", status: OfferDecisionPreview["status"] | OfferActionResult["status"]) {
  if (tone === "accept") {
    return <CheckCircle2 className="h-7 w-7" />;
  }

  if (status === "rejected") {
    return <XCircle className="h-7 w-7" />;
  }

  return <XCircle className="h-7 w-7" />;
}

export function OfferActionConfirmation({
  actionLabel,
  actionPath,
  actionTone,
  confirmCopy,
  preview,
}: OfferActionConfirmationProps) {
  const [result, setResult] = useState<OfferActionResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  const currentStatus = result?.status ?? preview.status;
  const currentMessage = result?.message ?? requestError ?? preview.message;
  const currentOffer = result?.offer ?? preview.offer;
  const showAction = preview.canSubmit && !result;

  async function handleSubmit() {
    setSubmitting(true);
    setRequestError(null);

    try {
      const response = await fetch(actionPath, {
        method: "POST",
      });
      const payload = (await response.json()) as OfferActionResult | { message?: string };

      if (!response.ok) {
        setRequestError(payload.message ?? "Unable to record your response.");
        return;
      }

      setResult(payload as OfferActionResult);
    } catch {
      setRequestError("Unable to record your response right now. Please try again later.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10 text-slate-950">
      <section className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-[0_24px_70px_rgba(15,23,42,0.10)]">
        <div className={`mx-auto flex h-14 w-14 items-center justify-center rounded-xl ${
          actionTone === "accept" ? "bg-emerald-50 text-emerald-700" : "bg-orange-50 text-orange-700"
        }`}>
          {cardIcon(actionTone, currentStatus)}
        </div>
        <p className="mt-6 text-[11px] font-black uppercase tracking-[0.22em] text-orange-600">Phoenix Workforce</p>
        <h1 className="mt-3 text-3xl font-black tracking-tight">
          {result
            ? actionTone === "accept"
              ? currentStatus === "accepted"
                ? "Offer Accepted Successfully"
                : "Offer Link Closed"
              : "Response Recorded"
            : actionTone === "accept"
              ? "Confirm Offer Acceptance"
              : "Confirm Offer Rejection"}
        </h1>
        <p className="mt-4 text-base leading-7 text-slate-600">
          {result ? currentMessage : confirmCopy}
        </p>
        {!result && currentMessage !== confirmCopy ? (
          <p className="mt-3 text-sm text-slate-500">{currentMessage}</p>
        ) : null}
        {currentOffer ? (
          <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4 text-left text-sm">
            <div className="font-bold text-slate-950">{currentOffer.jobTitle}</div>
            <div className="mt-1 text-slate-600">{currentOffer.candidateName}</div>
            <div className="mt-3 text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
              Offer ID {currentOffer.offerCode}
            </div>
          </div>
        ) : null}
        {showAction ? (
          <div className="mt-8 flex justify-center">
            <button
              className={`inline-flex min-w-48 items-center justify-center rounded-xl px-5 py-3 text-sm font-bold text-white transition ${
                actionTone === "accept"
                  ? "bg-emerald-600 hover:bg-emerald-700"
                  : "bg-orange-600 hover:bg-orange-700"
              } disabled:cursor-not-allowed disabled:opacity-70`}
              disabled={submitting}
              onClick={handleSubmit}
              type="button"
            >
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {submitting ? "Submitting..." : actionLabel}
            </button>
          </div>
        ) : null}
      </section>
    </main>
  );
}
