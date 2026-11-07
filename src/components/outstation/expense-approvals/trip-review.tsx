"use client";

import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  Camera,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  HelpCircle,
  Loader2,
  MapPin,
  Route,
  ShieldCheck,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { adminPanelHeaderClassName } from "@/components/admin/admin-design-tokens";
import {
  FieldWorkforceRouteMap,
  type RouteCheckin,
  type RouteDestination,
  type RouteMarker,
  type TripRouteLine,
} from "@/components/field-workforce-compliance/field-workforce-route-map";
import { CostBreakdownFact, Fact, RouteFact } from "@/components/outstation/approval-detail-primitives";
import { type ClaimValidationOutcome, ExpenseClaimValidationPanel } from "@/components/outstation/expense-claim-validation-panel";
import { type AttachmentsData, TripAttachments } from "@/components/outstation/trip-attachments";
import {
  type TripWorkloadEvidence,
  TripWorkloadEvidencePanel,
  type WorkloadCheckinDetail,
  formatClock,
} from "@/components/outstation/trip-workload-evidence";
import { Badge } from "@/components/ui/badge";
import { isWorkedTripDay } from "@/lib/crm/trip-day-meetings";
import { formatDateTimeValue, formatDateValue, formatNumberValue } from "@/lib/i18n/format";
import { isRejectedStatus } from "@/lib/outstation/approval-state";
import { outstationRequestIdFromTripId } from "@/lib/outstation/expense-approval-decisions";
import type { ApproverTripRoute } from "@/lib/outstation/day-route-line";
import { displayPlace } from "@/lib/outstation/place-label";
import { tripSpan, tripSpanLabel } from "@/lib/outstation/trip-span";
import { cn } from "@/lib/utils";

import {
  DISTANCE_TONE_CLASS,
  type Decision,
  DuplicateTripFlag,
  EmployeeNote,
  type LoadedRecord,
  PANEL_CLASS,
  type TripIdleDays,
  capturedLocationConfidenceTone,
  distanceFlag,
  egp,
} from "./shared";

/**
 * The trip as a page (owner, 2026-11-07: "one trip fills the screen … make sure I see a map and
 * the visits on map, visit type, time saved and check-in and photo captured time at arrival and
 * departure — any information or data you have for the trip must be shown").
 *
 * Top to bottom, nothing folded, nothing in a scroll box:
 *
 *   1. the header band — who, which trip, where it sits in the list, the claim large;
 *   2. the glance strip — length, dates, distance, transport, type, the cost equation;
 *   3. the verdict strip — three sentences: field work, claim checks, photos — each a link down;
 *   4. the route, the captured geography and the employee's note;
 *   5. field work, day by day, every day open and EACH DAY ON ITS OWN MAP (owner: "if 3 days then
 *      I should have 3 maps"): the day's GPS check-ins numbered as in its list, the arrival (A)
 *      photo on the first day, the departure (D) photo on the last, each journey stop on the day
 *      it was captured, and a legend naming every pin; every visit and every check-in printed;
 *   6. the claim checks, every check open;
 *   7. the photos with everything they carry, the stops, the tickets.
 *
 * The three evidence panels keep their own fetches and rules; this page only reads what they
 * loaded (through `onLoaded` / `onOutcome`) to pin the day maps and word the verdicts. The decision
 * itself is the page's sticky footer (decision-bar.tsx), not part of this.
 */
