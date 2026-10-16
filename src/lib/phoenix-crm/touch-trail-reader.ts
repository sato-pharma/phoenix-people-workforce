/**
 * Phoenix CRM — READING the touch trail.
 *
 * The collector and the writer answer "is it saved?". This file answers the question the owner will
 * actually ask of it — "what did he do, in what order, and what did the screen say at the time?" —
 * and it is the half with no DOM and no database client in it, so a test can reach every rule.
 *
 * FOUR RULES GOVERN IT.
 *
 *   1. 🔴 GOLDEN RULE #1 IS UNTOUCHED, AND THIS IS THE SIDE OF IT THAT MATTERS. The trail is evidence
 *      readable only ABOVE the rep: the reader lives under `/admin`, a tree he cannot open, and
 *      nothing here writes, edits or deletes a row. A rep never learns that it was read.
 *
 *   2. 🔴 KEYSET PAGING IS NOT AN OPTIMISATION HERE, IT IS CORRECTNESS. PostgREST stops at 1,000 rows
 *      with no error, no marker and no short-read signal, and one rep's field day is a thousand to
 *      three thousand events — so a plain `.select()` would quietly answer with the first slice of a
 *      day and look exactly like the whole of it. `TRAIL_READ_PAGE` is that cap, named, and the
 *      server read walks the `bigint id` past it.
 *
 *   3. 🔴 WHAT THE SERVER SAW AND WHAT THE DEVICE CLAIMED ARE TWO DIFFERENT FACTS, AND THEY ARE NEVER
 *      AVERAGED. `occurred_at` is the batch's ARRIVAL, shared by up to forty events; `ms_since_load`
 *      is what orders them inside it; `device_at` is the browser's own clock and is the only one a
 *      rep's phone can be wrong about. `deviceClockOffMs` therefore reports the CLOSEST an event's
 *      own stamp came to its arrival, which is the only figure the flush wait cannot inflate.
 *
 *   4. A HOLE IS SHOWN AS A HOLE. A row that will not parse is dropped and counted, a day past the
 *      read ceiling says so, and a session longer than the stream cap names its true length. A
 *      reader that silently rounds down is worse than no reader at all.
 */

import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";
import { FLUSH_EVERY_MS } from "@/lib/phoenix-crm/touch-trail";

/**
 * PostgREST's own ceiling on one response, and therefore the keyset page size (rule 2).
 *
 * It is not configurable from here and it does not announce itself: a read that asks for 5,000 rows
 * gets 1,000 and a 200.
 */
export const TRAIL_READ_PAGE = 1_000;

/** The most rows one day's read walks. Past this the day is reported as partial, never trimmed quietly. */
export const MAX_TRAIL_ROWS = 40_000;

/** The most events one session hands to the screen at once. Its TRUE length is counted separately. */
export const MAX_SESSION_EVENTS = 3_000;

/** How many of the trail's own days the picker offers. */
export const TRAIL_DAYS_LISTED = 21;

/** How many events a page of the stream draws before "show more". */
export const STREAM_PAGE = 100;

/**
 * Beyond this, a device stamp behind its own arrival is the CLOCK and not the flush.
 *
 * The browser holds an event for up to `FLUSH_EVERY_MS` and then pays the network, so some lag is the
 * design working. A minute is a phone whose clock is wrong, and so is any lag at all in the other
 * direction — an event cannot arrive before it happened.
 *
 * Held at the one minute it has always meant: when the flush wait went from 5 s to 30 s (2026-10-16)
 * the old `FLUSH_EVERY_MS + 55_000` would have quietly moved the line the Super Admin reads to 85 s.
 * The wait plus thirty seconds for the network is that same minute.
 */
export const DEVICE_CLOCK_GRACE_MS = FLUSH_EVERY_MS + 30_000;

/** One stored interaction, as the reader works with it. */
export type TouchTrailRow = {
  id: number;
  actorHrId: string | null;
  seatId: string | null;
  sessionId: string;
  msSinceLoad: number | null;
  /** The server's stamp: when the BATCH arrived, shared by every event in it. */
  occurredAt: string;
  /** The browser's own clock at the event. Null when the browser sent nothing readable. */
  deviceAt: string | null;
  visitDay: string | null;
  kind: string;
  route: string | null;
  screen: string | null;
  element: string | null;
  elementLabel: string | null;
  value: string | null;
  valueLength: number | null;
  pointerX: number | null;
  pointerY: number | null;
  viewportW: number | null;
  viewportH: number | null;
  isTest: boolean;
};

