import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Contract guards for the weekly-digest settlement service
 * (src/lib/attendance/settlement-service.ts). The service is entirely
 * Supabase-backed and cannot be unit-tested without DB infra, so — matching
 * the established pattern for this module (see attendance-self-scope.test.ts)
 * — these pin the exact safety wiring rather than mocking the client.
 */
export function runAttendanceSettlementServiceTests() {
  const service = readFileSync("src/lib/attendance/settlement-service.ts", "utf8");

  // 1. Self-scope: an employee can only act on their own digest.
  assert.match(
    service,
    /async function assertOwnsDigest/,
    "settlement service must have an ownership guard",
  );
  assert.match(
    service,
    /await assertOwnsDigest\(digest, input\.actorHrId\)/,
    "confirmDigestLines/submitDigestDispute must call assertOwnsDigest before acting",
  );

  // 2. Concurrency safety: state-changing updates must guard on the row's
  //    CURRENT action in the WHERE clause and treat 0-rows-affected as a
  //    conflict, not a silent success (the excuse-decision race-condition
  //    pattern — see decideExcuseRequestAsManager in src/lib/excuses/service.ts).
  const confirmUpdateCount = (service.match(/\.eq\("action", "pending"\)/g) ?? []).length;
  assert.ok(
    confirmUpdateCount >= 2,
    "both confirmDigestLines and submitDigestDispute must guard their update on action='pending'",
  );
  assert.match(
    service,
    /if \(!updated\) \{\s*skipped\.push\(lineId\);/,
    "confirmDigestLines must treat a 0-row update as skipped, not confirmed",
  );
  assert.match(
    service,
    /if \(!updated\) throw conflictError\("This day has already been acted on\."\);/,
    "submitDigestDispute must throw a conflict, not silently continue, when the line already moved",
  );

  // 3. Double-deduction guard: every settlement insert must go through
  //    insertSettlement, which catches the DB's unique(digest_line_id)
  //    violation (23505) and turns it into a clean conflict error rather than
  //    an opaque DB error or (worse) a swallowed failure.
  assert.match(
    service,
    /async function insertSettlement/,
    "settlement inserts must be centralized in one function",
  );
  assert.match(
    service,
    /code === "23505"/,
    "insertSettlement must detect the unique(digest_line_id) violation",
  );
  assert.match(
    service,
    /throw conflictError\("This attendance day has already been settled\."\);/,
    "insertSettlement must surface the double-settlement case as a conflict, not a raw DB error",
  );

  // 4. Dispute review must be limited to the resolved reviewer list (self-review
  //    exclusion + CEO fallback lives in digest-recipients.ts) — never a bare
  //    role check.
  assert.match(
    service,
    /const reviewers = await resolveDisputeReviewers\(digest\.employee_hr_id, settings\)/,
    "reviewDigestDispute must resolve the authorized reviewer list from settings",
  );
  assert.match(
    service,
    /if \(!reviewer \|\| !reviewers\.includes\(reviewer\)\)/,
    "reviewDigestDispute must reject a reviewer who is not in the resolved list",
  );

  // 5. Missing-punch lines (deduction_days === 0) must never enter the
  //    confirm/dispute flow — they're informational, resolved by a separate
  //    verification chain (not this service).
  assert.match(
    service,
    /if \(Number\(line\.deduction_days\) <= 0\) \{\s*skipped\.push\(lineId\);/,
    "confirmDigestLines must skip zero-deduction (missing-punch) lines rather than confirming them",
  );
  assert.match(
    service,
    /if \(Number\(line\.deduction_days\) <= 0\) \{\s*throw validationError\("This line has no deduction to dispute\."\);/,
    "submitDigestDispute must reject disputing a zero-deduction (missing-punch) line",
  );

  // 6. Immutability at the application layer: settlement-service.ts must never
  //    issue an update/delete against attendance_settlements — only insert.
  //    (The DB trigger is the hard backstop; this pins the app never even tries.)
  assert.doesNotMatch(
    service,
    /from\("attendance_settlements"\)\s*\.\s*(update|delete)\(/,
    "settlement-service.ts must never update or delete attendance_settlements rows",
  );

  // 7. The DB schema itself must enforce the same invariant the service
  //    assumes: one settlement row per digest line, ever.
  const digestTables = readFileSync("supabase/_migrations_archive/pre-baseline-2026-07-11/20260703190000_attendance_weekly_digest_tables.sql", "utf8");
  assert.match(
    digestTables,
    /digest_line_id\s+bigint\s+not null unique references public\.attendance_digest_lines\(id\)/,
    "attendance_settlements.digest_line_id must be unique — the hard backstop against a double settlement",
  );
  assert.match(
    digestTables,
    /phx_attendance_settlement_immutable/,
    "attendance_settlements must have the immutability trigger",
  );
}
