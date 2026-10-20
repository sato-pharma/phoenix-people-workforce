"use client";

// Recruitment workspace — the 10-second Undo every decision carries (owner, 2026-10-20: "a
// 10-second Undo", changed from 5).
//
// TWO KINDS OF UNDO, AND THE DIFFERENCE IS WHO HAS BEEN TOLD.
//   • APPLIED — a status, a folder filing, a booking, an archive, a placement, an answer. These touch
//     only our own record, so they are written at once and Undo writes them back (a status through
//     `revert-status`, a filing by removing it, a booking by cancelling it).
//   • PENDING — anything that tells a person or removes something for good: a send to a manager, the
//     sorry message, the "ask again" WhatsApp, a delete, a merge, a call result. Those cannot be
//     un-sent, so they WAIT out the ten seconds and Undo simply never sends them. The row already
//     shows the outcome — that is the optimistic half — and Undo puts it back.
//
// A tab closed inside the ten seconds would otherwise drop a pending action the reader believes is
// done, so `pagehide` sends each one with `keepalive` — the one fetch a closing page lets finish.

import { RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { adminPanelDepthClassName } from "@/components/admin/admin-design-tokens";
import { errorText } from "@/components/recruitment/workspace/workspace-format";
import { UNDO_WINDOW_MS } from "@/lib/recruitment/workspace/vocabulary";
import { cn } from "@/lib/utils";

/** One request a closing page sends on its way out. */
export type UndoBeacon = { url: string; method: "POST" | "PATCH" | "DELETE"; body?: unknown };

export type UndoAction = {
  /** What happened, in a sentence: "Shortlisted Mona Ali". */
  message: string;
  kind: "applied" | "pending";
  /** PENDING: the request itself, run when the ten seconds pass. */
  commit?: () => Promise<void>;
  /** APPLIED: the request that writes the change back. */
  revert?: () => Promise<void>;
  /** Both: put the screen back as it was (Undo, or a pending request the server refused). */
  restore?: () => void;
  /** PENDING: what a closing page sends instead of `commit`. */
  beacons?: UndoBeacon[];
};

type Entry = UndoAction & { id: number; state: "open" | "working" };

export function useUndoQueue(onProblem: (message: string) => void) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const pending = useRef(new Map<number, Entry>());
  const nextId = useRef(1);
  const problem = useRef(onProblem);
  useEffect(() => {
    problem.current = onProblem;
  }, [onProblem]);

  const drop = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    pending.current.delete(id);
    setEntries((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const push = useCallback(
    (action: UndoAction) => {
      const id = nextId.current++;
      const entry: Entry = { ...action, id, state: "open" };
      if (action.kind === "pending") pending.current.set(id, entry);
      // Every entry is kept until its 10 seconds end (Undo looks it up here); only the newest four are drawn.
      setEntries((current) => [...current, entry]);
      const timer = setTimeout(() => {
        timers.current.delete(id);
        if (action.kind !== "pending" || !action.commit) {
          drop(id);
          return;
        }
        pending.current.delete(id);
        setEntries((current) => current.map((item) => (item.id === id ? { ...item, state: "working" } : item)));
        action
          .commit()
          .catch((error: unknown) => {
            action.restore?.();
            problem.current(errorText(error, "That did not go through."));
          })
          .finally(() => drop(id));
      }, UNDO_WINDOW_MS);
      timers.current.set(id, timer);
    },
    [drop],
  );

  const undo = useCallback(
    (id: number) => {
      const entry = entries.find((item) => item.id === id);
      if (!entry || entry.state !== "open") return;
      const timer = timers.current.get(id);
      if (timer) clearTimeout(timer);
      timers.current.delete(id);
      pending.current.delete(id);
      if (entry.kind === "pending") {
        entry.restore?.();
        drop(id);
        return;
      }
      setEntries((current) => current.map((item) => (item.id === id ? { ...item, state: "working" } : item)));
      Promise.resolve(entry.revert?.())
        .then(() => entry.restore?.())
        .catch((error: unknown) => problem.current(errorText(error, "Undo did not go through.")))
        .finally(() => drop(id));
    },
    [drop, entries],
  );

  /** The newest open entry — what the `u` key undoes. */
  const undoLatest = useCallback(() => {
    const latest = [...entries].reverse().find((entry) => entry.state === "open");
    if (latest) undo(latest.id);
  }, [entries, undo]);

  // A closing tab sends what is still waiting, so a send the reader saw happen does happen.
  useEffect(() => {
    const flush = () => {
      for (const entry of pending.current.values()) {
        for (const beacon of entry.beacons ?? []) {
          void fetch(beacon.url, {
            body: beacon.body === undefined ? undefined : JSON.stringify(beacon.body),
            headers: beacon.body === undefined ? undefined : { "Content-Type": "application/json" },
            keepalive: true,
            method: beacon.method,
          }).catch(() => undefined);
        }
      }
      pending.current.clear();
    };
    window.addEventListener("pagehide", flush);
    const allTimers = timers.current;
    return () => {
      window.removeEventListener("pagehide", flush);
      for (const timer of allTimers.values()) clearTimeout(timer);
    };
  }, []);

  return { entries, push, undo, undoLatest };
}

export function UndoToasts({
  entries,
  onUndo,
}: {
  entries: ReadonlyArray<{ id: number; message: string; kind: "applied" | "pending"; state: "open" | "working" }>;
  onUndo: (id: number) => void;
}) {
  if (entries.length === 0 || typeof document === "undefined") return null;
  return createPortal(
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-2"
    >
      <style>{"@keyframes phx-ws-undo{from{transform:scaleX(1)}to{transform:scaleX(0)}}"}</style>
      {entries.slice(-4).map((entry) => (
        <div
          className={cn("pointer-events-auto relative border border-slate-800 bg-slate-950 text-white", adminPanelDepthClassName)}
          key={entry.id}
          role="status"
        >
          <div className="flex items-start gap-3 px-3.5 py-3">
            <p className="min-w-0 grow break-words text-sm font-semibold leading-5" dir="auto">
              {entry.message}
              <span className="mt-0.5 block text-xs font-medium text-slate-400">
                {entry.state === "working"
                  ? entry.kind === "pending"
                    ? "Sending now…"
                    : "Undoing…"
                  : entry.kind === "pending"
                    ? "Sends in 10 seconds unless you undo."
                    : "Done. You have 10 seconds to undo."}
              </span>
            </p>
            <button
              className="inline-flex h-8 shrink-0 items-center gap-1.5 border border-orange-400/50 bg-orange-500/15 px-2.5 text-xs font-black uppercase tracking-wide text-orange-100 transition hover:bg-orange-500/30 disabled:opacity-40"
              disabled={entry.state !== "open"}
              onClick={() => onUndo(entry.id)}
              type="button"
            >
              <RotateCcw aria-hidden className="h-3.5 w-3.5" />
              Undo
            </button>
          </div>
          {entry.state === "open" ? (
            <span
              aria-hidden
              className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-orange-500"
              style={{ animation: `phx-ws-undo ${UNDO_WINDOW_MS}ms linear forwards` }}
            />
          ) : null}
        </div>
      ))}
    </div>,
    document.body,
  );
}

/** A plain notice under the header — a refusal from the server, said in its own words. */
export function WorkspaceNotice({ message, onClose, tone = "rose" }: { message: string; onClose: () => void; tone?: "rose" | "emerald" }) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 border px-3.5 py-2.5 text-sm font-semibold",
        tone === "rose" ? "border-rose-200 bg-rose-50 text-rose-900" : "border-emerald-200 bg-emerald-50 text-emerald-900",
      )}
      role={tone === "rose" ? "alert" : "status"}
    >
      <p className="min-w-0 grow break-words" dir="auto">
        {message}
      </p>
      <button aria-label="Dismiss" className="shrink-0 p-0.5 opacity-70 transition hover:opacity-100" onClick={onClose} type="button">
        <X aria-hidden className="h-4 w-4" />
      </button>
    </div>
  );
}
