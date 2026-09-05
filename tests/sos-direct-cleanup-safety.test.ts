import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  BATCH_CASCADE_CHILD_TABLES,
  LINKED_RUN_STEP_TABLE,
  LIVE_DIRECT_VINTAGE_FROM,
  assertBackupCoversCascade,
  classifyDirectCleanupBatches,
  cleanupSafetyBanner,
} from "../src/lib/sales/direct-cleanup-safety.ts";

// `pnpm sos:direct-cleanup` deletes production sales rows against a database with NO point-in-time
// recovery. The audit (run wf_2196360f-a88, 2026-09-05) found it would remove 8 batches /
// 10,789,398.01 EGP — including the LIVE 2026-08 `DirectReq` vintage — behind a banner promising a
// backup that covered none of the cascade.
//
// This test pins the three things that made it dangerous:
//   1. the live vintage is refused, and refused for BOTH reasons independently;
//   2. a backup that does not cover the cascade is rejected BEFORE anything is deleted;
//   3. the script actually calls the guards, rather than merely importing them.
//
// The production figures below are measured, not illustrative — see the audit report.

const SCRIPT = fileURLToPath(new URL("../scripts/source-of-sales-direct-import-cleanup.ts", import.meta.url));

// The eight batches the filter matched on production, 2026-09-05.
const PRODUCTION_MATCHED_BATCHES = [
  { distributor_code: "DIRECT", id: "b1", period: "2026-01", status: "validated" },
  { distributor_code: "DIRECT", id: "b2", period: "2026-02", status: "validated" },
  { distributor_code: "DIRECT", id: "b3", period: "2026-03", status: "validated" },
  { distributor_code: "DIRECT", id: "b4", period: "2026-04", status: "validated" },
  { distributor_code: "DIRECT", id: "b5", period: "2026-05", status: "validated" },
  { distributor_code: "DIRECT", id: "b6", period: "2026-06", status: "validated" },
  { distributor_code: "DIRECT", id: "b7", period: "2026-07", status: "validated" },
  // 293,837.57 EGP. Matched ONLY by `is_direct` — never by distributor_code.
  { distributor_code: "DirectReq", id: "b8", period: "2026-08", status: "validated" },
];

function testLiveVintageIsRefused() {
  const { deletable, protectedLive } = classifyDirectCleanupBatches(PRODUCTION_MATCHED_BATCHES);

  assert.equal(deletable.length, 7, "the seven retired DIRECT batches should remain deletable");
  assert.equal(protectedLive.length, 1, "exactly the live DirectReq batch should be protected");
  assert.equal(protectedLive[0].id, "b8");
  assert.match(protectedLive[0].reason, /live direct vintage/i);
  assert.ok(
    !deletable.some((batch) => batch.period === "2026-08"),
    "2026-08 must never appear in the deletable set — this is the 293,837.57 EGP the audit found",
  );
}

function testBothGuardsFireIndependently() {
  // Either guard alone must stop it, so a plausible future edit to one cannot reopen the hole.
  const periodOnly = classifyDirectCleanupBatches([{ distributor_code: "DIRECT", id: "x", period: "2026-08" }]);
  assert.equal(periodOnly.deletable.length, 0, "period guard alone must refuse the live vintage");

  const codeOnly = classifyDirectCleanupBatches([{ distributor_code: "DirectReq", id: "y", period: "2026-07" }]);
  assert.equal(codeOnly.deletable.length, 0, "distributor-code guard alone must refuse a non-retired code");

  const noPeriod = classifyDirectCleanupBatches([{ distributor_code: "DIRECT", id: "z", period: null }]);
  assert.equal(noPeriod.deletable.length, 0, "a batch with no period cannot be proven retired, so it is refused");
}

function testBackupMustCoverTheCascade() {
  const counts = Object.fromEntries([...BATCH_CASCADE_CHILD_TABLES, LINKED_RUN_STEP_TABLE].map((t) => [t, 2]));
  const complete: Record<string, unknown> = {};
  for (const table of [...BATCH_CASCADE_CHILD_TABLES, LINKED_RUN_STEP_TABLE]) complete[table] = [{}, {}];

  // A complete backup passes.
  assert.doesNotThrow(() => assertBackupCoversCascade(complete, counts));

  // The original defect: five rollup tables destroyed by cascade, present in no backup.
  const missingRollups = { ...complete };
  delete missingRollups["source_of_sales_fact_rollup"];
  assert.throws(
    () => assertBackupCoversCascade(missingRollups, counts),
    /source_of_sales_fact_rollup/,
    "a cascade table absent from the backup must abort the delete",
  );

  // The other half: a table that IS present but silently empty — what `monthly_sales_runs` did.
  const silentlyEmpty = { ...complete, [LINKED_RUN_STEP_TABLE]: [] };
  assert.throws(
    () => assertBackupCoversCascade(silentlyEmpty, counts),
    /monthly_sales_run_step: backup holds 0 rows but 2 will be deleted/,
    "a backup entry that is empty while rows will be deleted must abort the delete",
  );
}

function testTheScriptActuallyCallsTheGuards() {
  // A guard nothing calls is not a guard. Pinned by substring, never by byte offset — a fixed
  // window false-fails the moment the file shifts (AGENTS.md §2.1).
  const source = readFileSync(SCRIPT, "utf8");

  assert.ok(source.includes("classifyDirectCleanupBatches("), "apply must classify batches before deleting");
  assert.ok(source.includes("assertBackupCoversCascade("), "apply must verify the backup covers the cascade");
  assert.ok(
    !source.includes('"monthly_sales_runs"'),
    "the script must not read monthly_sales_runs — that table does not exist and reading it silently backed up nothing",
  );
  // The delete must operate on the CLASSIFIED set, not the raw match.
  assert.ok(
    source.includes("const batchIds = deletable.map("),
    "the deletion set must come from the classified deletable batches, not from every matched batch",
  );
}

function testBannerDescribesWhatIsActuallyDone() {
  const banner = cleanupSafetyBanner();
  assert.ok(banner.includes(LIVE_DIRECT_VINTAGE_FROM), "the banner must name the live-vintage cutoff it enforces");
  assert.ok(/no point-in-time recovery/i.test(banner), "the banner must state that production has no PITR");
  assert.ok(
    !/backs up affected batches, rows, summaries, and linked monthly runs/.test(banner),
    "the old banner promised a backup that was never taken — it must not come back",
  );
}

export function runSosDirectCleanupSafetyTests() {
  testLiveVintageIsRefused();
  testBothGuardsFireIndependently();
  testBackupMustCoverTheCascade();
  testTheScriptActuallyCallsTheGuards();
  testBannerDescribesWhatIsActuallyDone();
}
