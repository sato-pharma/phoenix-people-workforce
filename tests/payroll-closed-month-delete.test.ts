import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isPayrollConflictError } from "../src/lib/payroll/errors.ts";
import {
  assertSalaryBatchDeletable,
  isDeletableSalaryBatch,
  isReplaceableSalaryBatch,
} from "../src/lib/payroll/service.ts";
import type { SalaryBatch } from "../src/lib/payroll/types.ts";

/**
 * A CLOSED PAYROLL MONTH IS NEVER DELETED.
 *
 * Three triggers exist to enforce that in the database — on salary_batches, salary_records and
 * salary_flags. All three open with a check on `request.phx_allow_salary_batch_delete` and return
 * early when it is 'on'. phx_delete_salary_batch set that flag as its third statement,
 * unconditionally, and never tested the status it had just read: it put `status` in the return
 * payload and otherwise ignored it. Every delete through the application therefore ran with all
 * three guards disarmed.
 *
 * When this was found, ALL EIGHT production batches were in the protected state — 3 approved,
 * 5 locked, 896 salary_records between them — so nothing was legitimately deletable and
 * everything was deletable. The screen offered it behind one browser confirm, and production has
 * no PITR. The sibling guard phx_prevent_closed_salary_batch_update, written in the same
 * migration for the same table, has no bypass at all; that asymmetry is what marked this as an
 * oversight rather than a decision.
 *
 * Owner ruling, 2026-09-12: refuse it outright.
 *
 * The rule is the REPLACE rule and must stay that way. Deleting a batch removes the batch, its
 * salary_records and its salary_flags outright, so it is strictly more destructive than replacing
 * one and can never be permitted where a replace is refused. A second, laxer definition of
 * "closed" is precisely how this hole grows back.
 */

const OPEN_STATUSES = ["uploaded", "part1_ready", "rejected"] as const;
const CLOSED_STATUSES = [
  "part1_paid",
  "adjustments_open",
  "part2_ready",
  "under_review",
  "approved",
  "locked",
] as const;

const MIGRATION = "supabase/migrations/20260912120000_payroll_batch_delete_refuses_closed_months.sql";

function batch(overrides: Partial<SalaryBatch> = {}): SalaryBatch {
  return {
    approvedAt: null,
    approvedBy: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    fileName: "payroll.xlsx",
    id: "b1",
    lockedAt: null,
    month: 8,
    part1PaidAt: null,
    part1PaidBy: null,
    part2ReadyAt: null,
    part2ReadyBy: null,
    rejectedReason: null,
    status: "uploaded",
    uploadedBy: null,
    year: 2026,
    ...overrides,
  };
}

export function runPayrollClosedMonthDeleteTests(): void {
  // ---- 1. A closed month cannot be deleted ------------------------------------------------------
  for (const status of CLOSED_STATUSES) {
    assert.equal(
      isDeletableSalaryBatch(batch({ status })),
      false,
      `HEADLINE: a payroll batch with status "${status}" must not be deletable — every batch in production was in one of these states while all of them were deletable through the admin screen`,
    );
    assert.throws(
      () => assertSalaryBatchDeletable(batch({ status })),
      (error: unknown) => isPayrollConflictError(error),
      `deleting a "${status}" batch must raise a payroll conflict, not fall through to the RPC`,
    );
  }

  // Part 1 paid closes the month even when the status still reads as an open one.
  assert.equal(
    isDeletableSalaryBatch(batch({ status: "uploaded", part1PaidAt: "2026-09-05T00:00:00.000Z" })),
    false,
    "HEADLINE: a batch whose Part 1 is already paid must not be deletable whatever its status says — people have been paid from it",
  );

  // ---- 2. An open month can still be deleted ----------------------------------------------------
  // The fix must not take away admin cleanup of a genuine draft; that is the case the delete
  // exists for, and a fix that blocked it would simply be reverted.
  for (const status of OPEN_STATUSES) {
    assert.equal(
      isDeletableSalaryBatch(batch({ status })),
      true,
      `HEADLINE: a "${status}" batch must remain deletable — admin cleanup of an unpaid draft is what this path is for`,
    );
    assert.doesNotThrow(() => assertSalaryBatchDeletable(batch({ status })));
  }

  // ---- 3. Delete is never laxer than replace ----------------------------------------------------
  for (const status of [...OPEN_STATUSES, ...CLOSED_STATUSES]) {
    for (const part1PaidAt of [null, "2026-09-05T00:00:00.000Z"]) {
      const candidate = batch({ status, part1PaidAt });
      if (!isDeletableSalaryBatch(candidate)) continue;
      assert.ok(
        isReplaceableSalaryBatch(candidate),
        `HEADLINE: status "${status}" (part1PaidAt=${String(part1PaidAt)}) is deletable but not replaceable — delete is the more destructive of the two and must never be offered where replace is refused`,
      );
    }
  }

  // ---- 4. The migration refuses BEFORE it bypasses the guards -----------------------------------
  // The SQL is the real boundary: it covers every caller, including one that never goes through
  // the service. Order matters — a refusal placed after the set_config would run with the three
  // closed-month triggers already disarmed.
  const sql = readFileSync(MIGRATION, "utf8");
  const refusal = sql.indexOf("cannot be deleted");
  const bypass = sql.indexOf("set_config('request.phx_allow_salary_batch_delete'");
  assert.ok(refusal > 0, "the migration must raise a refusal naming the month");
  assert.ok(bypass > 0, "the migration must still set the bypass — the cascade needs it for a batch that IS deletable");
  assert.ok(
    refusal < bypass,
    "HEADLINE: the migration must refuse a closed month BEFORE it sets request.phx_allow_salary_batch_delete — a refusal after that line runs with all three closed-month triggers already disarmed",
  );
  assert.match(
    sql,
    /not in \('uploaded', 'part1_ready', 'rejected'\)/,
    "the migration must carry the same open-status list the service uses, or the two layers can disagree about what 'closed' means",
  );
  assert.match(
    sql,
    /part1_paid_at is not null/,
    "the migration must also refuse on Part 1 being paid, not on status alone",
  );

  // ---- 5. The screen must not offer what the server refuses -------------------------------------
  const shared = readFileSync("src/components/payroll/dashboard/shared.tsx", "utf8");
  assert.match(
    shared,
    /export function isBatchDeletable[\s\S]{0,200}isBatchReplaceable\(batch\)/,
    "the dashboard's delete predicate must delegate to the replace predicate, so the two can never drift apart",
  );
  const history = readFileSync("src/components/payroll/dashboard/payroll-history.tsx", "utf8");
  assert.match(
    history,
    /disabled=\{!isBatchDeletable\(batch\) \|\| deletingBatchId === batch\.id\}/,
    "HEADLINE: the Delete button must be disabled for a closed month — Replace was already guarded this way while Delete was not, which is the same asymmetry the database had",
  );

  // ---- 6. The service is actually wired to the guard --------------------------------------------
  const service = readFileSync("src/lib/payroll/service.ts", "utf8");
  const deleteFn = service.slice(service.indexOf("export async function deleteSalaryBatch"));
  const rpcCall = deleteFn.indexOf('supabase.rpc("phx_delete_salary_batch"');
  const guardCall = deleteFn.indexOf("assertSalaryBatchDeletable(existing)");
  assert.ok(guardCall > 0, "deleteSalaryBatch must assert deletability");
  assert.ok(
    guardCall < rpcCall,
    "HEADLINE: deleteSalaryBatch must refuse before it calls the RPC, or the screen gets a raw Postgres error instead of a sentence naming the month",
  );
}
