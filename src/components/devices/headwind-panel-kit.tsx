"use client";

/**
 * The few pieces every Headwind panel shares — the read hook, the frame, the two states.
 *
 * WHY IT IS ITS OWN FILE. These began inside `headwind-tablet-panel.tsx`, where there was exactly one
 * consumer. The tablet panel now has four sections and the server-settings screen has three more, and
 * a second copy of `useRead` is precisely how one of them quietly loses the guarantee below.
 *
 * 🔴 THE URL IS PART OF THE STATE ON PURPOSE, AND THAT IS WHAT KEEPS "LOADING" OUT OF THE EFFECT.
 * The obvious shape — three `useState`s and a `setLoading(true)` at the top of the effect — sets state
 * synchronously while the effect runs, which cascades a second render every time the tablet changes
 * (and `react-hooks/set-state-in-effect` refuses it). Storing the answer together with the URL it
 * answers means the switch to "loading" is DERIVED during the render that changed the URL: an answer
 * whose URL is no longer the one being asked about is simply not shown. So a stale tablet's facts can
 * never appear under a different tablet's heading, which on a custody console matters more than the
 * render count does.
 *
 * DESIGN IDENTITY is the section it sits in — slate borders, SQUARE corners, 9px micro-labels, wrapped
 * text with nothing truncated, and Cairo times. Every class string here is whole and standalone: there
 * is no tailwind-merge in this tree, so a base constant with a colour appended would leave two
 * competing `border-*` utilities and stylesheet source order, not the className, would decide.
 */

import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export const MICRO_LABEL = "text-[9px] font-black uppercase tracking-[0.14em] text-slate-500";

/** A quiet action. `break-all` is not decoration — a label can carry a package name, one long word. */
export const PANEL_ACTION =
  "inline-flex max-w-full items-center gap-1.5 break-all border border-slate-300 px-2 py-0.5 text-left text-[10px] font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50";
/** The same button once it is armed and the next press does the thing. */
export const PANEL_ARMED =
  "inline-flex max-w-full items-center gap-1.5 break-all border border-rose-700 bg-rose-700 px-2 py-0.5 text-left text-[10px] font-semibold text-white transition hover:bg-rose-800 disabled:opacity-50";

/**
 * How long a press-again button stays armed before it quietly goes back to its first state.
 *
 * 🔴 AN ARMED BUTTON THAT NEVER DISARMS IS A LOADED ONE. Factory reset, the corporate wipe, an app
 * removal and a revoke all arm on the first press; left armed, the next stray press — minutes later,
 * after a scroll — does the destructive thing with no second look. Eight seconds is long enough to read
 * the armed sentence and press again, and short enough that a press after walking away starts over.
 */
export const ARM_WINDOW_MS = 8_000;

/**
 * Disarm after `ARM_WINDOW_MS`. `armed` is whatever the panel keeps armed — a package name, an action
 * id, or a plain flag; `null` and `false` mean nothing is armed. The timer restarts when a different
 * thing is armed, and is dropped when the panel moves to another tablet (its derived state disarms).
 * The disarm runs from a timer, never synchronously inside the effect.
 */
export function useDisarmAfterWindow(armed: string | boolean | null, disarm: () => void): void {
  const disarmRef = useRef(disarm);
  useEffect(() => {
    disarmRef.current = disarm;
  });
  useEffect(() => {
    if (armed === null || armed === false) return;
    const timer = window.setTimeout(() => disarmRef.current(), ARM_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function failureOf(payload: unknown): string {
  const failure = (payload ?? {}) as { message?: unknown };
  return typeof failure.message === "string" && failure.message
    ? failure.message
    : "The server answered with an error and no explanation.";
}

export async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const payload = await readBody(response);
  if (!response.ok) throw new Error(failureOf(payload));
  return payload as T;
}

export async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    cache: "no-store",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const payload = await readBody(response);
  if (!response.ok) throw new Error(failureOf(payload));
  return payload as T;
}

type ReadState<T> = { url: string; data: T | null; error: string | null; answered: boolean };

export function useRead<T>(url: string): { data: T | null; error: string | null; loading: boolean } {
  const [state, setState] = useState<ReadState<T>>({ answered: false, data: null, error: null, url });

  useEffect(() => {
    let current = true;
    readJson<T>(url)
      .then((result) => {
        if (current) setState({ answered: true, data: result, error: null, url });
      })
      .catch((caught: unknown) => {
        if (current) {
          setState({
            answered: true,
            data: null,
            error: caught instanceof Error && caught.message ? caught.message : "Could not read this.",
            url,
          });
        }
      });
    return () => {
      current = false;
    };
  }, [url]);

  const settled = state.answered && state.url === url;
  return { data: settled ? state.data : null, error: settled ? state.error : null, loading: !settled };
}

export function Panel({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <div className="border border-slate-200 bg-white px-4 py-3">
      <p className={MICRO_LABEL}>{title}</p>
      <div className="mt-2">{children}</div>
    </div>
  );
}

export function Busy({ what }: { what: string }) {
  return (
    <p className="flex items-center gap-2 text-[11px] font-semibold text-slate-500">
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Reading {what}…
    </p>
  );
}

export function Failed({ message }: { message: string }) {
  return <p className="break-words text-[11px] font-bold text-rose-700">{message}</p>;
}

export function Done({ message }: { message: string }) {
  return <p className="break-words text-[11px] font-bold text-emerald-800">{message}</p>;
}

/**
 * Why something cannot be done, said in words where the button would have been.
 *
 * 🔴 THIS IS THE OWNER'S RULING OF 2026-09-25 MADE STRUCTURAL: "do not build a dead button." An action
 * this server cannot carry does not render as a greyed control at all — a greyed button invites a
 * press, teaches nothing, and reads as "not built yet" whether the reason is a box that needs
 * rebuilding or a permission Android grants only to a tablet's manufacturer. A sentence can say which.
 */
export function CannotDo({ label, reason }: { label: string; reason: string }) {
  return (
    <div className="border border-slate-200 bg-slate-50 px-2 py-1.5">
      <p className="break-words text-[11px] font-bold text-slate-700">{label}</p>
      <p className="mt-0.5 break-words text-[11px] font-semibold text-slate-500">{reason}</p>
    </div>
  );
}
