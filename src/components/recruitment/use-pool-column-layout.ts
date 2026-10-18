"use client";

// The candidate pool's column layout, one per view ("all", or a role family) — which WhatsApp
// questions show and in what order (pool-whatsapp-columns.ts).
//
// Kept in this browser's localStorage, like the sidebar and the bottom-nav choices: it is how one
// reader likes to look at the pool, not a fact about any candidate. An empty store, a private window
// or a storage error all read as "nothing saved", which is the view's own WhatsApp questions.

import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "phoenix-recruitment-pool-columns-v1";
const CHANGE_EVENT = "phoenix-recruitment-pool-columns-change";

type Layouts = Readonly<Record<string, readonly string[]>>;

const EMPTY: Layouts = {};

function parse(raw: string | null): Layouts {
  if (!raw) return EMPTY;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY;
    const out: Record<string, string[]> = {};
    for (const [view, keys] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(keys)) out[view] = keys.filter((key): key is string => typeof key === "string");
    }
    return out;
  } catch {
    return EMPTY;
  }
}

// Cached so useSyncExternalStore gets a stable reference while nothing changed.
let cache: { raw: string | null; value: Layouts } = { raw: null, value: EMPTY };

function getSnapshot(): Layouts {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (raw !== cache.raw) cache = { raw, value: parse(raw) };
  return cache.value;
}

function getServerSnapshot(): Layouts {
  return EMPTY;
}

function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(CHANGE_EVENT, callback);
  };
}

/**
 * `[saved, save]` for one view. `saved` is null when the reader never changed this view; `save(null)`
 * puts the view back on its WhatsApp questions.
 */
export function usePoolColumnLayout(viewKey: string): [readonly string[] | null, (keys: readonly string[] | null) => void] {
  const layouts = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const saved = Object.prototype.hasOwnProperty.call(layouts, viewKey) ? layouts[viewKey] : null;

  const save = useCallback(
    (keys: readonly string[] | null) => {
      try {
        const next: Record<string, readonly string[]> = { ...getSnapshot() };
        if (keys === null) delete next[viewKey];
        else next[viewKey] = [...keys];
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
      } catch {
        // Storage refused (private mode, quota): the pool keeps showing the view's own questions.
      }
    },
    [viewKey],
  );

  return [saved, save];
}
