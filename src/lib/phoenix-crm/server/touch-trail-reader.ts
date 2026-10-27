/**
 * Phoenix CRM — serving the touch trail to the Super Admin.
 *
 * Owner, 2026-10-04: "build the touch trail reader for the Super Admin." The table has been filling
 * since 23:02 on 3 Oct and until now the only way to read it was hand-written SQL.
 *
 * FIVE RULES, AND THE FIRST TWO ARE THE ONES THAT WOULD HURT IF BROKEN.
 *
 *   1. 🔴 ONE READER: THE SUPER ADMIN, AND NEVER A TEST ACCOUNT. `canReadTouchTrail` is the same gate
 *      `canDecideValidationReviews` uses, and it gates the page as well as this module. The trail
 *      records every pair of hands on the module including a manager's, so widening it would hand one
 *      manager another manager's keystrokes — and it records what a rep typed and deleted, which is
 *      the most private thing in the module. A rep cannot reach `/admin` at all.
 *
 *   2. 🔴 EVERY READ IS KEYSET-PAGED PAST POSTGREST'S SILENT 1,000-ROW CEILING. A field day is one to
 *      three thousand events per rep, so a plain `.select()` answers with a slice of the morning and
 *      looks exactly like the whole day. `TRAIL_READ_PAGE` is that ceiling by name and every walk
 *      below steps the `bigint id` past it, stopping at `MAX_TRAIL_ROWS` and SAYING it stopped.
 *
 *   3. THE DAY IS READ WHOLE AND FILTERED IN MEMORY. A rep filter in the query would shrink the
 *      people list to the person already chosen and the totals to his share, so the filter could
 *      never be widened again from the page. One Super Admin page may pay a few extra round trips
 *      for a people list that is always complete and totals that are always the day's.
 *
 *   4. THE SUMMARY READ LEAVES `value` BEHIND. What a rep typed is the heaviest column in the table
 *      and the day view never prints it — `value_length` is all a count of typed events needs. The
 *      stream read, which does print it, asks for everything.
 *
 *   5. 🔴 NOTHING IS HIDDEN AND NOTHING IS ROUNDED DOWN. Test-persona rows are listed and flagged,
 *      never filtered out; a day past the ceiling says so; a session longer than the stream cap names
 *      its true length. The rule the whole trail exists for is that nothing is ever lost.
 */

