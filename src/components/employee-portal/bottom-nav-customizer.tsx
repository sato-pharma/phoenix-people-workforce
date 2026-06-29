"use client";

import Link from "next/link";
import { Pin, PinOff, RotateCcw, Smartphone } from "lucide-react";

import { Card } from "@/components/ui/card";
import type { EmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";
import {
  HOME_ENTRY,
  MAX_BOTTOM_NAV_CUSTOM,
  PROFILE_ENTRY,
  visiblePortalNavEntries,
} from "./employee-portal-nav-registry";
import { useBottomNavPreference } from "./use-bottom-nav-preference";

export function BottomNavCustomizer({ visibility }: { visibility: EmployeePortalNavVisibility }) {
  const entries = visiblePortalNavEntries(visibility);
  const [selected, setSelected] = useBottomNavPreference();

  const validHrefs = new Set(entries.map((entry) => entry.href));
  const pinnedHrefs = selected.filter((href) => validHrefs.has(href));
  const pinnedSet = new Set(pinnedHrefs);
  const atMax = pinnedSet.size >= MAX_BOTTOM_NAV_CUSTOM;

  function toggle(href: string) {
    if (pinnedSet.has(href)) {
      setSelected(pinnedHrefs.filter((value) => value !== href));
      return;
    }
    if (pinnedSet.size >= MAX_BOTTOM_NAV_CUSTOM) return;
    setSelected([...pinnedHrefs, href]);
  }

  return (
    <Card className="rounded border border-gray-200 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-6 lg:col-span-2">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="inline-flex rounded border border-orange-200 bg-orange-50 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-orange-600">
          Quick Navigation
        </span>
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-400">
          <Smartphone className="h-3.5 w-3.5" />
          Pin shortcuts to your mobile bottom bar
        </span>
      </div>
      <p className="mb-4 text-xs text-slate-500">
        All your destinations are below. Pin up to {MAX_BOTTOM_NAV_CUSTOM} to the phone bottom bar
        ({pinnedSet.size}/{MAX_BOTTOM_NAV_CUSTOM} pinned). <span className="font-semibold">Home</span> and{" "}
        <span className="font-semibold">Profile</span> always stay there. Tap a tile to open it.
      </p>

      {/* Fixed anchors */}
      <div className="mb-3 flex flex-wrap gap-2">
        {[HOME_ENTRY, PROFILE_ENTRY].map((entry) => {
          const Icon = entry.icon;
          return (
            <span
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-bold text-slate-500"
              key={entry.href}
            >
              <Icon className="h-3.5 w-3.5" />
              {entry.fullLabel}
              <span className="text-[9px] font-black uppercase tracking-wide text-slate-400">Always</span>
            </span>
          );
        })}
        {pinnedSet.size > 0 ? (
          <button
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-bold text-slate-500 transition-colors hover:border-orange-300 hover:text-orange-600"
            onClick={() => setSelected([])}
            type="button"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset to defaults
          </button>
        ) : null}
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map((entry) => {
          const Icon = entry.icon;
          const isPinned = pinnedSet.has(entry.href);
          const disabled = !isPinned && atMax;
          return (
            <div
              className={`relative flex items-center gap-3 rounded-lg border p-3 transition-colors ${
                isPinned ? "border-orange-300 bg-orange-50/50" : "border-slate-200 bg-white"
              }`}
              key={entry.href}
            >
              <Link className="flex min-w-0 flex-1 items-center gap-3" href={entry.href}>
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                    isPinned ? "bg-orange-100 text-orange-600" : "bg-slate-100 text-slate-500"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 whitespace-nowrap text-sm font-bold text-slate-800">{entry.fullLabel}</span>
              </Link>
              <button
                aria-label={isPinned ? `Unpin ${entry.fullLabel}` : `Pin ${entry.fullLabel}`}
                aria-pressed={isPinned}
                className={`shrink-0 rounded-md p-1.5 transition-colors ${
                  isPinned
                    ? "text-orange-600 hover:bg-orange-100"
                    : disabled
                      ? "cursor-not-allowed text-slate-300"
                      : "text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                }`}
                disabled={disabled}
                onClick={() => toggle(entry.href)}
                title={disabled ? `Unpin one first (max ${MAX_BOTTOM_NAV_CUSTOM})` : undefined}
                type="button"
              >
                {isPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
              </button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
