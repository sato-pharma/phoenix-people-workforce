"use client";

// The candidate pool's column layout, one per view ("all", or a role family) — which WhatsApp
// questions show and in what order (pool-whatsapp-columns.ts).
//
// Saved to the reader's ACCOUNT since 2026-10-19 (owner — "Columns follow you"): it used to live in
// this browser's localStorage alone, so the columns set up at a desk were missing on the phone. The
// account copy (/api/recruitment/pool-column-layout) is the truth; localStorage stays as the instant
// copy the first paint reads, so the pool does not open on the default columns and then jump.
//
// The first time an account with nothing saved opens the pool in a browser that still holds the old
// browser-only layout, that layout is sent up once — nobody loses the columns they already chose.
// "Nothing saved" must be the account's own answer: a read that failed sends nothing up.
// Any failure (offline, a missing table, a refused save) leaves the pool on what it already shows.

import { useCallback, useSyncExternalStore } from "react";

import {
  parsePoolColumnLayouts,
  readPoolColumnLayoutAnswer,
  type PoolColumnLayouts,
} from "@/lib/recruitment/pool-column-layout-rules";

const STORAGE_KEY = "phoenix-recruitment-pool-columns-v1";
const ENDPOINT = "/api/recruitment/pool-column-layout";

const EMPTY: PoolColumnLayouts = {};

let layouts: PoolColumnLayouts | null = null;
let accountRead: "idle" | "reading" | "done" = "idle";
// A save made before the account copy arrived already sent the whole document up; the late read must
// not put the older one back over it.
let savedBeforeAccountRead = false;
const listeners = new Set<() => void>();

function readLocal(): PoolColumnLayouts {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? parsePoolColumnLayouts(JSON.parse(raw)) : EMPTY;
  } catch {
    return EMPTY;
  }
}

function writeLocal(next: PoolColumnLayouts) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage refused (private mode, quota): the account copy still holds it.
  }
}

function setLayouts(next: PoolColumnLayouts) {
  layouts = next;
  writeLocal(next);
  for (const listener of listeners) listener();
}

async function putToAccount(next: PoolColumnLayouts): Promise<void> {
  try {
    await fetch(ENDPOINT, {
      body: JSON.stringify({ layouts: next }),
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    });
  } catch {
    // Offline or refused: this browser keeps it, and the next save tries again.
  }
}

async function readAccount(): Promise<void> {
  accountRead = "reading";
  try {
    const response = await fetch(ENDPOINT, { cache: "no-store", credentials: "same-origin" });
    const body: unknown = response.ok ? await response.json().catch(() => null) : null;
    if (savedBeforeAccountRead) return;
    const answer = readPoolColumnLayoutAnswer(response.ok, body);
    if (answer.kind === "saved") {
      setLayouts(answer.layouts);
      return;
    }
    // A read that failed is not an empty account: carrying this browser's copy up on it wrote an
    // older layout over the account's newer one. The pool keeps what it shows.
    if (answer.kind === "unavailable") return;
    // Nothing on the account yet: carry the old browser-only layout up, once.
    const local = layouts ?? readLocal();
    if (Object.keys(local).length > 0) await putToAccount(local);
  } catch {
    // The pool keeps this browser's copy.
  } finally {
    accountRead = "done";
  }
}

function getSnapshot(): PoolColumnLayouts {
  if (layouts === null) layouts = readLocal();
  return layouts;
}

function getServerSnapshot(): PoolColumnLayouts {
  return EMPTY;
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  if (accountRead === "idle") void readAccount();
  // Another tab of this browser saved: pick its copy up.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    layouts = readLocal();
    callback();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * `[saved, save]` for one view. `saved` is null when the reader never changed this view; `save(null)`
 * puts the view back on its WhatsApp questions.
 */
export function usePoolColumnLayout(viewKey: string): [readonly string[] | null, (keys: readonly string[] | null) => void] {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const saved = Object.prototype.hasOwnProperty.call(current, viewKey) ? current[viewKey] : null;

  const save = useCallback(
    (keys: readonly string[] | null) => {
      const next: Record<string, readonly string[]> = { ...getSnapshot() };
      if (keys === null) delete next[viewKey];
      else next[viewKey] = [...keys];
      if (accountRead !== "done") savedBeforeAccountRead = true;
      setLayouts(next);
      void putToAccount(next);
    },
    [viewKey],
  );

  return [saved, save];
}
