import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  insertRawPunches,
  RAW_PUNCH_BATCH_FUNCTION,
  RAW_PUNCH_BATCH_SIZE,
  RAW_PUNCH_FALLBACK_CONCURRENCY,
  RAW_PUNCH_SINGLE_FUNCTION,
  type RawPunchRpc,
  type RawPunchRpcReply,
  type RawPunchToInsert,
} from "../src/lib/attendance/raw-punch-batch.ts";

// THE INCIDENT. 18 Oct 2026, 10:16-10:33 Cairo: the on-prem agent replayed punches the table already
// held and `POST /api/attendance/raw-punches` answered with 10,461 single-row `phx_insert_attendance_raw_punch`
// calls, fifty at a time, while production was entering the slowdown that timed out the login check from
// 10:30 to 11:55. The route now sends up to 250 punches per call to `phx_insert_attendance_raw_punches`.
//
// These tests pin the three things that must not change under that: the counts the agent reads back
// (`inserted` / `duplicate`), the per-punch failure report that tells it what to send again, and the fact
// that a failing batch can never be worse than the old path.

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

/** Drops `//` line comments and `--` SQL comments so an assertion about code cannot be met by prose. */
function withoutLineComments(source: string, marker: "//" | "--"): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(marker))
    .join("\n");
}

function punches(count: number, firstIndex = 0): RawPunchToInsert[] {
  return Array.from({ length: count }, (_, offset) => {
    const index = firstIndex + offset;
    return {
      inputIndex: index,
      row: {
        device_id: "dev-1",
        device_user_id: String(1000 + index),
        employee_hr_id: `HR-${index}`,
        punch_time: new Date(Date.UTC(2026, 9, 18, 6, 0, index)).toISOString(),
        punch_type: index % 2 === 0 ? "in" : null,
        verify_mode: "fingerprint",
        raw_payload: index % 3 === 0 ? null : { n: index },
        source_run_id: "run-1",
      },
    };
  });
}

type Call = { fn: string; args: Record<string, unknown> };

function recorder(answer: (call: Call, nth: number) => RawPunchRpcReply | Promise<RawPunchRpcReply>) {
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlightSingles = 0;
  const rpc: RawPunchRpc = async (fn, args) => {
    const call = { fn, args };
    calls.push(call);
    const isSingle = fn === RAW_PUNCH_SINGLE_FUNCTION;
    if (isSingle) {
      inFlight += 1;
      maxInFlightSingles = Math.max(maxInFlightSingles, inFlight);
    }
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return await answer(call, calls.length - 1);
    } finally {
      if (isSingle) inFlight -= 1;
    }
  };
  return { rpc, calls, maxInFlightSingles: () => maxInFlightSingles };
}

const ok = (data: unknown): RawPunchRpcReply => ({ data, error: null });
const failed = (message: string, code?: string): RawPunchRpcReply => ({ data: null, error: { code, message } });

