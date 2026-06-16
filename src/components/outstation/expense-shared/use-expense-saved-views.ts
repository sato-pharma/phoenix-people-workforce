"use client";

import { useCallback, useSyncExternalStore } from "react";

import type { ExpenseCommandFilters } from "@/components/outstation/expense-shared/types";

// Per-device personal "saved views" for the Outstation Expense Command Center —
// admins save common filter combinations under a friendly name (e.g. "High-risk last
// 30d", "Pending Cairo Q3"), then load them with one click. Storage is localStorage,
// same hydration-safe pattern as `use-bottom-nav-preference.ts`.

const STORAGE_KEY = "phoenix-expense-command-views-v1";
const CHANGE_EVENT = "phoenix-expense-command-views-change";
const MAX_VIEWS = 10;
const MAX_NAME_LENGTH = 40;

export type ExpenseSavedView = {
  name: string;
  filters: ExpenseCommandFilters;
  createdAt: string;
};

const EMPTY: ExpenseSavedView[] = [];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(raw: string | null): ExpenseSavedView[] {
  if (!raw) return EMPTY;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY;
    return parsed
      .filter((entry): entry is ExpenseSavedView => {
        if (!isPlainObject(entry)) return false;
        if (typeof entry.name !== "string" || !entry.name.trim()) return false;
        if (!isPlainObject(entry.filters)) return false;
        return true;
      })
      .slice(0, MAX_VIEWS);
  } catch {
    return EMPTY;
  }
}

// Cache so useSyncExternalStore sees a stable reference when nothing changed.
let cache: { raw: string | null; value: ExpenseSavedView[] } = { raw: null, value: EMPTY };

function getSnapshot(): ExpenseSavedView[] {
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

function getServerSnapshot(): ExpenseSavedView[] {
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

function writeViews(next: ExpenseSavedView[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  } catch {
    // Ignore storage failures (private mode, quota) — the bar simply won't persist.
  }
}

export function useExpenseSavedViews() {
  const views = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const addView = useCallback((name: string, filters: ExpenseCommandFilters) => {
    const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
    if (!trimmed) return;
    const current = getSnapshot();
    // Upsert by name: overwrite if a view with the same name already exists.
    const withoutDuplicate = current.filter((view) => view.name !== trimmed);
    const next = [
      { name: trimmed, filters, createdAt: new Date().toISOString() },
      ...withoutDuplicate,
    ].slice(0, MAX_VIEWS);
    writeViews(next);
  }, []);

  const removeView = useCallback((name: string) => {
    const current = getSnapshot();
    writeViews(current.filter((view) => view.name !== name));
  }, []);

  return { views, addView, removeView };
}
