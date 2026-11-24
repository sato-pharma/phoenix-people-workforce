"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DESK_REFUSAL } from "@/lib/outstation/approvals/decision-plan";
import { type DeskLane, type DeskView, applyDeskOutcomes, applyEditedClaim, deskViewFromSearch, deskViewToSearch, openingLane } from "@/lib/outstation/approvals/desk-view";
import {
  type DeskNotice,
  type DeskPress,
  type PressQueue,
  EMPTY_PRESS_QUEUE,
  addPress,
  failedPressNotices,
  mergeNotices,
  nextDueAt,
  pressBody,
  pressNotices,
  pressSent,
  pressedRequestIds,
  queueWithPressesOut,
  readPressAnswer,
  settlePress,
  takeAll,
  takeDue,
  undoPress,
} from "@/lib/outstation/approvals/press-queue";
import type { DeskClaim, DeskDecisionRequest, DeskQueue } from "@/lib/outstation/approvals/types";

const ROUTE = "/api/admin/outstation/approvals";
const LOAD_FAILED = "Unable to load the expense approvals. Check the connection and try again.";
const UNKNOWN_RESULT = "No clear answer came back, so the list was read again. If this claim is still here, it was not decided.";

type LoadState = { error: string | null; loading: boolean; sessionExpired: boolean };

/**
 * The Expense Approvals page's state: what waits, the view kept in the address, and the presses.
 *
 * Rebuilt 2026-11-23 (owner: "REBUILD FROM SCRATCH"; "Save at once, with Undo"). Three rules:
 *
 *   - One read when the page opens: the claims that wait. History is read by its own lane, on a
 *     press. After a decision only the claims decided are re-read — the server sends them back.
 *   - A press waits six seconds (Undo), then is sent. Its claims are off the list meanwhile. A claim
 *     that did not land comes back with the reason. The queue itself is pure
 *     (`@/lib/outstation/approvals/press-queue`); this hook only keeps the clock and the request.
 *   - Leaving the page — closing it, hiding it on a phone, or moving to another screen — sends every
 *     press still inside its window, with `keepalive`, so a decision is never dropped in silence.
 */
