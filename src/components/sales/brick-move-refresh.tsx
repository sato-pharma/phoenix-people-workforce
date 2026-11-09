"use client";

import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  BRICK_MOVES_CHANNEL,
  describeBrickMoveRefresh,
  parseBrickMoveRefresh,
  type BrickMoveRefresh,
} from "@/lib/sales/master-data/brick-move-result";
import { cn } from "@/lib/utils";

// After a brick move, or an approved held pharmacy, the sales rows have already moved inside the
// database; the totals the reports read are rebuilt one file at a time by
// /api/sales/brick-moves/refresh. This calls it until nothing waits, says how far it got, and tells
// every other open tab (the Source Normalizer, another Database Mapping tab) to reload its lists.
//
// Square edges only, like every screen that shows it.

// Forty passes of about fifteen seconds: ten minutes, far past the largest move measured.
const MAX_PASSES = 40;

/** Tell every other open tab that a brick moved or a moved file was rebuilt. */
export function announceBrickMoves(): void {
  try {
    const channel = new BroadcastChannel(BRICK_MOVES_CHANNEL);
    channel.postMessage({ at: Date.now() });
    channel.close();
  } catch {
    // No BroadcastChannel in this browser: the other tabs show the change when they next load.
  }
}

/** Runs `onMove` whenever another tab moves a brick or rebuilds a moved file. */
export function useBrickMovesListener(onMove: () => void): void {
  const handler = useRef(onMove);
  useEffect(() => {
    handler.current = onMove;
  });
  useEffect(() => {
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(BRICK_MOVES_CHANNEL);
      channel.onmessage = () => handler.current();
    } catch {
      channel = null;
    }
    return () => channel?.close();
  }, []);
}

type RefreshState = { error: string | null; last: BrickMoveRefresh | null; running: boolean };

export type BrickMoveRefreshControl = RefreshState & { run: () => Promise<void> };

/** Rebuilds the moved files until none is left, a pass fails, or a pass finds nothing it may take. */
export function useBrickMoveRefresh(onProgress?: () => void): BrickMoveRefreshControl {
  const [state, setState] = useState<RefreshState>({ error: null, last: null, running: false });
  const runningRef = useRef(false);
  const mountedRef = useRef(true);
  const progressRef = useRef(onProgress);
  useEffect(() => {
    progressRef.current = onProgress;
  });
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setState({ error: null, last: null, running: true });
    let rebuilt = 0;
    try {
      for (let pass = 0; pass < MAX_PASSES && mountedRef.current; pass += 1) {
        const response = await fetch("/api/sales/brick-moves/refresh", { cache: "no-store", method: "POST" });
        const payload = (await response.json().catch(() => ({}))) as { error?: unknown; success?: unknown };
        if (!response.ok || payload.success !== true) {
          const error = typeof payload.error === "string" && payload.error ? payload.error : "The moved files could not be rebuilt.";
          if (mountedRef.current) setState({ error, last: null, running: false });
          return;
        }
        const step = parseBrickMoveRefresh(payload);
        rebuilt += step.refreshed;
        if (step.refreshed > 0) {
          announceBrickMoves();
          progressRef.current?.();
        }
        const done = step.remaining === 0 || step.failure !== null || step.refreshed === 0;
        if (mountedRef.current) setState({ error: null, last: { ...step, refreshed: rebuilt }, running: !done });
        if (done) return;
      }
    } catch {
      if (mountedRef.current) {
        setState((current) => ({
          ...current,
          error: "The moved files could not be rebuilt. Check the connection, then press Rebuild now.",
          running: false,
        }));
      }
    } finally {
      runningRef.current = false;
      if (mountedRef.current) setState((current) => (current.running ? { ...current, running: false } : current));
    }
  }, []);

  return { ...state, run };
}

/** One line: what the rebuild is doing or did, with a button to try again when files still wait. */
export function BrickMoveRefreshStatus({ className, refresh }: { className?: string; refresh: BrickMoveRefreshControl }) {
  if (!refresh.running && !refresh.last && !refresh.error) return null;
  const failed = Boolean(refresh.error || refresh.last?.failure);
  const text = refresh.error
    ?? (refresh.last ? describeBrickMoveRefresh(refresh.last) : "Rebuilding the totals of the moved files.");
  const waiting = refresh.error !== null || (refresh.last?.remaining ?? 0) > 0;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 border px-3 py-2 text-sm",
        failed ? "border-rose-200 bg-rose-50 text-rose-700" : "border-phx-line bg-white text-slate-700",
        className,
      )}
      role="status"
    >
      {refresh.running ? <Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin" /> : null}
      <span className="min-w-0 flex-1 break-words">{text}</span>
      {!refresh.running && waiting ? (
        <button
          className="border border-slate-300 bg-white px-2 py-1 text-phx-sm font-bold uppercase tracking-[0.12em] text-slate-700"
          onClick={() => void refresh.run()}
          type="button"
        >
          Rebuild now
        </button>
      ) : null}
    </div>
  );
}
