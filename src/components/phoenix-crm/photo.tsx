"use client";

/**
 * Phoenix CRM — showing stored clinic photos.
 *
 * The photos sit in a private bucket; the screen asks /api/phoenix-crm/photos/sign for short-lived
 * links. A list of a hundred customers must not send a hundred requests, so every thumbnail on screen
 * joins one batch (collected for a few milliseconds, at most 120 paths, one batch per territory so a
 * refusal for one territory never blanks another's photos). Every link the server hands out has at
 * least ten minutes left (it reuses its own links until then, so the browser keeps the picture), and
 * is reused here for eight.
 */

import { useEffect, useSyncExternalStore } from "react";
import { ImageOff } from "lucide-react";

import { crmPost } from "@/components/phoenix-crm/api";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";
import { cn } from "@/lib/utils";

const BATCH_MAX = 120;
const BATCH_WAIT_MS = 30;
const LINK_REUSE_MS = 8 * 60 * 1000;
const MISSING_RETRY_MS = 60 * 1000;
/** A link that fails to load sooner than this after signing is a missing file, not an expired link. */
const EXPIRED_AFTER_MS = 60 * 1000;

type PhotoState = { status: "loading" } | { status: "ready"; url: string } | { status: "missing" };

const LOADING: PhotoState = { status: "loading" };
const MISSING: PhotoState = { status: "missing" };

const entries = new Map<string, { state: PhotoState; at: number; inFlight: boolean }>();
const listeners = new Set<() => void>();
const queued = new Map<string, Set<string>>();
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

/** Test photos sit under `test/<territory>/…`, real ones under `<territory>/…`. */
function territoryGroup(path: string): string {
  const parts = path.split("/");
  return parts[0] === "test" ? `test/${parts[1] ?? ""}` : parts[0] ?? "";
}

async function signBatch(paths: string[]) {
  let urls: Record<string, string> = {};
  try {
    urls = await crmPost<Record<string, string>>("/api/phoenix-crm/photos/sign", { paths }, "urls");
  } catch {
    urls = {};
  }
  const now = Date.now();
  for (const path of paths) {
    const url = urls[path];
    entries.set(path, { at: now, inFlight: false, state: url ? { status: "ready", url } : MISSING });
  }
  notify();
}

function flush() {
  flushTimer = null;
  const groups = [...queued.values()];
  queued.clear();
  for (const group of groups) {
    const paths = [...group];
    for (let start = 0; start < paths.length; start += BATCH_MAX) {
      void signBatch(paths.slice(start, start + BATCH_MAX));
    }
  }
}

function requestLink(path: string, force = false) {
  const entry = entries.get(path);
  const now = Date.now();
  if (entry?.inFlight) return;
  if (entry && !force) {
    const age = now - entry.at;
    if (entry.state.status === "ready" && age < LINK_REUSE_MS) return;
    if (entry.state.status === "missing" && age < MISSING_RETRY_MS) return;
  }
  entries.set(path, { at: entry?.at ?? now, inFlight: true, state: entry?.state ?? LOADING });
  const group = territoryGroup(path);
  const bucket = queued.get(group) ?? new Set<string>();
  bucket.add(path);
  queued.set(group, bucket);
  if (!flushTimer) flushTimer = setTimeout(flush, BATCH_WAIT_MS);
}

/** A shown link stopped loading: re-sign once if it is old enough to have expired, else call it missing. */
function linkFailed(path: string) {
  const entry = entries.get(path);
  if (!entry || entry.inFlight) return;
  if (Date.now() - entry.at >= EXPIRED_AFTER_MS) {
    requestLink(path, true);
    return;
  }
  entries.set(path, { at: entry.at, inFlight: false, state: MISSING });
  notify();
}

function usePhotoLink(path: string | null): PhotoState {
  useEffect(() => {
    if (path) requestLink(path);
  }, [path]);
  return useSyncExternalStore(
    subscribe,
    () => (path ? entries.get(path)?.state ?? LOADING : MISSING),
    () => (path ? LOADING : MISSING),
  );
}

/**
 * Sign the links for photos about to be shown, so the next one in the one-by-one review (owner,
 * 2026-10-18) is already there when it slides in. The same batch and the same reuse as a thumbnail on
 * screen — a path signed in the last eight minutes is not asked for again.
 */
export function prefetchCrmPhotos(paths: ReadonlyArray<string | null>): void {
  for (const path of paths) {
    if (path) requestLink(path);
  }
}

/**
 * A stored photo as a thumbnail that opens full screen. `path` null (a customer validated before
 * photos, which cannot happen today, or a test row) shows a plain "No photo" tile.
 */
export function CrmPhotoThumb({
  alt,
  caption,
  className,
  lazy,
  missingText,
  path,
  rotatable,
}: {
  alt: string;
  caption?: string | null;
  className?: string;
  /** For a long list: the picture is fetched when it nears the screen, not when the page opens. */
  lazy?: boolean;
  /**
   * What the tile says when there is no photo at all. A trusted point (owner, 2026-11-10) passes
   * `TRUSTED_POINT_NO_PHOTO`, plain words and no image, so an administrator never reads it as a lost file.
   */
  missingText?: string;
  path: string | null;
  /**
   * Place checks only: the photo is shown WHOLE (never cropped to the tile) with ↺ ↻ on it, because a
   * timetable photographed sideways cannot be read until it is turned. Every other screen leaves it off.
   */
  rotatable?: boolean;
}) {
  const state = usePhotoLink(path);
  const box = cn("relative block h-24 w-24 shrink-0 overflow-hidden rounded-none border border-slate-200 bg-slate-100", className);

  if (state.status === "ready") {
    return (
      <span className={box}>
        <ZoomablePhoto
          alt={alt}
          caption={caption ?? alt}
          className={rotatable ? undefined : "h-full w-full object-cover"}
          lazy={lazy}
          rotatable={rotatable}
          onError={() => {
            // An expired link (the phone slept past ten minutes) is signed again; a fresh link that
            // still fails is a file that never arrived.
            if (path) linkFailed(path);
          }}
          src={state.url}
        />
      </span>
    );
  }
  if (state.status === "loading") {
    return <span aria-label="Loading photo" className={cn(box, "animate-pulse")} role="img" />;
  }
  if (!path && missingText) {
    return (
      <span aria-label={missingText} className={cn(box, "flex items-center justify-center p-1.5 text-center text-slate-600")} role="img">
        <span className="break-words text-phx-sm font-black uppercase leading-4 tracking-[0.08em]">{missingText}</span>
      </span>
    );
  }
  return (
    <span aria-label="No photo" className={cn(box, "flex flex-col items-center justify-center gap-1 text-slate-400")} role="img">
      <ImageOff aria-hidden className="h-5 w-5" />
      <span className="text-phx-sm font-black uppercase tracking-[0.1em]">No photo</span>
    </span>
  );
}