export function TripReview({
  decision,
  duplicateOf,
  onIdleDays,
  onNext,
  onPrevious,
  position,
  record,
  valuesOnly,
}: {
  decision: Decision;
  /** Other live claims for the same employee, day and destination (duplicate-trip-guard.ts). */
  duplicateOf?: string[];
  /**
   * Hands the trip's idle days up once its field work is read, so the decision box can offer the
   * allowance share for them (owner, 2026-11-07: "LET ME DECIDE" — offered, never applied).
   */
  onIdleDays?: (tripId: string, idle: TripIdleDays) => void;
  /** Absent at either end of the list. */
  onNext?: () => void;
  onPrevious?: () => void;
  /** "Trip 4 of 37" — where this trip sits in the list as filtered. */
  position: { index: number; total: number } | null;
  record: LoadedRecord;
  /** Imported history (trips before July 2026): shown, never decided. See imported-history.ts. */
  valuesOnly: boolean;
}) {
  // `undefined` is "still loading"; null is "nothing came back".
  const [workload, setWorkload] = useState<TripWorkloadEvidence | null | undefined>(undefined);
  const [attachments, setAttachments] = useState<AttachmentsData | null | undefined>(undefined);
  const [claimOutcome, setClaimOutcome] = useState<ClaimValidationOutcome | undefined>(undefined);

  // The idle-day count the field-work tile states, lifted to the decision box. Not for a rep with no
  // CRM identity mapped: no visits there is not evidence of an idle day.
  useEffect(() => {
    if (!onIdleDays || !workload || workload.matchStatus === "unmapped") return;
    const days = workload.dateBreakdown;
    if (days.length === 0) return;
    // A meeting day is worked (trip-day-meetings.ts): no idle-day allowance share is offered for it.
    onIdleDays(record.tripId, { idleDays: days.filter((day) => !isWorkedTripDay(day)).length, tripDays: days.length });
  }, [onIdleDays, record.tripId, workload]);

  const span = tripSpan(record.date, record.toDate);
  const flag = record.km ? distanceFlag(record.km) : null;
  const isRejected = isRejectedStatus(decision.status);
  // Only a Phoenix-submitted trip has an outstation request behind it (and therefore a captured
  // GPS point). An imported expense returns null here and the claim checks say so.
  const validationRequestId = outstationRequestIdFromTripId(record.tripId);
  const destination = record.location || record.to || "";

  // ── Every point the trip has, grouped by its day — ONE MAP PER DAY ──────────────────────
  // Owner, 2026-11-07 ~01:00, on the first cut that drew the whole trip on one map: "in a multiple
  // day trip separate each day from the other; if 3 days then I should have 3 maps." Each day block
  // below draws its own map: that day's GPS check-ins, the arrival photo (A) on the first day, the
  // departure photo (D) on the last, and every journey stop (S2, S3 …) on the day it was captured.
  const dayKeys = span.dayKeys.length > 0 ? span.dayKeys : [record.date.slice(0, 10)];
  const firstDay = dayKeys[0];
  const lastDay = dayKeys[dayKeys.length - 1];
  const legendByDay = useMemo<Map<string, DayLegendItem[]>>(() => {
    const byDay = new Map<string, DayLegendItem[]>();
    const add = (dayKey: string, item: DayLegendItem) => {
      // A photo or stop captured outside the trip's dates (a departure photo taken the morning
      // after, say) is drawn on the nearest trip day; its legend line still prints the real time.
      const key = dayKey < firstDay ? firstDay : dayKey > lastDay ? lastDay : dayKey;
      byDay.set(key, [...(byDay.get(key) ?? []), item]);
    };
    for (const photo of attachments?.photos ?? []) {
      const positioned = photo.latitude !== null && photo.longitude !== null;
      const label = photo.kind === "arrival" ? "A" : "D";
      const when = photo.capturedAt ? ` · ${formatDateTimeValue(photo.capturedAt)}` : "";
      add(photo.kind === "arrival" ? firstDay : lastDay, {
        label,
        line: (
          <>
            <span className="font-bold text-slate-900">{photo.label}</span>
            {when}
            {photo.url ? (photo.sourceNote ? " · uploaded" : " · live capture") : ` · ${photo.missingNote ?? "no photo"}`}
            {positioned ? (
              <span className="font-mono text-slate-500">
                {" "}· {photo.latitude?.toFixed(5)}, {photo.longitude?.toFixed(5)}
              </span>
            ) : photo.url ? (
              <span className="text-amber-700"> · no GPS position, not on the map</span>
            ) : null}
            {photo.locationLabel ? <span dir="auto"> · {displayPlace(photo.locationLabel)}</span> : null}
          </>
        ),
        marker:
          photo.latitude !== null && photo.longitude !== null
            ? { at: photo.capturedAt ?? null, id: photo.kind, label, lat: photo.latitude, lon: photo.longitude, title: `${photo.label}${when}` }
            : null,
      });
    }
    for (const stop of attachments?.journey?.stops ?? []) {
      const label = `S${stop.stopNumber}`;
      const where = stop.governorate ? ` · ${stop.governorate}` : "";
      add(cairoDayKey(stop.capturedAt), {
        label,
        line: (
          <>
            <span className="font-bold text-slate-900">Stop {stop.stopNumber}</span>
            {where}
            {` · ${formatDateTimeValue(stop.capturedAt)}`}
            {typeof stop.latitude === "number" && typeof stop.longitude === "number" ? (
              <span className="font-mono text-slate-500">
                {" "}· {stop.latitude.toFixed(5)}, {stop.longitude.toFixed(5)}
              </span>
            ) : null}
          </>
        ),
        marker:
          typeof stop.latitude === "number" && typeof stop.longitude === "number"
            ? {
                at: stop.capturedAt,
                id: `stop-${stop.stopNumber}`,
                label,
                lat: stop.latitude,
                lon: stop.longitude,
                title: `Stop ${stop.stopNumber}${where} · ${formatDateTimeValue(stop.capturedAt)}`,
              }
            : null,
      });
    }
    return byDay;
  }, [attachments, firstDay, lastDay]);
  const legendFor = (dayKey: string) => legendByDay.get(dayKey) ?? EMPTY_LEGEND;
  // The trip's road route from home (owner, 2026-11-07: "only a dot appears but not the route"). It is
  // the way out and the way back, so it is drawn on the first and the last day's map.
  const tripRoute = attachments?.tripRoute ?? null;
  const tripRouteLine = useMemo<TripRouteLine | null>(
    () => (tripRoute ? { encodedPolyline: tripRoute.encodedPolyline } : null),
    [tripRoute],
  );
  const routeFor = (dayKey: string): DayRouteOverlay | null =>
    tripRoute && tripRouteLine && (dayKey === firstDay || dayKey === lastDay) ? { line: tripRouteLine, route: tripRoute } : null;
  const pinsLoading = validationRequestId !== null && attachments === undefined;
  // Where the employee was when he submitted the request — the same point the claim checks
  // compare against — drawn as a hollow pin on EVERY day's map, so a check-in or photo far from
  // it reads at a glance without opening the checks.
  const submittedAt = useMemo<RouteDestination | null>(
    () =>
      typeof record.capturedLatitude === "number" && typeof record.capturedLongitude === "number"
        ? {
            lat: record.capturedLatitude,
            lon: record.capturedLongitude,
            title: `Submitted from${record.capturedLocation?.label ? ` · ${record.capturedLocation.label}` : ""}`,
          }
        : null,
    [record.capturedLatitude, record.capturedLongitude, record.capturedLocation],
  );

  // ── The three verdicts ──────────────────────────────────────────────────────────────────────
  const fieldWorkSignal = ((): Signal => {
    if (!record.hrId) return { line: "This trip is not linked to an employee, so its visits cannot be verified.", tone: "warn" };
    if (workload === undefined) return { line: "Reading the CRM…", tone: "loading" };
    if (workload === null) return { line: "The workload evidence could not be loaded.", tone: "warn" };
    const days = workload.dateBreakdown;
    const idle = days.filter((day) => !isWorkedTripDay(day)).length;
    const total = days.reduce((sum, day) => sum + day.total, 0);
    const meetingDays = days.filter((day) => day.total === 0 && isWorkedTripDay(day)).length;
    if (workload.matchStatus === "unmapped") return { line: "No CRM identity is mapped for this employee.", tone: "warn" };
    if (days.length > 0 && idle === days.length) {
      return { line: days.length > 1 ? `No field activity on any of the ${formatNumberValue(days.length)} days.` : "No field activity on this day.", tone: "danger" };
    }
    if (idle > 0) return { line: `${formatNumberValue(idle)} of ${formatNumberValue(days.length)} days with no field activity.`, tone: "warn" };
    // A meeting is the day's work but not a field visit (owner, 2026-11-07): said plainly, never in rose.
    if (meetingDays > 0) {
      if (total === 0) {
        return {
          line: days.length > 1 ? "A meeting recorded on every day · no field visits." : "A meeting recorded on the day · no field visits.",
          tone: "neutral",
        };
      }
      return {
        line: `Worked every day · ${formatNumberValue(total)} field visits, and a meeting on ${formatNumberValue(meetingDays)} day${meetingDays === 1 ? "" : "s"}.`,
        tone: "ok",
      };
    }
    return {
      line: days.length > 1
        ? `Visits on every day · ${formatNumberValue(total)} field visits.`
        : `${formatNumberValue(total)} field visits on the day.`,
      tone: "ok",
    };
  })();

  const claimSignal = ((): Signal => {
    if (validationRequestId === null) return { line: "Not available for an imported row.", tone: "neutral" };
    if (claimOutcome === undefined) return { line: "Checking the claim…", tone: "loading" };
    if (claimOutcome === "clean") return { line: "Verified against the day's CRM activity.", tone: "ok" };
    if (claimOutcome === "review") return { line: "Needs a look.", tone: "danger" };
    if (claimOutcome === "unverifiable") return { line: "Could not verify: no CRM activity to compare against.", tone: "neutral" };
    if (claimOutcome === "error") return { line: "The checks could not be loaded.", tone: "warn" };
    return { line: "Not available.", tone: "neutral" };
  })();

  const photoSignal = ((): Signal => {
    if (validationRequestId === null) return { line: "Uploaded from sheet — no photos.", tone: "neutral" };
    if (attachments === undefined) return { line: "Loading the photos…", tone: "loading" };
    if (attachments === null || !attachments.found) return { line: "The photos could not be loaded.", tone: "warn" };
    const photos = attachments.photos ?? [];
    const departure = photos.find((photo) => photo.kind === "departure");
    const arrival = photos.find((photo) => photo.kind === "arrival");
    if (departure?.isFlagged && departure.review) return { line: departure.review, tone: "danger" };
    const missing = photos.find((photo) => !photo.url && photo.missingNote);
    if (missing?.missingNote) return { line: missing.missingNote, tone: missing.missingNote.startsWith("Not required") ? "neutral" : "warn" };
    if (arrival?.sourceNote) return { line: `Arrival photo ${arrival.sourceNote.toLowerCase()}`, tone: "warn" };
    if (departure?.gpsMissingReason) return { line: `Departure photo: ${departure.gpsMissingReason}`, tone: "warn" };
    return { line: "Arrival and departure photos captured live, with GPS.", tone: "ok" };
  })();

  return (
    <div className={cn(PANEL_CLASS, "min-w-0")} data-trip-review>
      {/* ── 1. Header band ─────────────────────────────────────────────────────────────────── */}
      <div className={cn(adminPanelHeaderClassName, "px-5 pb-4 pt-3")}>
        {position ? (
          // Walk the list without leaving the page — the same order as the rail, so it agrees
          // with the ↑ ↓ keys.
          <div className="flex items-center justify-between gap-2">
            <button
              className="inline-flex items-center gap-1 py-1 pr-2 text-phx-xs font-bold text-slate-300 transition-colors hover:text-white disabled:cursor-default disabled:text-slate-600"
              disabled={!onPrevious}
              onClick={onPrevious}
              type="button"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Previous
            </button>
            <span className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-400">
              Trip {formatNumberValue(position.index)} of {formatNumberValue(position.total)}
            </span>
            <button
              className="inline-flex items-center gap-1 py-1 pl-2 text-phx-xs font-bold text-slate-300 transition-colors hover:text-white disabled:cursor-default disabled:text-slate-600"
              disabled={!onNext}
              onClick={onNext}
              type="button"
            >
              Next <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
        <div className="mt-2 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <p className="text-phx-2xs font-black uppercase tracking-[0.22em] text-orange-400">
              {valuesOnly ? "Imported trip · values only" : "Trip under review"}
            </p>
            <h2 className="mt-1 break-words text-xl font-black tracking-tight text-white">{record.specialist || "Unassigned"}</h2>
            <p className="mt-0.5 font-mono text-xs text-slate-400">{record.tripId}</p>
            <DuplicateTripFlag copies={duplicateOf} wide />
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1 text-right">
            {/* A rejected trip used to read "Pending" here — the badge only knew about approval. */}
            {decision.hrApproved ? (
              <Badge variant="success">Approved</Badge>
            ) : isRejected ? (
              <Badge variant="danger">Rejected</Badge>
            ) : (
              <Badge variant="warning">Pending</Badge>
            )}
            <p className="font-mono text-phx-2xl font-black tabular-nums leading-none text-white">{egp(record.total)}</p>
            <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-400">Claimed</p>
          </div>
        </div>
      </div>

      {/* ── 2. Glance strip ────────────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap border-b border-slate-200 bg-slate-50 [&>*]:min-w-0">
        <div className="flex items-center gap-3 border-b border-r border-slate-200 px-4 py-2.5">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 whitespace-nowrap border px-2 py-0.5 text-xs font-black uppercase tracking-wide",
              span.multiDay ? "border-orange-400 bg-white text-orange-700" : "border-slate-300 bg-white text-slate-600",
            )}
          >
            <CalendarDays className="h-3.5 w-3.5" />
            {tripSpanLabel(span)}
          </span>
          <span className="break-words text-sm font-bold text-slate-900">
            {formatDateValue(record.date, null, { weekday: "short" })}
            {span.multiDay ? (
              <>
                {" "}
                <ArrowRight aria-hidden className="inline h-3.5 w-3.5 text-slate-400" />{" "}
                {formatDateValue(record.toDate, null, { weekday: "short" })}
              </>
            ) : null}
          </span>
        </div>
        <div className="border-b border-r border-slate-200 px-4 py-2.5">
          <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">Distance</p>
          {record.km && flag ? (
            <p
              className={cn("mt-0.5 inline-flex items-center gap-1 whitespace-nowrap px-1.5 py-0.5 text-sm font-semibold", DISTANCE_TONE_CLASS[flag.tone])}
              title={flag.label || undefined}
            >
              {flag.tone === "fail" ? <AlertTriangle className="h-3.5 w-3.5" /> : null}
              {formatNumberValue(record.km)} km
              {flag.label ? <span className="text-phx-2xs font-bold"> · {flag.label}</span> : null}
            </p>
          ) : (
            <p className="mt-0.5 text-sm font-semibold text-slate-900">—</p>
          )}
        </div>
        <div className="border-b border-r border-slate-200 px-4 py-2.5">
          <Fact label="Transport" value={record.transportationType} />
        </div>
        <div className="border-b border-r border-slate-200 px-4 py-2.5">
          <Fact label="Expense · trip" value={[record.requestType, record.tripType].filter(Boolean).join(" · ")} />
        </div>
        <div className="flex-1 border-b border-slate-200 px-4 py-2.5 [&>div]:border-t-0 [&>div]:pt-0">
          <CostBreakdownFact
            allowance={record.allowance}
            formatCurrency={egp}
            meeting={record.meetingAmount}
            other={record.other}
            total={record.total}
            travel={record.travelCost}
          />
        </div>
      </div>

      {/* ── 3. Verdict strip — the "obvious at a glance" part ─────────────────────────────── */}
      <div className="grid border-b border-slate-200 sm:grid-cols-3 [&>*]:min-w-0" data-verdict-strip>
        <SignalTile href="#trip-field-work" icon={Route} signal={fieldWorkSignal} title="Field work" />
        <SignalTile href="#trip-claim-checks" icon={ShieldCheck} signal={claimSignal} title="Claim checks" />
        <SignalTile href="#trip-photos" icon={Camera} signal={photoSignal} title="Photos" />
      </div>

      <div className="space-y-5 px-5 py-4">
        {/* ── 4. Route, geography, the employee's note ──────────────────────────────────── */}
        <div className="grid gap-x-6 gap-y-3 sm:grid-cols-4 [&>*]:min-w-0">
          {/* The place in words first (RouteFact keeps its own dir="auto" per end); the address as
              Google stored it, plus code and all, sits under it in small type — kept, never leading. */}
          <RouteFact from={record.from} to={displayPlace(destination)} />
          {destination && displayPlace(destination) !== destination ? (
            <p className="col-span-2 -mt-2 break-words text-phx-xs text-slate-500 sm:col-span-4" dir="auto">
              <MapPin className="mr-1 inline h-3 w-3 text-slate-400" />
              Stored address · {destination}
            </p>
          ) : null}
          {/* Brick / area / region derived from the trip's captured GPS point (captured-location.ts)
              — absent, not "Not resolved", for an imported trip that never captured coordinates. */}
          {record.capturedLocation ? (
            <div className="col-span-2 min-w-0 border-t border-slate-200 pt-3 sm:col-span-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">Captured geography</p>
                {record.capturedLocation.confidence ? (
                  <Badge variant={capturedLocationConfidenceTone(record.capturedLocation.confidence)}>
                    {record.capturedLocation.confidence}
                  </Badge>
                ) : null}
              </div>
              <p className="mt-1 flex items-start gap-1.5 break-words text-sm font-semibold text-slate-900" dir="auto">
                <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-500" />
                {record.capturedLocation.label}
              </p>
              <div className="mt-2 grid grid-cols-3 gap-x-4 gap-y-1">
                <Fact label="Brick" value={record.capturedLocation.brickLabel} />
                <Fact label="Area" value={record.capturedLocation.areaLabel} />
                <Fact label="Region" value={record.capturedLocation.regionLabel} />
              </div>
            </div>
          ) : null}
          {/* What the employee wrote when submitting. Read-only, and apart from the reason box in
              the decision bar, which is HR's own and opens holding the system's sentence. */}
          {record.employeeNote ? (
            <div className="col-span-2 border-t border-slate-200 pt-3 sm:col-span-4">
              <EmployeeNote note={record.employeeNote} wide />
            </div>
          ) : null}
        </div>

        {/* ── 5. Field work, day by day — every day open, ONE MAP EACH ───────────────────── */}
        <section id="trip-field-work">
          <SectionHead
            summary={span.multiDay ? `${tripSpanLabel(span)} · one map for each day` : "One day, one map"}
            title="Field work, day by day"
            tone={fieldWorkSignal.tone}
          />
          <div className="border border-t-0 border-slate-200 p-3">
            <TripWorkloadEvidencePanel
              alwaysOpen
              declaredAm={record.amWorkload}
              declaredPharmacies={record.pharmacyWorkload ?? null}
              declaredPm={record.pmWorkload}
              hrId={record.hrId ?? null}
              onLoaded={setWorkload}
              renderDayMap={(day, firstCheckinNumber) => (
                <DayMap
                  checkins={day.checkins ?? EMPTY_CHECKINS}
                  dayKey={day.date}
                  firstCheckinNumber={firstCheckinNumber}
                  legend={legendFor(day.date)}
                  loading={pinsLoading}
                  submittedAt={submittedAt}
                  tripRoute={routeFor(day.date)}
                />
              )}
              tripEndDate={record.toDate || record.date}
              tripStartDate={record.date}
            />
            {/* With no employee linked, or the CRM read failed, there are no day blocks to draw
                in — the photos and stops still get their day's map, one per trip day. */}
            {!record.hrId || workload === null ? (
              <ol className="mt-3 space-y-2">
                {dayKeys.map((dayKey, index) => (
                  <li className="border border-slate-200 bg-white" key={dayKey}>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-l-[3px] border-l-slate-300 bg-slate-50 px-3 py-2.5">
                      {dayKeys.length > 1 ? (
                        <span className="text-phx-2xs font-black uppercase tracking-wide text-slate-400">
                          Day {formatNumberValue(index + 1)} of {formatNumberValue(dayKeys.length)}
                        </span>
                      ) : null}
                      <span className="text-sm font-bold text-slate-900">{formatDateValue(dayKey, null, { weekday: "short" })}</span>
                      <span className="text-xs font-semibold text-slate-500">No CRM activity to draw — the photos and stops only.</span>
                    </div>
                    <DayMap
                      checkins={EMPTY_CHECKINS}
                      dayKey={dayKey}
                      firstCheckinNumber={1}
                      legend={legendFor(dayKey)}
                      loading={pinsLoading}
                      submittedAt={submittedAt}
                      tripRoute={routeFor(dayKey)}
                    />
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        </section>

        {/* ── 6. Claim checks — every check open ────────────────────────────────────────── */}
        <section id="trip-claim-checks">
          <SectionHead summary={claimSignal.line} title="Claim checks" tone={claimSignal.tone} />
          <div className="border border-t-0 border-slate-200 p-3">
            {validationRequestId !== null ? (
              <ExpenseClaimValidationPanel bare onOutcome={setClaimOutcome} requestId={validationRequestId} />
            ) : (
              <p className="flex items-start gap-2 text-xs leading-relaxed text-slate-500">
                <HelpCircle className="mt-0.5 h-4 w-4 shrink-0" />
                An imported expense carries no captured GPS point, so there is nothing to check it against.
              </p>
            )}
          </div>
        </section>

        {/* ── 7. Photos, stops and tickets — in full ────────────────────────────────────── */}
        <section id="trip-photos">
          <SectionHead summary={photoSignal.line} title="Photos, stops and tickets" tone={photoSignal.tone} />
          <div className="border border-t-0 border-slate-200 p-3">
            <TripAttachments onLoaded={setAttachments} tripId={record.tripId} />
          </div>
        </section>
      </div>
    </div>
  );
}

/** One line of a day's legend: the pin's label, where it is on the map (if it has a position), the words. */
type DayLegendItem = { label: string; line: ReactNode; marker: RouteMarker | null };

/** The trip's road route on one day's map: the line itself (a stable reference) and what the legend says. */
type DayRouteOverlay = { line: TripRouteLine; route: ApproverTripRoute };

// Shared empties, so a day with nothing hands the map the same reference every render.
const EMPTY_LEGEND: DayLegendItem[] = [];
const EMPTY_CHECKINS: WorkloadCheckinDetail[] = [];

/** "2026-10-14" for an instant, read in Cairo — which trip day a stop was captured on. */
function cairoDayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone: "Africa/Cairo", year: "numeric" }).format(date);
}

const DAY_MAP_COPY = {
  description: "",
  empty: "Nothing with a GPS position was recorded on this day, so there is nothing to draw.",
  title: "The day on a map",
};

/**
 * True once the element has scrolled within `margin` of the viewport — and stays true. A latch,
 * never a fold: nothing is behind a click, the map simply draws as the reviewer reaches it.
 */
function useSeenOnce<T extends HTMLElement>(margin = "320px") {
  const ref = useRef<T | null>(null);
  // No observer (an old browser, a test renderer): draw at once rather than never.
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = ref.current;
    if (!element || seen) return;
    const px = Number.parseInt(margin, 10) || 0;
    // The observer is the cheap path. The scroll listener is the fallback for a browser that
    // throttles observers (a background or embedded tab never got a callback), so a reviewer who
    // scrolls always gets the map; nothing here can ever set it back to false.
    const check = () => {
      // Within reach of the viewport's bottom, OR already scrolled past (a jump to the foot of the
      // page went through it): either way the reviewer has reached this day.
      if (element.getBoundingClientRect().top < window.innerHeight + px) setSeen(true);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      { rootMargin: margin },
    );
    observer.observe(element);
    const frame = window.requestAnimationFrame(check);
    window.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  }, [margin, seen]);
  return { ref, seen };
}

/**
 * One trip day on its own map (owner: "if 3 days then I should have 3 maps"): the day's check-ins
 * numbered as in the list under it, the arrival or departure photo if it falls on this day, the
 * stops captured on it, and the point the request was submitted from as a hollow pin — with a
 * legend naming every pin, so the map reads without hovering.
 *
 * A six-day trip is six Google maps; each one is created only when its day scrolls into view
 * (useSeenOnce), so opening a trip costs one map, not six, and Google bills one load.
 */
function DayMap({
  checkins,
  dayKey,
  firstCheckinNumber,
  legend,
  loading,
  submittedAt,
  tripRoute = null,
}: {
  checkins: WorkloadCheckinDetail[];
  dayKey: string;
  firstCheckinNumber: number;
  legend: DayLegendItem[];
  loading: boolean;
  submittedAt: RouteDestination | null;
  tripRoute?: DayRouteOverlay | null;
}) {
  const { ref, seen } = useSeenOnce<HTMLDivElement>();
  // Stable references: FieldWorkforceRouteMap re-creates its Google map when these change identity,
  // and a fresh array per render left it at a blank wrapper (trip-workload-evidence.tsx).
  const mapped = useMemo<RouteCheckin[]>(
    () =>
      checkins.map((checkin, index) => ({
        address: checkin.address,
        checkDate: checkin.at ?? `${dayKey}T00:00`,
        contactName: checkin.via ? `${checkin.contact ?? "Check-in"} (via ${checkin.via})` : checkin.contact,
        id: `${dayKey}-${firstCheckinNumber + index}`,
        lat: checkin.lat,
        lon: checkin.lon,
      })),
    [checkins, dayKey, firstCheckinNumber],
  );
  const home = tripRoute?.route.home ?? null;
  const markers = useMemo<RouteMarker[]>(
    () => [
      ...(home ? [{ id: "home", label: "H", lat: home.lat, lon: home.lon, title: `Home${home.label ? ` · ${home.label}` : ""}` }] : []),
      ...legend.flatMap((item) => (item.marker ? [item.marker] : [])),
    ],
    [home, legend],
  );
  const pinned = markers.length + mapped.filter((checkin) => checkin.lat !== null && checkin.lon !== null).length;
  return (
    <div className="border-t border-slate-200 px-3 py-3" data-day-map={dayKey} data-map-drawn={seen ? "yes" : "no"} ref={ref}>
      <p className="mb-2 flex flex-wrap items-center gap-x-2 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
        <MapPin className="h-3.5 w-3.5" />
        This day on a map
        <span className="font-mono normal-case tracking-normal text-slate-400">
          {loading ? "loading the pins…" : `${formatNumberValue(pinned)} ${pinned === 1 ? "pin" : "pins"}`}
        </span>
      </p>
      {seen ? (
        <FieldWorkforceRouteMap
          checkins={mapped}
          copy={DAY_MAP_COPY}
          destination={submittedAt}
          frame="bare"
          markers={markers}
          route={null}
          tripRoute={tripRoute?.line ?? null}
        />
      ) : (
        // The map's own box size, so the page does not jump when the map replaces it.
        <div aria-hidden className="h-[360px] border border-slate-200 bg-slate-50 sm:h-[420px]" />
      )}
      <ul className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2 [&>*]:min-w-0" data-map-legend>
        {tripRoute ? (
          <li className="flex items-start gap-2">
            <span aria-hidden className="mt-1.5 h-1 w-5 shrink-0 bg-orange-500" />
            <span className="min-w-0 break-words text-slate-700">
              <span className="font-bold text-slate-900">The trip&rsquo;s route from home</span>
              {tripRoute.route.distanceKm !== null ? ` · ${formatNumberValue(tripRoute.route.distanceKm)} km` : ""}
            </span>
          </li>
        ) : null}
        {home ? (
          <li className="flex items-start gap-2">
            <PinBadge label="H" tone="photo" />
            <span className="min-w-0 break-words text-slate-700">
              <span className="font-bold text-slate-900">Home</span>
              {home.label ? <span dir="auto"> · {home.label}</span> : null}
              <span className="font-mono text-slate-500">
                {" "}· {home.lat.toFixed(5)}, {home.lon.toFixed(5)}
              </span>
            </span>
          </li>
        ) : null}
        {submittedAt ? (
          <li className="flex items-start gap-2">
            <PinBadge label="○" tone="submitted" />
            <span className="min-w-0 break-words text-slate-700">
              <span className="font-bold text-slate-900">Submitted from</span>
              <span className="font-mono text-slate-500">
                {" "}· {submittedAt.lat.toFixed(5)}, {submittedAt.lon.toFixed(5)}
              </span>
              {submittedAt.title.includes(" · ") ? <span dir="auto"> · {submittedAt.title.slice(submittedAt.title.indexOf(" · ") + 3)}</span> : null}
            </span>
          </li>
        ) : null}
        {legend.map((item) => (
          <li className="flex items-start gap-2" key={item.label}>
            <PinBadge label={item.label} tone="photo" />
            <span className="min-w-0 break-words text-slate-700">{item.line}</span>
          </li>
        ))}
        {mapped.map((checkin, index) => (
          <li className="flex items-start gap-2" key={checkin.id}>
            <PinBadge label={String(firstCheckinNumber + index)} tone="checkin" />
            <span className="min-w-0 break-words text-slate-700">
              <span className="font-bold text-slate-900">{checkin.contactName ?? "Check-in"}</span>
              {` · ${formatClock(checkin.checkDate)}`}
              {checkin.address ? <span dir="auto"> · {checkin.address}</span> : null}
              {checkin.lat === null || checkin.lon === null ? (
                <span className="text-amber-700"> · no coordinates, not on the map</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type Signal = { line: string; tone: "danger" | "loading" | "neutral" | "ok" | "warn" };

const SIGNAL_TONE: Record<Signal["tone"], { bar: string; text: string }> = {
  danger: { bar: "bg-rose-500", text: "text-rose-700" },
  loading: { bar: "bg-slate-300", text: "text-slate-500" },
  neutral: { bar: "bg-slate-300", text: "text-slate-600" },
  ok: { bar: "bg-emerald-500", text: "text-emerald-700" },
  warn: { bar: "bg-amber-500", text: "text-amber-800" },
};

/** One flat tile: a tone bar, the title, ONE sentence. A link to the section that proves it. */
function SignalTile({
  href,
  icon: Icon,
  signal,
  title,
}: {
  href: string;
  icon: typeof Route;
  signal: Signal;
  title: string;
}) {
  const tone = SIGNAL_TONE[signal.tone];
  return (
    <a
      className="flex items-stretch gap-3 border-b border-slate-200 px-4 py-2.5 transition-colors hover:bg-slate-50 sm:border-b-0 sm:border-r sm:last:border-r-0"
      href={href}
    >
      <span aria-hidden className={cn("w-1 shrink-0", tone.bar)} />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
          <Icon className="h-3.5 w-3.5" />
          {title}
        </span>
        <span className={cn("mt-0.5 flex items-start gap-1.5 break-words text-sm font-bold leading-snug", tone.text)}>
          {signal.tone === "loading" ? (
            <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
          ) : signal.tone === "ok" ? (
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : signal.tone === "neutral" ? (
            <HelpCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <span className="min-w-0">{signal.line}</span>
        </span>
      </span>
    </a>
  );
}

/** The dark section band with the orange accent bar — the module's divider, with no fold. */
function SectionHead({ summary, title, tone = "neutral" }: { summary?: string; title: string; tone?: Signal["tone"] }) {
  const summaryClass =
    tone === "danger" ? "text-rose-300" : tone === "warn" ? "text-amber-300" : tone === "ok" ? "text-emerald-300" : "text-slate-300";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-slate-900 px-4 py-2.5">
      <span aria-hidden className="h-4 w-1 bg-orange-500" />
      <span className="text-phx-xs font-black uppercase tracking-wide text-white">{title}</span>
      {summary ? <span className={cn("min-w-0 break-words text-phx-xs font-bold", summaryClass)}>{summary}</span> : null}
    </div>
  );
}

/** The pin's label as it appears on the map, so the legend and the map read the same. */
function PinBadge({ label, tone }: { label: string; tone: "checkin" | "photo" | "submitted" }) {
  return (
    <span
      className={cn(
        "mt-px inline-flex h-4 min-w-5 shrink-0 items-center justify-center px-1 font-mono text-phx-3xs font-black",
        tone === "photo"
          ? "bg-orange-100 text-orange-900 ring-1 ring-inset ring-orange-400"
          : tone === "submitted"
            ? "bg-white text-slate-700 ring-1 ring-inset ring-slate-500"
            : "bg-orange-500 text-white",
      )}
    >
      {label}
    </span>
  );
}
