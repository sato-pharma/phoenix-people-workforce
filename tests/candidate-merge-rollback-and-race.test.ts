import assert from "node:assert/strict";

import { createAccessContext } from "../src/lib/auth/permissions.ts";
import { ApiError } from "../src/lib/http/api-errors.ts";
import { normalizeEmail } from "../src/lib/recruitment/candidate-matching.ts";
import {
  MERGE_CANDIDATES_RPC,
  MERGE_RACE_MESSAGE,
  MERGE_RACE_SQLSTATE,
  mergeCandidates,
} from "../src/lib/recruitment/candidate-merge-service.ts";
import {
  anyWrite,
  atomically,
  RpcRaise,
  rpcCalls,
  snapshot,
  STAND_IN_ORIGIN,
  withStandIn,
  type Row,
  type RpcAnswer,
  type Seen,
  type StandIn,
  type Tables,
} from "./support/postgrest-stand-in.ts";

// A CANDIDATE MERGE IS ALL OR NOTHING, AND TWO MERGES OF ONE PAIR LEAVE ONE MERGE — proved on BEHAVIOUR.
// tests/candidate-merge-atomic.test.ts pins the SQL text of phx_merge_ats_candidates and drives
// mergeCandidates against a hand-rolled client that answers whatever it is told. This file runs the
// REAL mergeCandidates, through the REAL Supabase admin client, against the in-memory PostgREST in
// tests/support/postgrest-stand-in.ts, with the function modelled from its migration
// (20261113161727_ats_candidate_merge_atomic.sql): both candidate rows locked lowest id first and the
// merge refused (PX409) when one is gone, the five deduped moves, the plain re-points, the append-only
// copies, the WhatsApp relink, the delete of the duplicate and the whitelisted borrow — in that order,
// inside `atomically`, so a raise part-way keeps nothing, as Postgres does.
//
//   (a) A failure AFTER the function's first write — right after it moved the first manager send, and
//       again at the comment copy after it had moved files, applications, interviews and history —
//       leaves every candidate table exactly as it was, the duplicate whole. The app writes no merge
//       history line, never re-files the Drive cabinet, and the recruiter is refused, never told "merged".
//   (b) Two recruiters merging the same pair at once, and A-into-B racing B-into-A: exactly one merge
//       happens, the other gets the 409 the lock promises, and every child row was moved or copied ONCE
//       (no doubled history, no doubled comments), with one merge history line and one cabinet re-file.
//
// Every race holds both database calls until both callers have arrived, so each has already read both
// candidates and passed mergeBlockReason: only the function's own lock can pick the winner. No network,
// no environment file, no Drive: the Drive re-file is the `mirrorCvs` seam, counted.

const SURVIVOR = "11111111-1111-4111-8111-111111111111";
const DUPLICATE = "22222222-2222-4222-8222-222222222222";
const SUPER_ADMIN = createAccessContext({ hrId: "B-10", loginId: "b-10", role: "Super Admin" });

/** The columns a merge may write onto the survivor, exactly the function's v_allowed. */
const ALLOWED_BORROW = new Set([
  "national_id", "email", "phone", "whatsapp", "linkedin_url", "nationality", "date_of_birth",
  "place_of_birth", "gender", "marital_status", "military_status", "address", "governorate",
  "current_job_title", "applied_for_job_title", "applied_for_evidence", "professional_summary",
  "current_employer", "current_role_responsibilities", "years_experience", "expected_salary",
  "declared_expected_salary", "declared_background", "declared_experience", "notice_period",
  "cv_reference_name", "cv_external_url", "faculty", "university", "degree", "graduation_year",
  "grade", "medical_rep_employer", "medical_rep_experience_from", "medical_rep_experience_to",
  "offer_id", "email_norm", "phone_norm", "national_id_norm", "screening_extra_answers",
]);

