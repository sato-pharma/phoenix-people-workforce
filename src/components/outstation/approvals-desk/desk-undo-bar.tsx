"use client";

import { LoaderCircle, Undo2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { adminThumbBarDepthClassName } from "@/components/admin/admin-design-tokens";
import { approvalActionClassName } from "@/components/approvals-hub/approval-action-kit";
import { DESK_WORDS, pressLabel } from "@/lib/outstation/approvals/desk-view";
import { type DeskNotice, type PressQueue, UNDO_WINDOW_MS } from "@/lib/outstation/approvals/press-queue";
import { cn } from "@/lib/utils";

/**
 * The bar at the foot of the page while a press is out: what was pressed, Undo, and the seconds
 * left. A press already being sent says so and offers no Undo — nothing on the server reverses a
 * decision, and a button that pretended to would be a lie.
 */
export function DeskUndoBar({ onUndo, presses }: { onUndo: (id: number) => void; presses: PressQueue }) {
  const [now, setNow] = useState(() => Date.now());
  const busy = presses.waiting.length > 0;
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [busy]);

  if (presses.waiting.length === 0 && presses.sending.length === 0) return null;
  const sending = presses.sending.reduce((sum, press) => sum + press.decisions.length, 0);
  return (
    <div aria-live="polite" className={cn("sticky bottom-0 z-30 min-w-0 border border-slate-900 bg-slate-900 text-white", adminThumbBarDepthClassName)} data-desk-undo-bar role="status">
      {presses.waiting.map((press) => {
        const seconds = Math.min(UNDO_WINDOW_MS / 1000, Math.max(1, Math.ceil((press.dueAt - now) / 1000)));
        return (
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-white/10 px-4 py-2 last:border-b-0" data-press-id={press.id} key={press.id}>
            <p className="min-w-0 break-words text-sm font-bold">
              {pressLabel(press.decisions, press.claims)}
              <span className="ml-2 font-semibold tabular-nums text-slate-300">· saves in {seconds}s</span>
            </p>
            <button className={approvalActionClassName("neutral", "regular")} data-undo onClick={() => onUndo(press.id)} type="button">
              <Undo2 aria-hidden className="h-4 w-4 shrink-0" />
              {DESK_WORDS.undo}
            </button>
          </div>
        );
      })}
      {sending > 0 ? (
        <p className="flex min-w-0 items-center gap-2 px-4 py-2 text-sm font-bold text-slate-200" data-desk-sending>
          <LoaderCircle aria-hidden className="h-4 w-4 shrink-0 animate-spin" />
          Saving {sending === 1 ? "the decision" : `${sending} decisions`}
        </p>
      ) : null}
    </div>
  );
}

/**
 * What came back. A claim whose decision did not land is named with the reason and is back on the
 * list; an approval that landed with a caution (held out of payroll) says so. Each line is closed
 * by him — it never times out on its own.
 */
export function DeskNotices({ notices, onDismiss, onOpen }: { notices: DeskNotice[]; onDismiss: (requestId: number) => void; onOpen: (requestId: number) => void }) {
  if (notices.length === 0) return null;
  return (
    <ul className="grid min-w-0 gap-1.5" data-desk-notices>
      {notices.map((notice) => (
        <li
          className={cn(
            "flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1 border border-l-[3px] px-3 py-2 text-sm",
            notice.tone === "bad" ? "border-rose-200 border-l-rose-500 bg-rose-50 text-rose-900" : "border-amber-200 border-l-amber-500 bg-amber-50 text-amber-900",
          )}
          data-notice={notice.tone}
          key={notice.requestId}
          role={notice.tone === "bad" ? "alert" : undefined}
        >
          <p className="min-w-0 flex-1 break-words font-semibold leading-5">
            <button className="font-black underline" onClick={() => onOpen(notice.requestId)} type="button">
              <bdi dir="auto">{notice.name}</bdi>
            </button>
            {" — "}
            {notice.message}
          </p>
          <button aria-label={`Close the note about ${notice.name}`} className="inline-flex h-11 w-11 shrink-0 items-center justify-center hover:bg-black/5 md:h-8 md:w-8" onClick={() => onDismiss(notice.requestId)} type="button">
            <X aria-hidden className="h-4 w-4" />
          </button>
        </li>
      ))}
    </ul>
  );
}
