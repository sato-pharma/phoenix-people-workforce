"use client";

import { MapPin } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import {
  FieldWorkforceRouteMap,
  type RouteCheckin,
  type RouteDestination,
  type RouteMarker,
  type TripRouteLine,
} from "@/components/field-workforce-compliance/field-workforce-route-map";
import type { AttachmentsData } from "@/components/outstation/trip-attachments";
import {
  type TripWorkloadEvidence,
  TripWorkloadEvidencePanel,
  type WorkloadCheckinDetail,
  formatClock,
} from "@/components/outstation/trip-workload-evidence";
import { isWorkedTripDay } from "@/lib/crm/trip-day-meetings";
import { formatDateTimeValue, formatDateValue, formatNumberValue } from "@/lib/i18n/format";
import type { ApproverTripRoute } from "@/lib/outstation/day-route-line";
import { outstationRequestIdFromTripId } from "@/lib/outstation/expense-approval-decisions";
import { displayPlace } from "@/lib/outstation/place-label";
import { tripSpan } from "@/lib/outstation/trip-span";
import { cn } from "@/lib/utils";

import type { LoadedRecord, TripIdleDays } from "../review-model";

/**
 * Field work, day by day — every day open and EACH DAY ON ITS OWN MAP (owner, 2026-11-07: "in a
 * multiple day trip separate each day from the other; if 3 days then I should have 3 maps").
 *
 * Each day's map pins that day's GPS check-ins numbered as in its list, the arrival photo (A) on the
 * first day and the departure photo (D) on the last, every journey stop (S2, S3 …) on the day it was
 * captured, the point the request was submitted from as a hollow pin, and the trip's road route from
 * home on the first and last day — with a legend naming every pin, so the map reads without hovering.
 *
 * The CRM read is the evidence panel's own (TripWorkloadEvidencePanel); this file only lays the photos
 * and stops beside it and hands the trip's idle days up to the decision, which OFFERS the allowance
 * share for them and never applies it (owner, 2026-11-07: "LET ME DECIDE").
 */
