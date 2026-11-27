"use client";

import { MapPin } from "lucide-react";

import { cn } from "@/lib/utils";
import { directionsLinkLabel, directionsNote } from "@/lib/sales/territory/drilldown-words";
import type { TerritoryPharmacy } from "@/lib/sales/territory/types";

/**
 * A drilldown pharmacy's name: a Google Maps directions link when Phoenix has a location it trusts
 * (pharmacy-directions.ts), plain text when it has none — never a guess. Flat and square, 11px floor.
 */
export function PharmacyNameLink({ pharmacy, className }: { pharmacy: TerritoryPharmacy; className?: string }) {
  if (!pharmacy.directions) return <span className={className}>{pharmacy.clientName}</span>;
  return (
    <a
      aria-label={directionsLinkLabel(pharmacy.clientName)}
      className={cn(
        "inline-flex items-start gap-1 text-orange-700 underline decoration-orange-300 underline-offset-2 hover:text-orange-800 hover:decoration-orange-600",
        className,
      )}
      href={pharmacy.directions.url}
      rel="noopener noreferrer"
      target="_blank"
    >
      <MapPin aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words">{pharmacy.clientName}</span>
    </a>
  );
}

/** The line under the name that says where the link goes, or that there is no location yet. */
export function PharmacyDirectionsNote({ pharmacy, className }: { pharmacy: TerritoryPharmacy; className?: string }) {
  return (
    <p
      className={cn(
        "break-words text-phx-xs font-semibold leading-snug",
        pharmacy.directions ? "text-slate-600" : "text-slate-500",
        className,
      )}
    >
      {directionsNote(pharmacy.directions)}
    </p>
  );
}
