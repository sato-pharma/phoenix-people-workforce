import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { _resetSharedReadCache, getOrLoadShared } from "../src/lib/cache/shared-read.ts";
import {
  dropSharedReadinessAfter,
  READINESS_SHARED_COPY,
  READINESS_SHARED_LIMITS,
  READINESS_STAMP_FRESH_MS,
  READINESS_WRITERS,
  readinessStamps,
} from "../src/lib/phoenix-crm/server/readiness-reuse.ts";
import { fetchAllRowsKeyset } from "../src/lib/supabase/paginated.ts";
import { stripComments } from "./support/comment-strip.ts";

// 19 Nov 2026 performance audit. `phoenix_crm_seat_readiness` was the heaviest Phoenix CRM statement on
// production (22,228 calls since 1 Nov, 121 ms and 6,048 disk blocks each). Three callers made it:
// every plan save's stamp, every planner open (whose screens never drew the figure), and the display
// boards measuring every territory beneath the viewer on every open. Nothing on a screen changes when
// any of the three cuts go wrong — measuring every time again is only slow, and a copy kept past a
// write is only a stale figure on a board — so nothing on a screen can catch it. These are that signal.

function source(path: string): string {
  return stripComments(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
}

/** A top-level function's text, from its declaration to the first column-0 closing brace. */
function functionBody(text: string, declaration: string): string {
  const start = text.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} must still exist`);
  const rest = text.slice(start);
  const end = rest.indexOf("\n}\n");
  return rest.slice(0, end > 0 ? end : rest.length);
}

type Seat = { seatId: string; open: number };

type IdRow = { id: string | null };
type FakePage = { data: IdRow[]; error: null };
/** The few calls fetchAllRowsKeyset makes on a PostgREST builder, typed so the fake can name itself. */
type FakeQuery = {
  order: () => FakeQuery;
  limit: (value: number) => FakeQuery;
  gt: (column: string, value: string) => FakeQuery;
  then: (resolve: (value: FakePage) => void) => void;
};

async function sharedCopyIsDroppedByAListWriteOnly(): Promise<void> {
  _resetSharedReadCache();
  let loads = 0;
  const load = async (): Promise<Seat[]> => {
    loads += 1;
    return [{ seatId: "s1", open: loads }];
  };
  const read = () => getOrLoadShared<Seat>(READINESS_SHARED_COPY, "s1", load, READINESS_SHARED_LIMITS);

  assert.equal((await read()).cache, "miss", "the first open measures");
  assert.equal((await read()).cache, "hit", "a second open inside the minute is served the copy");
  assert.equal(loads, 1);

  // A visit save is not a readiness write: the copy stands.
  dropSharedReadinessAfter("phoenix_crm_save_visit");
  dropSharedReadinessAfter("phoenix_crm_save_plan");
  assert.equal((await read()).cache, "hit", "a write that changes no list count keeps the copy");

  // Validation moves a customer from open to validated: the next open measures again.
  dropSharedReadinessAfter("phoenix_crm_validate_customer");
  const after = await read();
  assert.equal(after.cache, "miss", "REGRESSION: a validation must drop the boards' readiness copy at once");
  assert.equal(after.rows?.[0]?.open, 2, "and the board reads the new measurement");

  for (const fn of [
    "phoenix_crm_validate_customer",
    "phoenix_crm_decide_validation_review",
    "phoenix_crm_restore_validation",
    "phoenix_crm_share_line_validation",
    "phoenix_crm_create_request",
    "phoenix_crm_decide_request",
    "phoenix_crm_withdraw_request",
    "phoenix_crm_reverse_list_request",
    "phoenix_crm_move_customer",
    "phoenix_crm_load_list_customers",
    "phoenix_crm_place_on_trusted_point",
    "phoenix_crm_decide_shared_place",
    "phoenix_crm_restore_shared_place",
    "phoenix_crm_seat_places_in_venue",
    "phoenix_crm_settle_venue_timetable",
    "phoenix_crm_update_place",
  ]) {
    assert.ok(READINESS_WRITERS.has(fn), `${fn} changes what a list counts, so it drops the readiness copy`);
  }
  assert.ok(!READINESS_WRITERS.has("phoenix_crm_save_visit"), "a visit save (about 500 a day) never drops it");
  assert.ok(!READINESS_WRITERS.has("phoenix_crm_save_plan"), "nor does a plan save");
  _resetSharedReadCache();
}

async function aFailedMeasurementIsNeverKept(): Promise<void> {
  _resetSharedReadCache();
  let calls = 0;
  const failing = async (): Promise<Seat[]> => {
    calls += 1;
    throw new Error("phoenix_crm_seat_readiness answered no row for 1 of 1 territories");
  };
  await assert.rejects(getOrLoadShared<Seat>(READINESS_SHARED_COPY, "s9", failing, READINESS_SHARED_LIMITS));
  await assert.rejects(getOrLoadShared<Seat>(READINESS_SHARED_COPY, "s9", failing, READINESS_SHARED_LIMITS));
  assert.equal(calls, 2, "a failure is thrown to the board and the next open measures again");
  _resetSharedReadCache();
}

async function theSaveStampRunsOncePerTerritoryInFiveMinutes(): Promise<void> {
  readinessStamps.reset();
  assert.equal(READINESS_STAMP_FRESH_MS, 5 * 60_000, "five minutes, the planners' own mint window");
  let stamps = 0;
  const stamp = async () => {
    stamps += 1;
  };
  await readinessStamps.run("seat-a", stamp);
  await readinessStamps.run("seat-a", stamp);
  await readinessStamps.run("seat-a", stamp);
  assert.equal(stamps, 1, "REGRESSION: three saves of one week inside five minutes measure the list once");
  await readinessStamps.run("seat-b", stamp);
  assert.equal(stamps, 2, "another territory is its own key");

  // A visit save is no list write: the stamps stand.
  dropSharedReadinessAfter("phoenix_crm_save_visit");
  await readinessStamps.run("seat-a", stamp);
  assert.equal(stamps, 2, "a write that changes no list count keeps the throttle");
  // A validation may have completed a list, so the next save of EVERY territory measures it at once —
  // otherwise "Ready since" would wait for a save after the five minutes, maybe the next week.
  dropSharedReadinessAfter("phoenix_crm_validate_customer");
  await readinessStamps.run("seat-a", stamp);
  await readinessStamps.run("seat-b", stamp);
  assert.equal(stamps, 4, "REGRESSION: a list write must clear every save stamp, so the next save stamps the completed list");
  await readinessStamps.run("seat-a", stamp);
  assert.equal(stamps, 4, "and the throttle holds again after that save");

  let failures = 0;
  const failing = async () => {
    failures += 1;
    throw new Error("timeout");
  };
  await assert.rejects(readinessStamps.run("seat-c", failing));
  await assert.rejects(readinessStamps.run("seat-c", failing));
  assert.equal(failures, 2, "a failed stamp is never remembered, so the next save stamps again");
  readinessStamps.reset();
}

function theWiringStaysWhereItIs(): void {
  // The write door drops the copy after the write succeeded, never before and never on a refusal.
  const door = functionBody(source("src/lib/phoenix-crm/server/db.ts"), "export async function callPhoenixCrm<T>(");
  const refused = door.indexOf("throw phoenixCrmRefusal(error) ?? error;");
  const dropped = door.indexOf("dropSharedReadinessAfter(fn);");
  assert.ok(refused > 0 && dropped > refused, "REGRESSION: the write door must drop the readiness copy after every successful write");

  // The display boards read the copy.
  const team = source("src/lib/phoenix-crm/server/team.ts");
  assert.ok(team.includes(": loadReadinessShared(seatIds),"), "the Team tab reads the minute-old copy");
  assert.ok(!/[^.\w]loadReadiness\(/.test(team), "and never measures every territory itself");
  const needsYou = source("src/lib/phoenix-crm/server/needs-you.ts");
  assert.ok(needsYou.includes(": loadReadinessShared(seatIds),"), "the Needs you board reads the same copy");

  // The digest is a notification: it measures live.
  const exceptions = source("src/lib/phoenix-crm/server/exceptions.ts");
  const shared = functionBody(exceptions, "export function sharedReadiness(");
  assert.ok(shared.includes("if (options.reuseRecent) return loadReadinessShared(seatIds);"), "only an opted-in caller gets the copy");
  assert.ok(shared.includes("shareInFlight(key, () => loadReadiness(seatIds))"), "everyone else measures live");
  assert.ok(!source("src/lib/phoenix-crm/server/daily-digest.ts").includes("reuseRecentReadiness"), "REGRESSION: the 06:55 digest must never read a kept copy");

  // The shared read keeps loadReadiness's contract: every territory asked about, or it throws.
  const sharedRead = functionBody(source("src/lib/phoenix-crm/server/list.ts"), "export async function loadReadinessShared(");
  assert.ok(sharedRead.includes("async () => [...(await loadReadiness(asked)).values()]"), "the copy is loadReadiness's own answer");
  assert.ok(sharedRead.includes("throw new Error("), "a copy missing a territory throws rather than reading as ready");

  // No planner open measures readiness; the save stamp goes through the throttle.
  for (const [path, declaration] of [
    ["src/lib/phoenix-crm/server/plans.ts", "export async function loadPlanner("],
    ["src/lib/phoenix-crm/server/monthly-plans.ts", "export async function loadMonthlyPlanner("],
  ] as const) {
    const planner = functionBody(source(path), declaration);
    assert.ok(!/territoryReadiness\(|loadReadiness\(/.test(planner), `REGRESSION: ${declaration} measures the list for a figure no planner screen draws`);
  }
  const plans = source("src/lib/phoenix-crm/server/plans.ts");
  assert.ok(
    plans.includes('afterResponse("phoenix_crm_plan_save_readiness_stamp", () => stampTerritoryReadyRecently(seat.seatId))'),
    "the save stamp runs after the answer, through the five-minute throttle",
  );
  assert.ok(
    functionBody(plans, "export function stampTerritoryReadyRecently(").includes("readinessStamps.run(seatId, () => territoryReadiness(seatId, false, true))"),
    "the throttle wraps the stamping measurement itself",
  );
}

async function theWorkEvidenceWalkSeeksOnId(): Promise<void> {
  // The keyset pager the work-evidence loader now uses, on uuid ids: every row once, in order, and a
  // row with no id throws rather than ending the walk short (a short list charges a worked day).
  const ids = Array.from({ length: 2_345 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
  const asked: Array<string | null> = [];
  const build = () => {
    let cursor: string | null = null;
    let limit = 0;
    const query: FakeQuery = {
      order: () => query,
      limit: (value: number) => {
        limit = value;
        return query;
      },
      gt: (_column: string, value: string) => {
        cursor = value;
        return query;
      },
      then: (resolve) => {
        asked.push(cursor);
        const rest = ids.filter((id) => cursor === null || id > cursor);
        resolve({ data: rest.slice(0, limit).map((id) => ({ id })), error: null });
      },
    };
    return query;
  };
  const cursorOf = (row: IdRow) => {
    if (typeof row.id === "string" && row.id) return row.id;
    throw new Error("a row came back without its id");
  };
  const rows = await fetchAllRowsKeyset<IdRow>(build, { cursorColumn: "id", cursorOf, pageSize: 1_000 });
  assert.equal(rows.length, ids.length, "every row of the window, none twice");
  assert.deepEqual(asked, [null, ids[999], ids[1999]], "each page seeks past the last id it saw — no OFFSET");

  const broken = () => {
    const query: FakeQuery = {
      order: () => query,
      limit: () => query,
      gt: () => query,
      then: (resolve) =>
        resolve({ data: Array.from({ length: 1_000 }, (_, index) => ({ id: index === 999 ? null : ids[index] })), error: null }),
    };
    return query;
  };
  await assert.rejects(
    fetchAllRowsKeyset<IdRow>(broken, { cursorColumn: "id", cursorOf, pageSize: 1_000 }),
    /without its id/,
    "REGRESSION: a full page ending in a row with no id must throw, never return the first page as the whole window",
  );
}

export async function runPhoenixCrmReadinessReuseTests(): Promise<void> {
  await sharedCopyIsDroppedByAListWriteOnly();
  await aFailedMeasurementIsNeverKept();
  await theSaveStampRunsOncePerTerritoryInFiveMinutes();
  theWiringStaysWhereItIs();
  await theWorkEvidenceWalkSeeksOnId();
}
