"use client";

import { AlertTriangle, CalendarCheck2, Car, HelpCircle, Loader2, MapPin, Moon, Sunrise, Users } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { formatDateValue, formatNumberValue, formatPhoenixTime } from "@/lib/i18n/format";
import type { CrmDayReading, CrmTripReading, CrmWhereabouts } from "@/lib/outstation/crm-trip-evidence";
import { cn } from "@/lib/utils";

/**
 * "Phoenix CRM on this trip" (owner, 2026-11-07: "wire the Phoenix CRM with the expense module and
 * get most benefit of this integration"). For each trip day: what the week plan said, where the
 * visits really were (from home and from the claimed destination), the activities logged, the Day
 * Start, the night after, a planned ride-along, and a visit partner who also claimed a car. The
 * reading is built in `src/lib/outstation/crm-trip-evidence.ts`; this only prints it.
 *
 * A visit's time is when it was SAVED, never an arrival time; distances are straight lines, so a
 * kilometre gap is "needs a look", never "wrong".
 */

export type CrmTripSignal = { line: string; tone: "danger" | "loading" | "neutral" | "ok" | "warn" };

type Payload = { found: boolean; reading: CrmTripReading | null; unavailable: string[] };

const WHEREABOUTS: Record<CrmWhereabouts, { label: string; tone: "danger" | "neutral" | "ok" | "warn" }> = {
  destination: { label: "At the destination", tone: "ok" },
  elsewhere: { label: "Away from home and destination", tone: "warn" },
  home: { label: "Back home", tone: "danger" },
  mixed: { label: "Destination and elsewhere", tone: "neutral" },
  none: { label: "No visits", tone: "neutral" },
  unknown: { label: "No position on the visits", tone: "neutral" },
};

const TONE_TEXT = { danger: "text-rose-700", neutral: "text-slate-600", ok: "text-emerald-700", warn: "text-amber-700" } as const;
const TONE_BAR = { danger: "border-l-rose-500", neutral: "border-l-slate-300", ok: "border-l-emerald-500", warn: "border-l-amber-500" } as const;

const km = (value: number | null) => (value === null ? null : `${formatNumberValue(Math.round(value))} km`);