/** Two records of one applicant, the duplicate holding something in every table a merge touches. */
function mergeTables(): Tables {
  const candidate = (fields: Row): Row => ({
    created_at: "2026-11-01T08:00:00Z",
    email: null,
    email_norm: null,
    full_name: "Ahmed Hassan",
    national_id: null,
    offer_id: null,
    phone: null,
    screening_extra_answers: {},
    status: "new",
    updated_at: "2026-11-01T08:00:00Z",
    ...fields,
  });
  return {
    ats_applications: [
      { candidate_id: SURVIVOR, converted_employee_hr_id: null, id: "a0000000-0000-4000-8000-000000000001", requisition_id: "r1", stage: "screening" },
      { candidate_id: DUPLICATE, converted_employee_hr_id: null, id: "a0000000-0000-4000-8000-000000000002", requisition_id: "r2", stage: "screening" },
    ],
    ats_candidate_comments: [
      { author_hr_id: "HR-011", author_job_title: "Talent Acquisition", author_name: "Yomna", body: "  Called, will send papers.\n", candidate_id: DUPLICATE, created_at: "2026-11-03T10:00:00Z", id: "c0000000-0000-4000-8000-000000000001" },
    ],
    ats_candidate_cv_extractions: [{ candidate_id: DUPLICATE, id: "e0000000-0000-4000-8000-000000000001" }],
    ats_candidate_district_returns: [
      { candidate_id: DUPLICATE, id: "d0000000-0000-4000-8000-000000000001", manager_hr_id: "B-40", status: "resolved" },
    ],
    ats_candidate_manager_folders: [
      { candidate_id: SURVIVOR, id: 1, manager_hr_id_norm: "b-30" },
      { candidate_id: DUPLICATE, id: 2, manager_hr_id_norm: "b-30" },
    ],
    ats_candidate_manager_sends: [
      { candidate_id: SURVIVOR, id: "s0000000-0000-4000-8000-000000000001", manager_hr_id: "B-30" },
      { candidate_id: DUPLICATE, id: "s0000000-0000-4000-8000-000000000002", manager_hr_id: "B-30" },
      { candidate_id: DUPLICATE, id: "s0000000-0000-4000-8000-000000000003", manager_hr_id: "B-31" },
    ],
    ats_candidate_status_events: [
      { actor_hr_id: "HR-011", candidate_id: DUPLICATE, created_at: "2026-11-02T09:00:00Z", from_status: "new", id: "h0000000-0000-4000-8000-000000000001", note: "Screened.", to_status: "shortlisted" },
      { actor_hr_id: "HR-011", candidate_id: DUPLICATE, created_at: "2026-11-02T09:05:00Z", from_status: "shortlisted", id: "h0000000-0000-4000-8000-000000000002", note: null, to_status: "shortlisted" },
    ],
    ats_candidate_views: [{ candidate_id: DUPLICATE, viewer_hr_id: "B-30" }],
    ats_candidates: [
      candidate({ id: SURVIVOR }),
      candidate({ email: "Ahmed.H@Example.com", email_norm: normalizeEmail("Ahmed.H@Example.com"), id: DUPLICATE, status: "shortlisted" }),
    ],
    ats_cv_folder_items: [{ candidate_id: DUPLICATE, folder_id: "f1", id: 1 }],
    ats_cv_intake_events: [{ candidate_id: DUPLICATE, id: "i0000000-0000-4000-8000-000000000001" }],
    ats_files: [
      { candidate_id: DUPLICATE, id: "f0000000-0000-4000-8000-000000000001", kind: "cv" },
      { candidate_id: DUPLICATE, id: "f0000000-0000-4000-8000-000000000002", kind: "certificate" },
    ],
    ats_interview_bookings: [{ candidate_id: DUPLICATE, id: "b0000000-0000-4000-8000-000000000001" }],
    ats_requisitions: [
      { id: "r1", job_title: "Medical Representative" },
      { id: "r2", job_title: "District Manager" },
    ],
    ats_whatsapp_classification_sessions: [{ applied_candidate_id: DUPLICATE, id: "w0000000-0000-4000-8000-000000000001" }],
  };
}

type Fault = (stage: string, draft: Tables) => void;

/**
 * public.phx_merge_ats_candidates as 20261113161727 writes it. Argument checks, the lock (both rows,
 * lowest id first, PX409 when one is gone), step 2's five deduped tables (a duplicate row whose key the
 * survivor already holds stays behind — deleted here for the two tables with no foreign key, left to
 * the cascade otherwise; a NULL/empty key or a row outside a partial index never blocks), step 3's plain
 * re-points (applications first), step 4's copies (status-event originals stay, comment originals are
 * deleted), step 5's relink, step 6's delete of the duplicate (its foreign-keyed children cascade) and
 * step 7's whitelisted borrow.
 */
