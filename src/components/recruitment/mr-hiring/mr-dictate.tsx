"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Mic, Square } from "lucide-react";

import { phxButtonGhostClassName } from "@/components/ui/form-tokens";
import { isDictationSupported, isSilentRecognitionError, startDictation, type DictationHandle } from "@/lib/phoenix-crm/dictation";
import { MR_DICTATE_LABEL, MR_DICTATE_LISTENING, mrDictationMessage } from "@/lib/recruitment/mr-hiring/dictation";
import { cn } from "@/lib/utils";

// The microphone under every comment box of Medical Rep hiring (owner, 7 Nov 2026: "make the same mic
// so I can talk and it is written instead of me typing"). The Phoenix CRM visit form's own engine —
// `startDictation`: Egyptian Arabic, English words mixed in, each phrase written as it settles.
//
// THE CALLER APPENDS. The comment is a controlled field, so writing `field.value` here would be swallowed
// by React and the words lost on save (the same reason as src/components/phoenix-crm/speak.tsx); the
// caller owns the state and adds each phrase with `appendDictated`, which also keeps the box's cap.
//
// NOT RENDERED WHERE IT CANNOT WORK — a browser with no speech engine gets the plain box, never an inert
// microphone, which reads as a bug. Read with useSyncExternalStore so the server render and the first
// browser render agree (no button on the server).

const noSubscribe = () => () => {};

export function MrDictate({ disabled, onAppend }: { disabled?: boolean; onAppend: (spoken: string) => void }) {
  const supported = useSyncExternalStore(noSubscribe, isDictationSupported, () => false);
  const handle = useRef<DictationHandle | null>(null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);

  // The form closing mid-sentence stops the microphone rather than leaving it open on a gone screen.
  useEffect(() => () => handle.current?.stop(), []);

  if (!supported) return null;

  function start() {
    setError(null);
    setInterim("");
    const started = startDictation({
      onEnd: () => {
        handle.current = null;
        setListening(false);
        setInterim("");
      },
      onError: (_message, code) => {
        if (!isSilentRecognitionError(code)) setError(mrDictationMessage(code));
      },
      onFinal: (text) => {
        if (text) onAppend(text);
      },
      onInterim: setInterim,
    });
    if (!started) {
      setError(mrDictationMessage("start-failed"));
      return;
    }
    handle.current = started;
    setListening(true);
  }

  function stop() {
    handle.current?.stop();
  }

  return (
    <div className="mt-2 min-w-0" data-mr-dictate>
      {listening ? (
        <div className="border border-orange-300 bg-orange-50 px-3 py-2">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2 text-xs font-black text-orange-700">
              <Mic aria-hidden className="h-4 w-4 shrink-0 animate-pulse" />
              {MR_DICTATE_LISTENING}
            </span>
            <button className={cn(phxButtonGhostClassName, "shrink-0 px-3 py-1.5")} onClick={stop} type="button">
              <Square aria-hidden className="h-3.5 w-3.5 shrink-0" />
              Stop
            </button>
          </div>
          {interim ? (
            <p className="mt-1.5 break-words text-xs font-medium italic leading-5 text-slate-600" dir="auto">
              {interim}
            </p>
          ) : null}
        </div>
      ) : (
        <button className={cn(phxButtonGhostClassName, "px-3 py-1.5")} disabled={disabled} onClick={start} type="button">
          <Mic aria-hidden className="h-4 w-4 shrink-0" />
          {MR_DICTATE_LABEL}
        </button>
      )}
      {error ? <p className="mt-1.5 break-words text-xs font-bold leading-5 text-rose-700">{error}</p> : null}
    </div>
  );
}
