// Safety rules for the Source of Sales direct-import cleanup.
//
// WHY THIS IS A MODULE AND NOT INLINE IN THE SCRIPT
// `scripts/source-of-sales-direct-import-cleanup.ts` calls `main()` at import time, so nothing in it
// can be tested without running it against production. These are the decisions that must never be
// wrong, so they live here where a registered test can reach them.
//
// WHAT THE AUDIT FOUND (run wf_2196360f-a88, 2026-09-05, verified against production the same day)
// The script's own banner promised it "backs up affected batches, rows, summaries, and linked
// monthly runs before deletion". Measured, it did none of the following:
//
//   1. Five rollup tables are removed by the DATABASE's own ON DELETE CASCADE and appear in no
//      backup file. Deleting the batch row is enough to take them.
//   2. The "linked monthly runs" leg read `monthly_sales_runs`, WHICH DOES NOT EXIST. The helper
//      swallowed the "does not exist" error and returned [], so the backup silently held nothing
//      and the count printed 0 — indistinguishable from "there were none".
//   3. Its row filter matched the LIVE direct vintage. 8 batches / 10,789,398.01 EGP were in scope,
//      including 2026-08 `DirectReq` (23 rows, 293,837.57 EGP) — matched only by `is_direct`, never
//      by `distributor_code`.
//
// Production has NO point-in-time recovery. Recovery from any of this is a hand-built salvage.

/**
 * Every table Postgres removes by itself when a `source_of_sales_import_batches` row is deleted.
 *
 * Read from `pg_constraint` on production 2026-09-05 — `confdeltype = 'c'` against
 * `source_of_sales_import_batches`. This is NOT a guess and must not be edited by hand: re-run the
 * query if the schema changes, because a table missing from this list is a table that vanishes with
 * no backup and no error.
 */
export const BATCH_CASCADE_CHILD_TABLES = [
  "source_of_sales_channel_customer_rollup",
  "source_of_sales_customer_directory_rollup",
  "source_of_sales_customer_presence_rollup",
  "source_of_sales_distributor_product_rollup",
  "source_of_sales_fact_rollup",
  "source_of_sales_import_rows",
  "source_of_sales_import_summaries",
] as const;

/**
 * The real "linked monthly run" table. Its FK to the batch is ON DELETE **SET NULL**, not CASCADE —
 * so the rows survive a delete but silently lose the link back to the batch that produced them.
 * That is still information the backup must carry.
 *
 * The script previously named `monthly_sales_runs`, which has never existed.
 */
export const LINKED_RUN_STEP_TABLE = "monthly_sales_run_step";

/**
 * The retired direct vintage: rows uploaded from Excel under distributor code `DIRECT`, periods
 * 2026-01..2026-07, `area_code` an empty string. These are what the cleanup exists to remove.
 */
export const RETIRED_DIRECT_DISTRIBUTOR_CODE = "DIRECT";

/**
 * The live vintage begins here. AGENTS.md §4, the direct-order month golden rule: the system's own
 * direct orders (`DirectReq`, 2026-08 onward) REPLACED the Excel-uploaded ones and are the current
 * vintage. Deleting them destroys sales Finance has booked, in the month it booked them.
 */
export const LIVE_DIRECT_VINTAGE_FROM = "2026-08";

export type CleanupBatch = {
  id: string;
  period?: string | null;
  distributor_code?: string | null;
  status?: string | null;
};

export type BatchClassification = {
  /** Safe to delete: retired vintage, before the live cutoff. */
  deletable: CleanupBatch[];
  /** Refused: live vintage, or a distributor code this cleanup was never meant to touch. */
  protectedLive: Array<CleanupBatch & { reason: string }>;
};

/**
 * Split the matched batches into what the cleanup may delete and what it must refuse.
 *
 * Two independent guards, deliberately both applied — either alone would have let 2026-08 through
 * on a plausible-looking change:
 *   - the period must be strictly before {@link LIVE_DIRECT_VINTAGE_FROM};
 *   - the distributor code must be exactly the retired `DIRECT` marker.
 *
 * A batch with no period is refused. An unknown period cannot be proven to be retired, and the
 * failure mode of guessing is the one this module exists to prevent.
 */
