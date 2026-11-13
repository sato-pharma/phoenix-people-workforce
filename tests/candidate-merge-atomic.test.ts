import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { recruitmentApiError } from "../app/api/recruitment/_lib/http.ts";
import type { AccessContext } from "../src/lib/auth/permissions.ts";
import { ApiError } from "../src/lib/http/api-errors.ts";
import { describeCopiedHistoryLine, mergeableFields } from "../src/lib/recruitment/candidate-merge.ts";
import {
  appendOnlyChildTables,
  childTables,
  dedupedChildTables,
  linkedByOwnColumn,
  MERGE_CANDIDATES_RPC,
  MERGE_RACE_MESSAGE,
  MERGE_RACE_SQLSTATE,
  mergeCandidates,
} from "../src/lib/recruitment/candidate-merge-service.ts";
import { normalizeEmail } from "../src/lib/recruitment/candidate-matching.ts";
import type { Candidate } from "../src/lib/recruitment/types.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

/**
 * A CANDIDATE MERGE IS ONE TRANSACTION (F-RCT-005, 2026-11-13).
 *
 * `mergeCandidates` used to run ~20 separate PostgREST calls — the deduped moves, the plain
 * reassigns, the append-only copies, the WhatsApp relink, the delete and the survivor's update — and
 * a failure part-way left a HALF merge: some child rows on the survivor, the rest on a duplicate that
 * still existed. Two of twenty-three production merges stopped half-way on 2026-09-04.
 *
 * Every one of those writes now lives in `public.phx_merge_ats_candidates`. This file pins:
 *
 *  1. the function locks BOTH candidate rows FOR UPDATE, lowest id first, and refuses if one is gone;
 *  2. every table the TypeScript lists name is handled in the SQL, with the SAME key, identity,
 *     partial-index predicate and orphan clean-up as `dedupedChildTables` declares, the SAME copied
 *     columns and original-deletion rule as `appendOnlyChildTables`;
 *  3. the survivor's columns are whitelisted in SQL, and the whitelist is exactly what TS may borrow;
 *  4. revoke from public/anon/authenticated, grant to service_role;
 *  5. `mergeCandidates` calls the RPC and issues no `.delete()` / `.update(` of its own;
 *  6. against a fake client: an RPC error throws and the Drive mirror never runs; a success reports
 *     the same summary words the step-by-step merge produced.
 */

