"use client";

// The interview calendar's pop-ups — one frame for all of them, and one rule for Escape.
//
// They stack: a session opens over the calendar, a booking over the session, a poll editor over the
// booking. Escape must close the TOP one only. Every pop-up here registers itself on one stack and
// answers Escape only while it is on top, on the window before the document sees the key — so the
// CV preview underneath (which listens on the document) stays open too.

import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useHydrated } from "@/hooks/use-hydrated";
import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import { cn } from "@/lib/utils";
import { adminPanelHeaderClassName, adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";

const layers: symbol[] = [];

/** Escape closes this layer, and only while nothing opened later sits above it. */
export function useTopmostEscape(onClose: () => void) {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const mine = Symbol("interview-calendar-layer");
    layers.push(mine);
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || layers[layers.length - 1] !== mine) return;
      event.stopImmediatePropagation();
      event.stopPropagation();
      onCloseRef.current();
    }
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      const at = layers.indexOf(mine);
      if (at >= 0) layers.splice(at, 1);
    };
  }, []);
}

const WIDTH = { lg: "max-w-[820px]", md: "max-w-[600px]", sm: "max-w-[520px]" } as const;

export function CalendarDialog({
  children,
  eyebrow,
  footer,
  onClose,
  sub,
  title,
  width = "md",
  z = 220,
}: {
  children: ReactNode;
  eyebrow?: string;
  footer?: ReactNode;
  onClose: () => void;
  sub?: ReactNode;
  title: string;
  width?: keyof typeof WIDTH;
  /** Stacking order; a pop-up opened from another passes a higher one. */
  z?: number;
}) {
  const dialogRef = useDialogA11y({ onClose, open: true });
  const mounted = useHydrated();
  const titleId = useId();
  useTopmostEscape(onClose);

  const body = (
    <div
      className="fixed inset-0 flex items-end justify-center bg-slate-900/45 sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{ zIndex: z }}
    >
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className={cn("flex max-h-[94vh] w-full flex-col border border-slate-200 bg-white shadow-[0_24px_60px_rgba(15,23,42,0.32)]", WIDTH[width])}
        ref={dialogRef}
        role="dialog"
      >
        {/* The house dark band names the pop-up — the same band every recruitment panel opens with. */}
        <header className={`flex items-start justify-between gap-3 px-4 py-3.5 text-white sm:px-5 ${adminPanelHeaderClassName}`}>
          <div className="min-w-0">
            {eyebrow ? (
              <p className="flex items-center gap-1.5 break-words text-[11px] font-black uppercase tracking-[0.12em] text-orange-300">
                <span aria-hidden className="inline-block h-2.5 w-[3px] bg-orange-500" />
                {eyebrow}
              </p>
            ) : null}
            <h2 className="mt-1 break-words text-[17px] font-bold leading-snug tracking-tight text-white" id={titleId}>
              {title}
            </h2>
            {sub ? <div className="mt-0.5 break-words text-[12px] leading-5 text-slate-300">{sub}</div> : null}
          </div>
          <button
            aria-label="Close"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center border border-white/15 text-slate-300 transition-colors hover:border-white/40 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
            onClick={onClose}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto bg-white px-4 py-4 sm:px-5">{children}</div>
        {footer ? (
          <footer className={`flex flex-col gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5 ${adminRecessedDepthClassName}`}>
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
  return mounted ? createPortal(body, document.body) : null;
}

/** A small uppercase heading inside a pop-up or panel. */
export function PanelHeading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <p className="flex items-center gap-2 text-[12px] font-black uppercase tracking-[0.08em] text-slate-800">
        <span aria-hidden className="inline-block h-3 w-[3px] bg-orange-500" />
        {children}
      </p>
      {aside}
    </div>
  );
}

export function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p className="break-words border border-red-200 border-l-[3px] border-l-red-600 bg-red-50 px-3 py-2 text-[12px] font-semibold text-red-700" role="alert">
      {children}
    </p>
  );
}

export function NoteLine({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "amber" | "emerald" | "sky" }) {
  const toneClass = {
    amber: "border-l-amber-500 bg-amber-50 text-slate-700",
    emerald: "border-l-emerald-600 bg-emerald-50 text-slate-800",
    sky: "border-l-sky-600 bg-sky-50 text-slate-700",
    slate: "border-l-slate-300 bg-slate-50 text-slate-600",
  }[tone];
  return <p className={cn("break-words border-l-[3px] px-3 py-2 text-[12px] leading-5", toneClass)}>{children}</p>;
}

/** A two- to four-way choice drawn as joined buttons. */
export function Segmented<T extends string | number>({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: T) => void;
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>;
  value: T | null;
}) {
  return (
    <div aria-label={label} className="flex flex-wrap" role="group">
      {options.map((option, index) => (
        <button
          aria-pressed={value === option.value}
          className={cn(
            "border px-2.5 py-1.5 text-[12px] font-bold leading-none tabular-nums transition-colors",
            index > 0 && "-ml-px",
            value === option.value
              ? "relative border-slate-900 bg-slate-900 text-white shadow-[inset_0_-2px_0_#f97316]"
              : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900",
            option.disabled && "cursor-not-allowed opacity-40",
          )}
          disabled={option.disabled}
          key={String(option.value)}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** An on/off switch with its words beside it — square, like everything else here. */
export function Switch({
  checked,
  disabled,
  hint,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  hint?: ReactNode;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={cn("flex items-start gap-2.5", disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer")}>
      <button
        aria-checked={checked}
        aria-label={label}
        className={cn(
          "relative mt-0.5 inline-flex h-5 w-9 shrink-0 border transition-colors",
          checked ? "border-orange-600 bg-orange-600" : "border-slate-300 bg-slate-200",
        )}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        role="switch"
        type="button"
      >
        <span className={cn("absolute top-[2px] h-3.5 w-3.5 bg-white transition-all", checked ? "left-[18px]" : "left-[2px]")} />
      </button>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-slate-800">{label}</span>
        {hint ? <span className="block text-[11px] text-slate-500">{hint}</span> : null}
      </span>
    </label>
  );
}
