"use client";

/**
 * Phoenix CRM — the microphone that speaks Egyptian Arabic into a text field.
 *
 * Why it appends through a callback rather than writing the field's DOM node: the comment is a
 * CONTROLLED React field (`value={comment}`), so assigning `field.value` defeats React's own value
 * tracker — the change event is swallowed, state never moves, and the next render puts the old text
 * back. It looks right on screen for a moment and the dictated Arabic is gone by the time the rep
 * saves. The caller owns the state, so the caller does the appending.
 *
 * Absent, never broken: where the browser has no speech engine (Firefox has none) this renders
 * nothing at all. An inert microphone reads as a bug, and the comment can always be typed.
 *
 * Support is read with `useSyncExternalStore` rather than set in an effect, because a `setState`
 * inside `useEffect` is a lint error in this repo. Support cannot change while the screen is open, so
 * the subscribe function has nothing to subscribe to.
 *
 * What the engine returns is TEXT. Nothing here records, stores or uploads audio.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Mic, Square } from "lucide-react";

import { CrmButton, CrmNote } from "@/components/phoenix-crm/ui";
import { startDictation, isDictationSupported, type DictationHandle } from "@/lib/phoenix-crm/dictation";

const subscribeToNothing = () => () => {};

/** False on the server, so the control never renders on the first pass and then vanishes. */
const unsupportedOnServer = () => false;

export function CrmDictate({
  disabled = false,
  label = "Dictate in Arabic",
  onAppend,
}: {
  disabled?: boolean;
  label?: string;
  /** One settled phrase. The caller appends it to its own state and applies its own cap. */
  onAppend: (text: string) => void;
}) {
  const supported = useSyncExternalStore(subscribeToNothing, isDictationSupported, unsupportedOnServer);

  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const handle = useRef<DictationHandle | null>(null);

  const stop = useCallback(() => {
    handle.current?.stop();
    handle.current = null;
    setListening(false);
    setInterim("");
  }, []);

  // The engine holds the microphone, so leaving the screen — Cancel, a saved visit, the tab closing —
  // must hand it back. Missing this leaves the phone showing Phoenix as listening indefinitely.
  useEffect(() => {
    return () => {
      handle.current?.stop();
      handle.current = null;
    };
  }, []);

  // Pressing Save while the microphone is open hands it back. Only the engine is touched here: its own
  // `onend` clears the state a moment later, because a `setState` inside `useEffect` is a lint error
  // in this repo.
  useEffect(() => {
    if (disabled) handle.current?.stop();
  }, [disabled]);

  // A press of Stop and the engine ending by itself can both land; whichever is second finds no handle.
  function start() {
    setError(null);
    const started = startDictation({
      onInterim: setInterim,
      onFinal: (text) => {
        onAppend(text);
        setInterim("");
      },
      onError: (message) => {
        setError(message);
        stop();
      },
      onEnd: () => {
        handle.current = null;
        setListening(false);
        setInterim("");
      },
    });

    if (!started) {
      setError("Dictation could not start on this browser. Type the comment instead.");
      return;
    }
    handle.current = started;
    setListening(true);
  }

  if (!supported) return null;

  return (
    <div className="mt-2 grid min-w-0 gap-2">
      {listening ? (
        <div className="min-w-0 border border-orange-200 bg-orange-50/60 px-3 py-2.5">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2 text-xs font-black text-orange-700">
              <Mic aria-hidden className="h-4 w-4 shrink-0 animate-pulse" />
              Listening — speak now
            </span>
            <CrmButton className="shrink-0" onClick={stop} size="sm">
              <Square aria-hidden className="h-3.5 w-3.5 shrink-0" />
              Stop
            </CrmButton>
          </div>
          {interim ? (
            <p className="mt-1.5 break-words text-xs font-medium italic leading-5 text-slate-600" dir="auto">
              {interim}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="min-w-0">
          <CrmButton disabled={disabled} onClick={start} size="sm">
            <Mic aria-hidden className="h-4 w-4 shrink-0" />
            {label}
          </CrmButton>
          <p className="mt-1.5 break-words text-xs font-medium leading-5 text-slate-500">
            Speak and it is written into the comment. Nothing is recorded — what saves is the text.
          </p>
        </div>
      )}

      {error ? <CrmNote tone="bad">{error}</CrmNote> : null}
    </div>
  );
}
