"use client";

import { AlertTriangle, CheckCircle2, Hourglass, Scale, ShieldCheck, XCircle } from "lucide-react";
import type { ReactNode } from "react";

import { AdminStatCard } from "@/components/admin/admin-design-system";
import { formatNumberValue } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";

import { type ReviewStats, type TripTab, countOutOf } from "./review-model";
import { egp } from "./review-parts";

/**
 * The six tiles — Awaiting, Needs a look, Clean, Approved, Adjusted, Rejected — in the Phoenix CRM
 * stat identity (`AdminStatCard size="compact"`). They count the LIVE decisions over the trips the
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
    key: "pending" | "look" | "clean" | "approved" | "adjusted" | "rejected";
    label: string;
    tab: TripTab;
    tone: "blue" | "emerald" | "orange" | "rose" | "violet";
  }> = [
    {
      description: stats.pendingValue > 0 ? `${egp(stats.pendingValue)} waiting` : "Nothing waiting",
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
      icon: <CheckCircle2 aria-hidden className="h-4 w-4" />,
      key: "approved",
      label: "Approved",
      tab: "approved",
      tone: "blue",
    },
    {
      description: stats.adjusted > 0 ? `${egp(stats.adjustedDelta)} below the claims` : "Every amount as claimed",
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
    <div className="space-y-2" data-review-stats>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 2xl:grid-cols-6">
        {tiles.map((tile) => {
          const figure = outOf(tile.key);
          return (
            <button
              aria-label={`${tile.label}: ${figure.value}${figure.of !== null ? ` of ${figure.of}` : ""}. Open the ${tile.label} tab.`}
              className="block min-w-0 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500 [&>*]:h-full"
              data-stat={tile.key}
              key={tile.key}
              onClick={() => onOpenTab(tile.tab)}
              type="button"
            >
              <AdminStatCard
                description={tile.description}
                icon={tile.icon}
                label={tile.label}
                size="compact"
                tone={tile.tone}
                value={
                  loading ? (
                    <span aria-hidden className="block h-6 w-16 animate-pulse bg-slate-100" />
                  ) : (
                    <span className="inline-flex flex-wrap items-baseline gap-x-1.5 tabular-nums">
                      {formatNumberValue(figure.value)}
                      {figure.of !== null ? (
                        <span className="text-xs font-bold text-slate-400" data-stat-of>
                          of {formatNumberValue(figure.of)}
                        </span>
                      ) : null}
                    </span>
                  )
                }
              />
            </button>
          );
        })}
      </div>
      {narrowed ? (
        <p className={cn("text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500")} data-stat-filtered>
          Filtered · each figure is out of the whole queue
        </p>
      ) : null}
    </div>
  );
}