export function DeckFieldWork({
  attachments,
  onIdleDays,
  onLoaded,
  record,
  workload,
}: {
  /** The photos, stops and route, once the attachments read lands (undefined while it is on its way). */
  attachments: AttachmentsData | null | undefined;
  onIdleDays: (tripId: string, idle: TripIdleDays) => void;
  onLoaded: (data: TripWorkloadEvidence | null) => void;
  record: LoadedRecord;
  /** The CRM read; `undefined` while loading, null when nothing came back. */
  workload: TripWorkloadEvidence | null | undefined;
}) {
  // The idle-day count the field work states, lifted to the decision. Not for a rep with no CRM
  // identity mapped: no visits there is not evidence of an idle day.
  useEffect(() => {
    if (!workload || workload.matchStatus === "unmapped") return;
    const days = workload.dateBreakdown;
    if (days.length === 0) return;
    // A meeting day is worked (trip-day-meetings.ts): no idle-day allowance share is offered for it.
    onIdleDays(record.tripId, { idleDays: days.filter((day) => !isWorkedTripDay(day)).length, tripDays: days.length });
  }, [onIdleDays, record.tripId, workload]);

  const span = tripSpan(record.date, record.toDate);
  const dayKeys = span.dayKeys.length > 0 ? span.dayKeys : [record.date.slice(0, 10)];
  const firstDay = dayKeys[0];
  const lastDay = dayKeys[dayKeys.length - 1];
  const legendByDay = buildDayLegends(attachments, firstDay, lastDay);
  const legendFor = (dayKey: string) => legendByDay.get(dayKey) ?? EMPTY_LEGEND;
  // The trip's road route from home is the way out and the way back: the first and the last day.
  const tripRoute = attachments?.tripRoute ?? null;
  const tripRouteLine = useMemo<TripRouteLine | null>(() => (tripRoute ? { encodedPolyline: tripRoute.encodedPolyline } : null), [tripRoute]);
  const routeFor = (dayKey: string): DayRouteOverlay | null =>
    tripRoute && tripRouteLine && (dayKey === firstDay || dayKey === lastDay) ? { line: tripRouteLine, route: tripRoute } : null;
  // Only an app-submitted trip has photos and stops to wait for; an imported row has none to load.
  const pinsLoading = outstationRequestIdFromTripId(record.tripId) !== null && attachments === undefined;
  // Where the request was submitted from — the point the claim checks compare against — as a hollow
  // pin on EVERY day's map, so a check-in or photo far from it reads at a glance.
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
  const submittedLabel = record.capturedLocation?.label ? displayPlace(record.capturedLocation.label) : null;

  return (
    <div className="min-w-0" data-deck-field-work>
      <TripWorkloadEvidencePanel
        alwaysOpen
        declaredAm={record.amWorkload}
        declaredPharmacies={record.pharmacyWorkload ?? null}
        declaredPm={record.pmWorkload}
        hrId={record.hrId ?? null}
        onLoaded={onLoaded}
        renderDayMap={(day, firstCheckinNumber) => (
          <DayMap
            checkins={day.checkins ?? EMPTY_CHECKINS}
            dayKey={day.date}
            firstCheckinNumber={firstCheckinNumber}
            legend={legendFor(day.date)}
            loading={pinsLoading}
            submittedAt={submittedAt}
            submittedLabel={submittedLabel}
            tripRoute={routeFor(day.date)}
          />
        )}
        tripEndDate={record.toDate || record.date}
        tripStartDate={record.date}
      />
      {/* With no employee linked, or the CRM read failed, there are no day blocks to draw in — the
          photos and stops still get their day's map, one per trip day. */}
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
                submittedLabel={submittedLabel}
                tripRoute={routeFor(dayKey)}
              />
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/** One line of a day's legend: the pin's label, where it sits on the map (if it has a position), the words. */
type DayLegendItem = { label: string; line: ReactNode; marker: RouteMarker | null };

/** The trip's road route on one day's map: the line (a stable reference) and what the legend says. */
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

function coordinates(lat: number, lon: number) {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

/**
 * Every photo and stop the trip has, grouped by the day it belongs on. A photo or stop captured
 * outside the trip's dates (a departure photo taken the morning after, say) is drawn on the nearest
 * trip day; its legend line still prints the real time.
 */
function buildDayLegends(attachments: AttachmentsData | null | undefined, firstDay: string, lastDay: string): Map<string, DayLegendItem[]> {
  const byDay = new Map<string, DayLegendItem[]>();
  const add = (dayKey: string, item: DayLegendItem) => {
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
            <span className="tabular-nums text-slate-500"> · {coordinates(photo.latitude as number, photo.longitude as number)}</span>
          ) : photo.url ? (
            <span className="text-amber-700"> · no GPS position, not on the map</span>
          ) : null}
          {photo.locationLabel ? (
            <>
              {" · "}
              <bdi dir="auto">{displayPlace(photo.locationLabel)}</bdi>
            </>
          ) : null}
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
    const located = typeof stop.latitude === "number" && typeof stop.longitude === "number";
    add(cairoDayKey(stop.capturedAt), {
      label,
      line: (
        <>
          <span className="font-bold text-slate-900">Stop {stop.stopNumber}</span>
          {where}
          {` · ${formatDateTimeValue(stop.capturedAt)}`}
          {located ? <span className="tabular-nums text-slate-500"> · {coordinates(stop.latitude as number, stop.longitude as number)}</span> : null}
        </>
      ),
      marker: located
        ? {
            at: stop.capturedAt,
            id: `stop-${stop.stopNumber}`,
            label,
            lat: stop.latitude as number,
            lon: stop.longitude as number,
            title: `Stop ${stop.stopNumber}${where} · ${formatDateTimeValue(stop.capturedAt)}`,
          }
        : null,
    });
  }
  return byDay;
}

const DAY_MAP_COPY = { description: "", empty: "No GPS points this day", title: "The day on a map" };

/**
 * True once the element has come within `margin` of the screen — and stays true. A latch, never a
 * fold: nothing is behind a click, the map simply draws as the reviewer reaches it.
 *
 * Inside the reviewer the evidence scrolls in its OWN column, not the window, so the fallback listens
 * to scrolls in the capture phase (an inner box's scroll never bubbles to the window). And a day in a
 * view that is switched off reports a zero-sized box — that is "not on screen", never "already
 * passed", or every hidden map would be created at once.
 */
function useSeenOnce<T extends HTMLElement>(margin = 320) {
  const ref = useRef<T | null>(null);
  // No observer (an old browser, a test renderer): draw at once rather than never.
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = ref.current;
    if (!element || seen) return;
    const check = () => {
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) return;
      if (box.top < window.innerHeight + margin) setSeen(true);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      { rootMargin: `${margin}px` },
    );
    observer.observe(element);
    const frame = window.requestAnimationFrame(check);
    document.addEventListener("scroll", check, { capture: true, passive: true });
    window.addEventListener("resize", check);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      document.removeEventListener("scroll", check, { capture: true });
      window.removeEventListener("resize", check);
    };
  }, [margin, seen]);
  return { ref, seen };
}

