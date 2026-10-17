import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { statusChangeRefusal } from "../src/lib/recruitment/candidate-status.ts";
import { returnReleasedCvToShortlist, type StatusWriteClient } from "../src/lib/recruitment/manager-recall-status.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * 2026-10-17, production: the recall of nine CVs from one manager deleted all nine sends, cleared the
 * stamps, then THREW on the status step and left every CV at `sent_to_manager` with nobody holding it.
 * The status step went through updateCandidateStatus, which is a person's click and refuses
 * `sent_to_manager → shortlisted` (statusChangeRefusal) to protect a CV a manager still holds.
 *
 * The recall now writes the move straight to the table, as manager-hold-return.ts does for the 45-day
 * return. This suite pins (1) what that write does against a fake client, (2) that the guard itself is
 * UNCHANGED, and (3) that the recall never routes through the guard again and refuses a bad note
 * before its first write.
 */

type Call = { method: string; args: unknown[] };

function fakeClient(options: { updated: unknown[]; eventError?: unknown }) {
  const log: Array<{ table: string; calls: Call[] }> = [];
  const client: StatusWriteClient = {
    from(table: string) {
      const entry = { table, calls: [] as Call[] };
      log.push(entry);
      const chain: Record<string, unknown> = {};
      const record = (method: string) => (...args: unknown[]) => {
        entry.calls.push({ method, args });
        return chain;
      };
      for (const method of ["update", "eq"]) chain[method] = record(method);
      chain.select = (...args: unknown[]) => {
        entry.calls.push({ method: "select", args });
        return Promise.resolve({ data: options.updated, error: null });
      };
      chain.insert = (...args: unknown[]) => {
        entry.calls.push({ method: "insert", args });
        return Promise.resolve({ error: options.eventError ?? null });
      };
      return chain;
    },
  };
  return { client, log };
}

const INPUT = {
  actorHrId: "B-10",
  candidateId: "cand-1",
  changedAt: "2026-10-17T10:00:00.000Z",
  note: "Taken back from Manager X.",
};

export async function runRecruitmentManagerRecallStatusTests(): Promise<void> {
  // ── 1 · The write itself ───────────────────────────────────────────────────────────────────────
  {
    const { client, log } = fakeClient({ updated: [{ id: "cand-1" }] });
    assert.equal(await returnReleasedCvToShortlist(client, INPUT), true, "a CV still at sent_to_manager is returned");

    const candidates = log.find((entry) => entry.table === "ats_candidates");
    assert.ok(candidates, "the move is written to ats_candidates");
    assert.deepEqual(
      candidates.calls.find((call) => call.method === "update")?.args[0],
      {
        status: "shortlisted",
        status_changed_at: INPUT.changedAt,
        status_changed_by_hr_id: "B-10",
        status_note: INPUT.note,
        updated_at: INPUT.changedAt,
      },
      "status, who and when, and the note go in one update",
    );
    const guards = candidates.calls.filter((call) => call.method === "eq").map((call) => call.args);
    assert.deepEqual(guards, [["id", "cand-1"], ["status", "sent_to_manager"]], "guarded on the CV AND on it still being sent_to_manager");

    const events = log.find((entry) => entry.table === "ats_candidate_status_events");
    assert.ok(events, "a history line is written");
    assert.deepEqual(
      events.calls.find((call) => call.method === "insert")?.args[0],
      {
        actor_hr_id: "B-10",
        candidate_id: "cand-1",
        from_status: "sent_to_manager",
        note: INPUT.note,
        to_status: "shortlisted",
      },
      "the history line says sent_to_manager → shortlisted, by the person who took it back",
    );
  }

  // Somebody moved it first: nothing is overwritten and no history line is invented.
  {
    const { client, log } = fakeClient({ updated: [] });
    assert.equal(await returnReleasedCvToShortlist(client, INPUT), false, "a CV that already moved is left alone");
    assert.ok(!log.some((entry) => entry.table === "ats_candidate_status_events"), "…and gets no history line");
  }

  // The status has changed, so a failed history write is logged, never turned into a failed recall.
  {
    const { client } = fakeClient({ updated: [{ id: "cand-1" }], eventError: { message: "boom" } });
    assert.equal(await returnReleasedCvToShortlist(client, INPUT), true, "a lost history line does not fail a completed return");
  }

  // ── 2 · The guard is UNCHANGED — it is the recall that stopped going through it ────────────────
  assert.ok(
    statusChangeRefusal("sent_to_manager", "shortlisted"),
    "a person's click still cannot move a sent CV back to shortlisted",
  );

  // ── 3 · The recall never routes through the guard, and checks its note before its first write ───
  {
    const read = (path: string) => stripComments(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"));
    const recall = read("../src/lib/recruitment/manager-recall.ts");
    assert.ok(!recall.includes("updateCandidateStatus"), "the recall must not call updateCandidateStatus — it refuses sent_to_manager → shortlisted");
    assert.ok(recall.includes("returnReleasedCvToShortlist(recruitmentDb()"), "the recall writes the move itself");
    assert.ok(
      recall.indexOf("CANDIDATE_STATUS_NOTE_MAX_LENGTH") < recall.indexOf("await deleteManagerSend("),
      "a note that is too long is refused BEFORE the send is deleted, so a recall never fails half done",
    );
  }
}
