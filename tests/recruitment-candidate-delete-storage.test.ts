import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  distinctStoragePaths,
  readCandidateStoragePaths,
  removeCandidateStorageObjects,
  type StorageCleanupDeps,
} from "../src/lib/recruitment/candidate-storage-cleanup.ts";
import { stripComments } from "./support/comment-strip.ts";

// Deleting a candidate used to leave their files in the `recruitment-files` bucket for ever: the
// `ats_files` rows cascade away, but each row only POINTS at an object, and nothing removed the object
// (89 on production, 2026-10-18, among them job offers and CVs of people whose records were deleted).
// `ats_candidate_comments` and `ats_candidate_manager_folders` carry no foreign key either, so they
// orphaned beside the filings.
//
// Two halves, on purpose. The helper is exercised for real through a plain-object fake — never a real
// client, because the suite loads .env.local and that is PRODUCTION. `deleteCandidate` itself calls the
// live client directly and cannot be driven without one, so its ORDER is pinned in source, the way
// tests/cv-cabinet-audit-fixes.test.ts pins the filing delete beside it.

type Result = { data: unknown; error: unknown };
type FilterCall = { column: string; op: "eq" | "in"; value: unknown };
type QueryCall = { filters: FilterCall[]; select: string; table: string };
type FileRow = { candidate_id: string; drive_file_id: string | null };
type Failure = "returned" | "thrown";

type QueryBuilder = {
  eq(column: string, value: unknown): QueryBuilder;
  in(column: string, value: unknown): QueryBuilder;
  select(columns: string): QueryBuilder;
  then: PromiseLike<Result>["then"];
};

type FakeOptions = {
  files?: FileRow[];
  /** Fails every `ats_files` read, as a returned error or as a thrown one. */
  readFailure?: Failure;
  /** Storage `remove` calls to fail, keyed by their 0-based position. */
  removeFailures?: Record<number, Failure>;
  /** Makes the Storage API answer `data: null` on success. */
  removeAnswersNull?: boolean;
};

function fakeClient(options: FakeOptions = {}) {
  const queries: QueryCall[] = [];
  const removeCalls: { bucket: string; paths: string[] }[] = [];
  const files = options.files ?? [];

  const respond = (call: QueryCall): Result => {
    if (call.table !== "ats_files") throw new Error(`the cleanup must only read ats_files, it asked for ${call.table}`);
    if (options.readFailure === "thrown") throw new Error("connection reset");
    if (options.readFailure === "returned") return { data: null, error: { message: "permission denied" } };
    let rows = files;
    for (const filter of call.filters) {
      if (filter.op === "eq") rows = rows.filter((row) => (row as Record<string, unknown>)[filter.column] === filter.value);
      else rows = rows.filter((row) => (filter.value as unknown[]).includes((row as Record<string, unknown>)[filter.column]));
    }
    return { data: rows.map((row) => ({ drive_file_id: row.drive_file_id })), error: null };
  };

  const query = (call: QueryCall): QueryBuilder => {
    const builder: QueryBuilder = {
      eq(column, value) {
        call.filters.push({ column, op: "eq", value });
        return builder;
      },
      in(column, value) {
        call.filters.push({ column, op: "in", value });
        return builder;
      },
      select(columns) {
        call.select = columns;
        return builder;
      },
      then(onfulfilled, onrejected) {
        return new Promise<Result>((resolve, reject) => {
          try {
            resolve(respond(call));
          } catch (error) {
            reject(error);
          }
        }).then(onfulfilled, onrejected);
      },
    };
    return builder;
  };

  const client = {
    from(table: string) {
      const call: QueryCall = { filters: [], select: "", table };
      queries.push(call);
      return query(call);
    },
    storage: {
      from(bucket: string) {
        return {
          async remove(paths: string[]) {
            const index = removeCalls.length;
            removeCalls.push({ bucket, paths: [...paths] });
            const failure = options.removeFailures?.[index];
            if (failure === "thrown") throw new Error("network down");
            if (failure === "returned") return { data: null, error: { message: "storage refused" } };
            return { data: options.removeAnswersNull ? null : paths.map((name) => ({ name })), error: null };
          },
        };
      },
    },
  };

  return { client: client as unknown as SupabaseClient, queries, removeCalls };
}

type LogEntry = { labels: Record<string, string | number>; message: string };

