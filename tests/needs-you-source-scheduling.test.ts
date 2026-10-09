import assert from "node:assert/strict";

import {
  loadNeedsYouSources,
  NEEDS_YOU_BOARD_BUDGET_MS,
  NEEDS_YOU_HEAVY_LANE_LIMIT,
  NEEDS_YOU_LIGHT_LANE_LIMIT,
  NEEDS_YOU_SOURCE_TIMEOUT_MS,
} from "../src/lib/needs-you/service.ts";
import { needsYouAdapters, type NeedsYouAdapter } from "../src/lib/needs-you/sources.ts";
import type { NeedsYouSourceId, NeedsYouSourceState } from "../src/lib/needs-you/types.ts";

/**
 * 🔴 THE BOARD WAS UNDER-REPORTING FOR A SCHEDULING REASON, NOT A QUERY ONE.
 *
 * On 2026-10-09 the owner opened `/admin/needs-you` three times and read 9 items, then 8, then 7 —
 * a different set of amber "could not be read" rows each time, and on the read he kept, NINE of the
 * 22 sources were unread. Behind two of those rows sat 13 marketing requests at his own step,
 * overdue, and a leaver with an uncollected deduction nine days old.
 *
 * Nothing was slow. Measured against production the same evening, each source read ALONE:
 * `closing-publication-drift` 5,516 ms, `action-inbox` 5,119 ms, `office-allocation-drift`
 * 4,640 ms, every other source under 1,100 ms — 0 of 22 over the 8-second budget. Started together
 * by the old unbounded `Promise.all`, the same three took 10,280 / 9,387 / 9,222 ms and even a
 * 903 ms source took 7,016 ms. The budget was being spent QUEUEING, and which sources lost the race
 * was luck — which is precisely why the set changed on every read.
 *
 * So the fix is scheduling, and these are the four properties it rests on. Each assertion below is
 * written as the change that would break it:
 *
 *  1. A heavy source running beside another heavy source. Measured: at a heavy lane of two the peak
 *     was 7,687 ms against 8,000 — 313 ms, which is not headroom — and the 22-way shape provoked a
 *     real `57014 canceling statement due to statement timeout` out of `phx_closing_drift_status`.
 *  2. The light lane widened "while we are here", putting the 19 light sources back into the
 *     contention that inflated a 903 ms read to 7,016 ms.
 *  3. The per-source timer moved back to fan-out time. `office-allocation-drift` starts at +10.5 s
 *     in the measured run and answers in 2,264 ms: a fan-out clock ambers a source that was never
 *     given the chance to run, which is the under-report wearing the amber row's clothes.
 *  4. A source the ceiling cut off being dropped from the results rather than returned amber — the
 *     one failure direction this module exists to prevent (`types.ts`, the governing rule).
 *
 *  5. And the declaration itself: the three sources measured in seconds must say `cost: "heavy"`.
 *     An undeclared heavy source joins the light lane and inflates the OTHER three sources in it,
 *     so this is not only about itself.
 *
 * Node builtins only, and every adapter here is a fake with a timer: the real ones need Supabase,
 * and this suite runs with PRODUCTION credentials, so a scheduling test that called them would be
 * reading live payroll to time a lane.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The real ids, so a renamed source fails here rather than silently testing nothing. */
const HEAVY_BY_MEASUREMENT: readonly NeedsYouSourceId[] = [
  "action-inbox",
  "closing-publication-drift",
  "office-allocation-drift",
];

type Trace = {
  /** Highest number of adapters of one cost class running at the same instant. */
  peak: { heavy: number; light: number };
  startedAt: Map<NeedsYouSourceId, number>;
};

/**
 * A fake adapter that records when it starts and how many of its own class are running with it.
 *
 * The ids are real `NeedsYouSourceId`s because the type is a closed union — which also means a
 * fixture cannot drift onto a source that no longer exists.
 */
function fake(
  id: NeedsYouSourceId,
  cost: "heavy" | undefined,
  ms: number,
  trace: Trace,
  live: { heavy: number; light: number },
  t0: number,
): NeedsYouAdapter {
  return {
    cost,
    id,
    load: async (): Promise<NeedsYouSourceState> => {
      const key = cost === "heavy" ? "heavy" : "light";
      live[key] += 1;
      trace.peak[key] = Math.max(trace.peak[key], live[key]);
      trace.startedAt.set(id, Date.now() - t0);
      try {
        await sleep(ms);
        return { status: "ok", items: [] };
      } finally {
        live[key] -= 1;
      }
    },
  };
}

