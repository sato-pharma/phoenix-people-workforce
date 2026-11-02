"use client";

import { MapPin } from "lucide-react";
import { useCallback, useState } from "react";

import {
  JourneyStopCard,
  type JourneyStopCapture,
  type JourneyStopSaveResult,
} from "@/components/outstation/journey-stop-card";
import { stableCurrencyFormatter } from "@/lib/format/stable-currency";
import type { ChainedJourneyPricing } from "@/lib/outstation/chained-journey";

/** The trip a test account's Submit checked and did not save — all a rehearsed stop needs. */
export type RehearsalTrip = {
  arrival: {
    capturedAt: string | null;
    distanceFromResidenceKm: number | null;
    latitude: number | null;
    longitude: number | null;
  };
  tripEndDate: string;
  tripStartDate: string;
};

type RehearsedStop = { governorate: string | null; locationLabel: string | null; stopNumber: number };

function egp(value: number) {
  return stableCurrencyFormatter("en-US", {
    currency: "EGP",
    maximumFractionDigits: 2,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

function km(value: number | null) {
  return value == null ? "distance unknown" : `${value.toLocaleString("en-US", { maximumFractionDigits: 1 })} km`;
}

/**
 * A TEST ACCOUNT's journey-stop rehearsal (owner, 2026-11-03 — "submit a trip to Sohag, then a stop
 * from Sohag to Assiut, and from Assiut back home"). Its claim was checked and never saved, so the
 * real Add stop under My claims has no trip to join. This takes each stop with the same live camera
 * and GPS, has the server measure and price it exactly as a real stop
 * (POST /api/outstation/rehearse-journey-stop), and shows every drive of the journey home to home.
 *
 * The stops are held only on this screen: the server keeps nothing, so the page sends the earlier
 * ones back with each new stop. Leaving the screen ends the rehearsal.
 */
export function JourneyStopRehearsal({ employeeHrId, trip }: { employeeHrId: string; trip: RehearsalTrip }) {
  // The server's own stop records, sent back verbatim with the next stop.
  const [stopRecords, setStopRecords] = useState<unknown[]>([]);
  const [stops, setStops] = useState<RehearsedStop[]>([]);
  const [pricing, setPricing] = useState<ChainedJourneyPricing | null>(null);
  const [stopsLeft, setStopsLeft] = useState<number | null>(null);

  const save = useCallback(
    async (capture: JourneyStopCapture): Promise<JourneyStopSaveResult> => {
      const response = await fetch("/api/outstation/rehearse-journey-stop", {
        body: JSON.stringify({
          // The photo itself is not sent: nothing is stored, and the price needs only the position.
          accuracyMeters: capture.accuracyMeters,
          arrival: trip.arrival,
          latitude: capture.latitude,
          locationLabel: capture.locationLabel,
          longitude: capture.longitude,
          stops: stopRecords,
          tripEndDate: trip.tripEndDate,
          tripStartDate: trip.tripStartDate,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.stop || !payload?.pricing) {
        throw new Error(payload?.message || `The stop could not be rehearsed (${response.status}).`);
      }
      const stop = payload.stop as RehearsedStop;
      const next = payload.pricing as ChainedJourneyPricing;
      setStopRecords((current) => [...current, payload.stop]);
      setStops((current) => [...current, stop]);
      setPricing(next);
      setStopsLeft(typeof payload.stopsLeft === "number" ? payload.stopsLeft : null);
      const place = stop.governorate ? ` in ${stop.governorate}` : "";
      return {
        flagged: next.flags.length > 0,
        message: `Stop ${stop.stopNumber}${place} checked, not saved. ${next.modeReason}`.trim(),
      };
    },
    [stopRecords, trip],
  );

  const nextStopNumber = Math.max(1, ...stops.map((stop) => stop.stopNumber)) + 1;
  const canAddMore = stopsLeft == null || stopsLeft > 0;

  return (
    <section aria-label="Rehearse a stop" className="mt-5 space-y-4 border-t border-slate-200 pt-5">
      <div>
        <p className="text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500">Rehearse the stops</p>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          On a real car trip the employee adds a stop under My claims when they drive on to another
          governorate. Take each stop photo here to see how Phoenix measures and pays the journey. The
          drive home from the last stop is added by itself. Nothing is saved, and leaving this screen
          ends the rehearsal.
        </p>
      </div>

      {stops.length > 0 ? (
        <ol className="space-y-1.5 text-xs text-slate-600">
          {stops.map((stop) => (
            <li className="flex items-start gap-1.5 break-words" key={stop.stopNumber}>
              <MapPin aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-700" />
              <span>
                <span className="font-bold text-slate-900">Stop {stop.stopNumber}</span>
                {stop.governorate ? ` · ${stop.governorate}` : ""}
                {stop.locationLabel ? ` · ${stop.locationLabel}` : ""}
              </span>
            </li>
          ))}
        </ol>
      ) : null}

      {pricing ? (
        <div className="border border-slate-200 bg-slate-50 p-4">
          <p className="text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500">
            {pricing.mode === "chained" ? "Paid drive by drive" : "Paid as a single destination"}
          </p>
          <p className="mt-1 text-sm leading-6 text-slate-800">{pricing.modeReason}</p>
          {pricing.legs.length > 0 ? (
            <ol className="mt-3 divide-y divide-slate-200 border-y border-slate-200">
              {pricing.legs.map((leg, index) => (
                <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2 text-sm" key={index}>
                  <span className="min-w-0 break-words text-slate-800">
                    {leg.from} → {leg.to}
                    <span className="block text-xs text-slate-500">
                      {km(leg.distanceKm)} · {leg.paid ? "paid one way" : "not paid on its own"}
                    </span>
                  </span>
                  <span className="font-black text-slate-900">{leg.paid ? egp(leg.fuelAmount) : "—"}</span>
                </li>
              ))}
            </ol>
          ) : null}
          <dl className="mt-3 space-y-1 text-sm">
            <div className="flex flex-wrap justify-between gap-x-3">
              <dt className="text-slate-600">Fuel for this journey</dt>
              <dd className="font-black text-slate-900">{egp(pricing.fuelAmount)}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-x-3">
              <dt className="text-slate-600">Without the stops (home to the first place and back)</dt>
              <dd className="font-semibold text-slate-700">{egp(pricing.singleDestinationFuelAmount)}</dd>
            </div>
          </dl>
          {pricing.flagReasons.length > 0 ? (
            <ul className="mt-3 space-y-1 border-t border-amber-200 pt-3 text-xs leading-5 text-amber-900">
              {pricing.flagReasons.map((reason) => (
                <li className="break-words" key={reason}>
                  {reason}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {canAddMore ? (
        <JourneyStopCard
          employeeHrId={employeeHrId}
          key={stops.length}
          nextStopNumber={nextStopNumber}
          rehearsal={{ save }}
          requestId={null}
        />
      ) : (
        <p className="text-sm text-slate-600">This trip has reached the most stops one trip may carry.</p>
      )}
    </section>
  );
}
