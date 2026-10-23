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
 * Driven against a stand-in client, so it touches no database: the first failing step must stop the
 * chain and be reported with the batch and the step, and the save itself must still succeed.
 */

type Call = { fn: string; args: unknown };

function fakeClient(failing: Record<string, string>) {
  const calls: Call[] = [];
  const client = {
    rpc: async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      if (fn === "sos_backfill_import_rows_from_customer_map") {
        return { data: [{ updated_rows: 3, affected_batch_ids: ["batch-7"] }], error: null };
      }
      if (failing[fn]) return { data: null, error: { message: failing[fn] } };
      return { data: null, error: null };
    },
  };
  return { calls, client: client as unknown as Parameters<typeof backfillCustomerRows>[0] };
}

const ROWS = [{ customer_code: "C-1", distributor_code: "D-1" }];

export async function runSosMappingBackfillRollupErrorsTests(): Promise<void> {
  // ── A failed fact rollup stops the chain and is reported ─────────────────────────────────────────
  {
    const { calls, client } = fakeClient({ phx_refresh_sos_fact_rollup: "canceling statement due to statement timeout" });
    const failures: { batchId: string; message: string }[] = [];
    const healed = await backfillCustomerRows(client, ROWS, (batchId, error) => failures.push({ batchId, message: error.message }));

    assert.equal(healed, 3, "the save itself still succeeds: the healed rows are kept and counted");
    assert.equal(
      failures.length,
      1,
      "HEADLINE: a fact rollup that resolves with { error } is REPORTED, never dropped — it used to leave the batch's Closing totals stale with no trace",
    );
    assert.equal(failures[0].batchId, "batch-7", "the report names the batch whose totals are stale");
    assert.match(failures[0].message, /fact rollup/i, "the report names the step that failed");
    assert.match(failures[0].message, /statement timeout/, "the report carries the database's own reason");

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
    const { calls, client } = fakeClient({ phx_refresh_sos_channel_rollup: "deadlock detected" });
    const failures: string[] = [];
    await backfillCustomerRows(client, ROWS, (_batchId, error) => failures.push(error.message));

    assert.deepEqual(failures.length, 1, "a failed channel rollup is reported once");
    assert.match(failures[0], /channel rollup failed for batch batch-7: deadlock detected/);
    const called = calls.map((c) => c.fn);
    assert.ok(called.includes("phx_refresh_sos_fact_rollup"), "the fact rollup ran before the failure");
    assert.ok(
      !called.includes("phx_refresh_sos_distributor_product_rollup") && !called.includes("phx_refresh_sos_import_summaries"),
      "nothing after the failed step runs",
    );
  }

  // ── A backfill that moved nothing rebuilds nothing and reports nothing ───────────────────────────
  {
    const calls: Call[] = [];
    const client = {
      rpc: async (fn: string, args: unknown) => {
        calls.push({ fn, args });
        return { data: [{ updated_rows: 0, affected_batch_ids: [] }], error: null };
      },
    } as unknown as Parameters<typeof backfillCustomerRows>[0];
    const failures: string[] = [];
    assert.equal(await backfillCustomerRows(client, ROWS, (_b, e) => failures.push(e.message)), 0);
    assert.equal(failures.length, 0, "no batch touched, nothing to report");
    assert.deepEqual(calls.map((c) => c.fn), ["sos_backfill_import_rows_from_customer_map"], "no rebuild runs for no batch");
  }
}
