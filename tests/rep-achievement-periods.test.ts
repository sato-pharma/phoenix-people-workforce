import assert from "node:assert/strict";

import { resolveRepAchievementPeriods } from "../src/lib/analytics/service.ts";

// Monthly Closing's rep-level achievement now comes from au.f_monthly_achievement, which takes
// ONE period at a time (a seat-occupancy snapshot "as of" that period's end) — unlike the legacy
// RPC it replaced, which accepted a period array / open date range in one SQL call. This is the
// pure function that turns whatever period filter a caller passed into the small, capped list of
// periods actually fetched. No Supabase calls — safe to test directly.

export async function runRepAchievementPeriodsTests() {
  // ── Explicit period list wins outright ──────────────────────────────────────
  {
    const result = resolveRepAchievementPeriods({ period: ["2026-07", "2026-08"] });
    assert.deepEqual(result, ["2026-07", "2026-08"]);
  }

  // ── Explicit list is deduped ─────────────────────────────────────────────────
  {
    const result = resolveRepAchievementPeriods({ period: ["2026-07", "2026-07", "2026-08"] });
    assert.deepEqual(result, ["2026-07", "2026-08"]);
  }

  // ── Explicit list is capped at 12 — one attribution-engine pass per period ──
  {
    const period = Array.from({ length: 20 }, (_, i) => `2026-${String((i % 12) + 1).padStart(2, "0")}-x${i}`);
    const result = resolveRepAchievementPeriods({ period });
    assert.equal(result.length, 12, "must never fan out past the cap regardless of input size");
  }

  // ── periodFrom + periodTo enumerates the inclusive range, oldest first ──────
  {
    const result = resolveRepAchievementPeriods({ periodFrom: "2026-07", periodTo: "2026-09" });
    assert.deepEqual(result, ["2026-07", "2026-08", "2026-09"]);
  }

  // ── A range spanning a year boundary shifts correctly ───────────────────────
  {
    const result = resolveRepAchievementPeriods({ periodFrom: "2025-11", periodTo: "2026-02" });
    assert.deepEqual(result, ["2025-11", "2025-12", "2026-01", "2026-02"]);
  }

  // ── A reversed range (from after to) returns nothing rather than looping ───
  {
    const result = resolveRepAchievementPeriods({ periodFrom: "2026-09", periodTo: "2026-07" });
    assert.deepEqual(result, [], "a nonsensical range must fail safe to empty, never hang or throw");
  }

  // ── A huge range is capped at 12 periods, not fetched in full ───────────────
  {
    const result = resolveRepAchievementPeriods({ periodFrom: "2020-01", periodTo: "2030-01" });
    assert.equal(result.length, 12);
    assert.equal(result[0], "2020-01");
  }

  // ── Only periodFrom given collapses to that single period (no open-ended
  //    fetch — au.f_monthly_achievement has no "onward" query shape to match) ──
  {
    const result = resolveRepAchievementPeriods({ periodFrom: "2026-07" });
    assert.deepEqual(result, ["2026-07"]);
  }
  {
    const result = resolveRepAchievementPeriods({ periodTo: "2026-07" });
    assert.deepEqual(result, ["2026-07"]);
  }

  // ── No period filter falls back to the newest period WITH DATA ─────────────
  // It used to default to the current calendar month, which showed a single month while the Period
  // filter still read "All" — and rendered a confident EGP 0 whenever the current month had not been
  // uploaded (2026-07 today; 2026-05 was never uploaded at all).
  {
    const result = resolveRepAchievementPeriods({}, "2026-06");
    assert.deepEqual(result, ["2026-06"], "unfiltered ⇒ newest period that actually has data");
  }
  {
    const result = resolveRepAchievementPeriods({}, null);
    assert.deepEqual(result, [], "nothing loaded ⇒ no periods, so the caller reports no data instead of inventing a zero");
  }
  {
    const result = resolveRepAchievementPeriods({});
    assert.deepEqual(result, [], "omitting the argument must not silently resurrect a calendar-month default");
  }

  // ── An explicit selection still wins over the fallback ──────────────────────
  {
    const result = resolveRepAchievementPeriods({ period: ["2026-03"] }, "2026-06");
    assert.deepEqual(result, ["2026-03"], "explicit period beats the newest-with-data fallback");
  }
  {
    const result = resolveRepAchievementPeriods({ periodFrom: "2026-01", periodTo: "2026-02" }, "2026-06");
    assert.deepEqual(result, ["2026-01", "2026-02"], "explicit range beats the fallback");
  }

  console.log("rep-achievement-periods: ok");
}
