import assert from "node:assert/strict";

import { readImportRowsFrom } from "../src/lib/sales/monthly-closing-details.ts";

/**
 * The Monthly Closing details read pages every import row of the month's validated batches. Until
 * 2026-09-17 it asked `batch_id IN (…) ORDER BY id LIMIT 1000` — one walk over the primary key that
 * starts at the first row ever imported. On production for July that threw away 254,652 rows to
 * return the first 1,000 (249 ms, 140,714 buffers; 1.4 s average over 1,625 calls in
 * pg_stat_statements). It now walks each batch on the table's unique (batch_id, row_number) index
 * (7 ms for the same page) and re-sorts the result by id.
 *
 * What this pins, against a mock that answers exactly the PostgREST operators the reader may use:
 *   1. the query SHAPE — one batch per request (`eq batch_id`), seeking on row_number; never the
 *      old IN list ordered by id, which is the regression that costs the database;
 *   2. the OUTPUT is what the old walk returned — every row of the requested line exactly once, in
 *      ascending id across all batches, however row_number and id interleave, across page
 *      boundaries, on an exact-multiple last page, and with a batch id listed twice.
 */

type Row = Record<string, unknown>;

interface Call {
  eq: Array<[string, unknown]>;
  inList: Array<[string, unknown[]]>;
  gt: Array<[string, number]>;
  order: string[];
  limit: number;
}

function mockSupabase(dataset: Row[]) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      assert.equal(table, "source_of_sales_import_rows");
      const call: Call = { eq: [], inList: [], gt: [], order: [], limit: Number.POSITIVE_INFINITY };
      calls.push(call);
      const builder = {
        select(_cols: string) { return builder; },
        eq(col: string, val: unknown) { call.eq.push([col, val]); return builder; },
        in(col: string, vals: unknown[]) { call.inList.push([col, vals]); return builder; },
        gt(col: string, val: number) { call.gt.push([col, val]); return builder; },
        order(col: string, _opts: { ascending: boolean }) { call.order.push(col); return builder; },
        limit(n: number) { call.limit = n; return builder; },
        then(resolve: (v: { data: Row[]; error: null }) => void) {
          let rows = dataset.filter((r) =>
            call.eq.every(([c, v]) => r[c] === v) &&
            call.inList.every(([c, vs]) => vs.includes(r[c])) &&
            call.gt.every(([c, v]) => Number(r[c]) > v),
          );
          for (const col of [...call.order].reverse()) rows = [...rows].sort((a, b) => Number(a[col]) - Number(b[col]));
          resolve({ data: rows.slice(0, call.limit), error: null });
        },
      };
      return builder;
    },
  };
  return { client: client as unknown as Parameters<typeof readImportRowsFrom>[0], calls };
}

/** What the old single walk returned: the batches' rows of that line, ascending by id. */
function oldWalk(dataset: Row[], batchIds: string[], lineKey: string): number[] {
  return dataset
    .filter((r) => batchIds.includes(String(r.batch_id)))
    .filter((r) => String(r.official_line ?? "").trim().toLowerCase() === lineKey)
    .map((r) => Number(r.id))
    .sort((a, b) => a - b);
}

export async function runMonthlyClosingDetailsKeysetTests() {
  // Two batches whose ids interleave, and whose row_number order is NOT their id order, with the
  // line spelled three ways plus a blank. pageSize 3 forces several pages per batch.
  const lines = ["Pedia", " pedia ", "CNS", null, "PEDIA"];
  const b1: Row[] = [50, 10, 90, 30, 70, 110, 130].map((id, i) => ({
    id, batch_id: "b1", row_number: i + 1, official_line: lines[i % lines.length],
  }));
  const b2: Row[] = [60, 20, 100, 40, 80, 120].map((id, i) => ({
    id, batch_id: "b2", row_number: i + 1, official_line: lines[(i + 2) % lines.length],
  }));
  const other: Row[] = [{ id: 1, batch_id: "b9", row_number: 1, official_line: "Pedia" }];
  const dataset = [...b1, ...b2, ...other];

  // ── 1. query shape: per batch, seeking on row_number — never the IN list walked by id ─────────
  {
    const { client, calls } = mockSupabase(dataset);
    await readImportRowsFrom(client, ["b1", "b2"], "Pedia", 3);
    assert.ok(calls.length > 0, "the reader must query the import rows");
    assert.ok(
      calls.every((c) => c.inList.length === 0 && !c.order.includes("id")),
      "every page must be ONE batch on (batch_id, row_number) — `batch_id IN (…) ORDER BY id` walks the whole primary key (254,652 rows discarded for July's first page on production)",
    );
    assert.ok(
      calls.every((c) => c.eq.length === 1 && c.eq[0]?.[0] === "batch_id" && c.order.join() === "row_number"),
      "each page must filter one batch_id and order by row_number, the table's unique index",
    );
    assert.ok(
      calls.every((c) => c.gt.every(([col]) => col === "row_number")),
      "the keyset cursor must seek on row_number",
    );
    assert.deepEqual(
      [...new Set(calls.map((c) => c.eq[0]?.[1]))].sort(),
      ["b1", "b2"],
      "only the requested batches are read",
    );
  }

  // ── 2. output: the line's rows, each once, ascending id across batches and pages ──────────────
  {
    const { client } = mockSupabase(dataset);
    const got = await readImportRowsFrom(client, ["b1", "b2"], "Pedia", 3);
    assert.deepEqual(
      got.map((r) => Number(r.id)),
      oldWalk(dataset, ["b1", "b2"], "pedia"),
      "same rows in the same order as the old id walk — no drop, no duplicate, ascending id across batches",
    );
    assert.ok(got.length > 0 && got.every((r) => String(r.batch_id) !== "b9"), "another month's batch never leaks in");
  }

  // ── 3. an exact-multiple last page ends cleanly ──────────────────────────────────────────────
  {
    const six: Row[] = [6, 5, 4, 3, 2, 1].map((id, i) => ({ id, batch_id: "b3", row_number: i + 1, official_line: "CNS" }));
    const { client, calls } = mockSupabase(six);
    const got = await readImportRowsFrom(client, ["b3"], "cns", 3);
    assert.deepEqual(got.map((r) => Number(r.id)), [1, 2, 3, 4, 5, 6], "6 rows over pages of 3 come back once each");
    assert.equal(calls.length, 3, "two full pages then one empty page — no endless loop");
  }

  // ── 4. a batch id listed twice is read once (one IN list never returned a row twice) ──────────
  {
    const { client } = mockSupabase(dataset);
    const got = await readImportRowsFrom(client, ["b1", "b2", "b1"], "Pedia", 3);
    assert.deepEqual(
      got.map((r) => Number(r.id)),
      oldWalk(dataset, ["b1", "b2"], "pedia"),
      "a duplicated batch id must not duplicate its rows",
    );
  }

  // ── 5. no batches → no query ─────────────────────────────────────────────────────────────────
  {
    const { client, calls } = mockSupabase(dataset);
    assert.deepEqual(await readImportRowsFrom(client, [], "Pedia", 3), []);
    assert.equal(calls.length, 0, "an empty batch list reads nothing");
  }

  // ── 6. the default page is still 1,000 rows ──────────────────────────────────────────────────
  {
    const { client, calls } = mockSupabase(dataset);
    await readImportRowsFrom(client, ["b1"], "Pedia");
    assert.ok(calls.every((c) => c.limit === 1000), "production pages stay at 1,000 rows");
  }
}