function capture() {
  const logs: LogEntry[] = [];
  const logFailure: NonNullable<StorageCleanupDeps["logFailure"]> = (message, details) => {
    logs.push({ labels: details.labels, message });
  };
  return { logFailure, logs };
}

function read(relative: string): string {
  return fs.readFileSync(path.join(process.cwd(), relative), "utf8").replace(/\r\n/g, "\n");
}

/** Source with comments removed, so a pin can never be satisfied by the comment explaining it. */
function codeOnly(source: string): string {
  return stripComments(source);
}

/** One top-level function, from its signature to its closing brace. */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end < 0 ? undefined : end + 2);
}

const CANDIDATE = "cand-1";
const A = "cv/aaaa/Ahmed-Hassan.pdf";
const B = "cv/bbbb/Offer-Letter.pdf";

export async function runRecruitmentCandidateDeleteStorageTests() {
  // ── 1. READING THE PATHS, BEFORE THE CASCADE TAKES THE ROWS ──────────────────────────────────────
  assert.deepEqual(
    distinctStoragePaths([A, ` ${A} `, B, null, undefined, "", "   ", 42, {}]),
    [A, B],
    "paths are trimmed, de-duplicated in first-seen order, and anything that is not a non-blank string is dropped",
  );

  {
    const { client, queries } = fakeClient({
      files: [
        { candidate_id: CANDIDATE, drive_file_id: A },
        { candidate_id: CANDIDATE, drive_file_id: `  ${A}` },
        { candidate_id: CANDIDATE, drive_file_id: B },
        { candidate_id: CANDIDATE, drive_file_id: null },
        { candidate_id: CANDIDATE, drive_file_id: "   " },
        { candidate_id: "somebody-else", drive_file_id: "cv/cccc/Not-Mine.pdf" },
      ],
    });
    const { logFailure, logs } = capture();
    const paths = await readCandidateStoragePaths(CANDIDATE, { client, logFailure });
    assert.deepEqual(paths, [A, B], "it returns the candidate's own distinct, non-blank paths and nobody else's");
    assert.equal(queries.length, 1, "one read is enough");
    assert.equal(queries[0].table, "ats_files");
    assert.equal(queries[0].select, "drive_file_id", "only the path column is read");
    assert.deepEqual(queries[0].filters, [{ column: "candidate_id", op: "eq", value: CANDIDATE }]);
    assert.equal(logs.length, 0, "a clean read logs nothing");
  }

  for (const readFailure of ["returned", "thrown"] as const) {
    const { client } = fakeClient({ files: [{ candidate_id: CANDIDATE, drive_file_id: A }], readFailure });
    const { logFailure, logs } = capture();
    const paths = await readCandidateStoragePaths(CANDIDATE, { client, logFailure });
    assert.deepEqual(paths, [], `a ${readFailure} read failure must not stop the delete — it yields no paths`);
    assert.equal(logs.length, 1, "and it is logged once");
    assert.equal(logs[0].labels.event, "candidate_delete_storage_list_failed");
    assert.equal(logs[0].labels.candidate_id, CANDIDATE);
  }

  // ── 2. REMOVING THE BYTES, AFTER THE RECORD IS GONE ──────────────────────────────────────────────
  {
    const { client, queries, removeCalls } = fakeClient();
    const { logFailure, logs } = capture();
    const outcome = await removeCandidateStorageObjects(CANDIDATE, [A, B], { client, logFailure });
    assert.deepEqual(outcome, { failed: 0, keptReferenced: 0, removed: 2 });
    assert.deepEqual(
      removeCalls,
      [{ bucket: "recruitment-files", paths: [A, B] }],
      "the objects go through the Storage API, on the recruitment bucket and no other",
    );
    assert.equal(queries.length, 1, "one reference check precedes the removal");
    assert.deepEqual(queries[0].filters, [{ column: "drive_file_id", op: "in", value: [A, B] }]);
    assert.equal(logs.length, 0, "a clean removal logs nothing");
  }

  {
    // Nothing to remove must not even reach the client.
    const poisoned = {
      from() {
        throw new Error("the client must not be touched");
      },
      storage: {
        from() {
          throw new Error("the client must not be touched");
        },
      },
    } as unknown as SupabaseClient;
    const { logFailure, logs } = capture();
    for (const paths of [[], ["", "  "]]) {
      assert.deepEqual(
        await removeCandidateStorageObjects(CANDIDATE, paths, { client: poisoned, logFailure }),
        { failed: 0, keptReferenced: 0, removed: 0 },
        "a candidate with no files costs no query and no storage call",
      );
    }
    assert.equal(logs.length, 0);
  }

  {
    const { client, removeCalls } = fakeClient();
    await removeCandidateStorageObjects(CANDIDATE, [A, A, ` ${A} `], { client });
    assert.deepEqual(removeCalls.map((call) => call.paths), [[A]], "a repeated path is removed once");
  }

  // A path a SURVIVING row still names is the one thing that must never be deleted — bytes cannot be
  // taken back. This is the merge-between-read-and-delete race, and any future copy-by-reference.
  {
    const { client, removeCalls } = fakeClient({ files: [{ candidate_id: "survivor", drive_file_id: A }] });
    const { logFailure, logs } = capture();
    const outcome = await removeCandidateStorageObjects(CANDIDATE, [A, B], { client, logFailure });
    assert.deepEqual(outcome, { failed: 0, keptReferenced: 1, removed: 1 });
    assert.deepEqual(removeCalls.map((call) => call.paths), [[B]], "the referenced object is left alone");
    assert.equal(logs.length, 0, "keeping a referenced object is correct, not a failure");
  }
  {
    const { client, removeCalls } = fakeClient({
      files: [
        { candidate_id: "survivor", drive_file_id: A },
        { candidate_id: "survivor", drive_file_id: B },
      ],
    });
    const outcome = await removeCandidateStorageObjects(CANDIDATE, [A, B], { client });
    assert.deepEqual(outcome, { failed: 0, keptReferenced: 2, removed: 0 });
    assert.equal(removeCalls.length, 0, "when every path is still referenced the Storage API is never called");
  }

  // If the reference check cannot be completed, NOTHING is removed: a leaked object is recoverable.
  for (const readFailure of ["returned", "thrown"] as const) {
    const { client, removeCalls } = fakeClient({ readFailure });
    const { logFailure, logs } = capture();
    const outcome = await removeCandidateStorageObjects(CANDIDATE, [A, B], { client, logFailure });
    assert.deepEqual(
      outcome,
      { failed: 2, keptReferenced: 0, removed: 0 },
      `${readFailure}: it must not throw, and an unconfirmed set must be left in storage`,
    );
    assert.equal(removeCalls.length, 0, `${readFailure}: an unconfirmed object is never deleted`);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].labels.event, "candidate_delete_storage_check_failed");
    assert.equal(logs[0].labels.candidate_id, CANDIDATE);
    assert.equal(logs[0].labels.file_count, 2);
  }

  // ── 3. A STORAGE FAILURE IS LOGGED, NEVER RAISED, AND ONE BATCH DOES NOT STARVE THE REST ─────────
  const many = Array.from({ length: 120 }, (_, index) => `cv/${String(index).padStart(3, "0")}/File-${index}.pdf`);

  {
    const { client, queries, removeCalls } = fakeClient();
    const outcome = await removeCandidateStorageObjects(CANDIDATE, many, { client });
    assert.equal(outcome.removed, 120);
    assert.deepEqual(
      queries.map((call) => (call.filters[0].value as unknown[]).length),
      [50, 50, 20],
      "the reference check is chunked — PostgREST answers an over-long .in() with ZERO rows and no error, which would read as 'nothing references these'",
    );
    assert.deepEqual(removeCalls.map((call) => call.paths.length), [50, 50, 20], "removal is batched the same way");
    assert.deepEqual(removeCalls.flatMap((call) => call.paths), many, "every path is removed exactly once, in order");
  }

  for (const failure of ["returned", "thrown"] as const) {
    const { client, removeCalls } = fakeClient({ removeFailures: { 0: failure } });
    const { logFailure, logs } = capture();
    const outcome = await removeCandidateStorageObjects(CANDIDATE, many, { client, logFailure });
    assert.deepEqual(outcome, { failed: 50, keptReferenced: 0, removed: 70 }, `${failure}: it must not throw`);
    assert.equal(removeCalls.length, 3, `${failure}: a failed batch must not stop the next two`);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].labels.event, "candidate_delete_storage_remove_failed");
    assert.equal(logs[0].labels.candidate_id, CANDIDATE);
    assert.equal(logs[0].labels.file_count, 50);
  }

  {
    const { client } = fakeClient({ removeAnswersNull: true });
    assert.deepEqual(
      await removeCandidateStorageObjects(CANDIDATE, [A], { client }),
      { failed: 0, keptReferenced: 0, removed: 0 },
      "a null answer from the Storage API is counted as nothing removed, not as a crash",
    );
  }

  // A stored path names a person ("Ahmed-Hassan.pdf"), so it must never reach the log.
  {
    const { client } = fakeClient({ readFailure: "returned" });
    const { logFailure, logs } = capture();
    await removeCandidateStorageObjects(CANDIDATE, [A, B], { client, logFailure });
    const failing = fakeClient({ removeFailures: { 0: "returned" } });
    await removeCandidateStorageObjects(CANDIDATE, [A, B], { client: failing.client, logFailure });
    assert.equal(logs.length, 2);
    assert.ok(
      !JSON.stringify(logs).includes("cv/"),
      "no log line may carry a storage path — it names the person whose CV it is",
    );
  }

  // ── 4. deleteCandidate: THE ORDER, PINNED IN SOURCE ──────────────────────────────────────────────
  const candidates = codeOnly(read("src/lib/recruitment/candidates.ts"));
  const deleteBody = functionBody(candidates, "export async function deleteCandidate(");
  const at = (needle: string) => {
    const found = deleteBody.indexOf(needle);
    assert.ok(found >= 0, `deleteCandidate must contain ${needle}`);
    return found;
  };
  const readAt = at("readCandidateStoragePaths(id)");
  const filingAt = at('.from("ats_cv_folder_items").delete().eq("candidate_id", id)');
  const shelfAt = at('.from("ats_candidate_manager_folders").delete().eq("candidate_id", id)');
  const commentAt = at('.from("ats_candidate_comments").delete().eq("candidate_id", id)');
  const recordAt = at('.from("ats_candidates").delete().eq("id", id)');
  const removeAt = at("removeCandidateStorageObjects(id, storagePaths)");

  assert.ok(
    readAt < Math.min(filingAt, shelfAt, commentAt, recordAt),
    "the paths are read BEFORE any delete — the cascade destroys the only record of where the bytes are",
  );
  for (const [name, position] of [["folder filings", filingAt], ["manager shelves", shelfAt]] as const) {
    assert.ok(position < recordAt, `${name} have no foreign key, so they must be deleted with the candidate, before the row`);
  }
  const guardAt = deleteBody.indexOf("if (error) throw error;", recordAt);
  assert.ok(guardAt > recordAt, "the candidate delete must still throw on failure");
  assert.ok(
    commentAt > guardAt,
    "comments go only AFTER the candidate delete has succeeded: a failed delete must leave every comment in place — a filing or a shelf comes back with one press, a comment does not",
  );
  assert.ok(
    removeAt > guardAt,
    "the bytes are removed only AFTER the record delete has succeeded — never before it, or a failed delete would leave a live record with its files gone",
  );
  assert.ok(
    !deleteBody.includes("ats_candidate_status_events"),
    "ats_candidate_status_events is an append-only audit trail kept on purpose — a delete never touches it",
  );

  // ── 5. THE HELPER USES THE STORAGE API, NEVER SQL ────────────────────────────────────────────────
  const helper = codeOnly(read("src/lib/recruitment/candidate-storage-cleanup.ts"));
  assert.ok(
    helper.includes(".storage.from(RECRUITMENT_FILES_BUCKET).remove("),
    "objects are removed through the Storage API",
  );
  assert.ok(
    !helper.includes("storage.objects"),
    "delete from storage.objects is refused by storage.protect_delete() (42501) — the helper must never name that table",
  );
  assert.ok(!helper.includes(".delete("), "the helper removes bytes only; it never deletes a database row");

  // ── 6. A MERGE MOVES A DUPLICATE'S FILES, IT NEVER DROPS THEM, SO IT LEAKS NO BYTES ──────────────
  const merge = codeOnly(read("src/lib/recruitment/candidate-merge-service.ts"));
  const childTablesStart = merge.indexOf("const childTables");
  const childTables = merge.slice(childTablesStart, merge.indexOf("] as const;", childTablesStart));
  assert.ok(
    childTables.includes('"ats_files"'),
    "a merge re-points the duplicate's files to the survivor, so their objects stay referenced",
  );
  assert.doesNotMatch(
    merge,
    /from\("ats_files"\)\s*\.delete/,
    "a merge must not delete ats_files rows — if it ever drops a file it must remove the bytes too (removeCandidateStorageObjects)",
  );
}