import { forbiddenError, validationError } from "@/lib/http/api-errors";
import { personKey, territoryName } from "@/lib/phoenix-crm/scope";
import type { PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import {
  MAX_SESSION_EVENTS,
  MAX_TRAIL_ROWS,
  TRAIL_DAYS_LISTED,
  TRAIL_READ_PAGE,
  orderWithinSession,
  parseTrailRow,
  summariseSessions,
  type TouchTrailRow,
  type TouchTrailSession,
} from "@/lib/phoenix-crm/touch-trail-reader";
import { isArchivedTrailDay } from "@/lib/phoenix-crm/touch-trail-archive";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const TABLE = "phoenix_crm_touch_trail";

/** Where the Super Admin reads it. */
export const TOUCH_TRAIL_PATH = "/admin/field-crm/touch-trail";

/**
 * The lean projection the day view needs (rule 4) — no `value`, no element identity, no coordinates.
 */
const SUMMARY_COLUMNS =
  "id, session_id, actor_hr_id, seat_id, ms_since_load, occurred_at, device_at, kind, screen, value_length, viewport_w, viewport_h, is_test";

/** The stream prints everything, so it asks for everything. */
const STREAM_COLUMNS =
  "id, session_id, actor_hr_id, seat_id, ms_since_load, occurred_at, device_at, visit_day, kind, route, screen, element, element_label, value, value_length, pointer_x, pointer_y, viewport_w, viewport_h, is_test";

/** The Super Admin, and nobody else — the same gate the place checks use (rule 1). */
export function canReadTouchTrail(viewer: PhoenixCrmViewer): boolean {
  return viewer.isSuperAdmin && viewer.canUpdate && !viewer.isTestPersona;
}

/** A person who left a mark on the day — for the filter, by name. */
export type TouchTrailPerson = { hrId: string; name: string };

/** One page load as the screen draws it: names resolved, no HR code and no raw seat id. */
export type TouchTrailSessionCard = {
  sessionId: string;
  person: string;
  territory: string | null;
  isTest: boolean;
  events: number;
  typed: number;
  firstAt: string;
  lastAt: string;
  onScreenMs: number | null;
  kinds: ReadonlyArray<{ kind: string; count: number }>;
  screens: ReadonlyArray<string>;
  viewports: ReadonlyArray<string>;
  deviceClockOffMs: number | null;
};

export type TouchTrailDayView = {
  day: string;
  /**
   * True when the day is older than the 30 the database keeps (owner, 2026-10-27): its touches were
   * moved to the archive bucket, so an empty view says so instead of "nothing was recorded".
   */
  archived: boolean;
  /** The visit days the picker offers, newest first. */
  days: ReadonlyArray<string>;
  people: ReadonlyArray<TouchTrailPerson>;
  /** The person the view is narrowed to, by HR id, or null for everyone. */
  personHrId: string | null;
  sessions: ReadonlyArray<TouchTrailSessionCard>;
  totals: { events: number; sessions: number; people: number; screens: number };
  /** True when the day has more rows than `MAX_TRAIL_ROWS` and this view is the first of them. */
  partial: boolean;
  /** Rows the reader could not parse. Shown, because a silent drop is the one thing rule 5 forbids. */
  unreadable: number;
};

/** One event as the stream draws it. */
export type TouchTrailEventRow = {
  id: number;
  kind: string;
  occurredAt: string;
  deviceAt: string | null;
  msSinceLoad: number | null;
  screen: string | null;
  route: string | null;
  element: string | null;
  label: string | null;
  value: string | null;
  valueLength: number | null;
  pointerX: number | null;
  pointerY: number | null;
  viewportW: number | null;
  viewportH: number | null;
};

export type TouchTrailSessionView = {
  sessionId: string;
  person: string;
  territory: string | null;
  isTest: boolean;
  day: string | null;
  /** Every event of the session, in the order they happened. */
  events: ReadonlyArray<TouchTrailEventRow>;
  /** The session's TRUE length, counted in the database — which may exceed what `events` carries. */
  total: number;
  deviceClockOffMs: number | null;
  onScreenMs: number | null;
};

function assertReader(viewer: PhoenixCrmViewer): void {
  if (!canReadTouchTrail(viewer)) throw forbiddenError("Only the Super Admin reads the touch trail.");
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A day the caller may have typed into the query string. Anything else is refused, never guessed at. */
export function trailDayOrToday(raw: unknown, viewer: PhoenixCrmViewer): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return viewer.visitDay;
  if (!DAY_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw validationError("That is not a day the trail can be read for.");
  }
  return value;
}

/**
 * The days the picker offers: the last `TRAIL_DAYS_LISTED` visit days, ending with the viewer's own.
 *
 * Counted from the CALENDAR rather than from the table on purpose. PostgREST cannot answer "which
 * days have rows" without a view, and a `select visit_day` would itself stop at 1,000 rows — which on
 * a table this dense means the newest day or two and nothing else, a picker that hides last week. A
 * day with nothing in it says so when it is opened, which costs the reader one click and lies never.
 */
function dayList(viewer: PhoenixCrmViewer): string[] {
  const days: string[] = [];
  const anchor = Date.parse(`${viewer.visitDay}T00:00:00Z`);
  if (Number.isNaN(anchor)) return [viewer.visitDay];
  for (let back = 0; back < TRAIL_DAYS_LISTED; back += 1) {
    days.push(new Date(anchor - back * 86_400_000).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Walk a filtered slice of the table past PostgREST's ceiling (rule 2).
 *
 * The cursor is the `bigint id`, which is `generated always as identity` and therefore strictly
 * increasing and never reused — so a page boundary can neither repeat a row nor skip one, which an
 * `offset` walk over a table still being written to would do both of.
 */
async function walkTrail({
  column,
  columns,
  limit,
  value,
}: {
  /** The one column the slice is filtered on — a visit day, or a session. */
  column: "visit_day" | "session_id";
  columns: string;
  limit: number;
  value: string;
}): Promise<{ rows: TouchTrailRow[]; unreadable: number; hitCeiling: boolean }> {
  const rows: TouchTrailRow[] = [];
  let unreadable = 0;
  let cursor = 0;
  let hitCeiling = false;

  for (;;) {
    const remaining = limit - rows.length;
    if (remaining <= 0) {
      hitCeiling = true;
      break;
    }
    const page = Math.min(TRAIL_READ_PAGE, remaining);
    const { data, error } = await getSupabaseAdmin()
      .from(TABLE)
      .select(columns)
      .eq(column, value)
      .gt("id", cursor)
      .order("id", { ascending: true })
      .limit(page);
    throwIfError(error);
    // A select built from a column STRING is typed `GenericStringError[]` by the client, which cannot
    // know the shape at compile time — so the cast goes through `unknown`. Nothing is taken on trust:
    // `parseTrailRow` validates every field, so a shape that is not a row costs a DROPPED row (counted
    // below) and never a crash.
    const batch = (data ?? []) as unknown as Array<Record<string, unknown>>;
    for (const raw of batch) {
      const row = parseTrailRow(raw);
      if (row) rows.push(row);
      else unreadable += 1;
    }
    if (batch.length === 0) break;
    const lastRaw = batch[batch.length - 1];
    const lastId = Number(lastRaw?.id);
    // A page whose last row carries no readable id cannot advance the cursor, and walking again from
    // the same place would spin forever. Stop and let the caller report a partial read (rule 5).
    if (!Number.isFinite(lastId) || lastId <= cursor) {
      hitCeiling = true;
      break;
    }
    cursor = lastId;
    if (batch.length < page) break;
  }

  return { hitCeiling, rows, unreadable };
}

function territoryOf(viewer: PhoenixCrmViewer, seatId: string | null): string | null {
  if (!seatId) return null;
  const seat = viewer.org.seats.get(seatId);
  return seat ? territoryName(seat) : "Territory no longer in the organogram";
}

/** One visit day of the trail, grouped into page loads. */
export async function loadTouchTrailDay(
  viewer: PhoenixCrmViewer,
  input: { day?: unknown; personHrId?: unknown } = {},
): Promise<TouchTrailDayView> {
  assertReader(viewer);
  const day = trailDayOrToday(input.day, viewer);
  const wanted = personKey(typeof input.personHrId === "string" ? input.personHrId : null);

  const { hitCeiling, rows, unreadable } = await walkTrail({
    column: "visit_day",
    columns: SUMMARY_COLUMNS,
    limit: MAX_TRAIL_ROWS,
    value: day,
  });

  const names = await loadPeopleNames(rows.map((row) => row.actorHrId));
  const people = new Map<string, TouchTrailPerson>();
  for (const row of rows) {
    const key = personKey(row.actorHrId);
    if (key && !people.has(key)) people.set(key, { hrId: key, name: nameOf(names, key) });
  }

  // Rule 3: the day was read whole, so narrowing happens here and the people list above stays complete.
  const kept = wanted ? rows.filter((row) => personKey(row.actorHrId) === wanted) : rows;
  const sessions = summariseSessions(kept);
  const screens = new Set<string>();
  for (const session of sessions) for (const screen of session.screens) screens.add(screen);

  return {
    archived: isArchivedTrailDay(day, viewer.visitDay),
    day,
    days: dayList(viewer),
    partial: hitCeiling,
    people: [...people.values()].sort((a, b) => a.name.localeCompare(b.name)),
    personHrId: wanted,
    sessions: sessions.map((session) => cardOf(viewer, session, names)),
    totals: {
      events: kept.length,
      people: new Set(sessions.map((session) => personKey(session.actorHrId) ?? "—")).size,
      screens: screens.size,
      sessions: sessions.length,
    },
    unreadable,
  };
}

function cardOf(
  viewer: PhoenixCrmViewer,
  session: TouchTrailSession,
  names: Awaited<ReturnType<typeof loadPeopleNames>>,
): TouchTrailSessionCard {
  return {
    deviceClockOffMs: session.deviceClockOffMs,
    events: session.events,
    firstAt: session.firstAt,
    isTest: session.isTest,
    kinds: session.kinds,
    lastAt: session.lastAt,
    onScreenMs: session.onScreenMs,
    person: nameOf(names, session.actorHrId),
    screens: session.screens,
    sessionId: session.sessionId,
    territory: territoryOf(viewer, session.seatId),
    typed: session.typed,
    viewports: session.viewports,
  };
}

/** One page load, event by event, in the order they happened. */
export async function loadTouchTrailSession(viewer: PhoenixCrmViewer, rawSessionId: unknown): Promise<TouchTrailSessionView | null> {
  assertReader(viewer);
  const sessionId = typeof rawSessionId === "string" ? rawSessionId.trim() : "";
  if (!sessionId || sessionId.length > 64) return null;

  // The TRUE length, from the database, so a session past the stream cap can name what it is not
  // showing (rule 5). `head: true` sends no rows back for it.
  const counted = await getSupabaseAdmin().from(TABLE).select("id", { count: "exact", head: true }).eq("session_id", sessionId);
  throwIfError(counted.error);
  const total = counted.count ?? 0;
  if (total === 0) return null;

  const { rows } = await walkTrail({
    column: "session_id",
    columns: STREAM_COLUMNS,
    limit: MAX_SESSION_EVENTS,
    value: sessionId,
  });
  if (rows.length === 0) return null;

  const [session] = summariseSessions(rows);
  if (!session) return null;
  const names = await loadPeopleNames([session.actorHrId]);
  const ordered = orderWithinSession(rows);

  return {
    day: ordered.find((row) => row.visitDay)?.visitDay ?? null,
    deviceClockOffMs: session.deviceClockOffMs,
    // Named, never the raw seat id — and null on a screen that serves no territory, which is correct
    // rather than a gap: the seat lives only in the `day/<seat>/<date>` route segment.
    territory: territoryOf(viewer, session.seatId),
    events: ordered.map((row) => ({
      deviceAt: row.deviceAt,
      element: row.element,
      id: row.id,
      kind: row.kind,
      label: row.elementLabel,
      msSinceLoad: row.msSinceLoad,
      occurredAt: row.occurredAt,
      pointerX: row.pointerX,
      pointerY: row.pointerY,
      route: row.route,
      screen: row.screen,
      value: row.value,
      valueLength: row.valueLength,
      viewportH: row.viewportH,
      viewportW: row.viewportW,
    })),
    isTest: session.isTest,
    onScreenMs: session.onScreenMs,
    person: nameOf(names, session.actorHrId),
    sessionId,
    total,
  };
}