export function useDesk(initialSearch: string) {
  const [loaded, setLoaded] = useState<DeskQueue | null>(null);
  const [load, setLoad] = useState<LoadState>({ error: null, loading: true, sessionExpired: false });
  const [view, setViewState] = useState<DeskView>(() => deskViewFromSearch(initialSearch));
  const [presses, setPresses] = useState<PressQueue>(EMPTY_PRESS_QUEUE);
  const [notices, setNotices] = useState<DeskNotice[]>([]);
  /** Goes up each time a press is answered, so History, when it is the lane on screen, reads again. */
  const [historyVersion, setHistoryVersion] = useState(0);
  const pressesRef = useRef<PressQueue>(EMPTY_PRESS_QUEUE);
  const viewRef = useRef<DeskView>(view);

  const setPressQueue = useCallback((next: PressQueue) => {
    pressesRef.current = next;
    setPresses(next);
  }, []);

  // No setState before the first `await`, so this is safe to call straight from an effect.
  const read = useCallback(async () => {
    try {
      const response = await fetch(ROUTE, { cache: "no-store", headers: { accept: "application/json" } });
      const payload = (await response.json().catch(() => null)) as (DeskQueue & { error?: string; message?: string }) | null;
      if (!response.ok || !payload || !Array.isArray(payload.claims)) {
        setLoad({
          error: payload?.message || "Unable to load the expense approvals.",
          loading: false,
          sessionExpired: response.status === 401 || payload?.error === "session_expired",
        });
        return;
      }
      setLoaded(payload);
      setLoad({ error: null, loading: false, sessionExpired: false });
    } catch {
      setLoad({ error: LOAD_FAILED, loading: false, sessionExpired: false });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void read();
    });
    return () => {
      cancelled = true;
    };
  }, [read]);

  const retry = useCallback(() => {
    setLoad({ error: null, loading: true, sessionExpired: false });
    void read();
  }, [read]);

  const send = useCallback(
    async (press: DeskPress, closing: boolean) => {
      try {
        const response = await fetch(ROUTE, {
          body: JSON.stringify(pressBody(press)),
          headers: { accept: "application/json", "content-type": "application/json" },
          keepalive: closing,
          method: "POST",
        });
        const answer = readPressAnswer(response.status, await response.json().catch(() => null));
        if (answer.kind === "unknown") {
          // The server failed part-way, or its answer could not be read: the decision may have
          // landed before it did. Never "nothing changed" — say so, and read the truth.
          setNotices((current) => mergeNotices(current, failedPressNotices(press, UNKNOWN_RESULT)));
          if (!closing) void read();
          setHistoryVersion((current) => current + 1);
          return;
        }
        if (answer.kind === "refused") {
          // Turned away at the door (a 4xx), before any claim was read.
          setNotices((current) => mergeNotices(current, failedPressNotices(press, answer.message || DESK_REFUSAL.notSaved)));
          if (response.status === 401) setLoad({ error: "Your session has expired.", loading: false, sessionExpired: true });
          return;
        }
        const outcomes = answer.outcomes;
        setLoaded((current) => (current ? applyDeskOutcomes(current, outcomes, pressSent(press)) : current));
        setNotices((current) => mergeNotices(current, pressNotices(press, outcomes, DESK_REFUSAL.notSaved)));
        setHistoryVersion((current) => current + 1);
      } catch {
        // No answer at all: the decision may or may not have landed. Say so, and read the truth.
        setNotices((current) => mergeNotices(current, failedPressNotices(press, UNKNOWN_RESULT)));
        if (!closing) void read();
        setHistoryVersion((current) => current + 1);
      } finally {
        setPressQueue(settlePress(pressesRef.current, press.id));
      }
    },
    [read, setPressQueue],
  );

  const flush = useCallback(
    (closing: boolean) => {
      const { due, queue } = closing ? takeAll(pressesRef.current) : takeDue(pressesRef.current, Date.now());
      if (due.length === 0) return;
      setPressQueue(queue);
      for (const press of due) void send(press, closing);
    },
    [send, setPressQueue],
  );

  // The clock: one timer, for the press that is due first.
  useEffect(() => {
    const due = nextDueAt(presses);
    if (due === null) return;
    const timer = window.setTimeout(() => flush(false), Math.max(0, due - Date.now()));
    return () => window.clearTimeout(timer);
  }, [flush, presses]);

  // Leaving: the tab closing, the page hidden on a phone, or this screen unmounting.
  useEffect(() => {
    const leave = () => flush(true);
    const hidden = () => {
      if (document.visibilityState === "hidden") flush(true);
    };
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", hidden);
      flush(true);
    };
  }, [flush]);

  const pressed = useMemo(() => pressedRequestIds(presses), [presses]);
  /** The page as it reads right now: what was loaded, less the claims inside a press. */
  const queue = useMemo(() => (loaded ? queueWithPressesOut(loaded, pressed) : null), [loaded, pressed]);

  /** One press — a single claim, or the whole Ready lane. `claims` is each claim as it is on screen. */
  const press = useCallback(
    (decisions: ReadonlyArray<DeskDecisionRequest>, claims: ReadonlyArray<DeskClaim>) => {
      const next = addPress(pressesRef.current, { claims, decisions, now: Date.now() });
      if (next === pressesRef.current) return;
      const ids = new Set(decisions.map((decision) => decision.requestId));
      setNotices((current) => current.filter((notice) => !ids.has(notice.requestId)));
      setPressQueue(next);
    },
    [setPressQueue],
  );

  const undo = useCallback((id: number) => setPressQueue(undoPress(pressesRef.current, id)), [setPressQueue]);

  /** A claim whose amounts were just saved on the opened trip, as the server now reads it. */
  const edited = useCallback((before: DeskClaim | null, after: DeskClaim) => {
    setLoaded((current) => (current ? applyEditedClaim(current, before, after) : current));
    setHistoryVersion((current) => current + 1);
  }, []);

  const dismissNotice = useCallback((requestId: number) => setNotices((current) => current.filter((notice) => notice.requestId !== requestId)), []);

  /** The view, kept in the address so a reload or a shared link opens the same thing. */
  const setView = useCallback((change: Partial<DeskView>) => {
    const next = { ...viewRef.current, ...change };
    viewRef.current = next;
    setViewState(next);
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${deskViewToSearch(next)}${window.location.hash}`);
  }, []);

  const lane: DeskLane = openingLane(view, queue?.claims ?? null);

  return {
    canDecide: Boolean(queue?.canDecide),
    dismissNotice,
    edited,
    historyVersion,
    lane,
    load,
    notices,
    press,
    pressed,
    presses,
    queue,
    retry,
    setView,
    undo,
    view,
  };
}

export type Desk = ReturnType<typeof useDesk>;
