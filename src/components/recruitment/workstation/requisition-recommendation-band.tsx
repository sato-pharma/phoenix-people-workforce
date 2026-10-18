"use client";

// THE SYSTEM'S RECOMMENDATION FOR THIS CV, AND THE ONE PRESS THAT ACTS ON IT.
//
// The owner, 2026-10-16: "the system auto screens and matches and recommends, and then by one click
// from admin or TA the CV is requisitioned, or kept shortlisted, or rejected." This band is the
// first two of those; the third is the Reject button already on the bar, which this band never
// proposes — "never recommend Reject" was his answer.
//
// A BAND UNDER THE BAR, NOT ANOTHER BUTTON IN IT, because a recommendation is a sentence before it
// is a press: the reader has to see WHY ("Chose Menoufia 1 on WhatsApp") to trust the one click, and
// the reason does not fit in a button. It carries the accent rule down its leading edge that every
// band here uses when the page is offering something, and its press is the accent — the "carry on"
// colour — because attaching is the work moving forward.
//
// "Keep shortlisted" has no button of its own here. That press already exists — Shortlist, with its
// S key — and a second control doing the same thing would make the reader wonder how they differ.

import { useState } from "react";
import { ClipboardCheck, Loader2 } from "lucide-react";

import { adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";
import { Action } from "@/components/recruitment/workstation/workstation-look";
import { phxSelectClassName } from "@/components/ui/form-tokens";
import { requisitionOptionLabel, type RequisitionRecommendation } from "@/lib/recruitment/requisition-match";
import { cn } from "@/lib/utils";

export function RequisitionRecommendationBand({
  attachedTo,
  busy,
  onAttach,
  recommendation,
}: {
  /** The requisition code this sitting attached the CV to, which replaces the recommendation. */
  attachedTo: string | null;
  busy: boolean;
  onAttach: (requisitionId: string) => void;
  recommendation: RequisitionRecommendation;
}) {
  // Several equal options are a pick, never a pre-filled guess — the same rule the send picker keeps
  // (suggestPositions): the pre-filled value is the one that gets confirmed.
  const options = recommendation.verdict === "attach" ? recommendation.options : [];
  const [chosen, setChosen] = useState<string>(options.length === 1 ? options[0].id : "");

  if (attachedTo) {
    return (
      <p className="border-t border-phx-ok-line bg-phx-ok-bg px-4 py-1.5 text-[12px] font-semibold text-phx-ok">
        Attached to {attachedTo} and kept shortlisted.
      </p>
    );
  }

  // THE SYSTEM IS SPEAKING, so the line says so the way every other band on this page does: the
  // accent rule down its leading edge and the recommendation as an orange kicker. A recessed strip
  // (2026-10-19), cut into the card above it rather than floating off it.
  if (recommendation.verdict === "keep") {
    return (
      <p
        className={cn(
          "border-l-[3px] border-t border-l-phx-accent border-t-phx-line bg-phx-paper px-4 py-1.5 text-[12px] text-phx-ink-2",
          adminRecessedDepthClassName,
        )}
      >
        <span className="font-bold uppercase tracking-[0.06em] text-phx-accent-press">Recommended: keep shortlisted.</span>{" "}
        {recommendation.reason}
      </p>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1.5 border-l-[3px] border-t border-l-phx-accent border-t-phx-line bg-phx-accent-soft px-4 py-2",
        adminRecessedDepthClassName,
      )}
    >
      <p className="min-w-0 flex-1 basis-64 text-[12px] text-phx-ink-2">
        <span className="font-bold uppercase tracking-[0.06em] text-phx-accent-press">Recommended: attach to a requisition.</span>{" "}
        {recommendation.reason}
        {options.length === 1 ? (
          <span className="block font-semibold text-phx-ink">
            {options[0].code} · {requisitionOptionLabel(options[0])}
          </span>
        ) : null}
      </p>
      {options.length > 1 ? (
        <select
          aria-label="Requisition"
          className={cn(phxSelectClassName, "min-w-0 flex-1 basis-56")}
          onChange={(event) => setChosen(event.target.value)}
          value={chosen}
        >
          <option value="">It fits {options.length} — choose one</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.code} · {requisitionOptionLabel(option)}
            </option>
          ))}
        </select>
      ) : null}
      <Action
        disabled={busy || !chosen}
        onClick={() => chosen && onAttach(chosen)}
        size="md"
        title="Open an application on this requisition, tell its hiring manager, and keep the CV shortlisted."
        tone="primary"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ClipboardCheck className="h-3.5 w-3.5" />}
        Attach to requisition
      </Action>
    </div>
  );
}
