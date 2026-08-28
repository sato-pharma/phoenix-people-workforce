// THE MEMORY INDEX ALARM HAS TO FIRE BEFORE THE DAMAGE, NOT AFTER IT.
//
// WHY THIS EXISTS. `MEMORY.md` is the only memory file that auto-loads, and the loader truncates it
// at 24,400 bytes SILENTLY — no error, no marker, no ellipsis. Past that byte a hook is present in
// the file and absent from every session that reads it. `repo-doctor.mjs` warned only when the file
// was ALREADY over that line, which by construction can never prevent anything: the first time it
// fires, sessions have been loading a partial index for however long it took someone to run it.
//
// THE DISCRIMINATING CASE IS TODAY'S REAL SIZE. On 2026-08-28 the index measured 24,065 bytes —
// 335 from the cliff, less than either of the two hook lines that had landed in the preceding 40
// minutes (330 and 235 bytes). The old ceiling-only rule said NOTHING at that size. Every case
// below that matters therefore pins BOTH answers: `ceilingOnlyWarns` reproduces the pre-fix check
// verbatim, and asserting it stays silent where the budget speaks is what proves these tests
// discriminate rather than passing for free.
//
// THE DANGEROUS DIRECTION IS ONE-WAY. This figure is the only mechanical signal that the index is
// losing hooks, so an unmeasurable file must read as UNKNOWN, never as healthy. A size check that
// answers "fine" when `statSync` threw is exactly how the cliff gets crossed while the doctor
// prints a clean bill — the same failure shape as the reachability bug in
// `repo-doctor-unpushed-commits.test.ts`.

import { strict as assert } from "node:assert";

import {
  MEMORY_INDEX_BUDGET,
  MEMORY_INDEX_READ_CEILING,
  assessMemoryIndexSize,
  memoryIndexBudgetLines,
} from "../scripts/memory-index-budget.mjs";

// The pre-fix check, reproduced verbatim: repo-doctor printed its warning on `indexBytes >
// READ_CEILING` and nothing otherwise. Kept so every assertion can show what the old rule said.
function ceilingOnlyWarns(bytes: number): boolean {
  return bytes > 24_400;
}

export function runMemoryIndexBudgetTests() {
  // ── 1. the budget must leave real slack, and must not gut the index ───────────────────────────
  // Both directions matter. Too close to the cliff and the alarm is decoration; too far below and
  // it demands the file be cut into the ~13,000 bytes of hooks that structurally have to exist.
  assert.ok(
    MEMORY_INDEX_BUDGET < MEMORY_INDEX_READ_CEILING,
    "the budget must sit BELOW the loader cliff or it can never warn early",
  );
  const slack = MEMORY_INDEX_READ_CEILING - MEMORY_INDEX_BUDGET;
  assert.ok(
    slack >= 2_000,
    `the budget leaves only ${slack} bytes of slack; at the index's own ~230-byte average hook that `
      + "is fewer than nine hooks, which parallel sessions can spend in under an hour",
  );
  assert.ok(
    MEMORY_INDEX_BUDGET > 13_000,
    "the budget must stay above the ~13KB structural floor of hooks that have to exist — see "
      + "memory-index-floor-is-13kb-dont-gut-it-chasing-17",
  );

  // ── 2. THE CASE THE OLD RULE MISSED ──────────────────────────────────────────────────────────
  // 24,065 bytes, measured live 2026-08-28. This is the whole reason the budget exists.
  const measuredToday = assessMemoryIndexSize(24_065);
  assert.equal(measuredToday.status, "over_budget");
  assert.equal(measuredToday.mustFree, 2_065);
  assert.equal(measuredToday.headroomToCeiling, 335);
  assert.equal(
    ceilingOnlyWarns(24_065),
    false,
    "PIN: the old ceiling-only rule was SILENT at 335 bytes from the cliff — if this ever reads "
      + "true the discriminator is gone and these tests stop proving anything",
  );

  // ── 3. mustFree must actually close the gap ──────────────────────────────────────────────────
  // A number that is merely "large when bad" is not actionable. Freeing exactly this many bytes
  // has to land the file on the budget, or the instruction the doctor prints is a lie.
  for (const bytes of [22_001, 23_000, 24_065, 24_400, 30_000]) {
    const v = assessMemoryIndexSize(bytes);
    assert.equal(bytes - v.mustFree, MEMORY_INDEX_BUDGET, `mustFree does not close the gap at ${bytes}`);
  }

  // ── 4. boundaries, both of them ──────────────────────────────────────────────────────────────
  assert.equal(assessMemoryIndexSize(MEMORY_INDEX_BUDGET).status, "ok", "at budget is inside it");
  assert.equal(assessMemoryIndexSize(MEMORY_INDEX_BUDGET).mustFree, 0);
  assert.equal(assessMemoryIndexSize(MEMORY_INDEX_BUDGET + 1).status, "over_budget");
  assert.equal(assessMemoryIndexSize(MEMORY_INDEX_BUDGET + 1).mustFree, 1);
  // The loader truncates PAST the ceiling, so landing exactly on it has not yet dropped anything.
  assert.equal(assessMemoryIndexSize(MEMORY_INDEX_READ_CEILING).status, "over_budget");
  assert.equal(assessMemoryIndexSize(MEMORY_INDEX_READ_CEILING + 1).status, "over_ceiling");
  assert.equal(assessMemoryIndexSize(MEMORY_INDEX_READ_CEILING + 1).headroomToCeiling, -1);

  // ── 5. an unmeasurable index is UNKNOWN, never ok ─────────────────────────────────────────────
  // repo-doctor leaves the size at 0 when statSync throws, so 0 is the live path, not a synthetic
  // edge. NaN and undefined cover a future caller that forgets to default it.
  for (const bad of [0, -1, Number.NaN, undefined as unknown as number]) {
    const v = assessMemoryIndexSize(bad);
    assert.equal(v.status, "unknown", `an unmeasurable size (${String(bad)}) must not read as healthy`);
    assert.notEqual(v.status, "ok");
  }

  // ── 6. the printed sentence must match the verdict ────────────────────────────────────────────
  // A report that says "healthy" beside a figure over the cliff is worse than no report, so the
  // wording is pinned to the arithmetic rather than left to a caller.
  const overCliff = memoryIndexBudgetLines(assessMemoryIndexSize(24_500)).join(" ");
  assert.match(overCliff, /OVER THE CLIFF/, "an over-cliff index must say so in those words");
  assert.match(overCliff, /invisible/, "it must say the dropped hooks are invisible, not merely that the file is big");

  const overBudget = memoryIndexBudgetLines(measuredToday).join(" ");
  assert.match(overBudget, /OVER BUDGET/);
  assert.match(overBudget, /free 2065 bytes/, "the report must name the exact number of bytes to free");
  assert.doesNotMatch(overBudget, /budget left/, "an over-budget index must never print the healthy phrasing");

  const unknown = memoryIndexBudgetLines(assessMemoryIndexSize(0)).join(" ");
  assert.match(unknown, /UNKNOWN/, "an unmeasurable index must be reported as unknown out loud");
  assert.doesNotMatch(unknown, /budget left/);

  const healthy = memoryIndexBudgetLines(assessMemoryIndexSize(20_000)).join(" ");
  assert.match(healthy, /2000 bytes of budget left/);
  assert.doesNotMatch(healthy, /OVER/, "a healthy index must not carry an alarm word");
}