export async function runAttendanceRawPunchBatchTests() {
  // ── 1 · the numbers the owner can see ────────────────────────────────────────────────────────────
  assert.equal(RAW_PUNCH_BATCH_SIZE, 250, "250 punches a call: a full 1,000-punch request is four calls");
  assert.equal(RAW_PUNCH_FALLBACK_CONCURRENCY, 10, "the fallback runs ten at a time, not the old fifty");

  // ── 2 · nothing to insert: no call at all ────────────────────────────────────────────────────────
  {
    const { rpc, calls } = recorder(() => ok(0));
    const outcome = await insertRawPunches([], rpc);
    assert.deepEqual(outcome, { inserted: 0, duplicate: 0, failures: [], batchesFallenBack: 0 });
    assert.equal(calls.length, 0);
  }

  // ── 3 · THE POINT: 1,000 new punches cost four calls, not a thousand ─────────────────────────────
  {
    const { rpc, calls } = recorder((call) => ok((call.args.p_rows as unknown[]).length));
    const outcome = await insertRawPunches(punches(1000), rpc);
    assert.equal(calls.length, 4, "1,000 punches are four database calls");
    assert.ok(calls.every((call) => call.fn === RAW_PUNCH_BATCH_FUNCTION), "all of them are the batch function");
    assert.deepEqual(
      calls.map((call) => (call.args.p_rows as unknown[]).length),
      [250, 250, 250, 250],
    );
    assert.equal(outcome.inserted, 1000);
    assert.equal(outcome.duplicate, 0);
    assert.deepEqual(outcome.failures, []);
    assert.equal(outcome.batchesFallenBack, 0);
  }

  // ── 4 · a replay: the batch inserts nothing, and every punch is counted as the duplicate it is ───
  {
    const { rpc, calls } = recorder(() => ok(0));
    const outcome = await insertRawPunches(punches(600), rpc);
    assert.equal(calls.length, 3, "600 punches = 250 + 250 + 100");
    assert.equal(outcome.inserted, 0);
    assert.equal(outcome.duplicate, 600, "duplicate = batch size - inserted, summed over the batches");
    assert.equal(outcome.batchesFallenBack, 0, "a clean replay never touches the per-punch path");
  }

  // ── 5 · a mixed batch ────────────────────────────────────────────────────────────────────────────
  {
    const { rpc } = recorder(() => ok(100));
    const outcome = await insertRawPunches(punches(250), rpc);
    assert.equal(outcome.inserted, 100);
    assert.equal(outcome.duplicate, 150);
  }

  // ── 6 · the batch payload: resolved employee, a payload that is never null ───────────────────────
  {
    const { rpc, calls } = recorder(() => ok(3));
    await insertRawPunches(punches(3), rpc);
    const rows = calls[0].args.p_rows as Array<Record<string, unknown>>;
    assert.equal(rows[0].employee_hr_id, "HR-0", "the employee the route resolved is what is sent");
    assert.deepEqual(rows[0].raw_payload, {}, "a missing raw payload is sent as {} (the column is NOT NULL)");
    assert.deepEqual(rows[1].raw_payload, { n: 1 });
    assert.equal(rows[1].punch_type, null, "a null punch type stays null (it picks the other unique index)");
    assert.deepEqual(
      Object.keys(rows[0]).sort(),
      ["device_id", "device_user_id", "employee_hr_id", "punch_time", "punch_type", "raw_payload", "source_run_id", "verify_mode"],
      "exactly the eight columns the SQL function reads -- nothing else leaks into the database call",
    );
  }

  // ── 7 · FALLBACK: a failing batch is retried punch by punch and still reports by input index ─────
  {
    const items = [...punches(2, 7), ...punches(1, 40), ...punches(2, 100)]; // indexes 7,8,40,100,101
    const { rpc, calls, maxInFlightSingles } = recorder((call) => {
      if (call.fn === RAW_PUNCH_BATCH_FUNCTION) return failed("Could not find the function", "PGRST202");
      const user = String(call.args.p_device_user_id);
      if (user === "1007") return ok(9001); // inserted
      if (user === "1008") return ok(null); // already there
      if (user === "1040") return failed("duplicate key value violates unique constraint", "23505"); // stray unique violation
      if (user === "1100") return failed("canceling statement due to statement timeout", "57014"); // real failure
      return ok(9002);
    });
    const outcome = await insertRawPunches(items, rpc, { batchSize: 10, fallbackConcurrency: 2 });
    assert.equal(outcome.batchesFallenBack, 1);
    assert.equal(calls.filter((call) => call.fn === RAW_PUNCH_BATCH_FUNCTION).length, 1, "the batch is tried once");
    assert.equal(calls.filter((call) => call.fn === RAW_PUNCH_SINGLE_FUNCTION).length, 5, "then each punch once");
    assert.equal(outcome.inserted, 2, "1007 and 1101 were inserted");
    assert.equal(outcome.duplicate, 2, "no id back (1008) and a stray 23505 (1040) both read as duplicates");
    assert.deepEqual(
      outcome.failures,
      [{ index: 100, message: "canceling statement due to statement timeout" }],
      "a real failure is reported against the punch's OWN position in the request, not its place in the batch",
    );
    assert.ok(maxInFlightSingles() <= 2, "the fallback never runs more single calls at once than it was given");
    const sent = calls.find((call) => call.fn === RAW_PUNCH_SINGLE_FUNCTION)?.args ?? {};
    assert.deepEqual(Object.keys(sent).sort(), [
      "p_device_id",
      "p_device_user_id",
      "p_employee_hr_id",
      "p_punch_time",
      "p_punch_type",
      "p_raw_payload",
      "p_source_run_id",
      "p_verify_mode",
    ], "the fallback speaks the single-row function's own argument names");
  }

  // ── 8 · FALLBACK: concurrency really is bounded at the default of ten ────────────────────────────
  {
    const { rpc, calls, maxInFlightSingles } = recorder((call) =>
      call.fn === RAW_PUNCH_BATCH_FUNCTION ? failed("boom") : ok(1),
    );
    const outcome = await insertRawPunches(punches(250), rpc);
    assert.equal(calls.filter((call) => call.fn === RAW_PUNCH_SINGLE_FUNCTION).length, 250);
    assert.equal(outcome.inserted, 250);
    assert.ok(maxInFlightSingles() > 1, "the fallback does run in parallel");
    assert.ok(maxInFlightSingles() <= RAW_PUNCH_FALLBACK_CONCURRENCY, "and never more than ten at once");
  }

  // ── 9 · a batch that THROWS, and a batch that answers with nonsense, both fall back ──────────────
  {
    const thrown = recorder((call) => {
      if (call.fn === RAW_PUNCH_BATCH_FUNCTION) throw new Error("fetch failed");
      return ok(1);
    });
    const outcome = await insertRawPunches(punches(4), thrown.rpc);
    assert.equal(outcome.batchesFallenBack, 1, "a network failure on the batch must not become a 500");
    assert.equal(outcome.inserted, 4);

    for (const nonsense of [null, undefined, "3", 1.5, -1, 5, Number.NaN, { count: 3 }]) {
      const { rpc } = recorder((call) => (call.fn === RAW_PUNCH_BATCH_FUNCTION ? ok(nonsense) : ok(1)));
      const result = await insertRawPunches(punches(4), rpc);
      assert.equal(
        result.batchesFallenBack,
        1,
        `${String(nonsense)} is not a count of 0..4, so it must not be believed -- the per-punch path decides`,
      );
      assert.equal(result.inserted, 4);
    }
  }

  // ── 10 · one bad batch does not stop the next ones from being batched ────────────────────────────
  {
    const { rpc, calls } = recorder((call, nth) => {
      if (call.fn === RAW_PUNCH_BATCH_FUNCTION) return nth === 0 ? failed("timeout", "57014") : ok((call.args.p_rows as unknown[]).length);
      return ok(1);
    });
    const outcome = await insertRawPunches(punches(7), rpc, { batchSize: 3, fallbackConcurrency: 10 });
    assert.equal(outcome.batchesFallenBack, 1);
    assert.equal(outcome.inserted, 7);
    assert.equal(calls.filter((call) => call.fn === RAW_PUNCH_BATCH_FUNCTION).length, 3, "batches 2 and 3 still go through the batch");
    assert.equal(calls.filter((call) => call.fn === RAW_PUNCH_SINGLE_FUNCTION).length, 3, "only the failed batch's three punches go one by one");
  }

  // ── 11 · the route is wired to the helper and no longer calls the single function itself ───────
  {
    const route = withoutLineComments(read("app/api/attendance/raw-punches/route.ts"), "//");
    assert.ok(route.includes('from "@/lib/attendance/raw-punch-batch"'), "the route imports the helper");
    assert.ok(/await insertRawPunches\(/.test(route), "and uses it");
    assert.ok(
      !route.includes("phx_insert_attendance_raw_punch"),
      "the route must not name either insert function -- a per-punch loop here is the 10,461-call defect",
    );
    assert.ok(!/insertConcurrency/.test(route), "the old fifty-at-a-time constant is gone");
    assert.ok(
      route.includes("recordDeviceUserActivity(supabase, punches, new Set(unmappedPunches.map(mapKey)))"),
      "the device-user activity write is untouched",
    );
    assert.ok(/maxPunchesPerRequest = 1000/.test(route), "the request ceiling is unchanged");
  }

  // ── 12 · the migration: same posture as the single-row function, idempotent, service_role only ──
  {
    const sql = withoutLineComments(
      read("supabase/migrations/20261018142708_attendance_raw_punch_batch_insert.sql"),
      "--",
    ).toLowerCase();
    assert.ok(sql.includes("create or replace function public.phx_insert_attendance_raw_punches(p_rows jsonb)"));
    assert.ok(sql.includes("returns integer"));
    assert.ok(sql.includes("set search_path to 'public', 'pg_temp'"), "search_path is pinned");
    assert.ok(
      /\bon conflict do nothing\b/.test(sql) && !/on conflict\s*\(/.test(sql),
      "a bare ON CONFLICT DO NOTHING (no target) covers BOTH partial idempotency indexes",
    );
    assert.ok(
      sql.includes("revoke all on function public.phx_insert_attendance_raw_punches(jsonb) from public, anon, authenticated"),
      "execute is revoked from PUBLIC, anon and authenticated by name",
    );
    assert.ok(
      sql.includes("grant execute on function public.phx_insert_attendance_raw_punches(jsonb) to service_role"),
      "and re-granted to service_role alone",
    );
    assert.ok(!/security definer/.test(sql), "like the single-row function, it runs as the caller");
    assert.ok(!/\b(drop|truncate|delete)\b/.test(sql), "additive: nothing is dropped or deleted");
  }
}