function mergeFunction(fault?: Fault) {
  return (args: Record<string, unknown>, tables: Tables): RpcAnswer =>
    atomically(tables, (draft) => {
      const survivor = String(args.p_survivor_id ?? "");
      const duplicate = String(args.p_duplicate_id ?? "");
      if (!survivor || !duplicate) throw new RpcRaise("22023", "Both the candidate to keep and the duplicate are required.");
      if (survivor === duplicate) throw new RpcRaise("22023", "A candidate cannot be merged into itself.");
      if (!args.p_status_event_provenance || !args.p_comment_provenance) {
        throw new RpcRaise("22023", "phx_merge_ats_candidates: both provenance lines are required");
      }
      const borrow = (args.p_borrow ?? {}) as Record<string, unknown>;
      const refused = Object.keys(borrow).filter((key) => !ALLOWED_BORROW.has(key)).sort();
      if (refused.length > 0) throw new RpcRaise("22023", `phx_merge_ats_candidates: these columns may not be written by a merge: {${refused.join(",")}}`);

      const table = (name: string) => (draft[name] ??= []);
      for (const id of [survivor, duplicate].sort()) {
        if (!table("ats_candidates").some((row) => row.id === id)) {
          throw new RpcRaise(MERGE_RACE_SQLSTATE, `phx_merge_ats_candidates: candidate ${id} was merged or deleted by a concurrent change`);
        }
      }

      // STEP 2 — the deduped tables.
      const deduped: Record<string, { blocked: number; moved: number }> = {};
      const dedupe = (name: string, identity: string, key: string, orphans: boolean, onlyOpen = false) => {
        const rows = table(name);
        const counts = (row: Row) => !onlyOpen || String(row.status ?? "") === "open";
        const blocked = rows.filter(
          (row) =>
            row.candidate_id === duplicate &&
            counts(row) &&
            String(row[key] ?? "") !== "" &&
            rows.some((other) => other.candidate_id === survivor && counts(other) && other[key] === row[key]),
        );
        const blockedIds = new Set(blocked.map((row) => row[identity]));
        let moved = 0;
        for (const row of rows) {
          if (row.candidate_id === duplicate && !blockedIds.has(row[identity])) {
            row.candidate_id = survivor;
            moved += 1;
          }
        }
        if (orphans) draft[name] = rows.filter((row) => !(row.candidate_id === duplicate && blockedIds.has(row[identity])));
        deduped[name] = { blocked: blocked.length, moved };
      };
      dedupe("ats_candidate_manager_sends", "id", "manager_hr_id", false);
      fault?.("after_first_write", draft);
      dedupe("ats_candidate_manager_folders", "id", "manager_hr_id_norm", true);
      dedupe("ats_candidate_district_returns", "id", "manager_hr_id", false, true);
      dedupe("ats_candidate_views", "viewer_hr_id", "viewer_hr_id", false);
      dedupe("ats_cv_folder_items", "id", "folder_id", true);

      // STEP 3 — the plain child tables, applications first.
      const reassigned: Record<string, number> = {};
      for (const name of ["ats_applications", "ats_interview_bookings", "ats_files", "ats_candidate_cv_extractions", "ats_cv_intake_events"]) {
        let count = 0;
        for (const row of table(name)) {
          if (row.candidate_id === duplicate) {
            row.candidate_id = survivor;
            count += 1;
          }
        }
        reassigned[name] = count;
      }

      // STEP 4 — the append-only tables, copied oldest first with the provenance line.
      const copied: Record<string, number> = {};
      let copyNumber = 0;
      const copy = (name: string, columns: string[], noteColumn: string, provenance: string, deleteOriginals: boolean) => {
        const sources = table(name)
          .filter((row) => row.candidate_id === duplicate)
          .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)) || String(left.id).localeCompare(String(right.id)));
        for (const source of sources) {
          const note = String(source[noteColumn] ?? "").trim();
          const row: Row = { candidate_id: survivor, id: `copy-${name}-${(copyNumber += 1)}` };
          for (const column of columns) row[column] = source[column];
          row[noteColumn] = note ? `${note} ${provenance}` : provenance;
          table(name).push(row);
        }
        if (deleteOriginals) draft[name] = table(name).filter((row) => !sources.includes(row));
        copied[name] = sources.length;
      };
      copy("ats_candidate_status_events", ["actor_hr_id", "created_at", "from_status", "to_status"], "note", String(args.p_status_event_provenance), false);
      fault?.("comment_copy", draft);
      copy("ats_candidate_comments", ["author_hr_id", "author_job_title", "author_name", "created_at"], "body", String(args.p_comment_provenance), true);

      // STEP 5 — the record that links by a column of its own naming.
      let relinkedCount = 0;
      for (const row of table("ats_whatsapp_classification_sessions")) {
        if (row.applied_candidate_id === duplicate) {
          row.applied_candidate_id = survivor;
          relinkedCount += 1;
        }
      }

      // STEP 6 — the duplicate itself; ON DELETE CASCADE takes the blocked rows still pointing at it.
      draft.ats_candidates = table("ats_candidates").filter((row) => row.id !== duplicate);
      for (const name of ["ats_candidate_manager_sends", "ats_candidate_district_returns", "ats_candidate_views"]) {
        draft[name] = table(name).filter((row) => row.candidate_id !== duplicate);
      }

      // STEP 7 — the survivor's blanks.
      let candidate: Row | null = null;
      if (Object.keys(borrow).length > 0) {
        const row = table("ats_candidates").find((entry) => entry.id === survivor) as Row;
        Object.assign(row, borrow, { updated_at: new Date().toISOString() });
        candidate = { ...row };
      }

      return {
        body: { candidate, copied, deduped, reassigned, relinked: { ats_whatsapp_classification_sessions: relinkedCount } },
        status: 200,
      };
    });
}

