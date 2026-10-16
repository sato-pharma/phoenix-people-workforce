"use client";

/**
 * Phoenix CRM — the visit recording a rep has SENT and not yet logged a visit with (owner, 2026-10-16).
 *
 * Kept in the browser's own storage, per territory and world, so a page reload or a phone that drops the
 * tab between "Stop and send" and "Log visit" never makes the rep record the conversation again. It holds
 * a stored path and a length — never audio — and it is cleared the moment the visit saves, or when the
 * server refuses the recording (used, too old, never arrived).
 *
 * Read through `useSyncExternalStore` with a null server snapshot, so the server's render and hydration
 * agree and nothing is set from an effect. Where storage is blocked it lives in memory for the page.
 */

import { useCallback, useSyncExternalStore } from "react";

import type { VisitRecordingValue } from "@/components/phoenix-crm/visit-recording-gate";

const CHANGED = "phoenix-crm-visit-recording-changed";
const memory = new Map<string, string>();

function keyOf(seatId: string, test: boolean): string {
  return `phoenix-crm-visit-recording:${test ? "test:" : ""}${seatId}`;
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    if (value === null) memory.delete(key);
    else memory.set(key, value);
  }
  window.dispatchEvent(new Event(CHANGED));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function parse(raw: string | null): VisitRecordingValue | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<VisitRecordingValue>;
    if (typeof value.path === "string" && value.path && typeof value.seconds === "number" && Number.isFinite(value.seconds)) {
      return { path: value.path, seconds: value.seconds };
    }
  } catch {
    // A value this screen did not write is no recording.
  }
  return null;
}

/** The sent recording for this territory, and the two ways to change it. */
export function useSentVisitRecording(seatId: string, test: boolean) {
  const key = keyOf(seatId, test);
  const raw = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => null,
  );
  const keep = useCallback((value: VisitRecordingValue) => write(key, JSON.stringify(value)), [key]);
  const clear = useCallback(() => write(key, null), [key]);
  return { recording: parse(raw), keep, clear };
}