function mergeFunctionSql(): string {
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
  for (let at = files.length - 1; at >= 0; at -= 1) {
    const sql = readFileSync(new URL(files[at], dir), "utf8");
    if (/create or replace function public\.phx_merge_ats_candidates\(/i.test(sql)) {
      return stripSqlComments(sql).toLowerCase();
    }
  }
  throw new Error("no migration defines public.phx_merge_ats_candidates");
}

/** One deduped table's block: from its first read to the line that records its counts. */
function dedupedBlock(sql: string, table: string): string {
  const from = sql.indexOf(`from public.${table} d`);
  const start = sql.lastIndexOf("select coalesce(array_agg(", from);
  const end = sql.indexOf(`jsonb_build_object('${table}'`, from);
  assert.ok(from > 0 && start > 0 && end > from, `${table} is in dedupedChildTables but the merge function never moves it`);
  return sql.slice(start, end);
}

type Call = { args?: unknown; kind: string; table?: string };

function fakeClient(calls: Call[], rpcAnswer: { data: unknown; error: unknown }) {
  const builder = (table: string) => ({
    in: () => {
      calls.push({ kind: "read", table });
      return Promise.resolve({ data: [], error: null });
    },
    insert: (row: unknown) => {
      calls.push({ args: row, kind: "insert", table });
      return Promise.resolve({ error: null });
    },
    select() {
      return this;
    },
  });
  return {
    from: (table: string) => builder(table),
    rpc: (name: string, args: unknown) => {
      calls.push({ args, kind: "rpc", table: name });
      return Promise.resolve(rpcAnswer);
    },
  };
}

const access = { hrId: "B-10", role: "Super Admin", scope: "system" } as unknown as AccessContext;

function candidate(fields: Partial<Candidate> & { id: string }): Candidate {
  return {
    fullName: "Ahmed Hassan",
    offerId: null,
    screeningExtraAnswers: {},
    status: "new",
    ...fields,
  } as unknown as Candidate;
}

export async function runCandidateMergeAtomicTests() {
  const sql = mergeFunctionSql();

  // ── 1. THE LOCK ─────────────────────────────────────────────────────────────────────────────────
  // THE HEADLINE. Both rows, in one deterministic order, before the first write — so two merges of
  // the same pair (or A→B racing B→A) queue instead of deadlocking, and the loser finds its row gone.
  assert.match(sql, /v_first := least\(p_survivor_id, p_duplicate_id\);/, "the first row locked must be the LOWER id");
  assert.match(sql, /v_second := greatest\(p_survivor_id, p_duplicate_id\);/, "the second row locked must be the HIGHER id");
  const lockFirstAt = sql.search(/from public\.ats_candidates where id = v_first for update;\s*if not found then\s*raise exception/);
  const lockSecondAt = sql.search(/from public\.ats_candidates where id = v_second for update;\s*if not found then\s*raise exception/);
  assert.ok(lockFirstAt > 0, "the lower id must be locked FOR UPDATE, and a missing row must refuse the merge");
  assert.ok(lockSecondAt > lockFirstAt, "the higher id is locked SECOND — any other order can deadlock against a concurrent merge");
  const firstWriteAt = Math.min(
    ...["update public.", "delete from public.", "insert into public."].map((verb) => {
      const at = sql.indexOf(verb);
      return at === -1 ? Number.POSITIVE_INFINITY : at;
    }),
  );
  assert.ok(lockSecondAt < firstWriteAt, "both rows must be locked before the function writes anything");
  assert.match(sql, /if p_survivor_id = p_duplicate_id then\s*raise exception/, "merging a record into itself would delete the survivor");
  // A row missing UNDER THE LOCK was read by TypeScript a moment earlier, so it is a lost race, not
  // an unknown id — it raises its own SQLSTATE so the caller can answer 409 instead of 404.
  const lockBlock = sql.slice(lockFirstAt, sql.indexOf("end if;", lockSecondAt) + "end if;".length);
  assert.equal(
    lockBlock.split(`using errcode = '${MERGE_RACE_SQLSTATE.toLowerCase()}'`).length - 1,
    2,
    "both lock refusals raise the race SQLSTATE the service maps to 409",
  );
  assert.ok(!lockBlock.includes("p0002"), "a lost race must not wear the not-found code — that answers 404 with the generic text");

  // ── 2. EVERY TABLE THE TYPESCRIPT USED TO TOUCH ───────────────────────────────────────────────
  for (const table of childTables) {
    assert.ok(
      sql.includes(`update public.${table} set candidate_id = p_survivor_id where candidate_id = p_duplicate_id;`),
      `${table} is a plain child table — the merge function must re-point every row of it`,
    );
  }
  assert.ok(
    sql.indexOf("update public.ats_applications set") < sql.indexOf("update public.ats_files set"),
    "applications still move before files — the only plain move a unique index can refuse",
  );

  for (const spec of dedupedChildTables) {
    const block = dedupedBlock(sql, spec.table);
    assert.ok(
      block.includes(`array_agg(d.${spec.identityColumn})`),
      `${spec.table}: the blocked rows are named by ${spec.identityColumn}, exactly as the TypeScript named them`,
    );
    assert.ok(
      block.includes(`s.${spec.keyColumn} = d.${spec.keyColumn}`),
      `${spec.table}: a collision is decided on ${spec.keyColumn}, the column the unique index is on`,
    );
    assert.ok(
      block.includes(`coalesce(d.${spec.keyColumn}::text, '') <> ''`),
      `${spec.table}: a NULL or empty key never blocks a row (splitRowsByExistingKey)`,
    );
    assert.ok(
      block.includes(`s.candidate_id = p_survivor_id`) && block.includes(`d.candidate_id = p_duplicate_id`),
      `${spec.table}: the duplicate's rows are compared against the SURVIVOR's`,
    );
    assert.ok(
      block.includes(`where candidate_id = p_duplicate_id and ${spec.identityColumn} <> all (`),
      `${spec.table}: every row that is not blocked moves`,
    );
    const deletesBlocked = block.includes(`delete from public.${spec.table}`);
    assert.equal(
      deletesBlocked,
      spec.orphansOnDelete,
      spec.orphansOnDelete
        ? `${spec.table} has no foreign key — its blocked rows must be deleted or they outlive the duplicate`
        : `${spec.table} cascades with the duplicate — deleting its rows by hand is not what the merge did`,
    );
    if (spec.onlyWhen) {
      const predicate = `coalesce(%s.${spec.onlyWhen.column}::text, '') = '${spec.onlyWhen.value}'`;
      assert.ok(
        block.includes(predicate.replace("%s", "d")) && block.includes(predicate.replace("%s", "s")),
        `${spec.table}: the PARTIAL index applies on BOTH sides, or a resolved row would block an open one`,
      );
    } else {
      assert.ok(!block.includes("::text, '') = '"), `${spec.table}: its unique index is not partial — no predicate may narrow it`);
    }
  }

  for (const spec of appendOnlyChildTables) {
    const insertAt = sql.indexOf(`insert into public.${spec.table}`);
    assert.ok(insertAt > 0, `${spec.table} is append-only — the merge function must COPY its rows onto the survivor`);
    const columnList = sql.slice(insertAt, sql.indexOf(")", insertAt));
    for (const column of ["candidate_id", ...spec.columns]) {
      assert.ok(columnList.includes(column), `${spec.table}: ${column} is carried over verbatim, as it was`);
    }
    const statement = sql.slice(insertAt, sql.indexOf(";", insertAt));
    assert.ok(
      statement.includes(`btrim(src.${spec.noteColumn}, v_ws) || ' ' ||`),
      `${spec.table}: the provenance line is appended to the row's own ${spec.noteColumn}, trimmed`,
    );
    assert.ok(statement.includes("order by src.created_at, src.id"), `${spec.table}: copies are written oldest first, as before`);
    assert.equal(
      statement.includes(`delete from public.${spec.table}`),
      spec.canDeleteOriginals,
      spec.canDeleteOriginals
        ? `${spec.table}: the copied originals must be removed — nothing else ever would`
        : `${spec.table}: a trigger refuses DELETE, so its originals must be left exactly where they are`,
    );
  }
  // The comment originals deleted are EXACTLY the rows copied — never a comment written meanwhile.
  assert.match(sql, /delete from public\.ats_candidate_comments c\s+where c\.id in \(select src\.id from src\)/);

  for (const link of linkedByOwnColumn) {
    assert.ok(
      new RegExp(`update public\\.${link.table}\\s+set ${link.column} = p_survivor_id\\s+where ${link.column} = p_duplicate_id;`).test(sql),
      `${link.table}.${link.column} must be repointed at the survivor before the duplicate is deleted`,
    );
  }

  // The trim the SQL applies is EXACTLY JavaScript's String.prototype.trim, which is what
  // describeCopiedHistoryLine used on the note before this function existed.
  const wsDeclaration = sql.slice(sql.indexOf("v_ws constant text :="), sql.indexOf(";", sql.indexOf("v_ws constant text :=")));
  const sqlTrim = new Set([...wsDeclaration.matchAll(/chr\((\d+)\)/g)].map((match) => Number(match[1])));
  const jsTrim = new Set<number>();
  for (let code = 0; code <= 0xffff; code += 1) {
    if (String.fromCharCode(code).trim() === "") jsTrim.add(code);
  }
  assert.deepEqual([...sqlTrim].sort((a, b) => a - b), [...jsTrim].sort((a, b) => a - b), "v_ws must be JavaScript's trim set, character for character");

  // ── 3. THE WHITELIST ────────────────────────────────────────────────────────────────────────────
  const allowedDeclaration = sql.slice(sql.indexOf("v_allowed constant text[] := array["), sql.indexOf("];", sql.indexOf("v_allowed constant")));
  const allowed = new Set([...allowedDeclaration.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]));
  const borrowable = new Set<string>([
    ...mergeableFields.map((field) => field.column),
    "email_norm",
    "phone_norm",
    "national_id_norm",
    "screening_extra_answers",
  ]);
  assert.deepEqual([...allowed].sort(), [...borrowable].sort(), "the SQL whitelist is exactly what TypeScript may borrow — no more, no less");
  for (const forbidden of ["status", "source", "notes", "full_name", "id"]) {
    assert.ok(!allowed.has(forbidden), `${forbidden} must never be writable by a merge`);
  }
  assert.match(sql, /where k <> all \(v_allowed\);\s*if v_bad is not null then\s*raise exception/, "a key outside the whitelist refuses the merge");
  assert.ok(sql.includes("format('%i = r.%i', k, k)"), "the column names are quoted as identifiers");
  assert.ok(
    sql.indexOf("delete from public.ats_candidates where id = p_duplicate_id") < sql.indexOf("update public.ats_candidates c set"),
    "the duplicate frees its email and national ID before the survivor borrows them",
  );

  // ── 4. WHO MAY CALL IT ──────────────────────────────────────────────────────────────────────────
  assert.match(sql, /security definer\s+set search_path = public/, "a SECURITY DEFINER function with a pinned search_path");
  assert.match(
    sql,
    /revoke execute on function public\.phx_merge_ats_candidates\(uuid, uuid, jsonb, text, text\) from public, anon, authenticated;/,
    "revoking from PUBLIC is what actually closes it — anon and authenticated inherit EXECUTE through it",
  );
  assert.match(sql, /grant execute on function public\.phx_merge_ats_candidates\(uuid, uuid, jsonb, text, text\) to service_role;/);
  for (const key of ["'deduped'", "'reassigned'", "'copied'", "'relinked'", "'candidate'"]) {
    assert.ok(sql.includes(key), `the function must report ${key} — the summary reads it`);
  }

  // ── 5. THE TYPESCRIPT NO LONGER WRITES ─────────────────────────────────────────────────────────
  const service = stripComments(
    readFileSync(new URL("../src/lib/recruitment/candidate-merge-service.ts", import.meta.url), "utf8"),
  );
  assert.equal(MERGE_CANDIDATES_RPC, "phx_merge_ats_candidates");
  assert.ok(service.includes("supabase.rpc(MERGE_CANDIDATES_RPC"), "mergeCandidates must call the merge function");
  assert.ok(!service.includes(".delete("), "the service must not delete a row itself — a second write outside the transaction is a half merge again");
  assert.ok(!service.includes(".update("), "the service must not update a row itself — every move belongs to the one transaction");
  assert.equal(
    service.split(".insert(").length - 1,
    1,
    "the only insert left is the best-effort merge history line, whose note is built from the function's counts",
  );

  // ── 6. AGAINST A FAKE CLIENT ────────────────────────────────────────────────────────────────────
  const survivorId = "11111111-1111-4111-8111-111111111111";
  const duplicateId = "22222222-2222-4222-8222-222222222222";
  const survivor = candidate({ id: survivorId, screeningExtraAnswers: { a: "1" } });
  const duplicate = candidate({ email: " Ahmed.H@Example.com ", id: duplicateId, screeningExtraAnswers: { b: "2" } });
  const loadCandidate = async (id: string) => (id === survivorId ? survivor : id === duplicateId ? duplicate : null);

  // (a) The function refuses → mergeCandidates throws, the Drive mirror never runs, no history line.
  {
    const calls: Call[] = [];
    let mirrored = 0;
    const refusal = { code: "23505", message: "duplicate key value violates unique constraint" };
    await assert.rejects(
      mergeCandidates(access, { duplicateId, survivorId }, {
        client: fakeClient(calls, { data: null, error: refusal }) as never,
        loadCandidate,
        mirrorCvs: async () => {
          mirrored += 1;
        },
      }),
      (error: unknown) => error === refusal,
      "an RPC error must reach the caller as it is",
    );
    assert.equal(mirrored, 0, "a merge the database refused must never re-file the cabinet");
    assert.equal(calls.filter((call) => call.kind === "rpc").length, 1);
    assert.equal(calls.filter((call) => call.kind === "insert").length, 0, "no history line for a merge that did not happen");
  }

  // (a2) A LOST RACE — a row read a moment ago is gone under the lock — answers 409 in plain words.
  {
    const calls: Call[] = [];
    let mirrored = 0;
    const race = {
      code: MERGE_RACE_SQLSTATE,
      message: `phx_merge_ats_candidates: candidate ${duplicateId} was merged or deleted by a concurrent change`,
    };
    let thrown: unknown = null;
    await assert.rejects(
      mergeCandidates(access, { duplicateId, survivorId }, {
        client: fakeClient(calls, { data: null, error: race }) as never,
        loadCandidate,
        mirrorCvs: async () => {
          mirrored += 1;
        },
      }).catch((error: unknown) => {
        thrown = error;
        throw error;
      }),
    );
    assert.ok(thrown instanceof ApiError, "a lost race must become an ApiError the route can map");
    assert.equal((thrown as ApiError).status, 409, "a lost race is a conflict, never a 404");
    assert.equal((thrown as ApiError).message, MERGE_RACE_MESSAGE);
    assert.equal(
      MERGE_RACE_MESSAGE,
      "This candidate was merged or changed by someone else a moment ago; refresh and try again.",
    );
    assert.equal(mirrored, 0, "a merge that lost the race must never re-file the cabinet");
    assert.equal(calls.filter((call) => call.kind === "insert").length, 0);
    const response = recruitmentApiError(thrown, "Failed to merge the candidate records.");
    assert.equal(response.status, 409, "the merge route answers the lost race with 409");
    assert.equal(((await response.json()) as { message: string }).message, MERGE_RACE_MESSAGE);
  }

  // (a3) An id that is not there BEFORE the merge starts stays a 404, and never reaches the database.
  {
    const calls: Call[] = [];
    let thrown: unknown = null;
    await assert.rejects(
      mergeCandidates(access, { duplicateId: "33333333-3333-4333-8333-333333333333", survivorId }, {
        client: fakeClient(calls, { data: {}, error: null }) as never,
        loadCandidate,
        mirrorCvs: async () => undefined,
      }).catch((error: unknown) => {
        thrown = error;
        throw error;
      }),
    );
    assert.ok(thrown instanceof ApiError && thrown.status === 404, "an unknown id is a 404, not the race's 409");
    assert.equal((thrown as ApiError).message, "The duplicate candidate no longer exists.");
    assert.equal(calls.filter((call) => call.kind === "rpc").length, 0, "an unknown id never reaches the merge function");
    assert.equal(recruitmentApiError(thrown, "Failed to merge the candidate records.").status, 404);
  }

  // (b) A refusal decided in TypeScript never reaches the database at all.
  {
    const calls: Call[] = [];
    await assert.rejects(
      mergeCandidates(access, { duplicateId: survivorId, survivorId }, {
        client: fakeClient(calls, { data: {}, error: null }) as never,
        loadCandidate,
        mirrorCvs: async () => undefined,
      }),
      /cannot be merged into itself/,
    );
    assert.equal(calls.filter((call) => call.kind === "rpc").length, 0);
  }

  // (c) Success: the arguments the function receives, and the summary built from what it answers.
  {
    const calls: Call[] = [];
    const sequence: string[] = [];
    const answer = {
      candidate: { email: "Ahmed.H@Example.com", full_name: "Ahmed Hassan", id: survivorId, status: "shortlisted" },
      copied: { ats_candidate_comments: 1, ats_candidate_status_events: 3 },
      deduped: {
        ats_candidate_district_returns: { blocked: 0, moved: 0 },
        ats_candidate_manager_folders: { blocked: 0, moved: 0 },
        ats_candidate_manager_sends: { blocked: 0, moved: 1 },
        ats_candidate_views: { blocked: 2, moved: 0 },
        ats_cv_folder_items: { blocked: 1, moved: 0 },
      },
      reassigned: {
        ats_applications: 1,
        ats_candidate_cv_extractions: 2,
        ats_cv_intake_events: 4,
        ats_files: 2,
        ats_interview_bookings: 1,
      },
      relinked: { ats_whatsapp_classification_sessions: 1 },
    };
    const client = fakeClient(calls, { data: answer, error: null });
    const result = await mergeCandidates(access, { duplicateId, survivorId }, {
      client: {
        ...client,
        rpc: (name: string, args: unknown) => {
          sequence.push("rpc");
          return client.rpc(name, args);
        },
      } as never,
      loadCandidate,
      mirrorCvs: async (id: string) => {
        sequence.push(`mirror:${id}`);
      },
    });

    const rpc = calls.find((call) => call.kind === "rpc");
    assert.equal(rpc?.table, "phx_merge_ats_candidates");
    const args = rpc?.args as Record<string, unknown>;
    assert.equal(args.p_survivor_id, survivorId);
    assert.equal(args.p_duplicate_id, duplicateId);
    assert.deepEqual(
      args.p_borrow,
      {
        email: "Ahmed.H@Example.com",
        email_norm: normalizeEmail("Ahmed.H@Example.com"),
        screening_extra_answers: { a: "1", b: "2" },
      },
      "the borrow decision stays in TypeScript: the trimmed value, its _norm twin, and the merged answers",
    );
    for (const [param, table] of [
      ["p_status_event_provenance", "ats_candidate_status_events"],
      ["p_comment_provenance", "ats_candidate_comments"],
    ] as const) {
      const line = String(args[param]);
      assert.ok(line.startsWith("[Copied from duplicate record 222222 when it was merged in on "), `${param} names the duplicate`);
      const mergedOn = line.slice("[Copied from duplicate record 222222 when it was merged in on ".length, line.indexOf(". The original"));
      assert.equal(line, describeCopiedHistoryLine({ duplicateId, existingNote: null, mergedOn, table }));
      // What the SQL builds from it is what describeCopiedHistoryLine built with the note in hand.
      assert.equal(
        `${"  Sent to Saad.\n".trim()} ${line}`,
        describeCopiedHistoryLine({ duplicateId, existingNote: "  Sent to Saad.\n", mergedOn, table }),
      );
    }

    assert.equal(
      result.summary,
      "Merged the duplicate record for Ahmed Hassan. Moved 1 booked interview, 2 files, 1 application and 1 manager send across. "
        + "Copied 3 history lines and 1 comment onto this record — those are append-only, so the rows are copied rather than moved. "
        + "Filled in the email and screening question answers. "
        + "2 view markers and 1 folder filing could not move across — the record being kept already had its own, so they were dropped.",
      "the summary words are unchanged — they are built from the function's counts exactly as from the old step-by-step counts",
    );
    assert.deepEqual(result.leftBehind, [
      "2 view markers could not move across — the record being kept already had its own, so they were dropped.",
      "1 folder filing could not move across — the record being kept already had its own, so it was dropped.",
    ]);
    assert.equal(result.movedApplications, 1);
    assert.equal(result.movedFiles, 2);
    assert.equal(result.movedInterviews, 1);
    assert.equal(result.copiedAppendOnlyRows, 4);
    assert.deepEqual(result.borrowedFields, ["email"]);
    assert.equal(result.candidate.status, "shortlisted", "the survivor returned is the row the function wrote");

    const history = calls.find((call) => call.kind === "insert");
    assert.equal(history?.table, "ats_candidate_status_events");
    assert.equal((history?.args as { note: string }).note, result.summary, "the merge history line carries the summary");
    assert.deepEqual(sequence, ["rpc", `mirror:${survivorId}`], "the cabinet is re-filed once, after the merge function committed");
  }
}
