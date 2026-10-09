import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { describeLifecycleStage } from "../src/lib/marketing-requests/case-file-service.ts";
import { roiLifecycleStage } from "../src/lib/marketing-requests/roi-live-stages.ts";
import {
  approvedMarketingRequestStatuses,
  marketingHistoryOutcome,
  MARKETING_HISTORY_OUTCOME_LABEL,
} from "../src/lib/marketing-requests/service.ts";

/**
 * `cancelled` is a real terminal status, added 2026-09-22 after the owner needed to call off an
 * approved, finance-executed request (MKT-REQ-20260825-AADD59CE) and the column could not store the
 * word.
 *
 * It behaves like a called-off request everywhere it matters:
 *   * its money is NEVER committed — it is excluded from `approvedMarketingRequestStatuses`, and its
 *     ROI lifecycle stage is `cancelled` even when a pay date is present (the same guard that keeps a
 *     `rejected` row with a pay date out of the pipeline);
 *   * it IS a finished decision, so it maps to a `cancelled` history outcome with a human label;
 *   * the case-file lifecycle sentence names it in prose, never as a raw status code.
 *
 * Also pins the migration that widens the DB check constraint — the status is worthless if the
 * database rejects it.
 */
export function runMarketingCancelledStatusTests() {
  // ── The money is never committed ───────────────────────────────────────────────────────────────
  assert.ok(
    !approvedMarketingRequestStatuses.includes("cancelled"),
    "a cancelled request must never count as approved/committed spend",
  );

  // A cancelled request with a real pay date must still read `cancelled`, not be promoted into the
  // measured pipeline — the exact trap the `rejected` early-return documents.
  assert.equal(
    roiLifecycleStage({ dataCoverage: "complete", payDate: "2026-09-05", status: "cancelled" }, "2026-12-31"),
    "cancelled",
    "a cancelled request is never promoted into the ROI pipeline, even with a pay date",
  );

  // ── It is a finished decision with a human label ───────────────────────────────────────────────
  assert.equal(marketingHistoryOutcome("cancelled"), "cancelled");
  assert.equal(MARKETING_HISTORY_OUTCOME_LABEL.cancelled, "Cancelled");
  // Owner rule: a raw status code is never shown to anyone.
  assert.notEqual(MARKETING_HISTORY_OUTCOME_LABEL.cancelled, "cancelled");

  // ── The case-file lifecycle sentence names it in prose ─────────────────────────────────────────
  const sentence = describeLifecycleStage({
    currentStepName: null,
    payDate: "2026-09-05",
    salesDataAsOf: "2026-08",
    stage: "cancelled",
    status: "cancelled",
    windowEnd: "2027-03",
  });
  assert.match(sentence, /cancelled/i, "the lifecycle sentence must name the cancelled state");
  assert.match(
    sentence,
    /no money is committed|nothing here counts/i,
    "the cancelled sentence must make clear no money is committed",
  );

  // ── The database actually accepts the value ────────────────────────────────────────────────────
  const migration = readFileSync(
    "supabase/migrations/20260922110000_marketing_requests_cancelled_status.sql",
    "utf8",
  );
  assert.match(
    migration,
    /marketing_requests_status_check/,
    "the migration must re-define the status check constraint",
  );
  assert.match(migration, /'cancelled'/, "the constraint must allow the 'cancelled' value");
}
