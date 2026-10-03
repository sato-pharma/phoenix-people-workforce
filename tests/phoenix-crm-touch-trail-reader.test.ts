import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEVICE_CLOCK_GRACE_MS,
  MAX_SESSION_EVENTS,
  MAX_TRAIL_ROWS,
  STREAM_PAGE,
  TRAIL_DAYS_LISTED,
  TRAIL_READ_PAGE,
  cairoClock,
  deviceClockNote,
  durationText,
  kindWords,
  orderWithinSession,
  parseTrailRow,
  sinceLoadText,
  summariseSessions,
  type TouchTrailRow,
} from "../src/lib/phoenix-crm/touch-trail-reader.ts";
import { FLUSH_EVERY_MS } from "../src/lib/phoenix-crm/touch-trail.ts";
import { canReadTouchTrail, trailDayOrToday } from "../src/lib/phoenix-crm/server/touch-trail-reader.ts";
import type { PhoenixCrmViewer } from "../src/lib/phoenix-crm/server/access.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// READING THE PHOENIX CRM TOUCH TRAIL (owner, 2026-10-04: "build the touch trail reader for the
// Super Admin").
//
// The table has been filling since 23:02 on 3 Oct and until this page there was no way to read it
// but hand-written SQL. What the reader must not do is the whole of this file:
//
//   · 🔴 IT MUST NOT ANSWER WITH A SLICE OF A DAY AND LOOK LIKE THE WHOLE OF IT. PostgREST stops at
//     1,000 rows with no error, no marker and no short-read signal, and one rep's field day is a
//     thousand to three thousand events. Every read is keyset-paged on the `bigint id`, and section 1
//     refuses an `offset`/`range` walk — which over a table still being written to would also both
//     repeat and skip rows.
//   · 🔴 IT MUST STAY THE SUPER ADMIN'S ALONE. The trail records every pair of hands on the module
//     including a manager's, and it keeps what a rep typed and then DELETED. Section 2.
//   · 🔴 IT MUST NEVER WRITE. A reader that can edit the evidence is not evidence. Section 3.
//   · 🔴 IT MUST NOT ROUND A HOLE DOWN. A day past the ceiling, a session past the stream cap and a
//     row that will not parse are each reported, never quietly dropped. Sections 4 and 7.
//   · AND THE SERVER'S CLOCK AND THE DEVICE'S ARE NEVER AVERAGED (section 6) — `occurred_at` is the
//     batch's arrival, shared by up to forty events, so only the MINIMUM gap to `device_at` carries
//     any information about the phone's clock.
// ─────────────────────────────────────────────────────────────────────────────

const RULES = "src/lib/phoenix-crm/touch-trail-reader.ts";
const SERVICE = "src/lib/phoenix-crm/server/touch-trail-reader.ts";
const BOARD = "src/components/phoenix-crm/touch-trail-board.tsx";
const PAGE = "app/(admin)/admin/field-crm/touch-trail/page.tsx";
const NAV = "src/config/system-navigation.ts";
const MIGRATION = "supabase/migrations/20261003221224_phoenix_crm_touch_trail.sql";

