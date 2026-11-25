"use client";

/**
 * Phoenix CRM — every photo of a polyclinic's timetable, beside the first (owner, 25 Nov 2026: "every
 * photo appear").
 *
 * The screens already draw the first photo (`schedulePhotoPath`, or a seated customer's `photoPath`).
 * `TimetablePages` sits under it and draws pages 2 to 5, which it asks for in one batch per screen from
 * /api/phoenix-crm/photos/timetable-pages — the photos/sign door's own pattern: queued for a moment,
 * sent together, remembered for the page's life. A board photographed in one photo draws nothing.
 */

import { useEffect, useSyncExternalStore } from "react";

import { crmPost } from "@/components/phoenix-crm/api";
import { CrmPhotoThumb } from "@/components/phoenix-crm/photo";
import { cn } from "@/lib/utils";

const BATCH_MAX = 200;
const BATCH_WAIT_MS = 30;
/** A board gains pages only when it is photographed, so one answer serves the page for a few minutes. */
const REUSE_MS = 5 * 60 * 1000;

const NONE: string[] = [];
const known = new Map<string, { pages: string[]; at: number; inFlight: boolean }>();
const listeners = new Set<() => void>();
const queued = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function askBatch(paths: string[]) {
  let pages: Record<string, string[]> = {};
  try {
    pages = await crmPost<Record<string, string[]>>("/api/phoenix-crm/photos/timetable-pages", { paths }, "pages");
  } catch {
    pages = {};
  }
  const now = Date.now();
  for (const path of paths) known.set(path, { at: now, inFlight: false, pages: Array.isArray(pages[path]) ? pages[path] : NONE });
  notify();
}

function flush() {
  flushTimer = null;
  const paths = [...queued];
  queued.clear();
  for (let start = 0; start < paths.length; start += BATCH_MAX) void askBatch(paths.slice(start, start + BATCH_MAX));
}

function request(path: string) {
  const entry = known.get(path);
  if (entry?.inFlight) return;
  if (entry && Date.now() - entry.at < REUSE_MS) return;
  known.set(path, { at: entry?.at ?? 0, inFlight: true, pages: entry?.pages ?? NONE });
  queued.add(path);
  if (!flushTimer) flushTimer = setTimeout(flush, BATCH_WAIT_MS);
}

function useTimetablePages(firstPath: string | null): string[] {
  useEffect(() => {
    if (firstPath) request(firstPath);
  }, [firstPath]);
  return useSyncExternalStore(
    subscribe,
    () => (firstPath ? known.get(firstPath)?.pages ?? NONE : NONE),
    () => NONE,
  );
}

/**
 * Pages 2 to 5 of the timetable whose first photo is `firstPath`, as thumbnails of the same size the
 * screen gives the first one. Nothing at all for a one-photo board, so a screen without pages is
 * exactly as it was.
 */
export function TimetablePages({
  className,
  firstPath,
  name,
  rotatable,
  thumbClassName = "h-64 w-full",
  tone = "light",
}: {
  className?: string;
  firstPath: string | null;
  /** Whose timetable it is, for the pictures' text. */
  name: string;
  rotatable?: boolean;
  thumbClassName?: string;
  /** "dark" on the review deck's dark stage: small pictures in a row, light words. */
  tone?: "light" | "dark";
}) {
  const pages = useTimetablePages(firstPath);
  if (pages.length === 0) return null;
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <p className={cn("break-words text-xs font-semibold", tone === "dark" ? "text-slate-300" : "text-slate-500")}>
        The timetable is in {pages.length + 1} photos. The others:
      </p>
      <div className={tone === "dark" ? "flex min-w-0 flex-wrap gap-2" : "grid min-w-0 grid-cols-2 gap-2"}>
        {pages.map((path, index) => (
          <CrmPhotoThumb
            alt={`Timetable photo ${index + 2} for ${name}`}
            caption={`Photo ${index + 2}`}
            className={thumbClassName}
            key={path}
            lazy
            path={path}
            rotatable={rotatable}
          />
        ))}
      </div>
    </div>
  );
}
