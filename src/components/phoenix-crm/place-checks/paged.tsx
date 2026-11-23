"use client";

/**
 * Phoenix CRM — Place checks: a list drawn a page at a time, and what the board says while it reads the
 * rows the page did not send.
 */

import { useState, type ReactNode } from "react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { CrmButton } from "@/components/phoenix-crm/ui";

/** Every list on the board shows this many rows, then "Show more" — no tab draws its whole set at once. */
export const PAGE_ROWS = 20;
/** A building is a tall card with its customers under it, so the polyclinics page by fewer. */
export const PAGE_BUILDINGS = 10;
/**
 * The two lanes page by ten (the rebuild, 23 Nov 2026): a waiting row is its photograph and its evidence,
 * and twenty of them were a phone page 51,062 px long.
 */
export const PAGE_LANE = 10;

/**
 * A list shown a page at a time. Keyed by the filters at the call site, so a filter change starts it over
 * rather than keeping a page offset from the wider set. `initial` opens it further than its first page
 * (the address remembered how far he had read) and `onLimit` says how far it is open now.
 */
export function Paged<Row>({
  children,
  initial,
  noun,
  onLimit,
  rows,
  size,
}: {
  children: (shown: Row[]) => ReactNode;
  initial?: number | null;
  noun: string;
  onLimit?: (limit: number) => void;
  rows: Row[];
  size: number;
}) {
  const [limit, setLimit] = useState(() => Math.max(size, initial ?? size));
  const shown = rows.length > limit ? rows.slice(0, limit) : rows;
  const left = rows.length - shown.length;
  const more = () => {
    const next = limit + size;
    setLimit(next);
    onLimit?.(next);
  };
  return (
    <>
      {children(shown)}
      {left > 0 ? (
        <div className="flex min-w-0 flex-wrap items-center gap-3 border-t border-slate-200 px-4 py-3">
          <CrmButton onClick={more} size="sm">
            Show {Math.min(size, left)} more {noun}
          </CrmButton>
          <span className="break-words text-xs font-semibold text-slate-500">
            {shown.length} of {rows.length} shown
          </span>
        </div>
      ) : null}
    </>
  );
}

/**
 * What the board says while the click's read is on its way — every place in use and the older decisions —
 * and, when it fails, why, with the one button that asks again.
 */
export function ReadingEverything({ error, onRetry, stale = false }: { error: string | null; onRetry: () => void; stale?: boolean }) {
  return (
    <AdminCallout tone={error ? "warning" : "neutral"}>
      <span className="flex min-w-0 flex-wrap items-center gap-3">
        <span className="min-w-0 flex-1 basis-60 break-words">
          {stale
            ? `Reading every place again did not work${error ? `: ${error.trim().replace(/([^.!?])$/, "$1.")}` : "."} The lists and counts below are from the reading before it.`
            : (error ?? "Reading every place in use and every older decision, so each list and count here is complete.")}
        </span>
        {error ? (
          <CrmButton onClick={onRetry} size="sm">
            Try again
          </CrmButton>
        ) : null}
      </span>
    </AdminCallout>
  );
}
