"use client";

// Recruitment workspace — the region tabs, and for Medical Rep the AU area tabs inside a region.
//
// The owner, 20 Oct 2026: Medical Rep splits by region, then by AU AREA NAME (every product line's
// team in that area together), with an "Unspecified" tab beside the regions for replies that name no
// area; District Manager splits by region only. Each place says its vacant AU seats beside its CVs —
// "Alex-BHR · 2 vacant seats · 5 CVs" — because a pile of CVs means something different when there
// is a seat waiting for one of them.
//
// The places and the seats come from the server (`loadWorkspacePlaces`), grouped exactly as the bot
// groups areas, so a tab here and a reply there can never disagree about where an area belongs.
//
// Each level is one segmented bar, drawn like the role strip above it: a recessed track, the chosen
// place lifted white with the orange rule under it, and the CV count a tabular badge.

import { MapPin } from "lucide-react";

import { adminChipDepthClassName, adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";
import { tabsWithAreas, type WorkspaceRoleTab } from "@/lib/recruitment/workspace/role-tabs";
import type { WorkspaceCounts, WorkspacePlaces } from "@/lib/recruitment/workspace/types";
import { cn } from "@/lib/utils";

export const UNSPECIFIED_REGION = "unspecified";

const NUMBER = new Intl.NumberFormat("en-US");

function seatsText(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? "1 vacant seat" : `${n} vacant seats`;
}

/** One region's CV count: its own total when the server sends one, else the sum of its areas. */
export function regionCount(byPlace: WorkspaceCounts["byPlace"] | undefined, region: string): number | null {
  if (!byPlace) return null;
  const own = byPlace.find((entry) => entry.region === region && entry.area === null);
  if (own) return own.n;
  const areas = byPlace.filter((entry) => entry.region === region);
  return areas.length ? areas.reduce((sum, entry) => sum + entry.n, 0) : 0;
}

export function areaCount(byPlace: WorkspaceCounts["byPlace"] | undefined, region: string, area: string): number | null {
  if (!byPlace) return null;
  return byPlace.find((entry) => entry.region === region && entry.area === area)?.n ?? 0;
}

function PlaceButton({
  count,
  label,
  onClick,
  seats,
  selected,
}: {
  count: number | null;
  label: string;
  onClick: () => void;
  seats: number;
  selected: boolean;
}) {
  const seatLine = seatsText(seats);
  return (
    <button
      aria-pressed={selected}
      className={cn(
        "relative inline-flex min-h-8 items-center gap-1.5 px-2.5 py-1 text-left text-xs font-bold transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 focus-visible:ring-offset-1",
        selected ? cn("bg-white text-slate-950", adminChipDepthClassName) : "text-slate-600 hover:bg-white/70 hover:text-slate-900",
      )}
      onClick={onClick}
      type="button"
    >
      <span className="break-words" dir="auto">
        {label}
      </span>
      {seatLine ? <span className="font-semibold text-emerald-700">{seatLine}</span> : null}
      {count !== null ? (
        <span
          className={cn(
            "border px-1.5 text-phx-xs font-black tabular-nums",
            selected ? "border-orange-200 bg-orange-50 text-orange-700" : "border-slate-200 bg-white/80 text-slate-500",
          )}
          title={`${NUMBER.format(count)} ${count === 1 ? "CV" : "CVs"}`}
        >
          {NUMBER.format(count)}
        </span>
      ) : null}
      {selected ? <span aria-hidden className="absolute inset-x-2 bottom-0 h-0.5 bg-orange-500" /> : null}
    </button>
  );
}

export function PlaceTabStrip({
  area,
  byPlace,
  loading = false,
  onChange,
  places,
  region,
  tab,
  tabCount,
}: {
  area: string | null;
  byPlace: WorkspaceCounts["byPlace"] | undefined;
  /** The tab's regions are on their way — said as loading, never as a failure. */
  loading?: boolean;
  onChange: (place: { region: string | null; area: string | null }) => void;
  places: WorkspacePlaces | null;
  region: string | null;
  tab: WorkspaceRoleTab;
  /** The whole tab's count, for "All regions". */
  tabCount: number | null;
}) {
  if (!places && loading) {
    return <p className="text-xs font-semibold text-slate-500">Loading the regions…</p>;
  }
  if (!places) {
    return <p className="text-xs font-semibold text-slate-500">The regions could not be loaded; the list shows every region.</p>;
  }
  const withAreas = tabsWithAreas.includes(tab);
  const chosenRegion = region ? places.regions.find((entry) => entry.code === region) ?? null : null;
  const totalSeats = places.regions.reduce((sum, entry) => sum + entry.vacantSeats, 0);

  return (
    <div className="space-y-1.5">
      <div aria-label="Regions" className={cn("flex flex-wrap items-center gap-1 border border-slate-200 bg-slate-100/80 p-1", adminRecessedDepthClassName)} role="group">
        <span className="inline-flex items-center gap-1 px-1.5 text-phx-xs font-black uppercase tracking-wide text-slate-500">
          <MapPin aria-hidden className="h-3.5 w-3.5 text-orange-600" />
          Region
        </span>
        <PlaceButton
          count={tabCount}
          label="All regions"
          onClick={() => onChange({ area: null, region: null })}
          seats={totalSeats}
          selected={!region}
        />
        {places.regions.map((entry) => (
          <PlaceButton
            count={regionCount(byPlace, entry.code)}
            key={entry.code}
            label={entry.name}
            onClick={() => onChange({ area: null, region: entry.code })}
            seats={entry.vacantSeats}
            selected={region === entry.code}
          />
        ))}
        <PlaceButton
          count={regionCount(byPlace, UNSPECIFIED_REGION)}
          label="Unspecified"
          onClick={() => onChange({ area: null, region: UNSPECIFIED_REGION })}
          seats={0}
          selected={region === UNSPECIFIED_REGION}
        />
      </div>
      {withAreas && chosenRegion && chosenRegion.areas.length > 0 ? (
        <div
          aria-label={`Areas in ${chosenRegion.name}`}
          className={cn("flex flex-wrap items-center gap-1 border border-l-2 border-slate-200 border-l-orange-300 bg-slate-100/80 p-1", adminRecessedDepthClassName)}
          role="group"
        >
          <span className="px-1.5 text-phx-xs font-black uppercase tracking-wide text-slate-500">Area</span>
          <PlaceButton
            count={regionCount(byPlace, chosenRegion.code)}
            label={`All of ${chosenRegion.name}`}
            onClick={() => onChange({ area: null, region: chosenRegion.code })}
            seats={chosenRegion.vacantSeats}
            selected={!area}
          />
          {chosenRegion.areas.map((entry) => (
            <PlaceButton
              count={areaCount(byPlace, chosenRegion.code, entry.code)}
              key={entry.code}
              label={entry.name}
              onClick={() => onChange({ area: entry.code, region: chosenRegion.code })}
              seats={entry.vacantSeats}
              selected={area === entry.code}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
