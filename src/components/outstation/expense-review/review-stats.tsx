"use client";

import { AlertTriangle, CheckCircle2, Hourglass, Scale, ShieldCheck, XCircle } from "lucide-react";
import type { ReactNode } from "react";

import { formatNumberValue } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";

import { type ReviewStats, type TripTab, countOutOf } from "./review-model";
import { egp } from "./review-parts";

/**
 * The six figures — Awaiting, Needs a look, Clean, Approved, Adjusted, Rejected — as ONE slim strip
 * over the tabs. They count the LIVE decisions over the trips the
 * filters leave, so a trip approved a moment ago is already counted. Narrowed by a filter or a search,
 * EVERY tile says what it is out of — "95 of 129" — the adjusted one included (it alone had no "of"
 * on the retired page). Each tile opens its tab.
 */
export function ReviewStatTiles({
  loading,
  narrowed,
  onOpenTab,
  overall,
  stats,
}: {
  loading: boolean;
  narrowed: boolean;
  onOpenTab: (tab: TripTab) => void;
  overall: ReviewStats;
  stats: ReviewStats;
}) {
  const outOf = (key: keyof ReviewStats) => countOutOf(stats[key], narrowed ? overall[key] : null);
  const tiles: Array<{
    description: string;
    icon: ReactNode;
    /** The money beside the count, when the tile has one — "EGP 50,264". */
    money?: string;
    key: "pending" | "look" | "clean" | "approved" | "adjusted" | "rejected";
    label: string;
    tab: TripTab;
    tone: "blue" | "emerald" | "orange" | "rose" | "violet";
  }> = [
    {
      description: stats.pendingValue > 0 ? `${egp(stats.pendingValue)} waiting` : "Nothing waiting",
      money: stats.pendingValue > 0 ? egp(stats.pendingValue) : undefined,
      icon: <Hourglass aria-hidden className="h-4 w-4" />,
      key: "pending",
      label: "Awaiting",
      tab: "awaiting",
      tone: "orange",
    },
    {
      description: "Idle days, unverified visits or a departure photo to check",
      icon: <AlertTriangle aria-hidden className="h-4 w-4" />,
      key: "look",
      label: "Needs a look",
      tab: "look",
      tone: "rose",
    },
    {
      description: "Nothing found — can be approved together",
      icon: <ShieldCheck aria-hidden className="h-4 w-4" />,
      key: "clean",
      label: "Clean",
      tab: "clean",
      tone: "emerald",
    },
    {
      description: stats.approvedValue > 0 ? `${egp(stats.approvedValue)} to pay` : "None approved",
      money: stats.approvedValue > 0 ? `${egp(stats.approvedValue)} to pay` : undefined,
      icon: <CheckCircle2 aria-hidden className="h-4 w-4" />,
      key: "approved",
      label: "Approved",
      tab: "approved",
      tone: "blue",
    },
    {
      description: stats.adjusted > 0 ? `${egp(stats.adjustedDelta)} below the claims` : "Every amount as claimed",
      money: stats.adjusted > 0 ? `${egp(stats.adjustedDelta)} below` : undefined,
      icon: <Scale aria-hidden className="h-4 w-4" />,
      key: "adjusted",
      label: "Adjusted",
      tab: "adjusted",
      tone: "violet",
    },
    {
      description: "Undo puts one back in waiting",
      icon: <XCircle aria-hidden className="h-4 w-4" />,
      key: "rejected",
      label: "Rejected",
      tab: "rejected",
      tone: "rose",
    },
  ];

  return (
    <div className="min-w-0" data-review-stats>
      {/* One band, six cells: a label, the figure, its "of N" and its money on one line. Six tall
          cards spent ~120px restating the tabs' own counts (owner, 2026-11-07: "the screen is
          consumed in irrelevant place"). */}
      <div className="grid min-w-0 grid-cols-2 border border-slate-200 bg-white sm:grid-cols-3 xl:grid-cols-6" data-stat-strip>
        {tiles.map((tile) => {
          const figure = outOf(tile.key);
          return (
            <button
              aria-label={`${tile.label}: ${figure.value}${figure.of !== null ? ` of ${figure.of}` : ""}. Open the ${tile.label} tab.`}
              className={cn(
                "min-w-0 border-b border-r border-slate-100 border-t-[3px] px-3 py-2 text-left transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-orange-500",
                TONE_RULE[tile.tone],
              )}
              data-stat={tile.key}
              key={tile.key}
              onClick={() => onOpenTab(tile.tab)}
              title={tile.description}
              type="button"
            >
              <span className="flex min-w-0 items-center gap-1.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
                <span className={cn("shrink-0", TONE_ICON[tile.tone])}>{tile.icon}</span>
                {tile.label}
              </span>
              {loading ? (
                <span aria-hidden className="mt-1 block h-5 w-14 animate-pulse bg-slate-100" />
              ) : (
                <span className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-1.5 tabular-nums">
                  <span className="text-lg font-black leading-tight text-slate-950">{formatNumberValue(figure.value)}</span>
                  {figure.of !== null ? (
                    <span className="text-xs font-bold text-slate-400" data-stat-of>
                      of {formatNumberValue(figure.of)}
                    </span>
                  ) : null}
                  {tile.money ? <span className="min-w-0 break-words text-xs font-semibold text-slate-500">{tile.money}</span> : null}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {narrowed ? (
        <p className="mt-1 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500" data-stat-filtered>
          Filtered · each figure is out of the whole queue
        </p>
      ) : null}
    </div>
  );
}

/** The cell's top rule, in its tile's tone — the colour the six tall cards carried, in 3px. */
const TONE_RULE: Record<"blue" | "emerald" | "orange" | "rose" | "violet", string> = {
  blue: "border-t-sky-500",
  emerald: "border-t-emerald-500",
  orange: "border-t-orange-500",
  rose: "border-t-rose-500",
  violet: "border-t-violet-500",
};

const TONE_ICON: Record<"blue" | "emerald" | "orange" | "rose" | "violet", string> = {
  blue: "text-sky-600",
  emerald: "text-emerald-600",
  orange: "text-orange-600",
  rose: "text-rose-600",
  violet: "text-violet-600",
};