function source(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

function viewerWith(patch: Partial<PhoenixCrmViewer>): PhoenixCrmViewer {
  return {
    hrId: "B-900",
    role: "Medical Rep",
    isSuperAdmin: false,
    isSfeManager: false,
    isTestPersona: false,
    canCreate: false,
    canApprove: false,
    canUpdate: false,
    basis: "tree",
    cairoToday: "2026-10-04",
    visitDay: "2026-10-03",
    ...patch,
  } as unknown as PhoenixCrmViewer;
}

const SUPER_ADMIN = viewerWith({ hrId: "B-10", role: "Super Admin", isSuperAdmin: true, canUpdate: true, basis: "all" });
const SFE = viewerWith({ hrId: "B-700", role: "SFE Manager", isSfeManager: true, canUpdate: true, basis: "all" });
const CEO = viewerWith({ hrId: "B-100", role: "CEO", canUpdate: true, basis: "all" });
const REP = viewerWith({});

/** One stored row, with only what a case cares about spelled out. */
function row(patch: Partial<TouchTrailRow>): TouchTrailRow {
  return {
    actorHrId: "B-158",
    deviceAt: null,
    element: null,
    elementLabel: null,
    id: 1,
    isTest: false,
    kind: "tap",
    msSinceLoad: 0,
    occurredAt: "2026-10-03T21:00:00.000Z",
    pointerX: null,
    pointerY: null,
    route: null,
    screen: null,
    seatId: null,
    sessionId: "s1",
    value: null,
    valueLength: null,
    viewportH: null,
    viewportW: null,
    visitDay: "2026-10-03",
    ...patch,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 🔴 KEYSET PAGING PAST POSTGREST'S SILENT 1,000-ROW CEILING
// ─────────────────────────────────────────────────────────────────────────────

function runPagingTests(): void {
  assert.equal(TRAIL_READ_PAGE, 1_000, "the page size IS PostgREST's own ceiling — a larger number is silently cut to it");
  assert.ok(MAX_TRAIL_ROWS > TRAIL_READ_PAGE, "a day's ceiling must be more than one page, or the walk is pointless");
  assert.ok(MAX_SESSION_EVENTS > TRAIL_READ_PAGE, "and so must a session's, since a field-day page load passes 1,000 events");
  assert.ok(STREAM_PAGE > 0 && STREAM_PAGE < MAX_SESSION_EVENTS, "the stream draws a page at a time, not the whole session");
  assert.ok(TRAIL_DAYS_LISTED >= 7, "the picker must reach back at least a week");

  const code = stripComments(source(SERVICE));
  assert.match(code, /\.gt\("id", cursor\)/, "🔴 the walk steps a cursor on `id` — this is the whole defence against the silent cut");
  assert.match(code, /\.order\("id", \{ ascending: true \}\)/, "and it reads in `id` order, or a cursor means nothing");
  assert.match(code, /Math\.min\(TRAIL_READ_PAGE, remaining\)/, "no page may ask for more than the ceiling");
  assert.doesNotMatch(code, /\.range\(/, "🔴 no `range` walk: over a table still being written to it repeats and skips rows");
  assert.doesNotMatch(code, /\.offset\(/, "🔴 and no `offset` walk, for the same reason");
  assert.match(code, /if \(batch\.length < page\) break;/, "a short page ends the walk");
  assert.match(code, /if \(!Number\.isFinite\(lastId\) \|\| lastId <= cursor\)/, "a cursor that cannot advance stops, rather than spinning forever");
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 🔴 THE SUPER ADMIN'S ALONE — AND NEVER A TEST ACCOUNT
// ─────────────────────────────────────────────────────────────────────────────

function runGateTests(): void {
  assert.equal(canReadTouchTrail(SUPER_ADMIN), true, "the Super Admin reads the trail");
  assert.equal(canReadTouchTrail(SFE), false, "🔴 the SFE Manager does NOT — the trail holds what a rep typed and deleted");
  assert.equal(canReadTouchTrail(CEO), false, "and neither does the CEO");
  assert.equal(canReadTouchTrail(REP), false, "and a rep least of all — he must never learn the trail exists");
  assert.equal(
    canReadTouchTrail(viewerWith({ isSuperAdmin: true, canUpdate: true, isTestPersona: true })),
    false,
    "🔴 not a TEST persona mirroring the Super Admin either: a test account sees the test world only",
  );
  assert.equal(
    canReadTouchTrail(viewerWith({ isSuperAdmin: true, canUpdate: false })),
    false,
    "and not a Super Admin whose module grant was taken away",
  );

  const page = stripComments(source(PAGE));
  const gateOne = page.indexOf('canAccess(access, "phoenix_crm", "update")');
  assert.ok(gateOne !== -1, "the page asks the module grant first");
  assert.ok(gateOne < page.indexOf("resolvePhoenixCrmViewer("), "gate one comes before the organogram is read");
  assert.match(page, /if \(!viewer \|\| !canReadTouchTrail\(viewer\)\) redirect\("\/admin"\)/, "then the reader predicate, and a REDIRECT rather than a message");
  assert.match(stripComments(source(SERVICE)), /function assertReader\(viewer: PhoenixCrmViewer\): void \{\s*if \(!canReadTouchTrail\(viewer\)\) throw forbiddenError/, "and the service refuses on its own, never trusting the page to have asked");
  assert.equal(
    (stripComments(source(SERVICE)).match(/assertReader\(viewer\);/g) ?? []).length,
    2,
    "both loaders — the day and the session — call it; a new one that forgets is what this count catches",
  );

  const nav = source(NAV);
  assert.match(nav, /href: "\/admin\/field-crm\/touch-trail",/, "the nav card exists");
  const card = nav.slice(nav.indexOf('href: "/admin/field-crm/touch-trail",'));
  assert.match(card.slice(0, 600), /roles: \["Super Admin"\],/, "and it is offered to the Super Admin alone");
  assert.match(card.slice(0, 600), /permissions: \[\{ resource: "phoenix_crm", action: "update" \}\]/, "with the same grant the page asks for");
  assert.ok(
    nav.indexOf('"/admin/field-crm/touch-trail",', nav.indexOf("/admin/phoenix-crm/integrity")) !== -1,
    "and it is placed in a hub band — a card left out of every band is appended to the FIRST one under a heading nobody chose",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 🔴 A READER THAT COULD WRITE WOULD NOT BE EVIDENCE
// ─────────────────────────────────────────────────────────────────────────────

function runReadOnlyTests(): void {
  for (const path of [RULES, SERVICE, BOARD, PAGE]) {
    const code = stripComments(source(path));
    for (const write of [".insert(", ".update(", ".upsert(", ".delete("]) {
      assert.ok(!code.includes(write), `🔴 ${path} must never ${write} — the trail is read, never edited`);
    }
  }
  const service = stripComments(source(SERVICE));
  assert.ok(!service.includes("callPhoenixCrm("), "and it calls no RPC either: an RPC is a write door this page has no use for");
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. EVERY COLUMN THE READER NAMES EXISTS IN THE TABLE
//
// A PostgREST select is a STRING: one wrong column name fails the WHOLE read with a 42703, which the
// compiler cannot see and a grep will not catch. So the two projections are checked against the
// migration that created the table.
// ─────────────────────────────────────────────────────────────────────────────

function tableColumns(): Set<string> {
  const sql = stripSqlComments(source(MIGRATION));
  const start = sql.indexOf("create table if not exists public.phoenix_crm_touch_trail (");
  assert.ok(start !== -1, "the migration still creates the table by that name");
  const body = sql.slice(start, sql.indexOf("\n);", start));
  const columns = new Set<string>();
  for (const line of body.split("\n").slice(1)) {
    const match = /^\s{2}([a-z_]+)\s+(bigint|text|integer|boolean|date|timestamptz|numeric)/.exec(line);
    if (match?.[1]) columns.add(match[1]);
  }
  assert.ok(columns.size >= 20, `the column scan found only ${columns.size} — the migration's shape changed and this test is now blind`);
  return columns;
}

function runProjectionTests(): void {
  const code = source(SERVICE);
  const columns = tableColumns();
  const projections = [...code.matchAll(/const (SUMMARY_COLUMNS|STREAM_COLUMNS) =\s*\n?\s*"([^"]+)"/g)];
  assert.equal(projections.length, 2, "both projections are still declared as one string each");

  const named = new Map<string, string[]>();
  for (const [, name, list] of projections) {
    const parts = String(list)
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    for (const part of parts) {
      assert.ok(columns.has(part), `🔴 ${name} asks for "${part}", which the table does not have — that is a 42703 on the WHOLE read`);
    }
    named.set(String(name), parts);
  }

  const summary = named.get("SUMMARY_COLUMNS") ?? [];
  const stream = named.get("STREAM_COLUMNS") ?? [];
  assert.ok(!summary.includes("value"), "the day read leaves `value` behind — it is the heaviest column and the day view never prints it");
  assert.ok(summary.includes("value_length"), "but it keeps `value_length`, which is all a count of typed events needs");
  assert.ok(stream.includes("value"), "the stream does print what was typed, so it asks for it");
  for (const needed of ["id", "session_id", "occurred_at", "kind"]) {
    assert.ok(summary.includes(needed), `${needed} is what parseTrailRow refuses a row without, so every projection must carry it`);
    assert.ok(stream.includes(needed), `${needed} likewise in the stream projection`);
  }
  // Every column of the table is reachable somewhere, or part of the evidence has no reader at all.
  for (const column of columns) {
    if (column === "created_at") continue; // the insert's own stamp; `occurred_at` is the event's
    assert.ok(stream.includes(column), `🔴 "${column}" is stored and the stream never reads it — that part of the evidence is unreachable`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE DAY IS READ WHOLE AND NARROWED IN MEMORY
// ─────────────────────────────────────────────────────────────────────────────

function runWholeDayTests(): void {
  const code = stripComments(source(SERVICE));
  assert.match(code, /column: "visit_day",/, "the day read filters on the visit day");
  assert.ok(
    !/column: "actor_hr_id"/.test(code) && !/\.eq\("actor_hr_id"/.test(code),
    "🔴 and never on the person: a rep filter in the QUERY would shrink the people list to the person already chosen, so the filter could never be widened again",
  );
  assert.match(code, /const kept = wanted \? rows\.filter\(\(row\) => personKey\(row\.actorHrId\) === wanted\) : rows;/, "the narrowing happens in memory, after the whole day is in hand");
  assert.ok(
    code.indexOf("const names = await loadPeopleNames(rows.map((row) => row.actorHrId));") < code.indexOf("const kept ="),
    "and the people list is built from ALL the day's rows, before the narrowing",
  );
  assert.match(code, /nameOf\(names, session\.actorHrId\)/, "names, never HR codes, reach the screen");
  assert.match(code, /territoryName\(seat\)/, "and a seat id becomes its territory's name");
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. THE SERVER'S CLOCK AND THE DEVICE'S ARE TWO FACTS, NEVER AVERAGED
// ─────────────────────────────────────────────────────────────────────────────

function runSummaryTests(): void {
  const rows: TouchTrailRow[] = [
    row({ id: 3, msSinceLoad: 2_400, kind: "type", value: "Dr Hassan", valueLength: 9, screen: "visit", viewportW: 375, viewportH: 633 }),
    row({ id: 1, msSinceLoad: 0, kind: "screen", screen: "day", viewportW: 375, viewportH: 697, seatId: "SEAT-PED-REP-D15" }),
    row({ id: 2, msSinceLoad: 900, kind: "tap", screen: "day", viewportW: 375, viewportH: 697 }),
    row({ id: 4, msSinceLoad: 61_000, kind: "tap", screen: "visit", occurredAt: "2026-10-03T21:01:05.000Z", viewportW: 375, viewportH: 633 }),
    row({ id: 9, sessionId: "s2", msSinceLoad: 10, kind: "tap", occurredAt: "2026-10-03T22:00:00.000Z", isTest: true }),
  ];

  const sessions = summariseSessions(rows);
  assert.equal(sessions.length, 2, "one summary per page load");
  assert.equal(sessions[0]?.sessionId, "s2", "the most recently active session is first");

  const first = sessions[1];
  assert.ok(first, "the earlier session is still summarised");
  assert.equal(first.events, 4, "every event of it is counted");
  assert.equal(first.firstAt, "2026-10-03T21:00:00.000Z", "the first arrival");
  assert.equal(first.lastAt, "2026-10-03T21:01:05.000Z", "and the last");
  assert.equal(first.onScreenMs, 61_000, "the load was open for as long as its furthest `ms_since_load`");
  assert.deepEqual([...first.screens], ["day", "visit"], "screens in the order they were FIRST seen — the route he took");
  assert.deepEqual([...first.viewports], ["375x697", "375x633"], "both viewports, in order: a phone's address bar collapsing makes two");
  assert.equal(first.typed, 1, "one event carried something he had typed");
  assert.equal(first.seatId, "SEAT-PED-REP-D15", "the seat is the SESSION's, taken from the row that named one");
  assert.equal(first.isTest, false, "and this one is not a test account");
  assert.equal(sessions[0]?.isTest, true, "while that one is, and is listed rather than hidden");
  assert.deepEqual(
    first.kinds.map((entry) => entry.kind),
    ["tap", "screen", "type"],
    "kinds busiest first, then alphabetically — so the shape of the session reads at a glance",
  );
  assert.equal(first.kinds[0]?.count, 2, "with its real count");

  // A seat null everywhere is CORRECT, not a hole: it lives only in the `day/<seat>/<date>` route.
  assert.equal(summariseSessions([row({ seatId: null })])[0]?.seatId, null, "a session that never named a seat reports none");

  // 🔴 The MINIMUM gap, because the flush wait can only inflate it (up to FLUSH_EVERY_MS plus network).
  const skewed = summariseSessions([
    row({ id: 1, deviceAt: "2026-10-03T20:59:56.000Z" }), // 4 s behind its arrival — the flush
    row({ id: 2, deviceAt: "2026-10-03T20:59:51.000Z" }), // 9 s behind — a fuller buffer
  ]);
  assert.equal(skewed[0]?.deviceClockOffMs, 4_000, "🔴 the CLOSEST an event's own stamp came to its arrival — never an average, which the flush would poison");
  assert.equal(summariseSessions([row({ deviceAt: null })])[0]?.deviceClockOffMs, null, "and null when no event carried a device stamp at all");

  assert.equal(deviceClockNote(4_000), null, "four seconds is the flush working — nothing is said");
  assert.equal(deviceClockNote(FLUSH_EVERY_MS), null, "and so is the flush interval exactly");
  assert.equal(deviceClockNote(DEVICE_CLOCK_GRACE_MS), null, "up to the grace, nothing is said");
  assert.match(String(deviceClockNote(DEVICE_CLOCK_GRACE_MS + 1_000)), /behind the server/, "past it, the phone's clock is named");
  assert.match(String(deviceClockNote(-30_000)), /ahead of the server/, "and ANY lag the other way is named — an event cannot arrive before it happened");
  assert.equal(deviceClockNote(null), null, "nothing to say about a session that sent no device stamp");
  assert.ok(DEVICE_CLOCK_GRACE_MS > FLUSH_EVERY_MS, "the grace must cover the flush wait, or every session would be flagged");
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. A ROW THAT WILL NOT PARSE IS DROPPED AND COUNTED, NEVER THROWN OVER
// ─────────────────────────────────────────────────────────────────────────────

function runParseTests(): void {
  const parsed = parseTrailRow({
    actor_hr_id: "B-158",
    device_at: "2026-10-03T21:29:58.000Z",
    element: "button[type=submit]@save-visit",
    element_label: "Save the visit",
    id: "412",
    is_test: false,
    kind: "press",
    ms_since_load: "2400",
    occurred_at: "2026-10-03T21:30:02.000Z",
    pointer_x: 188,
    pointer_y: 540,
    route: "/employee-portals/field-crm/day/SEAT-PED-REP-D15/2026-10-03",
    screen: "visit",
    seat_id: "SEAT-PED-REP-D15",
    session_id: "abc",
    value: "  kept exactly as typed  ",
    value_length: 25,
    viewport_h: 633,
    viewport_w: 375,
    visit_day: "2026-10-03",
  });
  assert.ok(parsed, "a full row parses");
  assert.equal(parsed.id, 412, "a numeric id arriving as a string is read as a number — PostgREST sends a bigint as text");
  assert.equal(parsed.msSinceLoad, 2_400, "and so is the elapsed time");
  assert.equal(parsed.value, "  kept exactly as typed  ", "🔴 what the rep typed is returned UNTOUCHED — trimming it would edit the evidence");
  assert.equal(parsed.elementLabel, "Save the visit", "and `element_label` becomes `elementLabel` — the human words he read");
  assert.equal(parsed.element, "button[type=submit]@save-visit", "under the element identity a restyle cannot rename");

  for (const missing of [
    { label: "no id", patch: { id: null } },
    { label: "no session", patch: { session_id: "   " } },
    { label: "no arrival", patch: { occurred_at: null } },
    { label: "no kind", patch: { kind: "" } },
  ]) {
    const raw = { id: 1, kind: "tap", occurred_at: "2026-10-03T21:00:00.000Z", session_id: "s1", ...missing.patch };
    assert.equal(parseTrailRow(raw), null, `a row with ${missing.label} is dropped, so the caller can COUNT it`);
  }
  for (const rubbish of [null, undefined, 7, "a string", [], {}]) {
    assert.equal(parseTrailRow(rubbish), null, "and anything unreadable is dropped rather than thrown over");
  }

  const code = stripComments(source(SERVICE));
  assert.match(code, /else unreadable \+= 1;/, "the walk counts what it dropped");
  assert.match(code, /unreadable,/, "and hands the count to the screen");
  const board = stripComments(source(BOARD));
  assert.match(board, /view\.unreadable > 0/, "🔴 which SAYS it, because a silent drop is the one thing the trail must not do");
  assert.match(board, /view\.partial/, "and a day longer than one read says that too");
  assert.match(board, /session\.total > session\.events\.length/, "and a session past the stream cap names its true length");
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. THE ORDER WITHIN A PAGE LOAD IS `ms_since_load`, NOT THE SERVER STAMP
// ─────────────────────────────────────────────────────────────────────────────

function runOrderTests(): void {
  // Two reasons the server stamp cannot order a session, and this case holds BOTH. Forty events share
  // one arrival, so equal stamps say nothing; and the collector queues events while the phone is
  // offline, so an EARLY event can arrive in a much LATER batch — which is why the ids here are
  // written in arrival order and the elapsed times disagree with it.
  const ordered = orderWithinSession([
    row({ id: 3, msSinceLoad: 2_400, occurredAt: "2026-10-03T21:30:02.000Z" }),
    row({ id: 4, msSinceLoad: 100, occurredAt: "2026-10-03T21:35:00.000Z" }), // queued offline, flushed late
    row({ id: 2, msSinceLoad: 900, occurredAt: "2026-10-03T21:30:02.000Z" }),
  ]);
  assert.deepEqual(
    ordered.map((entry) => entry.id),
    [4, 2, 3],
    "🔴 `ms_since_load` orders a page load, NEVER the arrival — an event queued offline arrives last and happened first",
  );

  const fallback = orderWithinSession([row({ id: 7, msSinceLoad: null }), row({ id: 2, msSinceLoad: null })]);
  assert.deepEqual(
    fallback.map((entry) => entry.id),
    [2, 7],
    "a row with no elapsed time falls back to its id — at least the order it was written",
  );
  assert.deepEqual(orderWithinSession([]).length, 0, "an empty session sorts to nothing rather than throwing");

  const service = stripComments(source(SERVICE));
  assert.match(service, /orderWithinSession\(rows\)/, "the session loader uses that one ordering, rather than a second copy of it");
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. CAIRO, TO THE SECOND, AND NEVER AN ELLIPSIS
// ─────────────────────────────────────────────────────────────────────────────

function runFormatTests(): void {
  // 3 Oct 2026 is inside Egypt's summer time (UTC+3), so 18:32:07Z is 21:32:07 in Cairo. A
  // hand-written offset would be an hour wrong for the other half of the year — hence the January case.
  assert.equal(cairoClock("2026-10-03T18:32:07.000Z"), "21:32:07", "a Cairo clock to the second, in summer time");
  assert.equal(cairoClock("2026-01-15T19:32:07.000Z"), "21:32:07", "🔴 and in WINTER, where the offset is +2 — which is why the zone is named, never an offset");
  assert.equal(cairoClock(null), "—", "nothing to show for a missing instant");
  assert.equal(cairoClock("not a date"), "—", "or an unreadable one");

  assert.equal(durationText(48_000), "48 s", "under a minute reads in seconds");
  assert.equal(durationText(252_000), "4 m 12 s", "then in minutes and seconds");
  assert.equal(durationText(3_960_000), "1 h 06 m", "and in hours, with the minutes padded");
  assert.equal(durationText(null), "—", "and a missing span shows nothing");
  assert.equal(durationText(-5), "—", "a negative one likewise, rather than a nonsense figure");

  assert.equal(sinceLoadText(12_480), "0:12.480", "where in the load an event fell, to the millisecond");
  assert.equal(sinceLoadText(61_000), "1:01.000", "past a minute too");
  assert.equal(sinceLoadText(7), "0:00.007", "and seven milliseconds in");
  assert.equal(sinceLoadText(null), "—", "nothing for a row that carried no elapsed time");

  assert.equal(kindWords("press"), "Press", "a kind reads as words");
  assert.equal(kindWords("offline"), "Lost the network", "including the ones a code would hide");
  assert.equal(kindWords("something-new"), "something-new", "and an unknown kind reads as ITSELF rather than vanishing");

  // Comments are stripped first: the page quotes the owner, and an ellipsis inside HIS words is not a
  // truncation on the screen. The inverse of that trap — a comment SATISFYING a source assertion — is
  // why every other check in this file strips them too.
  for (const path of [RULES, BOARD, PAGE]) {
    const text = stripComments(source(path));
    assert.ok(!text.includes("…"), `🔴 ${path} must render no ellipsis — a trail is read for what the rep actually typed`);
    assert.ok(!/\btruncate\b/.test(text), `and ${path} must not truncate a cell with CSS either`);
  }
  const board = stripComments(source(BOARD));
  assert.ok(!board.includes("overflow-x"), "🔴 no horizontal scroller: the fits-the-screen rule says fit by MERGING columns");
  assert.ok(!/min-w-\[/.test(board), "and no min-width on a cell, which is the other half of that bug");
  assert.equal((board.match(/<CrmCardsOnPhone>/g) ?? []).length, 2, "each of the two tables draws the same rows as CARDS on a phone");

  // 🔴 ONE ARRAY FEEDS THE COLGROUP AND THE HEADER ROW, so they cannot disagree by construction —
  // the shape `tests/phoenix-crm-fits-the-screen.test.ts` requires where the widths come from a
  // spread. That guard can then no longer read the percentages, so the SUM is asserted here, and
  // exactly rather than merely under 100: under `table-fixed` anything over it leaves the box, and
  // `.admin-shell`'s `overflow-x: clip` cuts the excess instead of scrolling it.
  const declared = source(BOARD);
  for (const name of ["SESSION_COLUMNS", "EVENT_COLUMNS"]) {
    // A plain substring, not a built regex: the shape being pinned is full of regex metacharacters
    // and an over-escaped pattern fails on correct source, which is a false alarm rather than a guard.
    assert.ok(
      board.includes(`<CrmTable columns={[...${name}.map((column) => column.width)]}>`),
      `${name} feeds the colgroup by mapping its own widths`,
    );
    const block = declared.slice(declared.indexOf(`const ${name} = [`), declared.indexOf("] as const;", declared.indexOf(`const ${name} = [`)));
    const widths = [...block.matchAll(/width: "(\d+)%"/g)].map((match) => Number(match[1]));
    const heads = [...block.matchAll(/head: "([^"]+)"/g)].map((match) => match[1]);
    assert.ok(widths.length >= 4, `${name} still declares its widths as percentages (found ${widths.length})`);
    assert.equal(widths.length, heads.length, `${name} declares one head per width — which is the point of the single array`);
    assert.equal(
      widths.reduce((sum, width) => sum + width, 0),
      100,
      `🔴 ${name} must sum to exactly 100% — over it the table leaves its box and the overflow is CLIPPED, not scrolled`,
    );
  }
  assert.match(board, /function ColumnHeads\(\{ columns \}/, "and the header row is mapped from that array, never written out by hand");
  assert.equal((board.match(/<ColumnHeads columns=/g) ?? []).length, 2, "for both tables");
  assert.ok(!/<th className=\{crmThClassName\}>[A-Z]/.test(board), "🔴 no hand-written header cell may come back — that is the drift the single array removes");
}

export function runPhoenixCrmTouchTrailReaderTests(): void {
  const sections: Array<[string, () => void]> = [
    ["1 · keyset paging past the 1,000-row ceiling", runPagingTests],
    ["2 · the Super Admin's alone", runGateTests],
    ["3 · the reader never writes", runReadOnlyTests],
    ["4 · every column it names exists", runProjectionTests],
    ["5 · the day is read whole, narrowed in memory", runWholeDayTests],
    ["6 · the two clocks are never averaged", runSummaryTests],
    ["7 · a dropped row is counted out loud", runParseTests],
    ["8 · the order within a page load", runOrderTests],
    ["9 · Cairo to the second, no ellipsis", runFormatTests],
  ];
  const failures: string[] = [];
  for (const [name, run] of sections) {
    try {
      run();
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // The day picker's own default, checked here because it needs a viewer rather than a fixture row.
  try {
    assert.equal(trailDayOrToday(undefined, SUPER_ADMIN), "2026-10-03", "with no day in the query string, the viewer's own VISIT day — which ends at 02:00, so an evening of taps files on the day it was worked");
    assert.equal(trailDayOrToday("2026-09-30", SUPER_ADMIN), "2026-09-30", "a real day is taken as given");
    assert.throws(() => trailDayOrToday("yesterday", SUPER_ADMIN), /not a day/, "and anything else is refused rather than guessed at");
    assert.throws(() => trailDayOrToday("2026-13-45", SUPER_ADMIN), /not a day/, "including a date-shaped string that is not a date");
  } catch (error) {
    failures.push(`10 · the day picker's default: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (failures.length > 0) {
    throw new Error(`phoenix-crm touch trail reader:\n  - ${failures.join("\n  - ")}`);
  }
}