type Outside = { hosts: string[] };
type RaceGate = { arrivals: number; rpc: string[] };

/**
 * Runs `body` against the stand-in, recording any request to another host (the stand-in still refuses
 * it). With a gate, each call to one of `gate.rpc` is held until `gate.arrivals` have arrived, then they
 * run in the order they came — the worst interleaving two server requests can have.
 */
async function harness(standIn: StandIn, body: (seen: Seen[], outside: Outside) => Promise<void>, gate?: RaceGate): Promise<void> {
  await withStandIn(standIn, async (seen) => {
    const standInFetch = globalThis.fetch;
    const outside: Outside = { hosts: [] };
    const held: Array<() => void> = [];
    let lonelyTimer: ReturnType<typeof setTimeout> | null = null;
    const releaseAll = () => {
      if (lonelyTimer) clearTimeout(lonelyTimer);
      lonelyTimer = null;
      for (const release of held.splice(0)) release();
    };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith(STAND_IN_ORIGIN)) outside.hosts.push(new URL(url).origin);
      const rpcName = url.startsWith(`${STAND_IN_ORIGIN}/rest/v1/rpc/`) ? url.slice(`${STAND_IN_ORIGIN}/rest/v1/rpc/`.length).split("?")[0] : null;
      if (gate && rpcName && gate.rpc.includes(rpcName)) {
        await new Promise<void>((resolve) => {
          held.push(resolve);
          // Released on a later tick, once every held call is awaiting, so they resume in arrival order.
          if (held.length >= gate.arrivals) setTimeout(releaseAll, 0);
          else lonelyTimer ??= setTimeout(releaseAll, 1000);
        });
      }
      return standInFetch(input, init);
    }) as typeof fetch;
    try {
      await body(seen, outside);
    } finally {
      releaseAll();
      globalThis.fetch = standInFetch;
    }
  });
}

/** Every seeded table deep-equal to its copy, and any table the run created still empty. */
function assertNothingChanged(tables: Tables, before: Tables, message: string): void {
  for (const name of new Set([...Object.keys(before), ...Object.keys(tables)])) {
    assert.deepEqual(tables[name] ?? [], before[name] ?? [], `${message} — table ${name}`);
  }
}

const onCandidate = (tables: Tables, name: string, id: string) => (tables[name] ?? []).filter((row) => row.candidate_id === id);

// ─────────────────────────────────────────────────────────────────────────────── (a) part-way failure

