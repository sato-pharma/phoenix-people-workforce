"use client";

import { AlertTriangle, CalendarCheck2, Car, MapPin, Moon, Sunrise, Users } from "lucide-react";
import { type ReactNode, useMemo } from "react";

import type { TripRouteLine } from "@/components/field-workforce-compliance/field-workforce-route-map";
import type { AttachmentsData } from "@/components/outstation/trip-attachments";
import { CrmNote, CrmPill } from "@/components/phoenix-crm/ui";
import { formatDateValue, formatNumberValue, formatPhoenixTime } from "@/lib/i18n/format";
import { type DeskDayMap, deskDayMaps } from "@/lib/outstation/approvals/day-map";
import type { CrmDayReading, CrmTripReading, CrmWhereabouts } from "@/lib/outstation/crm-trip-evidence";
import { tripSpan } from "@/lib/outstation/trip-span";
import { cn } from "@/lib/utils";

import { DeskDayMapBox } from "./desk-day-map";
import { visitLocationNote } from "./desk-parts";

/**
 * The trip, day by day — Phoenix CRM's reading of each day and that day's own map.
 *
 * For each trip day: what the week plan said, where the visits really were, the activities logged,
 * the Day Start, the night after, a planned ride-along, a visit partner who also claimed a car —
 * then the day on a map. The reading is built in `src/lib/outstation/crm-trip-evidence.ts` and
 * arrives with the trip (one request, desk-reviewer.tsx); nothing is fetched here.
 *
 * A visit's time is when it was SAVED, never an arrival time; distances are straight lines, so a
 * kilometre gap is "needs a look", never "wrong". A day Phoenix CRM could not be read for still
 * gets its map: the photos and the stops have their own positions.
 */

type Tone = "danger" | "neutral" | "ok" | "warn";

const WHEREABOUTS: Record<CrmWhereabouts, { label: string; tone: Tone }> = {
  destination: { label: "At the destination", tone: "ok" },
  elsewhere: { label: "Away from home and destination", tone: "warn" },
  home: { label: "Back home", tone: "danger" },
  mixed: { label: "Destination and elsewhere", tone: "neutral" },
  none: { label: "No visits", tone: "neutral" },
  unknown: { label: "No position on the visits", tone: "neutral" },
};

const TONE_TEXT: Record<Tone, string> = { danger: "text-rose-700", neutral: "text-slate-600", ok: "text-emerald-700", warn: "text-amber-700" };
const TONE_RAIL: Record<Tone, string> = { danger: "border-l-rose-500", neutral: "border-l-slate-300", ok: "border-l-emerald-500", warn: "border-l-amber-500" };

const km = (value: number | null) => (value === null ? null : `${formatNumberValue(Math.round(value))} km`);

const NO_DAYS: CrmDayReading[] = [];

export function DeskDays({
  attachments,
  reading,
  tripEnd,
  tripStart,
}: {
  attachments: AttachmentsData | null;
  /** Null when Phoenix CRM held nothing to read for the trip, or could not be read. */
  reading: CrmTripReading | null;
  tripEnd: string;
  tripStart: string;
}) {
  const span = tripSpan(tripStart, tripEnd);
  const dayKeyText = (span.dayKeys.length > 0 ? span.dayKeys : [tripStart.slice(0, 10)]).join(",");
  const days = reading?.days ?? NO_DAYS;
  const route = attachments?.tripRoute ?? null;
  const routeLine = useMemo<TripRouteLine | null>(() => (route ? { encodedPolyline: route.encodedPolyline } : null), [route]);
  const maps = useMemo<DeskDayMap[]>(
    () =>
      deskDayMaps({
        dayKeys: dayKeyText.split(","),
        days,
        hasTripRoute: Boolean(route),
        photos: attachments?.photos ?? [],
        stops: attachments?.journey?.stops ?? [],
      }),
    [attachments, dayKeyText, days, route],
  );

  return (
    <div className="min-w-0 space-y-3" data-desk-days>
      {reading ? <TripFacts reading={reading} /> : null}
      <ol className="min-w-0 space-y-2">
        {maps.map((map, index) => (
          <DayBlock day={days.find((day) => day.date === map.date) ?? null} dayCount={maps.length} index={index} key={map.date} map={map} routeLine={routeLine} />
        ))}
      </ol>
    </div>
  );
}