export async function runNeedsYouSourceSchedulingTests() {
  const access = {
    hrId: "B-10",
    loginId: "scheduling.test",
    role: "Super Admin",
    scope: "system",
    source: "system",
  } as Parameters<typeof loadNeedsYouSources>[0];

  // ── 1 and 2. The two lanes, measured by what actually ran together ──────────
  {
    const trace: Trace = { peak: { heavy: 0, light: 0 }, startedAt: new Map() };
    const live = { heavy: 0, light: 0 };
    const t0 = Date.now();

    // Three heavy and eight light, every one of them slow enough that an unbounded fan-out would
    // have them all in flight at once. 40 ms each: long enough to overlap, short enough that the
    // whole case is under half a second.
    const adapters: NeedsYouAdapter[] = [
      ...HEAVY_BY_MEASUREMENT.map((id) => fake(id, "heavy", 40, trace, live, t0)),
      ...(
        [
          "marketing-approvals",
          "resignations",
          "payroll-publish",
          "orphaned-requests",
          "phoenix-crm-decisions",
          "uncollected-leaver-deductions",
          "leave-approvals",
          "probation-decisions",
        ] as const
      ).map((id) => fake(id, undefined, 40, trace, live, t0)),
    ];

    const results = await loadNeedsYouSources(access, adapters);

    assert.equal(
      trace.peak.heavy,
      1,
      "Two heavy sources ran at the same time. Measured on production 2026-10-09: run the three " +
        "heavy sources together and they take 10,280 / 9,387 / 9,222 ms against an 8,000 ms budget, " +
        "where each one alone takes 4.6-5.5 s — and the pile-up provoked a real `57014 canceling " +
        "statement due to statement timeout` from phx_closing_drift_status. A heavy lane of two " +
        "peaked at 7,687 ms: 313 ms of headroom on a laptop measurement with no production traffic " +
        "in it. NEEDS_YOU_HEAVY_LANE_LIMIT is 1 and the number is the fix.",
    );
    assert.equal(
      trace.peak.light,
      NEEDS_YOU_LIGHT_LANE_LIMIT,
      `The light lane ran ${trace.peak.light} sources at once, not ${NEEDS_YOU_LIGHT_LANE_LIMIT}. ` +
        "Wider puts the 19 light sources back into the contention that took payroll-publish from " +
        "903 ms to 7,016 ms; narrower adds wall time for nothing, since the light lane already " +
        "drains inside the heavy lane's own run.",
    );
    assert.ok(
      trace.peak.light > 1,
      "The light sources ran one at a time. That is not the fix either — the light lane is four " +
        "wide, and serialising 19 reads averaging 400 ms would add seconds to a page that already " +
        "waits on the heavy lane.",
    );

    // 3 heavy at 40 ms each, serialised, is the long pole: ~120 ms. The light lane must not be it.
    assert.deepEqual(
      results.map((result) => result.id),
      adapters.map((adapter) => adapter.id),
      "The results came back in a different order from the adapters that were asked for. The lanes " +
        "interleave, so the fan-out writes by index on purpose: a caller reading results[0] would " +
        "otherwise read whichever lane happened to finish first.",
    );
    assert.equal(
      results.filter((result) => result.state.status === "ok").length,
      adapters.length,
      "A source that answered was not reported as ok.",
    );
  }

  // ── 3. The per-source clock starts when the SOURCE starts ───────────────────
  {
    const trace: Trace = { peak: { heavy: 0, light: 0 }, startedAt: new Map() };
    const live = { heavy: 0, light: 0 };
    const t0 = Date.now();

    // Two heavy sources that each take nearly the whole budget, then a third that is quick. Under a
    // fan-out clock the third has already spent its budget waiting in the lane and ambers without
    // ever having run; under its own clock it answers.
    const adapters: NeedsYouAdapter[] = [
      fake("action-inbox", "heavy", 90, trace, live, t0),
      fake("closing-publication-drift", "heavy", 90, trace, live, t0),
      fake("office-allocation-drift", "heavy", 10, trace, live, t0),
    ];

    const results = await loadNeedsYouSources(access, adapters, new Date(), {
      // 100 ms stands in for the real 8,000: the third source starts at ~180 ms, well past it.
      sourceTimeoutMs: 100,
    });

    const third = results.find((result) => result.id === "office-allocation-drift");
    assert.ok(third, "office-allocation-drift produced no result at all.");
    assert.equal(
      third.state.status,
      "ok",
      "A source that was queued behind the rest of its lane, then answered in a tenth of its " +
        "budget, came back as unavailable. Its timer is being started at fan-out instead of at " +
        "dispatch — so the row says 'it did not answer' about a read that was never allowed to " +
        "begin. Measured on production: office-allocation-drift starts at +10.5 s and answers in " +
        "2,264 ms.",
    );
    assert.ok(
      (trace.startedAt.get("office-allocation-drift") ?? 0) >= 100,
      "The fixture no longer proves anything: the third source started before its own budget had " +
        "elapsed, so a fan-out clock would have passed too. Keep the two ahead of it slower than " +
        "sourceTimeoutMs.",
    );
  }

  // ── 4. The ceiling ambers what it never read, and never drops it ────────────
  {
    const trace: Trace = { peak: { heavy: 0, light: 0 }, startedAt: new Map() };
    const live = { heavy: 0, light: 0 };
    const t0 = Date.now();

    // One slow light source eats the whole board budget; the three behind it are never started.
    const adapters: NeedsYouAdapter[] = [
      ...(["marketing-approvals", "resignations", "payroll-publish", "orphaned-requests"] as const).map(
        (id) => fake(id, undefined, 120, trace, live, t0),
      ),
      ...(["leave-approvals", "probation-decisions", "coaching-red-zone", "salary-flags"] as const).map(
        (id) => fake(id, undefined, 5, trace, live, t0),
      ),
    ];

    const results = await loadNeedsYouSources(access, adapters, new Date(), {
      boardBudgetMs: 60,
      sourceTimeoutMs: 1_000,
    });

    assert.equal(
      results.length,
      adapters.length,
      "The ceiling returned fewer results than sources. A source missing from this array is a " +
        "source that is not on the board AT ALL — classify.ts walks the registry, so it would " +
        "render as amber by accident today and as nothing at all the day that changes. It must be " +
        "returned, with a state that says it was never read.",
    );
    const neverRead = results.filter(
      (result) =>
        result.state.status === "unavailable" &&
        result.state.because === "the board ran out of time before it could be read",
    );
    assert.ok(
      neverRead.length > 0,
      "No source reported the ceiling. The fixture starts four 120 ms sources against a 60 ms " +
        "board budget, so the four behind them cannot have run — if they all came back ok, the " +
        "ceiling is not being checked before dispatch.",
    );
    // `trace.startedAt` holds exactly the adapters whose `load` ran, so this names the cut-off ones
    // rather than inferring them from their state — the inference would pass even if the ceiling
    // reported every source as ok.
    for (const result of results) {
      if (trace.startedAt.has(result.id)) continue;
      assert.equal(
        result.state.status,
        "unavailable",
        `${result.id} was never started and came back "${result.state.status}". A source the ` +
          "ceiling cut off and reported as ok with no items is the board saying 'nothing here' " +
          "about a queue it never opened — the one failure direction this module exists to prevent.",
      );
    }
  }

  // ── 5. The declaration the whole shape rests on ─────────────────────────────
  {
    const declaredHeavy = needsYouAdapters
      .filter((adapter) => adapter.cost === "heavy")
      .map((adapter) => adapter.id)
      .sort();

    assert.deepEqual(
      declaredHeavy,
      [...HEAVY_BY_MEASUREMENT].sort(),
      "The set of sources declared `cost: \"heavy\"` has changed. Measured alone against " +
        "production 2026-10-09: closing-publication-drift 5,516 ms, action-inbox 5,119 ms, " +
        "office-allocation-drift 4,640 ms, and every other source under 1,100 ms. A source that " +
        "costs seconds and does NOT declare it joins the light lane and inflates the other three " +
        "sources in that lane as well as itself; a light source that declares it needlessly " +
        "serialises itself behind the heavy ones and adds wall time to the whole page. Re-measure " +
        "before editing this list, and put the numbers in the adapter's comment.",
    );

    assert.ok(
      NEEDS_YOU_HEAVY_LANE_LIMIT === 1 && NEEDS_YOU_LIGHT_LANE_LIMIT >= 2,
      "The lane limits left their measured shape: heavy must be 1 and light more than 1.",
    );
    assert.ok(
      NEEDS_YOU_BOARD_BUDGET_MS >= NEEDS_YOU_SOURCE_TIMEOUT_MS * 2,
      "The board ceiling is within one source budget of the per-source timeout, so the ceiling " +
        "would fire on a healthy board and amber sources that were about to answer — manufacturing " +
        "the under-report the lanes were built to remove. Measured healthy wall: 12.7 s.",
    );
  }
}
