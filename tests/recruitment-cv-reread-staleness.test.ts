import assert from "node:assert/strict";

import {
  EXTRACTOR_FIX_LANDED_AT,
  needsRereadThroughFixedExtractor,
} from "../src/lib/recruitment/cv-reread-staleness.ts";

/**
 * The filter that stops a CV re-read paying twice for work already done.
 *
 * Every timestamp below is real. On 2026-09-12 the production table held 941 candidates with a
 * reading: 307 produced after #3729 merged, 634 at or before it. The run that produced the fresh
 * ones started at 00:05:17Z — four minutes BEFORE the merge instant of 00:09:24Z — because it was
 * launched from the worktree that built the fix. Those four minutes are the whole reason the cut
 * leans the way it does, so they are pinned here.
 */
export async function runRecruitmentCvRereadStalenessTests(): Promise<void> {
  // ── The cutoff is the merge instant of #3729, read from GitHub, not remembered ──────────────
  {
    assert.equal(
      EXTRACTOR_FIX_LANDED_AT,
      "2026-09-12T00:09:24Z",
      "the cutoff is #3729's mergedAt — change it only against `gh pr view`, never from memory",
    );
    assert.equal(
      Number.isNaN(Date.parse(EXTRACTOR_FIX_LANDED_AT)),
      false,
      "the cutoff constant must itself be a parseable instant",
    );
  }

  // ── A reading produced AFTER the fix is trusted and costs nothing to keep ──────────────────
  {
    for (const readAt of [
      "2026-09-12T00:09:25Z", // one second after the merge
      "2026-09-12T01:30:00Z", // mid-run, comfortably after
      "2026-09-12T02:16:22.622857Z", // the last row the 2026-09-12 re-read wrote
    ]) {
      assert.equal(
        needsRereadThroughFixedExtractor(readAt),
        false,
        `${readAt} is after the fix landed — re-reading it would be paying twice`,
      );
    }
  }

  // ── A reading from BEFORE the fix is stale, however recent it feels ────────────────────────
  {
    for (const readAt of [
      "2026-09-12T00:05:17.138041Z", // the first row of the overnight run — BEFORE the merge
      "2026-09-12T00:09:24Z", // the merge instant itself: at-or-before, so stale
      "2026-09-11T21:44:24.085355Z", // the newest reading that predates the whole run
      "2026-09-04T05:38:59.645423Z", // the September re-read
      "2026-08-14T02:57:47.702466Z", // the oldest reading on file
    ]) {
      assert.equal(
        needsRereadThroughFixedExtractor(readAt),
        true,
        `${readAt} is at or before the fix — it still carries the old reading`,
      );
    }
  }

  // ── The boundary is exact, and inclusive on the stale side ────────────────────────────────
  {
    assert.equal(
      needsRereadThroughFixedExtractor("2026-09-12T00:09:24.000Z"),
      true,
      "the merge instant itself counts as stale — the cut is conservative by design",
    );
    assert.equal(
      needsRereadThroughFixedExtractor("2026-09-12T00:09:24.001Z"),
      false,
      "one millisecond later is trusted",
    );
  }

  // ── No reading at all is the strongest case for reading it ────────────────────────────────
  {
    for (const missing of [null, undefined, "", "   "]) {
      assert.equal(
        needsRereadThroughFixedExtractor(missing),
        true,
        `a candidate with ${JSON.stringify(missing)} on file has never been read — it must be re-read`,
      );
    }
  }

  // ── A timestamp this cannot parse must never read as "already fixed" ──────────────────────
  //
  // This is the direction that matters. Re-reading a CV that was already correct costs $0.0043.
  // Skipping one that is wrong leaves a bad fact on a real person's record, which is the defect
  // this whole job exists to repair.
  {
    for (const unusable of ["not a date", "2026-13-45T99:99:99Z", "yesterday", "--confirm-spend"]) {
      assert.equal(
        needsRereadThroughFixedExtractor(unusable),
        true,
        `"${unusable}" cannot be reasoned about, so it must fall towards re-reading`,
      );
    }
    assert.equal(
      needsRereadThroughFixedExtractor("2026-09-12T01:00:00Z", "not a date"),
      true,
      "an unusable CUTOFF must not silently pass every candidate as already fixed",
    );
  }

  // ── An explicit cutoff overrides the default, in both directions ──────────────────────────
  {
    assert.equal(
      needsRereadThroughFixedExtractor("2026-09-12T01:00:00Z", "2026-09-12T02:00:00Z"),
      true,
      "a later cutoff makes a previously-trusted reading stale again",
    );
    assert.equal(
      needsRereadThroughFixedExtractor("2026-08-20T00:00:00Z", "2026-08-01T00:00:00Z"),
      false,
      "an earlier cutoff trusts a reading the default would have re-read",
    );
  }

  // ── Date objects are accepted, since a driver may hand one back ───────────────────────────
  {
    assert.equal(
      needsRereadThroughFixedExtractor(new Date("2026-09-12T02:00:00Z")),
      false,
      "a Date after the cutoff is trusted",
    );
    assert.equal(
      needsRereadThroughFixedExtractor(new Date("2026-09-11T02:00:00Z")),
      true,
      "a Date before the cutoff is stale",
    );
    assert.equal(
      needsRereadThroughFixedExtractor(new Date("nonsense")),
      true,
      "an Invalid Date falls towards re-reading, like any other unusable value",
    );
  }

  // ── The population split this was built for, as one arithmetic check ──────────────────────
  //
  // Measured against production on 2026-09-12: 941 candidates with a reading, 307 of them after
  // the fix. The filter's whole purpose is that a re-read then charges for 634, not 941.
  {
    const readings = [
      ...Array.from({ length: 307 }, () => "2026-09-12T01:00:00Z"),
      ...Array.from({ length: 634 }, () => "2026-09-11T12:00:00Z"),
    ];
    const stale = readings.filter((at) => needsRereadThroughFixedExtractor(at)).length;
    assert.equal(stale, 634, "the filter must select exactly the readings that predate the fix");
    assert.equal(readings.length - stale, 307, "and must spare every reading produced after it");
  }
}
