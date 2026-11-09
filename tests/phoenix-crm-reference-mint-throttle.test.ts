import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createRecentOnce } from "../src/lib/phoenix-crm/server/recent-once.ts";
import { stripComments } from "./support/comment-strip.ts";

// 2026-10-23, every page change under 1 second. The monthly planner and the week's plan minted the
// territory's carried-over customers on EVERY open and read no customer until the mint answered — a
// whole database hop in front of the page for a mint that finds nothing new on almost every open.
// They now go through `ensureReferenceCustomersRecently` (src/lib/phoenix-crm/server/list.ts): a seat
// minted successfully in the last five minutes answers at once, built on `createRecentOnce`
// (src/lib/phoenix-crm/server/recent-once.ts). Nothing on a screen changes, so nothing on a screen can
// catch the throttle going wrong in either direction — minting every time again (slow), or skipping
// a first mint or remembering a failed one (a new iReports360 customer missing from the planner).
// These are that signal.

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

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function settled(promise: Promise<unknown>): Promise<"resolved" | "pending" | "rejected"> {
  let state: "resolved" | "pending" | "rejected" = "pending";
  promise.then(
    () => {
      state = "resolved";
    },
    () => {
      state = "rejected";
    },
  );
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  return state;
}

export async function runPhoenixCrmReferenceMintThrottleTests(): Promise<void> {
  // ── the throttle's own behaviour ─────────────────────────────────────────────────────────────
  {
    let clock = 1_000_000;
    const once = createRecentOnce({ freshMs: 5 * 60_000, maxKeys: 3, now: () => clock });
    let runs = 0;
    const work = async () => {
      runs += 1;
    };

    // The first open has no stamp: the work runs, and the caller waits on it.
    const gate = deferred();
    const first = once.run("seat-1|CNS|live", () => {
      runs += 1;
      return gate.promise;
    });
    assert.equal(runs, 1, "the first open mints");
    assert.equal(await settled(first), "pending", "and the caller waits on that mint before it reads");

    // A second open while the first mint runs joins it — one mint, not two.
    const joined = once.run("seat-1|CNS|live", work);
    assert.equal(runs, 1, "a mint already running is joined, never repeated");
    gate.resolve();
    await first;
    await joined;
    assert.equal(once.isFresh("seat-1|CNS|live"), true, "a mint that succeeded is stamped");

    // Inside the window: an already-settled promise, and no mint.
    clock += 4 * 60_000;
    const fresh = once.run("seat-1|CNS|live", work);
    assert.equal(runs, 1, "inside five minutes the mint is skipped");
    assert.equal(await settled(fresh), "resolved", "and the caller's reads start at once");

    // Past the window: it mints again.
    clock += 60_000;
    await once.run("seat-1|CNS|live", work);
    assert.equal(runs, 2, "at five minutes the stamp has expired and the next open mints");

    // Another seat, the same seat on a different line or in the test world is its own key.
    await once.run("seat-1|CNS|test", work);
    await once.run("seat-2|CNS|live", work);
    assert.equal(runs, 4, "each seat, line and world mints on its own");
  }

  // A failed mint is never remembered as done.
  {
    let clock = 0;
    const once = createRecentOnce({ freshMs: 5 * 60_000, maxKeys: 10, now: () => clock });
    let runs = 0;
    await assert.rejects(
      once.run("seat-1|CNS|live", async () => {
        runs += 1;
        throw new Error("mint failed");
      }),
      /mint failed/,
      "the mint's own failure still reaches the caller",
    );
    assert.equal(once.isFresh("seat-1|CNS|live"), false, "a failed mint leaves no stamp");
    clock += 1_000;
    await once.run("seat-1|CNS|live", async () => {
      runs += 1;
    });
    assert.equal(runs, 2, "so the very next open mints again");

    // A work function that throws before it returns a promise is a failure too, never a stamp.
    await assert.rejects(
      once.run("seat-9|CNS|live", () => {
        throw new Error("threw synchronously");
      }),
      /threw synchronously/,
    );
    assert.equal(once.isFresh("seat-9|CNS|live"), false, "a synchronous throw leaves no stamp either");
  }

  // `stamp` records a mint made elsewhere (the List's own unthrottled mint); `forget` undoes stamps,
  // including the one a mint already in flight would have taken.
  {
    const clock = 0;
    const once = createRecentOnce({ freshMs: 5 * 60_000, maxKeys: 10, now: () => clock });
    let runs = 0;
    once.stamp("seat-1|CNS|live");
    await once.run("seat-1|CNS|live", async () => {
      runs += 1;
    });
    assert.equal(runs, 0, "a mint the List just made lets the planner skip its own");

    once.forget((key) => key.startsWith("seat-1|"));
    await once.run("seat-1|CNS|live", async () => {
      runs += 1;
    });
    assert.equal(runs, 1, "after a move the planner mints again on its next open");

    once.forget(() => true);
    const gate = deferred();
    const inFlight = once.run("seat-2|CNS|live", () => gate.promise);
    once.forget((key) => key.startsWith("seat-2|"));
    gate.resolve();
    await inFlight;
    assert.equal(once.isFresh("seat-2|CNS|live"), false, "a mint that started before the forget is not stamped");

    const before = once.generation();
    once.forget((key) => key.startsWith("seat-3|"));
    once.stamp("seat-3|CNS|live", before);
    assert.equal(once.isFresh("seat-3|CNS|live"), false, "nor is an outside mint that started before it");
    once.stamp("seat-3|CNS|live", once.generation());
    assert.equal(once.isFresh("seat-3|CNS|live"), true, "an outside mint that started after it is");
  }

  // Bounded: past the cap the OLDEST stamp goes, which only ever costs one extra mint.
  {
    let clock = 0;
    const once = createRecentOnce({ freshMs: 5 * 60_000, maxKeys: 2, now: () => clock });
    once.stamp("a");
    clock += 1;
    once.stamp("b");
    clock += 1;
    once.stamp("a"); // re-stamping moves "a" to the back
    clock += 1;
    once.stamp("c");
    assert.equal(once.isFresh("b"), false, "the oldest stamp is evicted first");
    assert.equal(once.isFresh("a"), true, "a re-stamped key is young again");
    assert.equal(once.isFresh("c"), true, "and the newest stays");
  }

  // ── the wiring ───────────────────────────────────────────────────────────────────────────────
  {
    const list = source("src/lib/phoenix-crm/server/list.ts");
    const recently = functionBody(list, "export function ensureReferenceCustomersRecently(");
    assert.match(recently, /referenceMints\.run\(referenceMintKey\(seat\.seatId, lineCode, isTest\)/, "the planners' mint goes through the throttle, keyed by seat, line and world");
    assert.match(recently, /if \(!lineCode\) return Promise\.resolve\(\);/, "a seat with no line mints nothing, exactly as before");
    assert.match(list, /REFERENCE_MINT_FRESH_MS = 5 \* 60_000;/, "five minutes, as agreed");

    const always = functionBody(list, "export async function ensureReferenceCustomers(");
    assert.match(always, /await mintReferenceCustomers\(seat, isTest\);/, "missed records still mints on every read (since 1 Nov 2026 the List and the visit form go through the throttle)");
    assertBeforeText(always, "await mintReferenceCustomers(seat, isTest);", "referenceMints.stamp(", "and stamp only after the mint succeeded");

    const move = functionBody(list, "export async function moveCustomerToSeat(");
    assertBeforeText(move, 'callPhoenixCrm<Row>("phoenix_crm_move_customer"', "forgetReferenceMints([seat.seatId, toSeatId]);", "a move forgets both seats' stamps once it has landed");

    // The read-side wrapper (2026-11-09, a test login reads the real field force): the same throttle,
    // and nothing minted when a test login reads a real territory — it writes nothing real.
    const forView = functionBody(list, "export function ensureReferenceCustomersForView(");
    assert.match(forView, /if \(viewer\.isTestPersona && !isTest\) return Promise\.resolve\(\);/, "a test login's read of a real territory mints nothing");
    assert.match(forView, /return ensureReferenceCustomersRecently\(seat, isTest\);/, "everyone else's read mints through the throttle, as before");

    for (const [file, declaration, mint] of [
      ["src/lib/phoenix-crm/server/plans.ts", "export async function loadPlanner(", "ensureReferenceCustomersForView(viewer, seat, isTest)"],
      ["src/lib/phoenix-crm/server/monthly-plans.ts", "export async function loadMonthlyPlanner(", "ensureReferenceCustomersForView(viewer, seat, isTest)"],
      // 1 Nov 2026 (the speed root cause): the List and Add Visit too — the two screens a rep opens most.
      ["src/lib/phoenix-crm/server/list.ts", "export async function loadTerritoryList(", "ensureReferenceCustomersForView(viewer, seat, isTest)"],
      ["src/lib/phoenix-crm/server/visits.ts", "export async function loadVisitForm(", "ensureReferenceCustomersRecently(seat, isTest)"],
    ] as const) {
      const body = functionBody(source(file), declaration);
      assert.ok(body.includes(`const ensured = ${mint};`), `${declaration} mints through the throttle`);
      assert.doesNotMatch(body, /ensureReferenceCustomers\(seat/, `${declaration} never runs the every-time mint`);
      assert.match(body, /ensured\.then\(\(\) => loadTerritoryCustomers\(/, `${declaration} still reads its customers only after the mint, when there is one`);
    }
  }
}

function assertBeforeText(text: string, first: string, second: string, message: string): void {
  const a = text.indexOf(first);
  const b = text.indexOf(second);
  assert.ok(a >= 0, `${message} — missing: ${first}`);
  assert.ok(b >= 0, `${message} — missing: ${second}`);
  assert.ok(a < b, message);
}