export function classifyDirectCleanupBatches(batches: readonly CleanupBatch[]): BatchClassification {
  const deletable: CleanupBatch[] = [];
  const protectedLive: Array<CleanupBatch & { reason: string }> = [];

  for (const batch of batches) {
    const period = typeof batch.period === "string" ? batch.period.trim() : "";
    const code = typeof batch.distributor_code === "string" ? batch.distributor_code.trim() : "";

    if (!period) {
      protectedLive.push({ ...batch, reason: "batch has no period — cannot prove it is the retired vintage" });
      continue;
    }
    if (period >= LIVE_DIRECT_VINTAGE_FROM) {
      protectedLive.push({
        ...batch,
        reason: `period ${period} is at or after the live direct vintage ${LIVE_DIRECT_VINTAGE_FROM} (AGENTS.md §4 direct-order month golden rule)`,
      });
      continue;
    }
    if (code.toUpperCase() !== RETIRED_DIRECT_DISTRIBUTOR_CODE) {
      protectedLive.push({
        ...batch,
        reason: `distributor_code ${code || "(blank)"} is not the retired ${RETIRED_DIRECT_DISTRIBUTOR_CODE} vintage`,
      });
      continue;
    }
    deletable.push(batch);
  }

  return { deletable, protectedLive };
}

/**
 * Prove a backup actually holds every table the delete will take, BEFORE deleting anything.
 *
 * The original failure was not a missing backup call — it was a backup that wrote a file, printed
 * "Backup written", and did not contain the cascade. A written file is not a backup of the right
 * thing, so this asserts on CONTENT: every cascade table must be present as a key, and a table with
 * live rows must not be recorded as empty.
 *
 * `rowCounts` is what the delete is about to remove, table by table, measured from the database.
 */
export function assertBackupCoversCascade(
  backup: Record<string, unknown>,
  rowCounts: Record<string, number>,
): void {
  const problems: string[] = [];

  for (const table of [...BATCH_CASCADE_CHILD_TABLES, LINKED_RUN_STEP_TABLE]) {
    if (!(table in backup)) {
      problems.push(`${table}: not present in the backup at all`);
      continue;
    }
    const saved = backup[table];
    if (!Array.isArray(saved)) {
      problems.push(`${table}: backup entry is not an array`);
      continue;
    }
    const expected = rowCounts[table];
    if (typeof expected === "number" && saved.length !== expected) {
      problems.push(`${table}: backup holds ${saved.length} rows but ${expected} will be deleted`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      "REFUSING TO DELETE — the backup does not cover what the delete removes.\n  " +
        problems.join("\n  ") +
        "\nProduction has no point-in-time recovery; a partial backup is not a recovery path.",
    );
  }
}

/**
 * The banner the script prints. It is here, beside the guarantees, so a change to one is a visible
 * change to the other — the original defect was a banner that drifted away from the behaviour and
 * kept promising a backup nobody was taking.
 */
export function cleanupSafetyBanner(): string {
  return [
    "  - preview is read-only.",
    "  - apply refuses to run without both --apply and --confirm-production-delete.",
    `  - apply REFUSES any batch at or after ${LIVE_DIRECT_VINTAGE_FROM} (the live DirectReq vintage)`,
    `    and any batch whose distributor_code is not the retired ${RETIRED_DIRECT_DISTRIBUTOR_CODE}.`,
    "  - apply backs up the batches, the linked monthly run steps, and EVERY table the database",
    `    removes by cascade (${BATCH_CASCADE_CHILD_TABLES.length} of them), then verifies the written file`,
    "    row-for-row against what is about to be deleted and aborts if it does not match.",
    "  - production has NO point-in-time recovery. The backup file is the only recovery path.",
  ].join("\n");
}