/** The trip in four facts, then every open location warning in words. */
function TripFacts({ reading }: { reading: CrmTripReading }) {
  return (
    <>
      <div className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4 [&>*]:min-w-0" data-crm-trip-facts>
        <Fact label="Days in a sent plan" value={`${formatNumberValue(reading.days.length - reading.unplannedDays.length)} of ${formatNumberValue(reading.days.length)}`} />
        <Fact label="Days back home" tone={reading.homeDays.length > 0 ? "danger" : undefined} value={formatNumberValue(reading.homeDays.length)} />
        <Fact
          label="Farthest visit from home"
          tone={reading.km?.needsLook ? "warn" : undefined}
          value={reading.km ? `${km(reading.km.farthest)} · ${km(reading.km.claimed)} claimed` : (km(reading.farthestKmFromHome) ?? "No position")}
        />
        <Fact
          label="Open location warnings"
          tone={reading.warnings.some((warning) => warning.strong) ? "danger" : reading.warnings.length > 0 ? "warn" : undefined}
          value={formatNumberValue(reading.warnings.length)}
        />
      </div>
      {reading.warnings.length > 0 ? (
        <CrmNote tone="warn">
          <ul className="grid gap-1" data-crm-warnings>
            {reading.warnings.map((warning, index) => (
              <li className="flex min-w-0 items-start gap-1.5 break-words" key={`${warning.label}-${index}`}>
                <AlertTriangle aria-hidden className={cn("mt-1 h-3.5 w-3.5 shrink-0", warning.strong ? "text-rose-600" : "text-amber-600")} />
                <span className="min-w-0" dir="auto">
                  {warning.strong ? <b>Strong · </b> : null}
                  {warning.label}
                </span>
              </li>
            ))}
          </ul>
        </CrmNote>
      ) : null}
    </>
  );
}

function DayBlock({ day, dayCount, index, map, routeLine }: { day: CrmDayReading | null; dayCount: number; index: number; map: DeskDayMap; routeLine: TripRouteLine | null }) {
  const where = day ? WHEREABOUTS[day.whereabouts] : null;
  const tone: Tone = !day || day.beforePhoenix ? "neutral" : day.nothingInCrm ? "warn" : (where?.tone ?? "neutral");
  const headline = !day ? "Phoenix CRM was not read for this day" : day.beforePhoenix ? "Before Phoenix CRM" : day.nothingInCrm ? "Nothing in Phoenix CRM" : where?.label;
  return (
    <li className={cn("min-w-0 border border-l-[3px] border-slate-200 bg-white", TONE_RAIL[tone])} data-trip-day={map.date}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 bg-slate-50 px-3 py-2">
        {dayCount > 1 ? (
          <span className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">
            Day {formatNumberValue(index + 1)} of {formatNumberValue(dayCount)}
          </span>
        ) : null}
        <span className="text-sm font-black text-slate-950">{formatDateValue(map.date, null, { weekday: "short" })}</span>
        <span className={cn("text-xs font-bold", TONE_TEXT[tone])}>{headline}</span>
        {day && day.areas.length > 0 ? (
          <span className="min-w-0 break-words text-xs text-slate-600" dir="auto">
            {day.areas.join(" · ")}
          </span>
        ) : null}
      </div>
      {day?.beforePhoenix ? (
        <p className="px-3 py-2.5 text-xs text-slate-600">Phoenix CRM was not yet counted for this team on this day, so an empty day here says nothing about the trip.</p>
      ) : day ? (
        <DayReading day={day} pins={map.pins} />
      ) : null}
      <DeskDayMapBox map={map} routeLine={routeLine} />
    </li>
  );
}

function planLine(day: CrmDayReading): string | null {
  if (!day.plan) return null;
  const status = day.plan.status === "approved" ? "Approved plan" : day.plan.status === "submitted" ? "Sent plan" : day.plan.status === "returned" ? "Returned to change" : "Draft, not sent";
  const places = day.plan.places.length > 0 ? `${formatNumberValue(day.plan.places.length)} place${day.plan.places.length === 1 ? "" : "s"}` : null;
  const areas = [...new Set(day.plan.places.map((place) => place.area).filter((area): area is string => Boolean(area)))];
  return [status, places, ...day.plan.activities, ...areas].filter(Boolean).join(" · ");
}

