import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { intakeEventUpdateColumns } from "../src/lib/recruitment/inbound/cv-intake-service.ts";

// ─────────────────────────────────────────────────────────────────────────────
// `finalizeIntakeEvent` is called several times per intake, and the calls are not equally
// informed. The success path finalizes with candidate_id, file_id and match_reason; the outer
// catch finalizes with nothing but an outcome and a message.
//
// Until 2026-08-23 every column was written unconditionally (`patch.candidateId ?? null`), so the
// thin call erased what the fat one had recorded. The route to it was narrow but real: the success
// path finalizes, then calls notifyTalentAcquisitionOfInboundCv(...). That call is `.catch()`-
// guarded, but its ARGUMENT EXPRESSIONS are not — `unappliedFieldCount(...)` runs before the
// promise exists, so a throw there unwound into the outer catch, which re-finalized the event
// without candidate_id/file_id and stamped a successful intake as "error". The candidate and the
// CV still existed; the event row simply stopped pointing at them.
//
// claimIntakeEvent depends on the same durability from the other direction: its takeover
// deliberately leaves candidate_id/match_reason in place so a retry can reuse the candidate a dead
// attempt already created.
//
// Three defences are pinned: the patch semantics, the count that can no longer throw, and the
// outer catch that can no longer downgrade a recorded success.
// ─────────────────────────────────────────────────────────────────────────────

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const service = read("src/lib/recruitment/inbound/cv-intake-service.ts");

export function runRecruitmentIntakeFinalizePatchTests() {
  // ── An absent key must not reach the statement ────────────────────────────
  // This is the whole defect: the outer catch's thin finalize.
  const thin = intakeEventUpdateColumns({
    errorMessage: "Inbound CV intake failed.",
    outcome: "error",
  });
  assert.deepEqual(
    thin,
    { error_message: "Inbound CV intake failed.", outcome: "error" },
    "a finalize that names no candidate must not write candidate_id, file_id or match_reason",
  );
  for (const column of ["candidate_id", "file_id", "match_reason"]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(thin, column),
      false,
      `${column} must be OMITTED, not set to undefined — a present key still overwrites the row`,
    );
  }

  // ── A fully-informed call still writes everything ─────────────────────────
  assert.deepEqual(
    intakeEventUpdateColumns({
      candidateId: "cand-1",
      errorMessage: null,
      fileId: "file-1",
      matchReason: "email",
      outcome: "candidate_created",
    }),
    {
      candidate_id: "cand-1",
      error_message: null,
      file_id: "file-1",
      match_reason: "email",
      outcome: "candidate_created",
    },
    "the success finalize must still record the candidate, the file and how it matched",
  );

  // ── An explicit null is still a deliberate clear ──────────────────────────
  assert.deepEqual(
    intakeEventUpdateColumns({ candidateId: null, outcome: "ignored_no_attachment" }),
    { candidate_id: null, outcome: "ignored_no_attachment" },
    "a caller that explicitly passes null means clear it, and must keep working",
  );

  // ── outcome is mandatory and always written ───────────────────────────────
  assert.equal(
    intakeEventUpdateColumns({ outcome: "ignored_duplicate" }).outcome,
    "ignored_duplicate",
    "outcome is the one column every finalize states",
  );

  // ── The service must use the builder, not a raw unconditional write ───────
  assert.doesNotMatch(
    service,
    /candidate_id: patch\.candidateId \?\? null/,
    "the unconditional write is what erased a recorded candidate — it must not come back",
  );
  assert.match(
    service,
    /\.update\(\{ \.\.\.intakeEventUpdateColumns\(patch\), updated_at: new Date\(\)\.toISOString\(\) \}\)/,
    "finalizeIntakeEvent must build its columns through intakeEventUpdateColumns",
  );

  // ── The notification's field count must not be able to throw ──────────────
  const countFn = service.slice(service.indexOf("function unappliedFieldCount("));
  const countBody = countFn.slice(0, countFn.indexOf("\n}\n"));
  assert.match(
    countBody,
    /try \{/,
    "unappliedFieldCount is evaluated as a call ARGUMENT after the success finalize, so it must never throw",
  );
  assert.match(
    countBody,
    /return 0;/,
    "a failed count must degrade to zero rather than unwind the whole intake",
  );

  // ── The outer catch must not downgrade a recorded success ─────────────────
  assert.match(
    service,
    /settled = \{ candidateId: candidate\.id, fileId, matchReason, outcome \};/,
    "the success path must record that the event was finalized",
  );
  assert.match(
    service,
    /if \(settled\) \{[\s\S]{0,400}?return settled;/,
    "the outer catch must return the recorded success instead of re-finalizing it as an error",
  );
  const outerCatch = service.slice(service.lastIndexOf("  } catch (error) {"));
  assert.ok(
    outerCatch.indexOf("if (settled)") < outerCatch.indexOf('outcome: "error"'),
    "the settled guard must come BEFORE the error finalize, or it guards nothing",
  );
}
