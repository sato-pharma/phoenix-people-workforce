import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Contract guards for "fail-closed on bad data": one employee's bad/broken
 * data must never block the whole week's generation for everyone else, and
 * must never produce a digest built on data that couldn't be verified — that
 * employee is held (skipped) and reported, never guessed at or silently
 * dropped. Entirely Supabase-backed, so — matching this module's established
 * pattern — pinned via source inspection.
 */
export function runAttendanceFailClosedBadDataTests() {
  const digestService = readFileSync("src/lib/attendance/digest-service.ts", "utf8");

  // 1. Per-employee isolation: the loop body must be wrapped so one throw
  //    doesn't abort processing for the rest of the roster.
  const loopStart = digestService.indexOf("for (const employee of scoped)");
  const loopBody = digestService.slice(loopStart, loopStart + 3600);
  assert.match(loopBody, /try \{/, "the per-employee loop body must be wrapped in try/catch");
  assert.match(
    loopBody,
    /catch \(error\) \{\s*skipped\.push\(\{ employeeHrId: employee\.hrId, reason:/,
    "a per-employee failure must be collected as a skip with a reason, not thrown out of the loop",
  );

  // 2. Never silently dropped: the function's return type surfaces skips
  //    explicitly, and the scheduler is required to report them, not ignore
  //    them.
  assert.match(
    digestService,
    /export type ComputeSettlementWeekDigestsResult = \{\s*results: EmployeeWeekDigestResult\[\];\s*[\s\S]*?skipped: DigestGenerationSkip\[\];/,
    "the compute function's return type must explicitly carry skipped employees alongside results",
  );

  const scheduler = readFileSync("src/lib/attendance/digest-scheduler.ts", "utf8");
  assert.match(
    scheduler,
    /const \{ results: digests, skipped \} = await computeSettlementWeekDigests\(week\);/,
    "the scheduler must destructure and handle skipped employees, not just the results array",
  );
  assert.match(
    scheduler,
    /errors\.push\(`held \(bad data\)/,
    "skipped employees must be surfaced through the scheduler's error/reporting channel — never silently discarded",
  );

  // 3. A held employee produces NO digest for that week — no partial/guessed
  //    data ever reaches persistSettlementWeekDigests for them.
  assert.doesNotMatch(
    loopBody.slice(loopBody.indexOf("catch (error)")),
    /results\.push/,
    "the catch branch must never push a result — a skipped employee gets nothing persisted, not a best-guess digest",
  );
}