function DayReading({ day, pins }: { day: CrmDayReading; pins: Array<number | null> }) {
  const plan = planLine(day);
  return (
    <div className="grid min-w-0 gap-x-6 gap-y-2 px-3 py-2.5 text-xs sm:grid-cols-2 [&>*]:min-w-0">
      <div className="space-y-1">
        <Label icon={CalendarCheck2}>Planned</Label>
        {plan ? (
          <p className={cn("break-words", day.planned ? "text-slate-800" : "text-amber-700")} dir="auto">
            {plan}
          </p>
        ) : day.managerPlan ? null : (
          <p className="text-amber-700">No week plan for this day</p>
        )}
        {day.managerPlan ? (
          <p className="break-words text-slate-800" dir="auto">
            {day.managerPlan.sent ? "Manager plan sent" : "Manager plan not sent"}
            {day.managerPlan.lines.length > 0 ? ` · ${day.managerPlan.lines.join(" · ")}` : ""}
          </p>
        ) : null}
        {day.rideAlongsPlanned.length > 0 ? (
          <p className="flex min-w-0 items-start gap-1.5 break-words text-slate-800" dir="auto">
            <Users aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
            Ride-along planned with {day.rideAlongsPlanned.join(", ")}
          </p>
        ) : null}
        {day.activitiesLogged.length > 0 ? <p className="break-words text-slate-800">Logged: {day.activitiesLogged.join(" · ")}</p> : null}
      </div>

      <div className="space-y-1">
        <Label icon={MapPin}>Visited · {formatNumberValue(day.visits.length)}</Label>
        {day.visits.length === 0 ? <p className="text-slate-500">No visit saved</p> : null}
        <ul className="space-y-0.5">
          {day.visits.map((visit, visitIndex) => (
            <li className="break-words text-slate-800" data-visit-pin={pins[visitIndex] ?? "none"} key={`${visit.savedAt}-${visitIndex}`}>
              {pins[visitIndex] ? <span className="font-black tabular-nums text-slate-950">{pins[visitIndex]} · </span> : null}
              <span className="tabular-nums text-slate-500">{visit.savedAt ? formatPhoenixTime(visit.savedAt) : "—"}</span>{" "}
              <bdi dir="auto">{visit.customer ?? visit.place ?? "Visit"}</bdi>
              {visit.place && visit.customer ? (
                <>
                  {" · "}
                  <bdi dir="auto">{visit.place}</bdi>
                </>
              ) : null}
              {visit.kmFromDestination !== null ? <span className="text-slate-500"> · {km(visit.kmFromDestination)} from destination</span> : null}
              {visit.unplanned ? <CrmPill className="ml-1" tone="warn">Unplanned</CrmPill> : null}
              {visitLocationNote(visit.locationFlag) ? <CrmPill className="ml-1" tone="warn">{visitLocationNote(visit.locationFlag)}</CrmPill> : null}
            </li>
          ))}
        </ul>
        {day.dayStart ? (
          <p className="flex min-w-0 items-start gap-1.5 text-slate-700">
            <Sunrise aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
            Day Start {formatPhoenixTime(day.dayStart.at)}
            {day.dayStart.kmFromDestination !== null ? ` · ${km(day.dayStart.kmFromDestination)} from destination` : ""}
          </p>
        ) : null}
        {day.night ? (
          <p
            className={cn("flex min-w-0 items-start gap-1.5", day.night.verdict === "home" ? "font-bold text-amber-700" : day.night.verdict === "stayed" ? "text-emerald-700" : "text-slate-600")}
            data-crm-night={day.night.verdict}
          >
            <Moon aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {day.night.verdict === "stayed" ? "Night: the next morning started at the destination" : day.night.verdict === "home" ? "Night: the next morning started back home" : "Night: no position the next morning"}
            {day.night.nextMorningAt ? ` · ${formatPhoenixTime(day.night.nextMorningAt)}` : ""}
          </p>
        ) : null}
        {day.sharedCar.length > 0 ? (
          <p className="flex min-w-0 items-start gap-1.5 break-words font-bold text-amber-700" data-crm-shared-car>
            <Car aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />A car also claimed by {day.sharedCar.map((entry) => entry.name).join(", ")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Label({ children, icon: Icon }: { children: ReactNode; icon: typeof MapPin }) {
  return (
    <p className="flex items-center gap-1.5 text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">
      <Icon aria-hidden className="h-3.5 w-3.5" />
      {children}
    </p>
  );
}

function Fact({ label, tone, value }: { label: string; tone?: "danger" | "warn"; value: string }) {
  return (
    <div>
      <p className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <p className={cn("mt-0.5 break-words text-sm font-black", tone ? TONE_TEXT[tone] : "text-slate-950")}>{value}</p>
    </div>
  );
}
