"use client";

import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "phoenix-employee-bottom-nav-v1";
const CHANGE_EVENT = "phoenix-employee-bottom-nav-change";

const EMPTY: string[] = [];

function parse(raw: string | null): string[] {
  if (!raw) return EMPTY;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : EMPTY;
  } catch {
    return EMPTY;
  }
}

// Cache so useSyncExternalStore gets a stable reference when nothing changed.
let cache: { raw: string | null; value: string[] } = { raw: null, value: EMPTY };

function getSnapshot(): string[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (raw !== cache.raw) {
    cache = { raw, value: parse(raw) };
  }
  return cache.value;
}

function getServerSnapshot(): string[] {
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
 * Per-device preference for which shortcuts appear in the mobile bottom nav.
 * Stored in localStorage (UI personalization, like the sidebar-collapsed flag),
 * with a custom event so the bottom nav and the profile customizer stay in sync
 * within the same tab. Empty list = use the role-based defaults.
 */
export function useBottomNavPreference(): [string[], (hrefs: string[]) => void] {
  const selected = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setSelected = useCallback((hrefs: string[]) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(hrefs));
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
    } catch {
      // Ignore storage failures (private mode, quota) — the bar falls back to defaults.
    }
  }, []);

  return [selected, setSelected];
}
