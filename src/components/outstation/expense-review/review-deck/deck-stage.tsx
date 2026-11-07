"use client";

import { Camera, HelpCircle, Network, Route, ShieldCheck } from "lucide-react";
import type { ComponentType } from "react";

import { type ClaimValidationOutcome, ExpenseClaimValidationPanel } from "@/components/outstation/expense-claim-validation-panel";
import { type AttachmentsData, TripAttachments } from "@/components/outstation/trip-attachments";
import type { TripWorkloadEvidence } from "@/components/outstation/trip-workload-evidence";
import { outstationRequestIdFromTripId } from "@/lib/outstation/expense-approval-decisions";
import { tripSpan, tripSpanLabel } from "@/lib/outstation/trip-span";
import { cn } from "@/lib/utils";

import type { LoadedRecord, TripIdleDays } from "../review-model";
import { CrmTripSection } from "./crm-trip-section";
import { DeckFieldWork } from "./deck-days";
import { SIGNAL_TONE, type Signal, type TripSignals } from "./deck-signals";

/** The four things the stage can show — the same four "What the system found" names. */
export type StageView = "field" | "crm" | "photos" | "checks";

export const STAGE_VIEWS: ReadonlyArray<{ icon: ComponentType<{ className?: string }>; key: StageView; label: string }> = [
  { icon: Route, key: "field", label: "Field work and maps" },
  { icon: Network, key: "crm", label: "Phoenix CRM" },
  { icon: Camera, key: "photos", label: "Photos, stops and tickets" },
  { icon: ShieldCheck, key: "checks", label: "Claim checks" },
];

/**
 * The evidence, on the dark stage the Place checks reviewer gives its photograph — here the trip's
 * day maps, Phoenix CRM on the trip (the plan, where the visits were, the nights, a shared car), its
 * photos and tickets, and the claim checks, one at a time under a switcher.
 *
 * 🔴 All four views stay MOUNTED, the inactive ones hidden: each reads its own evidence once when the
 * trip opens, and the findings column words its four sentences from what they loaded — so a switch
 * never re-reads anything, and the column is complete before the reviewer looks at a single view.
 * The day maps are drawn only as each comes into view (deck-days.tsx), so a hidden view costs no map.
 *
 * The evidence panels are the ones the Held requests screen uses; this file reads nothing itself.
 */
export function DeckStage({
  onAttachments,
  onClaimOutcome,
  onCrmSignal,
  onIdleDays,
  onView,
  onWorkload,
  attachments,
  record,
  signals,
  view,
  workload,
}: {
  attachments: AttachmentsData | null | undefined;
  onAttachments: (data: AttachmentsData | null) => void;
  onClaimOutcome: (outcome: ClaimValidationOutcome) => void;
  onCrmSignal: (signal: Signal) => void;
  onIdleDays: (tripId: string, idle: TripIdleDays) => void;
  onView: (view: StageView) => void;
  onWorkload: (data: TripWorkloadEvidence | null) => void;
  record: LoadedRecord;
  signals: TripSignals;
  view: StageView;
  workload: TripWorkloadEvidence | null | undefined;
}) {
  const validationRequestId = outstationRequestIdFromTripId(record.tripId);
  const span = tripSpan(record.date, record.toDate);
  const toneOf: Record<StageView, keyof typeof SIGNAL_TONE> = {
    checks: signals.claim.tone,
    crm: signals.crm.tone,
    field: signals.fieldWork.tone,
    photos: signals.photos.tone,
  };
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col" data-deck-stage>
      <div aria-label="What to look at" className="flex min-w-0 flex-wrap gap-px border-b border-white/10 bg-slate-900" role="tablist">
        {STAGE_VIEWS.map((one) => {
          const Icon = one.icon;
          const active = view === one.key;
          return (
            <button
              aria-controls={`deck-view-${one.key}`}
              aria-selected={active}
              className={cn(
                "-mb-px inline-flex min-h-11 min-w-0 flex-1 basis-40 items-center gap-2 border-b-2 px-4 py-2 text-left text-sm font-black transition",
                active ? "border-orange-500 bg-slate-950 text-white" : "border-transparent text-slate-400 hover:text-slate-200",
              )}
              data-stage-view={one.key}
              key={one.key}
              onClick={() => onView(one.key)}
              role="tab"
              type="button"
            >
              <span aria-hidden className={cn("h-2 w-2 shrink-0", SIGNAL_TONE[toneOf[one.key]].dot)} />
              <Icon className="h-4 w-4 shrink-0" />
              <span className="break-words">{one.label}</span>
            </button>
          );
        })}
      </div>
      {/* One scroll for the evidence, inside the stage; the decision column scrolls on its own. */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2 sm:p-4" data-deck-stage-scroll>
        <section
          aria-label="Field work, day by day"
          className={cn("min-w-0 bg-white p-3 text-slate-900 sm:p-4", view === "field" ? null : "hidden")}
          id="deck-view-field"
          role="tabpanel"
        >
          <StageHeading
            line={span.multiDay ? `${tripSpanLabel(span)} · one map for each day` : "One day, one map"}
            title="Field work, day by day"
          />
          <DeckFieldWork attachments={attachments} onIdleDays={onIdleDays} onLoaded={onWorkload} record={record} workload={workload} />
        </section>
        <section
          aria-label="Phoenix CRM on this trip"
          className={cn("min-w-0 bg-white p-3 text-slate-900 sm:p-4", view === "crm" ? null : "hidden")}
          id="deck-view-crm"
          role="tabpanel"
        >
          <StageHeading line={signals.crm.line} title="Phoenix CRM on this trip" />
          <CrmTripSection onSignal={onCrmSignal} requestId={validationRequestId} />
        </section>
        <section
          aria-label="Photos, stops and tickets"
          className={cn("min-w-0 bg-white p-3 text-slate-900 sm:p-4", view === "photos" ? null : "hidden")}
          id="deck-view-photos"
          role="tabpanel"
        >
          <StageHeading line={signals.photos.line} title="Photos, stops and tickets" />
          <TripAttachments onLoaded={onAttachments} tripId={record.tripId} />
        </section>
        <section
          aria-label="Claim checks"
          className={cn("min-w-0 bg-white p-3 text-slate-900 sm:p-4", view === "checks" ? null : "hidden")}
          id="deck-view-checks"
          role="tabpanel"
        >
          <StageHeading line={signals.claim.line} title="Claim checks" />
          {validationRequestId !== null ? (
            <ExpenseClaimValidationPanel bare onOutcome={onClaimOutcome} requestId={validationRequestId} />
          ) : (
            <p className="flex items-start gap-2 text-sm leading-relaxed text-slate-500">
              <HelpCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
              An imported expense carries no captured GPS point, so there is nothing to check it against.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function StageHeading({ line, title }: { line: string; title: string }) {
  return (
    <div className="mb-3 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-slate-200 pb-2">
      <span aria-hidden className="h-4 w-1 self-center bg-orange-500" />
      <h3 className="break-words text-sm font-black uppercase tracking-wide text-slate-900">{title}</h3>
      <p className="min-w-0 break-words text-xs font-semibold text-slate-500">{line}</p>
    </div>
  );
}
