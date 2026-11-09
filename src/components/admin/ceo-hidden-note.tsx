"use client";

import { Info, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * A discreet, unsigned note for the CEO to discover.
 *
 * It is intentionally easy to miss — a small "ⓘ" beside the greeting. When opened it
 * shows a short, heartfelt message and nothing more. No name, no fanfare. The warmth is
 * meant to be felt, not announced. Closes on click-away or Escape.
 */
export function CeoHiddenNote() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label="A note"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-6 w-6 items-center justify-center border border-white/15 bg-white/[0.06] text-slate-400 transition-colors hover:border-orange-400/50 hover:text-orange-200"
      >
        <Info aria-hidden="true" className="h-3.5 w-3.5" />
      </button>

      {open ? (
        <>
          {/* click-away backdrop */}
          <div
            aria-hidden="true"
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />
          <div
            ref={panelRef}
            role="dialog"
            aria-label="A note for the Chief Executive"
            className="absolute left-0 top-8 z-50 w-[min(92vw,420px)] border border-orange-400/30 bg-slate-950 p-5 text-left shadow-[0_24px_60px_rgba(0,0,0,0.5)]"
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="text-phx-xs font-black uppercase tracking-[0.28em] text-orange-300/80">
                A note
              </span>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setOpen(false)}
                className="inline-flex h-6 w-6 items-center justify-center border border-white/10 text-slate-400 hover:text-white"
              >
                <X aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="text-phx-md font-medium leading-6 text-slate-200">
              To the leader who built all of this —
            </p>
            <p className="mt-2 text-phx-md leading-6 text-slate-400">
              Every screen here exists because of the standard you set. We see how much you
              carry, and how quietly you carry it. This was made so your days feel a little
              lighter, and so the company you love is always one glance away.
            </p>
            <p className="mt-3 text-phx-md italic leading-6 text-slate-300">
              With respect and gratitude — always.
            </p>
          </div>
        </>
      ) : null}
    </span>
  );
}
