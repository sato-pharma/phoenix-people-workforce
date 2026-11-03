"use client";

import { MapPin } from "lucide-react";
import { useCallback, useState } from "react";

import { JourneyRouteLine } from "@/components/outstation/journey-route-line";
import {
  JourneyStopCard,
  type JourneyStopCapture,
  type JourneyStopSaveResult,
} from "@/components/outstation/journey-stop-card";
import { stableCurrencyFormatter } from "@/lib/format/stable-currency";
import type { ChainedJourneyPricing } from "@/lib/outstation/chained-journey";
import type { JourneyStopRule } from "@/lib/outstation/journey-stop-rules";

/** The trip a test account's Submit checked and did not save — all a rehearsed stop needs. */
export type RehearsalTrip = {
  arrival: {
    capturedAt: string | null;
    distanceFromResidenceKm: number | null;
    latitude: number | null;
    longitude: number | null;
  };
  /** What a stop on this trip asks of the person the test account mirrors. */
  rule: JourneyStopRule;
  transportationType: string;
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

/**
 * A TEST ACCOUNT's journey-stop rehearsal (owner, 2026-11-03 — "submit a trip to Sohag, then a stop
 * from Sohag to Assiut, and from Assiut back home"). Its claim was checked and never saved, so the
 * real stop has no trip to join. This takes each stop with the same capture and the same rule, has the
 * server measure and price it exactly as a real stop (POST /api/outstation/rehearse-journey-stop), and
 * shows every drive of the journey home to home.
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
          // No photo and no ticket file is sent: nothing is stored, and the price needs only the
          // position and the ticket's amount.
          accuracyMeters: capture.accuracyMeters,
          arrival: trip.arrival,
          latitude: capture.latitude,
          locationLabel: capture.locationLabel,
          longitude: capture.longitude,
          stops: stopRecords,
          ticketAmount: capture.ticketAmount,
          ticketFileCount: capture.ticketFiles.length,
          transportationType: trip.transportationType,
          tripEndDate: trip.tripEndDate,
          tripStartDate: trip.tripStartDate,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.stop || !payload?.pricing) {
        throw new Error(payload?.message || "This place could not be checked. Check your connection and try again.");
      }
      const stop = payload.stop as RehearsedStop;
      const next = payload.pricing as ChainedJourneyPricing;
      setStopRecords((current) => [...current, payload.stop]);
      setStops((current) => [...current, stop]);
      setPricing(next);
      setStopsLeft(typeof payload.stopsLeft === "number" ? payload.stopsLeft : null);
      return {
        flagged: next.flags.length > 0,
        message: `${stop.governorate ?? "The next place"} checked, not saved.`,
      };
    },
    [stopRecords, trip],
  );

  const canAddMore = stopsLeft == null || stopsLeft > 0;

  return (
    <section aria-label="Rehearse the next place" className="mt-5 space-y-4 border-t border-slate-200 pt-5">
      <div>
        <p className="text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500">Rehearse the next places</p>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          On a real trip the person captures the next place at the top of this page when they move on to
          another governorate. Capture each place here to see how Phoenix measures and pays the journey.
          The way home from the last place is added by itself. Nothing is saved, and leaving this screen
          ends the rehearsal.
        </p>
      </div>

      {stops.length > 0 ? (
        <ol className="space-y-1.5 text-xs text-slate-600">
          {stops.map((stop) => (
            <li className="flex items-start gap-1.5 break-words" key={stop.stopNumber}>
              <MapPin aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-600" />
              <span>
                <span className="font-bold text-slate-900">{stop.governorate ?? "Next place"}</span>
                {stop.locationLabel ? ` · ${stop.locationLabel}` : ""}
              </span>
            </li>
          ))}
        </ol>
      ) : null}

      {pricing ? (
        <div className="border border-slate-200 bg-slate-50 p-4">
          <p className="text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500">
            {pricing.mode === "chained"
              ? "Paid drive by drive"
              : pricing.mode === "ticket_journey"
                ? "Paid by ticket"
                : "Paid as a single destination"}
          </p>
          <p className="mt-1 text-sm leading-6 text-slate-800">{pricing.modeReason}</p>
          {pricing.legs.length > 0 ? (
            <div className="mt-3">
              <JourneyRouteLine legs={pricing.legs} />
            </div>
          ) : null}
          {pricing.mode === "ticket_journey" ? null : (
            <dl className="mt-3 space-y-1 text-sm">
              <div className="flex flex-wrap justify-between gap-x-3">
                <dt className="text-slate-600">Fuel for this journey</dt>
                <dd className="font-black text-slate-900">{egp(pricing.fuelAmount)}</dd>
              </div>
              <div className="flex flex-wrap justify-between gap-x-3">
                <dt className="text-slate-600">Without the extra places (home to the first place and back)</dt>
                <dd className="font-semibold text-slate-700">{egp(pricing.singleDestinationFuelAmount)}</dd>
              </div>
            </dl>
          )}
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
          rehearsal={{ save }}
          requestId={null}
          rule={trip.rule}
        />
      ) : (
        <p className="text-sm text-slate-600">This trip has reached the most places one trip may carry.</p>
      )}
    </section>
  );
}
