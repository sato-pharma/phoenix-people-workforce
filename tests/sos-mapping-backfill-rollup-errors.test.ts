import assert from "node:assert/strict";

import { backfillCustomerRows } from "../src/lib/sales/normalizer/mapping.ts";

/**
 * A MAPPING SAVE NEVER LETS A FAILED TOTALS REBUILD PASS UNSEEN (2026-10-23).
 *
 * `backfillCustomerRows` moves import rows to the brick a saved mapping names, then rebuilds every
 * total that batch feeds. `supabase.rpc` never throws: a refresh that fails or times out RESOLVES with
 * `{ error }`, and every one of those results used to be dropped inside a try/catch that could catch
 * nothing. A failed fact rollup then let the channel, distributor x product and attribution rollups
 * rebuild on the OLD fact rows, and the Monthly Closing kept that batch's old totals with no trace.
 *
 * The rebuild now runs through the shared `refreshBatchRollups` (customer-map.ts), which checks every
 * step and stops at the first failure, and a file it could not rebuild is queued in
 * `source_of_sales_brick_move_files` for the 20-minute rebuild clock (audit P4-05).
 *
 * Driven against a stand-in client, so it touches no database: the first failing step must stop the
 * chain, the file must be queued, and the save itself must still succeed.
 */

type Call = { fn: string; args: unknown };

function fakeClient(failing: Record<string, string>) {
  const calls: Call[] = [];
  const queued: Record<string, unknown>[] = [];
  const client = {
    rpc: async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      if (fn === "sos_backfill_import_rows_from_customer_map") {
        return { data: [{ updated_rows: 3, affected_batch_ids: ["batch-7"] }], error: null };
      }
      if (failing[fn]) return { data: null, error: { message: failing[fn] } };
      return { data: null, error: null };
    },
    from: (table: string) => ({
      upsert: async (rows: Record<string, unknown>[]) => {
        assert.equal(table, "source_of_sales_brick_move_files", "a failed rebuild is queued on the brick-move queue");
        queued.push(...rows);
        return { error: null };
      },
    }),
  };
  return { calls, queued, client: client as unknown as Parameters<typeof backfillCustomerRows>[0] };
}

const ROWS = [{ customer_code: "C-1", distributor_code: "D-1", brick_id: "BR-1" }];

export async function runSosMappingBackfillRollupErrorsTests(): Promise<void> {
  // ── A failed fact rollup stops the chain and the file is queued ──────────────────────────────────
  {
    const { calls, queued, client } = fakeClient({ phx_refresh_sos_fact_rollup: "canceling statement due to statement timeout" });
    const healed = await backfillCustomerRows(client, ROWS);

    assert.equal(healed, 3, "the save itself still succeeds: the healed rows are kept and counted");
    assert.equal(
      queued.length,
      1,
      "HEADLINE: a fact rollup that resolves with { error } QUEUES the file for the rebuild clock, never drops it — it used to leave the batch's Closing totals stale with no trace",
    );
    assert.equal(queued[0].batch_id, "batch-7", "the queued row names the batch whose totals are stale");
    assert.equal(queued[0].old_brick_id, "BR-1", "keyed by a brick the re-pointed rows now sit on");

    const called = new Set(calls.map((c) => c.fn));
    for (const downstream of [
      "phx_refresh_sos_channel_rollup",
      "phx_refresh_sos_distributor_product_rollup",
      "phx_refresh_monthly_attribution",
      "phx_refresh_sos_import_summaries",
    ]) {
      assert.ok(
        !called.has(downstream),
        `${downstream} must NOT run after the fact rollup failed — it would rebuild on the old fact rows`,
      );
    }
  }

  // ── A failure further down stops what reads it, and keeps what already rebuilt ───────────────────
  {
    const { calls, queued, client } = fakeClient({ phx_refresh_sos_channel_rollup: "deadlock detected" });
    await backfillCustomerRows(client, ROWS);

    assert.equal(queued.length, 1, "a failed channel rollup queues the file once");
    const called = calls.map((c) => c.fn);
    assert.ok(called.includes("phx_refresh_sos_fact_rollup"), "the fact rollup ran before the failure");
    assert.ok(
      !called.includes("phx_refresh_sos_distributor_product_rollup") && !called.includes("phx_refresh_sos_import_summaries"),
      "nothing after the failed step runs",
    );
  }

  // ── A backfill that moved nothing rebuilds nothing and queues nothing ────────────────────────────
  {
    const calls: Call[] = [];
    const client = {
      rpc: async (fn: string, args: unknown) => {
        calls.push({ fn, args });
        return { data: [{ updated_rows: 0, affected_batch_ids: [] }], error: null };
      },
      from: () => {
        throw new Error("nothing may be queued when no batch was touched");
      },
    } as unknown as Parameters<typeof backfillCustomerRows>[0];
    assert.equal(await backfillCustomerRows(client, ROWS), 0);
    assert.deepEqual(calls.map((c) => c.fn), ["sos_backfill_import_rows_from_customer_map"], "no rebuild runs for no batch");
  }
}