export function CrmTripSection({
  onSignal,
  requestId,
}: {
  onSignal?: (signal: CrmTripSignal) => void;
  requestId: number | null;
}) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (requestId === null) return;
    // The section is keyed by the trip (the reviewer mounts one per trip, deck.tsx), so a new trip mounts it empty.
    let live = true;
    fetch(`/api/admin/outstation/${requestId}/crm-evidence`)
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as (Payload & { message?: string }) | null;
        if (!live) return;
        if (!response.ok || !body) setFailed(body?.message || "Phoenix CRM could not be read for this trip.");
        else setPayload(body);
      })
      .catch(() => live && setFailed("Could not reach the server."));
    return () => {
      live = false;
    };
  }, [requestId]);

  const reading = payload?.reading ?? null;
  useEffect(() => {
    if (!onSignal) return;
    if (requestId === null) onSignal({ line: "Not available for an imported row.", tone: "neutral" });
    else if (failed) onSignal({ line: "Phoenix CRM could not be read", tone: "neutral" });
    else if (!payload) onSignal({ line: "Reading Phoenix CRM", tone: "loading" });
    else if (!reading) onSignal({ line: "Nothing to read for this trip", tone: "neutral" });
    else onSignal({ line: reading.signal.sentence, tone: reading.signal.tone });
  }, [failed, onSignal, payload, reading, requestId]);

  if (requestId === null) {
    return <Note>An imported expense has no source request to read Phoenix CRM against.</Note>;
  }
  if (failed) return <Note tone="warn">{failed}</Note>;
  if (!payload) {
    return (
      <p className="flex items-center gap-2 text-xs font-semibold text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Reading Phoenix CRM for each trip day
      </p>
    );
  }
  if (!reading) return <Note>No employee or no dates on this trip, so there is nothing to read.</Note>;

  return (
    <div className="space-y-3" data-crm-trip>
      {payload.unavailable.length > 0 ? (
        <Note tone="warn">Not read this time: {payload.unavailable.join(", ")}. What is shown below is not the whole picture.</Note>
      ) : null}

      {/* The trip in four facts. */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4 [&>*]:min-w-0" data-crm-trip-facts>
        <TripFact label="Days in a sent plan" value={`${formatNumberValue(reading.days.length - reading.unplannedDays.length)} of ${formatNumberValue(reading.days.length)}`} />
        <TripFact label="Days back home" tone={reading.homeDays.length > 0 ? "danger" : undefined} value={formatNumberValue(reading.homeDays.length)} />
        <TripFact
          label="Farthest visit from home"
          tone={reading.km?.needsLook ? "warn" : undefined}
          value={
            reading.km
              ? `${km(reading.km.farthest)} · ${km(reading.km.claimed)} claimed`
              : (km(reading.farthestKmFromHome) ?? "No position")
          }
        />
        <TripFact
          label="Open location warnings"
          tone={reading.warnings.some((warning) => warning.strong) ? "danger" : reading.warnings.length > 0 ? "warn" : undefined}
          value={formatNumberValue(reading.warnings.length)}
        />
      </div>
      {reading.warnings.length > 0 ? (
        <ul className="space-y-1 border-l-2 border-amber-400 bg-amber-50/60 px-3 py-2 text-xs text-amber-900" data-crm-warnings>
          {reading.warnings.map((warning, index) => (
            <li className="flex items-start gap-1.5 break-words" key={`${warning.label}-${index}`}>
              <AlertTriangle className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", warning.strong ? "text-rose-600" : "text-amber-600")} />
              <span className="min-w-0" dir="auto">
                {warning.strong ? <b>Strong · </b> : null}
                {warning.label}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <ol className="space-y-2">
        {reading.days.map((day, index) => (
          <CrmDay day={day} dayCount={reading.days.length} index={index} key={day.date} />
        ))}
      </ol>
    </div>
  );
}

function CrmDay({ day, dayCount, index }: { day: CrmDayReading; dayCount: number; index: number }) {
  const where = WHEREABOUTS[day.whereabouts];
  const planLine = day.plan
    ? [
        day.plan.status === "approved" ? "Approved plan" : day.plan.status === "submitted" ? "Sent plan" : day.plan.status === "returned" ? "Returned to change" : "Draft, not sent",
        day.plan.places.length > 0 ? `${formatNumberValue(day.plan.places.length)} place${day.plan.places.length === 1 ? "" : "s"}` : null,
        ...day.plan.activities,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  const plannedAreas = day.plan ? [...new Set(day.plan.places.map((place) => place.area).filter((area): area is string => Boolean(area)))] : [];
  return (
    <li className={cn("border border-l-[3px] border-slate-200 bg-white", TONE_BAR[day.beforePhoenix ? "neutral" : day.nothingInCrm ? "warn" : where.tone])} data-crm-day={day.date}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 bg-slate-50 px-3 py-2">
        {dayCount > 1 ? (
          <span className="text-phx-sm font-black uppercase tracking-wide text-slate-400">
            Day {formatNumberValue(index + 1)} of {formatNumberValue(dayCount)}
          </span>
        ) : null}
        <span className="text-sm font-bold text-slate-900">{formatDateValue(day.date, null, { weekday: "short" })}</span>
        <span className={cn("text-xs font-bold", TONE_TEXT[day.beforePhoenix ? "neutral" : day.nothingInCrm ? "warn" : where.tone])}>
          {day.beforePhoenix ? "Before Phoenix CRM" : day.nothingInCrm ? "Nothing in Phoenix CRM" : where.label}
        </span>
        {day.areas.length > 0 ? (
          <span className="min-w-0 break-words text-xs text-slate-600" dir="auto">
            {day.areas.join(" · ")}
          </span>
        ) : null}
      </div>

      {day.beforePhoenix ? (
        <p className="px-3 py-2.5 text-xs text-slate-600">
          Phoenix CRM was not yet counted for this team on this day. The old system&apos;s visits are under Field work, day by day.
        </p>
      ) : (
        <div className="grid gap-x-6 gap-y-2 px-3 py-2.5 text-xs sm:grid-cols-2 [&>*]:min-w-0">
          {/* Planned */}
          <div className="space-y-1">
            <Label icon={CalendarCheck2}>Planned</Label>
            {planLine ? (
              <p className={cn("break-words", day.planned ? "text-slate-800" : "text-amber-700")} dir="auto">
                {planLine}
                {plannedAreas.length > 0 ? ` · ${plannedAreas.join(" · ")}` : ""}
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
              <p className="flex items-start gap-1.5 break-words text-slate-800" dir="auto">
                <Users className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                Ride-along planned with {day.rideAlongsPlanned.join(", ")}
              </p>
            ) : null}
            {day.activitiesLogged.length > 0 ? (
              <p className="break-words text-slate-800">Logged: {day.activitiesLogged.join(" · ")}</p>
            ) : null}
          </div>

          {/* Visited, the Day Start, the night */}
          <div className="space-y-1">
            <Label icon={MapPin}>
              Visited · {formatNumberValue(day.visits.length)}
            </Label>
            {day.visits.length === 0 ? <p className="text-slate-500">No visit saved</p> : null}
            <ul className="space-y-0.5">
              {day.visits.map((visit, visitIndex) => (
                <li className="break-words text-slate-800" key={`${visit.savedAt}-${visitIndex}`}>
                  <span className="tabular-nums text-slate-500">{visit.savedAt ? formatPhoenixTime(visit.savedAt) : "—"}</span>{" "}
                  <bdi dir="auto">{visit.customer ?? visit.place ?? "Visit"}</bdi>
                  {visit.place && visit.customer ? (
                    <>
                      {" · "}
                      <bdi dir="auto">{visit.place}</bdi>
                    </>
                  ) : null}
                  {visit.kmFromDestination !== null ? <span className="text-slate-500"> · {km(visit.kmFromDestination)} from destination</span> : null}
                  {visit.unplanned ? <Badge className="ml-1" size="sm" tone="warn">Unplanned</Badge> : null}
                  {visit.locationFlag ? <Badge className="ml-1" size="sm" tone="warn">Location: {visit.locationFlag.replace(/_/g, " ")}</Badge> : null}
                </li>
              ))}
            </ul>
            {day.dayStart ? (
              <p className="flex items-start gap-1.5 text-slate-700">
                <Sunrise className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                Day Start {formatPhoenixTime(day.dayStart.at)}
                {day.dayStart.kmFromDestination !== null ? ` · ${km(day.dayStart.kmFromDestination)} from destination` : ""}
              </p>
            ) : null}
            {day.night ? (
              <p
                className={cn(
                  "flex items-start gap-1.5",
                  day.night.verdict === "home" ? "font-bold text-amber-700" : day.night.verdict === "stayed" ? "text-emerald-700" : "text-slate-600",
                )}
                data-crm-night={day.night.verdict}
              >
                <Moon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {day.night.verdict === "stayed"
                  ? "Night: the next morning started at the destination"
                  : day.night.verdict === "home"
                    ? "Night: the next morning started back home"
                    : "Night: no position the next morning"}
                {day.night.nextMorningAt ? ` · ${formatPhoenixTime(day.night.nextMorningAt)}` : ""}
              </p>
            ) : null}
            {day.sharedCar.length > 0 ? (
              <p className="flex items-start gap-1.5 break-words font-bold text-amber-700" data-crm-shared-car>
                <Car className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                A car also claimed by {day.sharedCar.map((entry) => `${entry.name} (request ${entry.requestId})`).join(", ")}
              </p>
            ) : null}
          </div>
        </div>
      )}
    </li>
  );
}

function Label({ children, icon: Icon }: { children: ReactNode; icon: typeof MapPin }) {
  return (
    <p className="flex items-center gap-1.5 text-phx-sm font-black uppercase tracking-[0.12em] text-slate-400">
      <Icon className="h-3.5 w-3.5" />
      {children}
    </p>
  );
}

function TripFact({ label, tone, value }: { label: string; tone?: "danger" | "warn"; value: string }) {
  return (
    <div>
      <p className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-400">{label}</p>
      <p className={cn("mt-0.5 break-words text-sm font-bold", tone ? TONE_TEXT[tone] : "text-slate-900")}>{value}</p>
    </div>
  );
}

function Note({ children, tone }: { children: ReactNode; tone?: "warn" }) {
  return (
    <p className={cn("flex items-start gap-2 text-xs leading-relaxed", tone === "warn" ? "text-amber-700" : "text-slate-500")}>
      <HelpCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