async function mergeStoppedPartWayKeepsNothing(): Promise<void> {
  const cases = [
    {
      error: () => new RpcRaise("57014", "canceling statement due to statement timeout", 500),
      label: "stopped right after the first manager send moved",
      precondition: (draft: Tables) => {
        assert.equal(onCandidate(draft, "ats_candidate_manager_sends", SURVIVOR).length, 2, "precondition: the duplicate's B-31 send had already moved onto the survivor");
      },
      stage: "after_first_write",
    },
    {
      error: () => new RpcRaise("23514", 'new row for relation "ats_candidate_comments" violates check constraint "ats_candidate_comments_body_check"'),
      label: "refused at the comment copy, after files, applications, interviews and history had moved",
      precondition: (draft: Tables) => {
        assert.equal(onCandidate(draft, "ats_files", SURVIVOR).length, 2, "precondition: both files had moved onto the survivor");
        assert.equal(onCandidate(draft, "ats_interview_bookings", SURVIVOR).length, 1, "precondition: the booked interview had moved");
        assert.equal(onCandidate(draft, "ats_candidate_status_events", SURVIVOR).length, 2, "precondition: both history lines had been copied");
      },
      stage: "comment_copy",
    },
  ];
  for (const testCase of cases) {
    const tables = mergeTables();
    const before = snapshot(tables);
    let reached = false;
    const fault: Fault = (stage, draft) => {
      if (stage !== testCase.stage) return;
      reached = true;
      testCase.precondition(draft);
      throw testCase.error();
    };
    const mirrored: string[] = [];
    await harness({ rpc: { [MERGE_CANDIDATES_RPC]: mergeFunction(fault) }, tables }, async (seen, outside) => {
      let thrown: unknown = null;
      let answered: unknown = null;
      try {
        answered = await mergeCandidates(SUPER_ADMIN, { duplicateId: DUPLICATE, survivorId: SURVIVOR }, {
          mirrorCvs: async (id) => {
            mirrored.push(id);
          },
        });
      } catch (error) {
        thrown = error;
      }
      const expected = testCase.error();
      assert.equal(answered, null, `${testCase.label}: the recruiter is never told the records were merged`);
      assert.ok(thrown, `${testCase.label}: the recruiter is refused`);
      assert.equal((thrown as { code?: string }).code, expected.code, `${testCase.label}: with the database's own error`);
      assert.ok(!(thrown instanceof ApiError && thrown.status === 409), `${testCase.label}: a failed merge is not dressed up as the lost-race 409`);
      assert.ok(reached, `${testCase.label}: precondition — the failure struck after the function's first write`);
      assert.equal(rpcCalls(seen, MERGE_CANDIDATES_RPC).length, 1, `${testCase.label}: the merge function was asked once`);
      assert.deepEqual(anyWrite(seen), [], `${testCase.label}: NO merge history line and no table write of any kind follows the refusal`);
      assert.deepEqual(mirrored, [], `${testCase.label}: the Drive cabinet is never re-filed for a merge that did not happen`);
      assert.deepEqual(outside.hosts, [], `${testCase.label}: nothing outside Phoenix is called`);
      assertNothingChanged(tables, before, `ROLLBACK (${testCase.label}): the duplicate is whole and every candidate table reads exactly as before`);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────── (b) two merges at once

function assertMergedOnce(tables: Tables, kept: string, gone: string, label: string): void {
  assert.deepEqual(tables.ats_candidates.map((row) => row.id), [kept], `${label}: one record remains, the other is gone`);
  for (const name of ["ats_applications", "ats_files", "ats_interview_bookings", "ats_candidate_cv_extractions", "ats_cv_intake_events", "ats_cv_folder_items", "ats_candidate_manager_folders"]) {
    assert.deepEqual(onCandidate(tables, name, gone), [], `${label}: nothing in ${name} is left on the record that is gone`);
  }
  assert.equal(tables.ats_files.length, 2, `${label}: both files kept, none duplicated or lost`);
  assert.equal(tables.ats_applications.length, 2, `${label}: both applications kept`);
  assert.equal(tables.ats_interview_bookings.length, 1, `${label}: the booked interview kept once`);
  assert.equal(tables.ats_whatsapp_classification_sessions[0].applied_candidate_id, kept, `${label}: the WhatsApp answers point at the record kept`);
  assert.equal(tables.ats_candidate_comments.length, 1, `${label}: the comment exists ONCE — copied once, its original removed once`);
}

async function twoMergesOneWinner(): Promise<void> {
  // (b1) Two recruiters merge the same duplicate into the same survivor at the same moment.
  {
    const tables = mergeTables();
    const mirrored: string[] = [];
    await harness(
      { rpc: { [MERGE_CANDIDATES_RPC]: mergeFunction() }, tables },
      async (seen, outside) => {
        const merge = () =>
          mergeCandidates(SUPER_ADMIN, { duplicateId: DUPLICATE, survivorId: SURVIVOR }, {
            mirrorCvs: async (id) => {
              mirrored.push(id);
            },
          });
        const results = await Promise.allSettled([merge(), merge()]);
        const wins = results.filter((result) => result.status === "fulfilled");
        const losses = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason as unknown);
        assert.equal(wins.length, 1, "RACE (same pair): exactly one of two simultaneous merges happens");
        assert.equal(losses.length, 1, "RACE (same pair): the other is refused");
        const lost = losses[0] as ApiError;
        assert.ok(lost instanceof ApiError && lost.status === 409, `RACE (same pair): the second merge gets the 409 Conflict (got ${String((lost as { status?: unknown })?.status)} ${String((lost as Error)?.message)})`);
        assert.equal(lost.message, MERGE_RACE_MESSAGE, "in the recruiter's words");
        assert.equal(rpcCalls(seen, MERGE_CANDIDATES_RPC).length, 2, "both merges reached the function — its lock picked the winner");
        assertMergedOnce(tables, SURVIVOR, DUPLICATE, "RACE (same pair)");
        const copies = onCandidate(tables, "ats_candidate_status_events", SURVIVOR).filter((row) => String(row.note).includes("[Copied from duplicate record"));
        assert.equal(copies.length, 2, "RACE (same pair): the duplicate's two history lines are copied ONCE, never twice");
        const mergeLines = onCandidate(tables, "ats_candidate_status_events", SURVIVOR).filter((row) => String(row.note).startsWith("Merged the duplicate record"));
        assert.equal(mergeLines.length, 1, "RACE (same pair): ONE merge history line on the survivor");
        assert.equal(tables.ats_candidates[0].email, "Ahmed.H@Example.com", "RACE (same pair): the survivor borrowed the duplicate's email once");
        assert.deepEqual(mirrored, [SURVIVOR], "RACE (same pair): the Drive cabinet is re-filed once, for the merge that happened");
        assert.deepEqual(outside.hosts, [], "nothing outside Phoenix is called");
      },
      { arrivals: 2, rpc: [MERGE_CANDIDATES_RPC] },
    );
  }

  // (b2) One recruiter merges A into B while another merges B into A. Both lock lowest id first, so
  // the second finds one of its rows gone and refuses instead of deadlocking or merging back.
  {
    const tables = mergeTables();
    const mirrored: string[] = [];
    await harness(
      { rpc: { [MERGE_CANDIDATES_RPC]: mergeFunction() }, tables },
      async (seen) => {
        const merge = (survivorId: string, duplicateId: string) =>
          mergeCandidates(SUPER_ADMIN, { duplicateId, survivorId }, {
            mirrorCvs: async (id) => {
              mirrored.push(id);
            },
          });
        const results = await Promise.allSettled([merge(SURVIVOR, DUPLICATE), merge(DUPLICATE, SURVIVOR)]);
        const winnerIndex = results.findIndex((result) => result.status === "fulfilled");
        assert.equal(results.filter((result) => result.status === "fulfilled").length, 1, "RACE (A into B against B into A): exactly one merge happens");
        const lost = (results.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined)?.reason as ApiError;
        assert.ok(lost instanceof ApiError && lost.status === 409, `RACE (A into B against B into A): the other gets the 409 Conflict (got ${String((lost as { status?: unknown })?.status)} ${String((lost as Error)?.message)})`);
        assert.equal(rpcCalls(seen, MERGE_CANDIDATES_RPC).length, 2, "both merges reached the function — its lock picked the winner");
        const [kept, gone] = winnerIndex === 0 ? [SURVIVOR, DUPLICATE] : [DUPLICATE, SURVIVOR];
        assertMergedOnce(tables, kept, gone, "RACE (A into B against B into A)");
        assert.equal(
          (tables.ats_candidate_status_events ?? []).filter((row) => String(row.note).startsWith("Merged the duplicate record")).length,
          1,
          "RACE (A into B against B into A): ONE merge history line",
        );
        assert.deepEqual(mirrored, [kept], "RACE (A into B against B into A): the cabinet is re-filed once, for the record kept");
      },
      { arrivals: 2, rpc: [MERGE_CANDIDATES_RPC] },
    );
  }
}

export async function runCandidateMergeRollbackAndRaceTests(): Promise<void> {
  await mergeStoppedPartWayKeepsNothing();
  await twoMergesOneWinner();
}
