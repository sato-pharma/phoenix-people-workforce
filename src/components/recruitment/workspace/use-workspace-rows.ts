"use client";

// Recruitment workspace — the rows on screen: the first page, the next pages, and every optimistic
// change made to them before the server answers.
//
// WHY A HOOK, AND WHY EVERY FETCH STARTS FROM A HANDLER. The owner asked for "no reloads": a decision
// changes the row in place and the server is told behind it. So the rows live here, each change is a
// patch that hands back the row as it was (the rollback), and nothing re-reads the list after a press.
// Loading is started by the caller's own event handler — a tab press, a filter, the "N new CVs" bar —
// never by an effect watching state, which is what makes a stale answer able to overwrite a fresh one.
// A sequence number guards that race anyway: only the newest request may write.

import { useCallback, useEffect, useRef, useState } from "react";

import { getJson } from "@/components/recruitment/recruitment-fetch";
import { cursorParam, errorText } from "@/components/recruitment/workspace/workspace-format";
import type { WorkspaceCounts, WorkspaceCursor, WorkspacePage, WorkspaceRow } from "@/lib/recruitment/workspace/types";

export const WORKSPACE_PAGE_SIZE = 50;

export type WorkspaceRowsState = {
  rows: WorkspaceRow[];
  nextCursor: WorkspaceCursor | null;
  /** The whole list is being replaced (a tab, a filter). The skeleton shows. */
  loading: boolean;
  /** The next page is on its way. The rows stay. */
  loadingMore: boolean;
  error: string | null;
};

type RowPatch = Partial<WorkspaceRow> | ((row: WorkspaceRow) => WorkspaceRow);

export type RemovedRow = { row: WorkspaceRow; index: number };

function readPage(data: Record<string, unknown>): WorkspacePage {
  const rows = Array.isArray(data.rows) ? (data.rows as WorkspaceRow[]) : [];
  const cursor = data.nextCursor as WorkspaceCursor | null | undefined;
  return { nextCursor: cursor && cursor.createdAt && cursor.id ? cursor : null, rows };
}