/** One page load, summarised — what the day view lists. */
export type TouchTrailSession = {
  sessionId: string;
  actorHrId: string | null;
  seatId: string | null;
  isTest: boolean;
  events: number;
  /** Server arrivals: the first and the last batch of this session. */
  firstAt: string;
  lastAt: string;
  /** The browser's own elapsed time at the last event — how long the load was actually open. */
  onScreenMs: number | null;
  /** Counts per kind, busiest first. */
  kinds: ReadonlyArray<{ kind: string; count: number }>;
  /** The screens it touched, in the order they were first seen. */
  screens: ReadonlyArray<string>;
  /** Distinct viewports as `WxH`, in the order first seen — a phone's address bar makes two. */
  viewports: ReadonlyArray<string>;
  /** Events that carried something the rep had typed. */
  typed: number;
  /** The closest an event's own stamp came to its arrival, signed (rule 3). Null when none carried one. */
  deviceClockOffMs: number | null;
};

const TYPED_KINDS = new Set(["type", "change"]);

/** Human words for a stored kind. Names, never codes — and an unknown kind reads as itself. */
const KIND_WORDS: Record<string, string> = {
  change: "Changed a field",
  focus: "Entered a field",
  hide: "Left the app",
  offline: "Lost the network",
  online: "Back on the network",
  press: "Press",
  screen: "Opened a screen",
  scroll: "Scrolled",
  show: "Back in the app",
  submit: "Submitted",
  tap: "Tap",
  type: "Typed",
};

export function kindWords(kind: string): string {
  return KIND_WORDS[kind] ?? kind;
}

function text(value: unknown): string | null {
  const cleaned = typeof value === "string" ? value.trim() : "";
  return cleaned ? cleaned : null;
}

