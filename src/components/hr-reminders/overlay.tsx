"use client";

import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

// A dialog that fits any screen: a centred panel on a desktop, the whole screen on a phone. Escape
// and the backdrop close it, the page behind stops scrolling, and the panel itself scrolls — never
// the page sideways.
export function Overlay({
  children,
  onClose,
  title,
  eyebrow,
  wide = false,
}: {
  children: ReactNode;
  eyebrow?: string;
  onClose: () => void;
  title: string;
  wide?: boolean;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div
      aria-label={title}
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-slate-950/55 backdrop-blur-[2px] sm:items-center sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
    >
      <div
        className={`flex max-h-full w-full flex-col overflow-hidden border border-slate-200 bg-white shadow-[0_30px_80px_rgba(15,23,42,0.35)] ${wide ? "sm:max-w-3xl" : "sm:max-w-xl"}`}
      >
        <div className="relative flex items-start justify-between gap-4 border-b border-orange-500/25 bg-[linear-gradient(135deg,#0F172A_0%,#0B1220_55%,#1C0E02_100%)] px-5 py-4">
          <div className="min-w-0">
            {eyebrow ? (
              <p className="text-[10px] font-black uppercase tracking-[0.24em] text-orange-300">{eyebrow}</p>
            ) : null}
            <h2 className="mt-1 break-words text-lg font-black tracking-tight text-white">{title}</h2>
          </div>
          <button
            aria-label="Close"
            className="shrink-0 border border-white/20 bg-white/10 p-1.5 text-slate-100 transition hover:border-orange-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
            onClick={onClose}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