export function useWorkspaceRows(initial: { page: WorkspacePage | null; error: string | null }) {
  const [state, setState] = useState<WorkspaceRowsState>({
    error: initial.error,
    loading: false,
    loadingMore: false,
    nextCursor: initial.page?.nextCursor ?? null,
    rows: initial.page?.rows ?? [],
  });
  const sequence = useRef(0);
  const cursorRef = useRef<WorkspaceCursor | null>(initial.page?.nextCursor ?? null);
  const queryRef = useRef<string | null>(null);
  // What the reader sees, as of the last paint — read by the handlers below to hand back the
  // rollback synchronously (a state updater runs later, at render, so it cannot return it).
  const rowsRef = useRef<WorkspaceRow[]>(initial.page?.rows ?? []);
  useEffect(() => {
    rowsRef.current = state.rows;
  }, [state.rows]);

  /** Replace the list with the first page of this filter query. */
  const reload = useCallback(async (query: string) => {
    const mine = ++sequence.current;
    queryRef.current = query;
    setState((current) => ({ ...current, error: null, loading: true }));
    try {
      const data = await getJson(`/api/recruitment/workspace/rows?${query}${query ? "&" : ""}limit=${WORKSPACE_PAGE_SIZE}`);
      if (mine !== sequence.current) return;
      const page = readPage(data);
      cursorRef.current = page.nextCursor;
      setState({ error: null, loading: false, loadingMore: false, nextCursor: page.nextCursor, rows: page.rows });
    } catch (error) {
      if (mine !== sequence.current) return;
      // The old view's rows go: left under the new tab or filter, they could be acted on as if they belonged.
      cursorRef.current = null;
      setState({ error: errorText(error, "The CVs could not be loaded."), loading: false, loadingMore: false, nextCursor: null, rows: [] });
    }
  }, []);

  /** Append the next page of the same query. A no-op when there is no next page or one is loading. */
  const loadMore = useCallback(async (query: string) => {
    const cursor = cursorRef.current;
    if (!cursor) return;
    const mine = sequence.current;
    cursorRef.current = null;
    setState((current) => ({ ...current, loadingMore: true }));
    try {
      const data = await getJson(
        `/api/recruitment/workspace/rows?${query}${query ? "&" : ""}after=${encodeURIComponent(cursorParam(cursor))}&limit=${WORKSPACE_PAGE_SIZE}`,
      );
      if (mine !== sequence.current) return;
      const page = readPage(data);
      cursorRef.current = page.nextCursor;
      setState((current) => {
        const seen = new Set(current.rows.map((row) => row.id));
        return {
          ...current,
          loadingMore: false,
          nextCursor: page.nextCursor,
          rows: [...current.rows, ...page.rows.filter((row) => !seen.has(row.id))],
        };
      });
    } catch (error) {
      if (mine !== sequence.current) return;
      cursorRef.current = cursor;
      setState((current) => ({ ...current, error: errorText(error, "More CVs could not be loaded."), loadingMore: false }));
    }
  }, []);

  /** Change rows in place. Hands back each changed row as it was, for the rollback. */
  const patchRows = useCallback((ids: readonly string[], patch: RowPatch): WorkspaceRow[] => {
    const wanted = new Set(ids);
    const before = rowsRef.current.filter((row) => wanted.has(row.id));
    setState((current) => ({
      ...current,
      rows: current.rows.map((row) => {
        if (!wanted.has(row.id)) return row;
        return typeof patch === "function" ? patch(row) : { ...row, ...patch };
      }),
    }));
    return before;
  }, []);

  /** Put rows back exactly as they were (the rollback of `patchRows`). */
  const restoreRows = useCallback((previous: readonly WorkspaceRow[]) => {
    if (previous.length === 0) return;
    const byId = new Map(previous.map((row) => [row.id, row]));
    setState((current) => ({ ...current, rows: current.rows.map((row) => byId.get(row.id) ?? row) }));
  }, []);

  /** Take rows off the list (archived, deleted, merged away). Hands back where each sat. */
  const removeRows = useCallback((ids: readonly string[]): RemovedRow[] => {
    const wanted = new Set(ids);
    const removed: RemovedRow[] = [];
    rowsRef.current.forEach((row, index) => {
      if (wanted.has(row.id)) removed.push({ index, row });
    });
    setState((current) => ({ ...current, rows: current.rows.filter((row) => !wanted.has(row.id)) }));
    return removed;
  }, []);

  /** One row as the reader last saw it, for a handler that needs its "before". */
  const rowById = useCallback((id: string): WorkspaceRow | null => rowsRef.current.find((row) => row.id === id) ?? null, []);

  /** Put removed rows back where they sat. */
  const reinsertRows = useCallback((removed: readonly RemovedRow[]) => {
    if (removed.length === 0) return;
    setState((current) => {
      const rows = current.rows.filter((row) => !removed.some((item) => item.row.id === row.id));
      for (const item of [...removed].sort((a, b) => a.index - b.index)) {
        rows.splice(Math.min(item.index, rows.length), 0, item.row);
      }
      return { ...current, rows };
    });
  }, []);

  /** Add rows at the top (the "N new CVs" bar), replacing any already on screen. */
  const prependRows = useCallback((incoming: readonly WorkspaceRow[]) => {
    if (incoming.length === 0) return;
    setState((current) => {
      const fresh = new Map(incoming.map((row) => [row.id, row]));
      return { ...current, rows: [...incoming, ...current.rows.filter((row) => !fresh.has(row.id))] };
    });
  }, []);

  const clearError = useCallback(() => setState((current) => ({ ...current, error: null })), []);

  return { clearError, loadMore, patchRows, prependRows, reinsertRows, reload, removeRows, restoreRows, rowById, state };
}

/** The tab, place, status and funnel counts — one read, refreshed after anything that moves a number. */
export function useWorkspaceCounts(initial: WorkspaceCounts | null) {
  const [counts, setCounts] = useState<WorkspaceCounts | null>(initial);
  const sequence = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async (query: string) => {
    const mine = ++sequence.current;
    try {
      const data = await getJson(`/api/recruitment/workspace/counts?${query}`);
      if (mine !== sequence.current) return;
      setCounts(data as unknown as WorkspaceCounts);
    } catch {
      // A count that fails keeps the last good numbers on screen rather than painting zeros.
    }
  }, []);

  /** Several decisions in a row ask once, a second after the last. */
  const refreshSoon = useCallback(
    (query: string) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void refresh(query), 1_000);
    },
    [refresh],
  );

  return { counts, refresh, refreshSoon };
}
