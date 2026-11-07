"use client";

import { ArrowRight, CalendarDays, MapPin } from "lucide-react";
import type { ReactNode } from "react";

import { CrmPill } from "@/components/phoenix-crm/ui";
import { formatDateValue } from "@/lib/i18n/format";
import { displayPlace } from "@/lib/outstation/place-label";
import { tripSpan, tripSpanLabel } from "@/lib/outstation/trip-span";
import { cn } from "@/lib/utils";

import { type Decision, type LoadedRecord, decisionStateLabel } from "../review-model";
import { DistanceChip, DuplicateTripFlag, capturedLocationConfidenceTone, egp } from "../review-parts";

/**
 * The top of the white column: who, which trip, where it stands, and every fact of the claim — dates,
 * route, distance, transport, type, and the cost written out as the sum it is. Drawn as the Place
 * checks reviewer draws its subject: orange eyebrow, the name large, the state as pills under it.
 *
 * 🔴 Every value starts at the LEFT edge, Arabic included (`dir="auto"` keeps its reading order, and
 * `text-left` keeps the column straight) — a right-aligned brick beside a left-aligned area read as two
 * columns (live review, 2026-11-07).
 */
export function DeckSubject({
  decision,
  duplicateOf,
  record,
  unsaved,
  valuesOnly,
}: {
  decision: Decision;
  duplicateOf?: string[];
  record: LoadedRecord;
  unsaved: boolean;
  valuesOnly: boolean;
}) {
  const span = tripSpan(record.date, record.toDate);
  const state = decisionStateLabel(decision, record);
  const destination = record.location || record.to || "";
  const typeLine = [record.requestType, record.tripType].filter(Boolean).join(" · ");
  return (
    <header className="min-w-0 border-b border-slate-200" data-deck-subject>
      <div className="min-w-0 space-y-2 px-5 pb-4 pt-5">
        <p className="break-words text-phx-2xs font-black uppercase tracking-[0.16em] text-orange-600">
          {valuesOnly ? "Imported trip · values only" : "Outstation trip"}
          <span className="ml-2 font-semibold normal-case tracking-normal text-slate-400">{record.tripId}</span>
        </p>
        <div className="flex min-w-0 flex-wrap items-end justify-between gap-x-4 gap-y-1">
          <h3 className="min-w-0 break-words text-xl font-black leading-tight text-slate-950" dir="auto">
            {record.specialist || "Unassigned"}
          </h3>
          {/* Left-aligned: under a long name this wraps to its own line, and a right-aligned label
              then sat indented over the amount (live tour of d67cacc). */}
          <p className="shrink-0 text-left" data-subject-claimed>
            <span className="block text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">Claimed</span>
            <span className="block text-2xl font-black leading-none tabular-nums text-slate-950">{egp(record.total)}</span>
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <CrmPill tone={state.tone}>{state.label}</CrmPill>
          {unsaved ? <CrmPill tone="warn">Unsaved</CrmPill> : null}
          <CrmPill tone={span.multiDay ? "orange" : "neutral"}>
            <CalendarDays aria-hidden className="h-3 w-3" />
            {tripSpanLabel(span)}
          </CrmPill>
        </div>
        <DuplicateTripFlag copies={duplicateOf} wide />
      </div>

      <dl className="grid min-w-0 grid-cols-2 border-t border-slate-100 [&>div]:min-w-0" data-deck-facts>
        <SubjectFact className="col-span-2" label="Dates">
          <span className="inline-flex flex-wrap items-center gap-x-1.5">
            {formatDateValue(record.date, null, { weekday: "short" })}
            {span.multiDay ? (
              <>
                <ArrowRight aria-hidden className="h-3.5 w-3.5 text-slate-400" />
                {formatDateValue(record.toDate, null, { weekday: "short" })}
              </>
            ) : null}
          </span>
        </SubjectFact>
        <SubjectFact className="col-span-2" label="Route">
          {/* Both ends in words, each with its own reading direction, both starting at the left. The
              address as Google stored it, plus code and all, is the To's tooltip, never a line. */}
          <span className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-0.5">
            <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">From</span>
            <span className="min-w-0 break-words text-left" dir="auto">
              {displayPlace(record.from) || "—"}
            </span>
            <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">To</span>
            <span className="min-w-0 break-words text-left" dir="auto" title={destination || undefined}>
              {displayPlace(destination) || "—"}
            </span>
          </span>
        </SubjectFact>
        <SubjectFact label="Distance">
          <DistanceChip km={record.km} withLabel />
        </SubjectFact>
        <SubjectFact label="Transport">{record.transportationType || "—"}</SubjectFact>
        {record.noTicketFareLine ? (
          <SubjectFact className="col-span-2" label="Fixed train fare">
            <span data-no-ticket-fare>{record.noTicketFareLine}</span>
          </SubjectFact>
        ) : null}
        <SubjectFact className="col-span-2" label="Expense · trip">
          {typeLine || "—"}
        </SubjectFact>
        <SubjectFact className="col-span-2" label="Cost">
          <CostLine record={record} />
        </SubjectFact>
      </dl>

      {/* Brick / area / region from the trip's captured GPS point — absent, never "Not resolved", for
          an imported trip that never captured coordinates. */}
      {record.capturedLocation ? (
        <div className="min-w-0 space-y-2 border-t border-slate-100 px-5 py-3" data-captured-geography>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">Submitted from</p>
            {record.capturedLocation.confidence ? (
              <CrmPill tone={PILL_FOR_CONFIDENCE[capturedLocationConfidenceTone(record.capturedLocation.confidence)]}>
                {record.capturedLocation.confidence}
              </CrmPill>
            ) : null}
          </div>
          <p className="flex min-w-0 items-start gap-1.5 text-sm font-semibold text-slate-900">
            <MapPin aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-500" />
            <span className="min-w-0 break-words text-left" dir="auto">
              {record.capturedLocation.label}
            </span>
          </p>
          <dl className="grid min-w-0 grid-cols-3 gap-x-3 gap-y-1">
            {(
              [
                ["Brick", record.capturedLocation.brickLabel],
                ["Area", record.capturedLocation.areaLabel],
                ["Region", record.capturedLocation.regionLabel],
              ] as const
            ).map(([label, value]) => (
              <div className="min-w-0" key={label}>
                <dt className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">{label}</dt>
                <dd className="m-0 min-w-0 break-words text-left text-sm font-semibold text-slate-900" dir="auto">
                  {value || "—"}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </header>
  );
}

const PILL_FOR_CONFIDENCE = { bad: "bad", good: "good", neutral: "neutral", warn: "warn" } as const;

function SubjectFact({ children, className, label }: { children: ReactNode; className?: string; label: string }) {
  return (
    <div className={cn("border-b border-r border-slate-100 px-5 py-2.5 even:border-r-0", className)}>
      <dt className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">{label}</dt>
      <dd className="m-0 mt-0.5 min-w-0 break-words text-left text-sm font-semibold text-slate-900">{children}</dd>
    </div>
  );
}

/** Travel + Meeting + Allowance (+ Other) = Total — the sum the claim is, in tabular figures. */
function CostLine({ record }: { record: LoadedRecord }) {
  const parts: Array<[string, number]> = [
    ["Travel", record.travelCost],
    ["Meeting", record.meetingAmount],
    ["Allowance", record.allowance],
    ...(record.other ? ([["Other", record.other]] as Array<[string, number]>) : []),
  ];
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 tabular-nums" data-cost-line>
      {parts.map(([label, value], index) => (
        <span className="whitespace-nowrap" key={label}>
          {index > 0 ? <span className="mr-2 text-slate-300">+</span> : null}
          <span className="text-xs font-semibold text-slate-500">{label} </span>
          {egp(value)}
        </span>
      ))}
      <span className="whitespace-nowrap">
        <span className="mr-2 text-slate-300">=</span>
        <span className="font-black text-slate-950">{egp(record.total)}</span>
      </span>
    </span>
  );
}
