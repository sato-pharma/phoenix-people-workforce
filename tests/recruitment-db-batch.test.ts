import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { chunkIds, fetchRowsInBatches, IN_FILTER_BATCH_SIZE } from "../src/lib/recruitment/db-batch.ts";

export async function runRecruitmentDbBatchTests() {
  // --- chunkIds ---------------------------------------------------------------------------------
  assert.deepEqual(chunkIds([], 3), [], "no ids is no batches, not one empty batch");
  assert.deepEqual(
    chunkIds(["a"], 3),
    [["a"]],
    "a list shorter than one batch is still a batch — dropping the remainder loses rows with no error",
  );
  assert.deepEqual(chunkIds(["a", "b", "c"], 3), [["a", "b", "c"]], "an exact multiple must not add a trailing empty batch");
  assert.deepEqual(chunkIds(["a", "b", "c", "d"], 3), [["a", "b", "c"], ["d"]], "the remainder is its own batch");
  assert.throws(() => chunkIds(["a"], 0), /at least 1/, "size 0 would loop forever — it must throw, not hang");

  // Every id survives, exactly once, in order. This is the property that matters: a dropped id is a
  // candidate missing from a board, and the caller would see a shorter list rather than an error.
  const many = Array.from({ length: 250 }, (_, index) => `id-${index}`);
  const batches = chunkIds(many);
  assert.equal(batches.length, 3, `250 ids at ${IN_FILTER_BATCH_SIZE} per batch is 3 requests`);
  assert.deepEqual(batches.flat(), many, "flattening the batches must reproduce the input exactly");
  assert.ok(
    batches.every((batch) => batch.length <= IN_FILTER_BATCH_SIZE),
    "no batch may exceed the size that fits in the request URL",
  );

  // --- fetchRowsInBatches -----------------------------------------------------------------------
  const seen: string[][] = [];
  const rows = await fetchRowsInBatches<{ id: string }>(many, (batch) => {
    seen.push(batch);
    return Promise.resolve({ data: batch.map((id) => ({ id })), error: null });
  });
  assert.equal(seen.length, 3, "one request per batch");
  assert.deepEqual(
    rows.map((row) => row.id),
    many,
    "rows come back in batch order, with nothing lost between batches",
  );

  // A null `data` on a batch is not an error and must not abort the rest.
  const sparse = await fetchRowsInBatches<{ id: string }>(many, (batch) =>
    Promise.resolve({ data: batch[0] === "id-0" ? null : batch.map((id) => ({ id })), error: null }),
  );
  assert.equal(sparse.length, 150, "an empty first batch still leaves the other two batches' rows");

  // An error on ANY batch must surface. Silently returning the batches that worked would look like
  // "these are all the rows" — the exact failure this module exists to make impossible.
  let calls = 0;
  await assert.rejects(
    () =>
      fetchRowsInBatches<{ id: string }>(many, (batch) => {
        calls += 1;
        return Promise.resolve(
          calls === 2 ? { data: null, error: { message: "boom" } } : { data: batch.map((id) => ({ id })), error: null },
        );
      }),
    // PostgREST hands back a plain error object, not an Error, and the codebase's convention is to
    // `throw error` unchanged — so assert on the value that actually surfaces.
    (thrown: unknown) => {
      assert.equal((thrown as { message?: string }).message, "boom");
      return true;
    },
    "an error on the second batch must reject, not return the first batch's rows",
  );
  assert.equal(calls, 2, "it must stop at the failing batch rather than keep issuing requests");

  // --- The four unbounded call sites stay batched ------------------------------------------------
  // The defect here is invisible to the type system and to lint: `.in("id", someArray)` is valid
  // TypeScript that works perfectly until the list outgrows the request URL in production. So the
  // guard has to read the source.
  //
  // Deliberately NOT "every id filter in recruitment must be batched" — several are bounded by
  // construction (one candidate's own applications, a single id) and batching those would add round
  // trips across the Atlantic for nothing. This pins the four whose length is driven by how much
  // data exists, which is the set that can silently outgrow the limit.
  // Each site is pinned individually — by its own table and filter column — so breaking any ONE of
  // them fires its own assertion rather than hiding behind a sibling that is still batched.
  const repoRoot = process.cwd();
  const mustBatch: Array<{ file: string; site: string; table: string; column: string }> = [
    {
      file: "src/lib/recruitment/applications.ts",
      site: "candidates behind a company-wide application list",
      table: "ats_candidates",
      column: "id",
    },
    {
      file: "src/lib/recruitment/candidates.ts",
      site: "source context for the whole candidate pool",
      table: "ats_candidate_source_context",
      column: "candidate_id",
    },
    {
      file: "src/lib/recruitment/cv-review-queue.ts",
      site: "candidates behind up to MAX_EXTRACTION_ROWS extractions",
      table: "ats_candidates",
      column: "id",
    },
    {
      file: "src/lib/recruitment/selection.ts",
      site: "every applicant on one requisition",
      table: "ats_candidates",
      column: "id",
    },
    {
      file: "src/lib/recruitment/selection.ts",
      site: "every interview on one requisition",
      table: "ats_interviews",
      column: "application_id",
    },
    {
      file: "src/lib/recruitment/selection.ts",
      site: "prior rejections for every applicant on one requisition",
      table: "ats_applications",
      column: "candidate_id",
    },
  ];
  const sourceCache = new Map<string, string>();
  for (const { file, site, table, column } of mustBatch) {
    let source = sourceCache.get(file);
    if (source === undefined) {
      source = readFileSync(path.join(repoRoot, file), "utf8");
      sourceCache.set(file, source);
    }
    assert.match(
      source,
      /from "@\/lib\/recruitment\/db-batch"/,
      `${file} loads ${site} — that id list must go through db-batch`,
    );
    // From the .from("<table>") through to the .in("<column>", …) of the same query chain.
    const chain = new RegExp(`\\.from\\("${table}"\\)[\\s\\S]{0,300}?\\.in\\(\\s*"${column}"\\s*,\\s*([A-Za-z0-9_.\\[\\]() ]+?)\\s*\\)`);
    const matched = chain.exec(source);
    assert.ok(matched, `${file}: no ${table}.${column} id filter found at all (${site})`);
    assert.equal(
      matched[1],
      "batch",
      `${file}: ${table}.${column} is filtered on "${matched[1]}" rather than a batch — ${site} is unbounded, so the whole list would go into the request URL`,
    );
  }
}
