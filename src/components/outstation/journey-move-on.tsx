"use client";

import { ChevronDown, MapPin } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { JourneyStopCard } from "@/components/outstation/journey-stop-card";
import { CheckTile } from "@/components/ui/form-kit";
import { phxButtonGhostClassName } from "@/components/ui/form-tokens";
import { formatPhoenixLongDate } from "@/lib/i18n/format";
import { tidyOutstationAddress } from "@/lib/outstation/description-format";
import type { JourneyStopRule } from "@/lib/outstation/journey-stop-rules";
import { cn } from "@/lib/utils";

/** A trip that can still take its next place. */
export type MoveOnTrip = {
  acceptedClaim: boolean;
  destination: string;
  id: number;
  rule: JourneyStopRule;
  tripEndDate: string;
  tripStartDate: string;
};

/**
 * The way in for someone who moved on to another governorate (owner, 2026-11-03: "look it's built very
 * stupid and non clear and non logical"). It was a card hidden inside an expanded claim, under My
 * claims, under the form, on the road. It is one line at the top of the page now, shown only while a
 * trip can still take a place, and most days not shown at all.
 */
export function JourneyMoveOn({ employeeHrId, trips }: { employeeHrId: string; trips: MoveOnTrip[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [chosenId, setChosenId] = useState<number | null>(null);
  if (trips.length === 0) return null;
  const trip = trips.length === 1 ? trips[0] : (trips.find((entry) => entry.id === chosenId) ?? null);

  return (
    <section aria-label="Moved on to another governorate" className="border border-slate-200 bg-white">
      <button
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50 sm:px-5"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="flex min-w-0 items-start gap-2 text-sm font-black text-slate-900">
          <MapPin aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-orange-600" />
          Moved on to another governorate? Capture the next place
        </span>
        <ChevronDown
          aria-hidden
          className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <div className="space-y-3 border-t border-slate-200 p-4 sm:p-5">
          {trips.length > 1 ? (
            <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Which trip are you on">
              {trips.map((entry) => (
                <CheckTile
                  checked={entry.id === chosenId}
                  key={entry.id}
                  name="journey-move-on-trip"
                  onChange={() => setChosenId(entry.id)}
                  type="radio"
                >
                  {tidyOutstationAddress(entry.destination) ?? entry.destination} ·{" "}
                  {formatPhoenixLongDate(entry.tripStartDate)}
                </CheckTile>
              ))}
            </div>
          ) : null}
          {trip ? (
            <JourneyStopCard
              acceptedClaim={trip.acceptedClaim}
              employeeHrId={employeeHrId}
              key={trip.id}
              onSaved={() => router.refresh()}
              requestId={trip.id}
              rule={trip.rule}
            />
          ) : null}
          <button className={cn(phxButtonGhostClassName, "min-h-10")} onClick={() => setOpen(false)} type="button">
            Close
          </button>
        </div>
      ) : null}
    </section>
  );
}
