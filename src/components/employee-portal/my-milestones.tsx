"use client";

import { useState } from "react";
import { Award, Cake, Download, Loader2, Sparkles } from "lucide-react";

import { PortalEmptyState } from "@/components/employee-portal/portal-primitives";
import {
  SURFACE_CLASS,
  SectionCard,
  TABLE_HEAD_CLASS,
  TABLE_ROW_CLASS,
} from "@/components/sales/target-visuals";
import type { MyMilestoneEntry } from "@/lib/milestones/service";

type Props = { entries: MyMilestoneEntry[] };

/** A stable key per occasion — one person cannot have two of the same spec on the same date. */
const rowKey = (entry: MyMilestoneEntry) => `${entry.spec}-${entry.on}`;

/** "Today" · "In 12 days" · "Reached" — short enough never to force a sideways scroll. */
function whenLabel(daysAway: number): string {
  if (daysAway === 0) return "Today";
  if (daysAway > 0) return `In ${daysAway} ${daysAway === 1 ? "day" : "days"}`;
  return "Reached";
}

/** A square, no-rounded-corner action button in the portal's ink. */
const DOWNLOAD_BTN =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap border border-slate-900 " +
  "bg-slate-900 px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-slate-700 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

/**
 * My Milestones — the rep's own keepsake cards, self-scoped (owner, 2026-09-30).
 *
 * Each occasion downloads only the caller's own card through /api/milestones/my-card; nothing here
 * names anyone else. Speaks the sales pages' visual language (target-visuals.tsx): the same section
 * card, table head and rows — desktop table, phone cards, square corners, no sideways scroll.
 */
export function MyMilestones({ entries }: Props) {
  // The href currently downloading, so only its own button spins.
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function download(entry: MyMilestoneEntry) {
    setBusyKey(rowKey(entry));
    setError(null);
    try {
      const response = await fetch("/api/milestones/my-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period: entry.spec, on: entry.on }),
      });
      if (!response.ok) {
        const message = await response
          .json()
          .then((body: { error?: string }) => body?.error)
          .catch(() => null);
        throw new Error(message || "The card could not be produced. Please try again.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${entry.label.replace(/[^\p{L}\p{N}]+/gu, "-")}.pdf`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The card could not be produced.");
    } finally {
      setBusyKey(null);
    }
  }

  if (entries.length === 0) {
    return (
      <div className={SURFACE_CLASS}>
        <PortalEmptyState
          title="No milestones to show yet."
          message="Your first anniversary and birthday cards appear here once your hire date is on record."
        />
      </div>
    );
  }

  const upcoming = entries.filter((entry) => entry.daysAway >= 0).length;
  const OccasionIcon = (kind: MyMilestoneEntry["kind"]) => (kind === "birthday" ? Cake : Sparkles);

  return (
    <div className="space-y-3">
      {error ? (
        <p className="border border-red-300 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p>
      ) : null}

      <SectionCard
        surface="portal"
        icon={Award}
        title="Keepsake cards"
        subtitle={`${entries.length} milestone${entries.length === 1 ? "" : "s"}${upcoming > 0 ? ` · ${upcoming} coming up` : ""}`}
      >
        {/* Tablet and desktop: table-fixed + colgroup, so it always fits — never a sideways scroll. */}
        <div className="hidden md:block">
          <table className="w-full table-fixed text-left text-sm">
            <colgroup>
              <col style={{ width: "40%" }} />
              <col style={{ width: "26%" }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: "18%" }} />
            </colgroup>
            <thead>
              <tr className={TABLE_HEAD_CLASS}>
                <th className="px-3 py-2.5">Occasion</th>
                <th className="px-3 py-2.5">Date</th>
                <th className="px-3 py-2.5">When</th>
                <th className="px-3 py-2.5 text-right">Card</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const Icon = OccasionIcon(entry.kind);
                const busy = busyKey === rowKey(entry);
                return (
                  <tr key={rowKey(entry)} className={`${TABLE_ROW_CLASS} align-middle`}>
                    <td className="px-3 py-2.5">
                      <span className="flex items-center gap-2 font-bold text-slate-900">
                        <Icon aria-hidden className="size-4 shrink-0 text-orange-500" />
                        <span className="break-words">{entry.label}</span>
                      </span>
                    </td>
                    <td className="break-words px-3 py-2.5 text-slate-700">{entry.onLong}</td>
                    <td className="px-3 py-2.5 text-slate-600">{whenLabel(entry.daysAway)}</td>
                    <td className="px-3 py-2.5 text-right">
                      <button
                        type="button"
                        className={DOWNLOAD_BTN}
                        disabled={busy}
                        onClick={() => download(entry)}
                      >
                        {busy ? (
                          <Loader2 aria-hidden className="size-3.5 animate-spin" />
                        ) : (
                          <Download aria-hidden className="size-3.5" />
                        )}
                        {busy ? "Preparing" : "Download"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Phone: cards, never a table (owner's rule). */}
        <div className="space-y-2 md:hidden">
          {entries.map((entry) => {
            const Icon = OccasionIcon(entry.kind);
            const busy = busyKey === rowKey(entry);
            return (
              <article key={rowKey(entry)} className="border border-slate-200 bg-white p-3">
                <p className="flex items-center gap-2 text-sm font-black text-slate-900">
                  <Icon aria-hidden className="size-4 shrink-0 text-orange-500" />
                  <span className="break-words">{entry.label}</span>
                </p>
                <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-t border-slate-100 pt-2 text-xs">
                  <span className="break-words text-slate-700">{entry.onLong}</span>
                  <span className="text-slate-500">{whenLabel(entry.daysAway)}</span>
                </div>
                <button
                  type="button"
                  className={`${DOWNLOAD_BTN} mt-3 w-full`}
                  disabled={busy}
                  onClick={() => download(entry)}
                >
                  {busy ? (
                    <Loader2 aria-hidden className="size-3.5 animate-spin" />
                  ) : (
                    <Download aria-hidden className="size-3.5" />
                  )}
                  {busy ? "Preparing your card" : "Download card"}
                </button>
              </article>
            );
          })}
        </div>
      </SectionCard>
    </div>
  );
}