/**
 * One trip day on its own map. A six-day trip is six Google maps; each is created only when its day
 * comes into view, so opening a trip costs one map, not six, and Google bills one load.
 */
function DayMap({
  checkins,
  dayKey,
  firstCheckinNumber,
  legend,
  loading,
  submittedAt,
  submittedLabel,
  tripRoute = null,
}: {
  checkins: WorkloadCheckinDetail[];
  dayKey: string;
  firstCheckinNumber: number;
  legend: DayLegendItem[];
  loading: boolean;
  submittedAt: RouteDestination | null;
  submittedLabel: string | null;
  tripRoute?: DayRouteOverlay | null;
}) {
  const { ref, seen } = useSeenOnce<HTMLDivElement>();
  // Stable references: the route map re-creates its Google map when these change identity, and a
  // fresh array per render left it a blank wrapper (trip-workload-evidence.tsx).
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
  // Nothing of this day's own carries a position and no route is drawn on it: ONE line, never a 420px
  // map holding only the submitted-from pin.
  const empty = !loading && pinned === 0 && !tripRoute;
  return (
    <div className="border-t border-slate-200 px-3 py-3" data-day-map={dayKey} data-map-drawn={seen ? "yes" : "no"} ref={ref}>
      <p className="mb-2 flex flex-wrap items-center gap-x-2 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
        <MapPin aria-hidden className="h-3.5 w-3.5" />
        This day on a map
        <span className="normal-case tracking-normal tabular-nums text-slate-400">
          {loading ? "loading the pins" : `${formatNumberValue(pinned)} ${pinned === 1 ? "pin" : "pins"}`}
        </span>
      </p>
      {empty ? (
        <p className="border border-dashed border-slate-300 px-3 py-2 text-xs font-semibold text-slate-500" data-day-map-empty>
          {DAY_MAP_COPY.empty}
        </p>
      ) : seen ? (
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
        // The map's own box size, so the column does not jump when the map replaces it.
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
              {home.label ? (
                <>
                  {" · "}
                  <bdi dir="auto">{displayPlace(home.label)}</bdi>
                </>
              ) : null}
              <span className="tabular-nums text-slate-500"> · {coordinates(home.lat, home.lon)}</span>
            </span>
          </li>
        ) : null}
        {submittedAt && !empty ? (
          <li className="flex items-start gap-2">
            <PinBadge label="○" tone="submitted" />
            <span className="min-w-0 break-words text-slate-700">
              <span className="font-bold text-slate-900">Submitted from</span>
              <span className="tabular-nums text-slate-500"> · {coordinates(submittedAt.lat, submittedAt.lon)}</span>
              {submittedLabel ? (
                <>
                  {" · "}
                  <bdi dir="auto">{submittedLabel}</bdi>
                </>
              ) : null}
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
              {checkin.address ? (
                <>
                  {" · "}
                  <bdi dir="auto">{displayPlace(checkin.address)}</bdi>
                </>
              ) : null}
              {checkin.lat === null || checkin.lon === null ? <span className="text-amber-700"> · no coordinates, not on the map</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The pin's label as it appears on the map, so the legend and the map read the same. */
function PinBadge({ label, tone }: { label: string; tone: "checkin" | "photo" | "submitted" }) {
  return (
    <span
      className={cn(
        "mt-px inline-flex h-4 min-w-5 shrink-0 items-center justify-center px-1 text-phx-3xs font-black tabular-nums",
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