function intOrNull(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * Read one stored row.
 *
 * TOTAL, like the writer: a row missing the things that make it an event — its own id, the session it
 * belongs to, its arrival or its kind — is dropped rather than thrown over, because one unreadable row
 * must never cost a reader the day around it. Rule 4 is why the caller counts what was dropped.
 */
export function parseTrailRow(raw: unknown): TouchTrailRow | null {
  const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = intOrNull(row.id);
  const sessionId = text(row.session_id);
  const occurredAt = text(row.occurred_at);
  const kind = text(row.kind);
  if (id === null || !sessionId || !occurredAt || !kind) return null;
  return {
    actorHrId: text(row.actor_hr_id),
    deviceAt: text(row.device_at),
    element: text(row.element),
    elementLabel: text(row.element_label),
    id,
    isTest: row.is_test === true,
    kind,
    msSinceLoad: intOrNull(row.ms_since_load),
    occurredAt,
    pointerX: intOrNull(row.pointer_x),
    pointerY: intOrNull(row.pointer_y),
    route: text(row.route),
    screen: text(row.screen),
    seatId: text(row.seat_id),
    sessionId,
    value: typeof row.value === "string" ? row.value : null,
    valueLength: intOrNull(row.value_length),
    viewportH: intOrNull(row.viewport_h),
    viewportW: intOrNull(row.viewport_w),
    visitDay: text(row.visit_day),
  };
}

/**
 * Put one session's events in the order they happened.
 *
 * `ms_since_load` is the key, not the server stamp: a session IS one page load, so the browser's own
 * clock-since-load is monotonic across it and separates forty events that share a single arrival. A
 * row carrying no elapsed time falls back to its `id`, which is at least the order it was written.
 */
export function orderWithinSession(rows: ReadonlyArray<TouchTrailRow>): TouchTrailRow[] {
  return [...rows].sort((a, b) => {
    const left = a.msSinceLoad;
    const right = b.msSinceLoad;
    if (left !== null && right !== null && left !== right) return left - right;
    return a.id - b.id;
  });
}

function msOrNull(iso: string | null): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Group a day's rows into one summary per page load, the most recently active first. */
export function summariseSessions(rows: ReadonlyArray<TouchTrailRow>): TouchTrailSession[] {
  const byId = new Map<string, TouchTrailRow[]>();
  for (const row of rows) {
    const list = byId.get(row.sessionId);
    if (list) list.push(row);
    else byId.set(row.sessionId, [row]);
  }

  const sessions: TouchTrailSession[] = [];
  for (const [sessionId, list] of byId) {
    const ordered = orderWithinSession(list);
    const first = ordered[0];
    if (!first) continue;
    const kinds = new Map<string, number>();
    const screens: string[] = [];
    const viewports: string[] = [];
    let typed = 0;
    let firstAt = first.occurredAt;
    let lastAt = first.occurredAt;
    let onScreenMs: number | null = null;
    let deviceClockOffMs: number | null = null;
    let actorHrId: string | null = null;
    let seatId: string | null = null;
    let isTest = false;

    for (const row of ordered) {
      kinds.set(row.kind, (kinds.get(row.kind) ?? 0) + 1);
      if (row.screen && !screens.includes(row.screen)) screens.push(row.screen);
      if (row.viewportW !== null && row.viewportH !== null) {
        const size = `${row.viewportW}x${row.viewportH}`;
        if (!viewports.includes(size)) viewports.push(size);
      }
      if (TYPED_KINDS.has(row.kind) && (row.value !== null || (row.valueLength ?? 0) > 0)) typed += 1;
      if (row.occurredAt < firstAt) firstAt = row.occurredAt;
      if (row.occurredAt > lastAt) lastAt = row.occurredAt;
      if (row.msSinceLoad !== null && (onScreenMs === null || row.msSinceLoad > onScreenMs)) onScreenMs = row.msSinceLoad;
      // The seat and the actor belong to the SESSION, not the row: the first row that names one wins.
      // A seat is null on every screen outside `day/<seat>/<date>`, because the route segment is the
      // only place it exists — that is correct data, not a hole.
      if (!actorHrId && row.actorHrId) actorHrId = row.actorHrId;
      if (!seatId && row.seatId) seatId = row.seatId;
      if (row.isTest) isTest = true;
      const arrived = msOrNull(row.occurredAt);
      const claimed = msOrNull(row.deviceAt);
      if (arrived !== null && claimed !== null) {
        const off = arrived - claimed;
        // The MINIMUM, because the flush wait can only ever inflate this (rule 3).
        if (deviceClockOffMs === null || off < deviceClockOffMs) deviceClockOffMs = off;
      }
    }

    sessions.push({
      actorHrId,
      deviceClockOffMs,
      events: ordered.length,
      firstAt,
      isTest,
      kinds: [...kinds]
        .map(([kind, count]) => ({ count, kind }))
        .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
      lastAt,
      onScreenMs,
      screens,
      seatId,
      sessionId,
      typed,
      viewports,
    });
  }

  return sessions.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : a.sessionId.localeCompare(b.sessionId)));
}

/**
 * The Cairo wall clock of an instant, to the second — "21:32:07".
 *
 * Seconds are the point: a trail is read to tell one tap from the next, and the house formatters stop
 * at the minute. The ZONE is the repo's own `PHOENIX_BUSINESS_TIME_ZONE` and never a hand-written
 * offset, because Cairo observes DST and an offset would be an hour wrong for half the year.
 */
export function cairoClock(value: string | null | undefined): string {
  const ms = msOrNull(value ?? null);
  if (ms === null) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    second: "2-digit",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
  }).format(new Date(ms));
}

/** How long a session stayed open, in words — "48 s", "4 m 12 s", "1 h 06 m". */
export function durationText(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} m ${String(seconds % 60).padStart(2, "0")} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} m`;
}

/** Where in the page load an event fell — "0:12.480", which is what orders two taps in one batch. */
export function sinceLoadText(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

/**
 * The sentence for a device clock that is provably wrong, or null when it sits inside the flush wait.
 *
 * NOTHING is said in the normal case on purpose: a pill on every session would train the reader to
 * ignore the one session where it means something.
 */
export function deviceClockNote(offMs: number | null): string | null {
  if (offMs === null) return null;
  if (offMs < 0) return `Phone clock ${durationText(Math.abs(offMs))} ahead of the server`;
  if (offMs > DEVICE_CLOCK_GRACE_MS) return `Phone clock ${durationText(offMs)} behind the server`;
  return null;
}
