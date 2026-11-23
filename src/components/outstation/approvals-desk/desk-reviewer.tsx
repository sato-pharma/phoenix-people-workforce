"use client";

import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import { useHydrated } from "@/hooks/use-hydrated";
import { formatNumberValue } from "@/lib/i18n/format";
import { type DeskNotice, type PressQueue, pressedRequestIds } from "@/lib/outstation/approvals/press-queue";

import type { DecisionMode, OnPress } from "./desk-decision";
import { DeskTripFile } from "./desk-trip-file";
import { DeskUndoBar } from "./desk-undo-bar";

/** Another modal over the reviewer — the zoomed photo — owns the keyboard while it is open. */
function otherDialogOpen(): boolean {
  return document.querySelectorAll('[role="dialog"][aria-modal="true"]').length > 1;
}

function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.getAttribute("role") === "combobox") return true;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

const NAV_BUTTON =
  "inline-flex h-11 w-11 shrink-0 items-center justify-center border border-white/20 text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-400";

/**
 * One trip, whole, on one scroll — and the same buttons as its row.
 *
 * Rebuilt 2026-11-23 (owner: "REBUILD FROM SCRATCH LESS THAN 9.5/10 PER ITEM IS NOT ACCEPTED"). The
 * reviewer it replaces had four views and made four requests a trip. This one opens the trip with
 * ONE request (desk-trip-file.tsx) and lays it out top to bottom: what the system found, each day
 * with its map, the photos and tickets. Approve · Reduce · Reject stay pinned at the foot; they are
 * the row's own buttons (desk-decision.tsx), so there is never a second way to decide.
 *
 * A press here is the page's press: it saves by itself after six seconds of Undo, and the reviewer
 * moves straight to the next claim of the lane on screen — or closes after the last one. Undo
 * brings the claim back and opens it again. ← and → walk the lane; Escape closes the reason box
 * first, then the reviewer.
 */
export function DeskReviewer({
  canDecide,
  notice,
  onClose,
  onGo,
  onPress,
  onUndo,
  presses,
  requestId,
  walk,
}: {
  canDecide: boolean;
  /** What came back about this claim (a decision that did not land, a hold), if anything. */
  notice: DeskNotice | null;
  onClose: () => void;
  onGo: (requestId: number) => void;
  onPress: OnPress;
  onUndo: (pressId: number) => void;
  presses: PressQueue;
  requestId: number;
  /** The claims of the lane on screen, in order — what Previous and Next walk. */
  walk: number[];
}) {
  const hydrated = useHydrated();
  const titleId = useId();
  const [mode, setMode] = useState<DecisionMode>("idle");

  const index = walk.indexOf(requestId);
  const previous = index > 0 ? walk[index - 1] : null;
  const next = index >= 0 && index < walk.length - 1 ? walk[index + 1] : null;

  const go = useCallback(
    (target: number) => {
      setMode("idle");
      onGo(target);
    },
    [onGo],
  );

  const close = useCallback(() => {
    // The zoomed photo answers Escape first; then an open reason box; then the reviewer.
    if (otherDialogOpen()) return;
    if (mode !== "idle") {
      setMode("idle");
      return;
    }
    onClose();
  }, [mode, onClose]);
  const dialogRef = useDialogA11y<HTMLDivElement>({ open: hydrated, onClose: close });

  // ← and → between claims; never while typing, never with the zoom open, never a decision.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (typingIn(event.target) || otherDialogOpen()) return;
      if (event.key === "ArrowRight" && next !== null) go(next);
      else if (event.key === "ArrowLeft" && previous !== null) go(previous);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [go, next, previous]);

  // A press takes its own button off the screen; keep the keyboard inside the reviewer.
  useEffect(() => {
    const box = dialogRef.current;
    if (box && !box.contains(document.activeElement)) box.focus();
  }, [dialogRef, requestId]);

  /** The page's press, then straight on: the next claim of the lane, else the one before, else close. */
  const pressAndMove = useCallback<OnPress>(
    (decisions, claims) => {
      onPress(decisions, claims);
      setMode("idle");
      const target = next ?? previous;
      if (target !== null) onGo(target);
      else onClose();
    },
    [next, onClose, onGo, onPress, previous],
  );

  /** Undo, and back to the claim it was pressed on. */
  const undoAndReturn = useCallback(
    (pressId: number) => {
      const press = presses.waiting.find((entry) => entry.id === pressId);
      onUndo(pressId);
      if (press && press.claims.length === 1) go(press.claims[0].requestId);
    },
    [go, onUndo, presses.waiting],
  );

  if (!hydrated) return null;

  return createPortal(
    <div
      aria-labelledby={titleId}
      aria-modal="true"
      className="fixed inset-0 z-[200] flex min-w-0 flex-col bg-slate-100 text-slate-900 outline-none"
      data-desk-reviewer={requestId}
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
    >
      <header className="flex min-w-0 items-center gap-2 border-b-2 border-orange-500 bg-slate-950 px-3 py-2 text-white sm:px-4">
        <div className="min-w-0 flex-1">
          <p className="break-words text-phx-sm font-black uppercase tracking-[0.18em] text-orange-400">Expense approvals</p>
          <p className="break-words text-sm font-bold text-slate-200" data-reviewer-position>
            {index >= 0 ? `Claim ${formatNumberValue(index + 1)} of ${formatNumberValue(walk.length)} in this lane` : "One claim"}
          </p>
        </div>
        <button aria-label="Previous claim" className={NAV_BUTTON} disabled={previous === null} onClick={() => previous !== null && go(previous)} title="Previous claim (←)" type="button">
          <ChevronLeft aria-hidden className="h-5 w-5" />
        </button>
        <button aria-label="Next claim" className={NAV_BUTTON} disabled={next === null} onClick={() => next !== null && go(next)} title="Next claim (→)" type="button">
          <ChevronRight aria-hidden className="h-5 w-5" />
        </button>
        <button aria-label="Close the claim" className={NAV_BUTTON} data-reviewer-close onClick={onClose} title="Close (Esc)" type="button">
          <X aria-hidden className="h-5 w-5" />
        </button>
      </header>

      <DeskTripFile
        canDecide={canDecide}
        key={requestId}
        mode={mode}
        notice={notice}
        onGo={go}
        onMode={setMode}
        onPress={pressAndMove}
        pressed={pressedRequestIds(presses).has(requestId)}
        requestId={requestId}
        titleId={titleId}
      />

      <DeskUndoBar onUndo={undoAndReturn} presses={presses} />
    </div>,
    document.body,
  );
}
