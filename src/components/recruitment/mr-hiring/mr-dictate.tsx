"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import { Mic, Sparkles, Square } from "lucide-react";

import { postJson } from "@/components/recruitment/recruitment-fetch";
import { phxButtonGhostClassName } from "@/components/ui/form-tokens";
import { appendDictated, isDictationSupported, isSilentRecognitionError, startDictation, type DictationHandle } from "@/lib/phoenix-crm/dictation";
import {
  MR_DICTATE_KEEP_OWN,
  MR_DICTATE_KEPT,
  MR_DICTATE_LABEL,
  MR_DICTATE_LISTENING,
  MR_DICTATE_POLISHED,
  MR_DICTATE_POLISHING,
  mrDictationMessage,
} from "@/lib/recruitment/mr-hiring/dictation";
import { cn } from "@/lib/utils";

// The microphone under every comment box of Medical Rep hiring (owner, 7 Nov 2026: "make the same mic
// so I can talk and it is written instead of me typing"). The Phoenix CRM visit form's own engine —
// `startDictation`: Egyptian Arabic, English words mixed in, each phrase written as it settles.
//
// THEN THE WORDS ARE PROFESSIONALLY REWRITTEN, IN THE LANGUAGE SPOKEN (owner, 8 Nov 2026: "it fix the spelling and the grammar
// … rephrase it into professional corporate language"). When the speaker presses Stop, what he said in that
// turn goes to `/api/recruitment/mr-hiring/[candidateId]/polish` and comes back as clear professional wording,
// in place of the raw words, with "Keep my own words" to put them back. What was typed before he pressed
// Speak is never sent and never changed. If he edited the box while the words were away, or the rewrite
// fails, the box keeps exactly what is in it — never worse than the plain microphone.
//
// THE BOX'S STATE IS THE CALLER'S. The comment is a controlled field, so writing `field.value` here would be
// swallowed by React and the words lost on save (the same reason as src/components/phoenix-crm/speak.tsx);
// each phrase goes through the caller's setter with `appendDictated`, which also keeps the box's cap.
//
// NOT RENDERED WHERE IT CANNOT WORK — a browser with no speech engine gets the plain box, never an inert
// microphone, which reads as a bug. Read with useSyncExternalStore so the server render and the first
// browser render agree (no button on the server).

const noSubscribe = () => () => {};

export type MrDictateKind = "booking" | "recommendation" | "result";

export function MrDictate({
  candidateId,
  disabled,
  kind,
  limit,
  onChange,
  value,
}: {
  candidateId: string;
  disabled?: boolean;
  kind: MrDictateKind;
  limit: number;
  onChange: Dispatch<SetStateAction<string>>;
  value: string;
}) {
  const supported = useSyncExternalStore(noSubscribe, isDictationSupported, () => false);
  const handle = useRef<DictationHandle | null>(null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [polishing, setPolishing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ polishedValue: string; spokenValue: string } | null>(null);
  // The box as it stood when Speak was pressed, this turn's phrases, and the box as the phrases left it.
  const before = useRef("");
  const phrases = useRef<string[]>([]);
  const produced = useRef("");
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  }, [value]);

  // The form closing mid-sentence stops the microphone rather than leaving it open on a gone screen.
  useEffect(() => () => handle.current?.stop(), []);

  if (!supported) return null;

  async function polish() {
    const spoken = phrases.current.join(" ").trim();
    phrases.current = [];
    if (!spoken) return;
    setPolishing(true);
    try {
      const data = await postJson(`/api/recruitment/mr-hiring/${encodeURIComponent(candidateId)}/polish`, { kind, spoken });
      const text = typeof data.text === "string" ? data.text.trim() : "";
      const spokenValue = produced.current;
      // Edited while the words were away: what he typed wins, untouched.
      if (!text || latest.current !== spokenValue) return;
      const polishedValue = appendDictated(before.current, text, limit);
      onChange(polishedValue);
      setUndo({ polishedValue, spokenValue });
    } catch (failure) {
      setNotice(failure instanceof Error && failure.message ? failure.message : MR_DICTATE_KEPT);
    } finally {
      setPolishing(false);
    }
  }

  function start() {
    setError(null);
    setNotice(null);
    setUndo(null);
    setInterim("");
    before.current = value;
    produced.current = value;
    phrases.current = [];
    const started = startDictation({
      onEnd: () => {
        handle.current = null;
        setListening(false);
        setInterim("");
        void polish();
      },
      onError: (_message, code) => {
        if (!isSilentRecognitionError(code)) setError(mrDictationMessage(code));
      },
      onFinal: (text) => {
        if (!text) return;
        phrases.current.push(text);
        onChange((current) => {
          const next = appendDictated(current, text, limit);
          produced.current = next;
          return next;
        });
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

  function keepOwnWords() {
    if (undo && latest.current === undo.polishedValue) onChange(undo.spokenValue);
    setUndo(null);
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
        <button className={cn(phxButtonGhostClassName, "px-3 py-1.5")} disabled={disabled || polishing} onClick={start} type="button">
          <Mic aria-hidden className="h-4 w-4 shrink-0" />
          {MR_DICTATE_LABEL}
        </button>
      )}
      {polishing ? (
        <p className="mt-1.5 flex min-w-0 items-center gap-2 break-words text-xs font-bold leading-5 text-slate-600" role="status">
          <Sparkles aria-hidden className="h-3.5 w-3.5 shrink-0 animate-pulse" />
          {MR_DICTATE_POLISHING}
        </p>
      ) : null}
      {undo && value === undo.polishedValue ? (
        <p className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs font-bold leading-5 text-emerald-700" role="status">
          <span className="break-words">{MR_DICTATE_POLISHED}</span>
          <button className="font-black text-slate-700 underline underline-offset-2 hover:text-slate-900" onClick={keepOwnWords} type="button">
            {MR_DICTATE_KEEP_OWN}
          </button>
        </p>
      ) : null}
      {notice ? <p className="mt-1.5 break-words text-xs font-bold leading-5 text-slate-600">{notice}</p> : null}
      {error ? <p className="mt-1.5 break-words text-xs font-bold leading-5 text-rose-700">{error}</p> : null}
    </div>
  );
}
