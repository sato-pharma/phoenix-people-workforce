import assert from "node:assert/strict";

import {
  HIRE_HANDOFF_TABLE,
  loginProvisioningFailure,
  startHireHandoff,
} from "../src/lib/employees/hire-handoff.ts";
import {
  defaultHireHandoffRetryDeps,
  runHireHandoffReconciler,
  type HireHandoffRetryDeps,
} from "../src/lib/employees/hire-handoff-reconciler.ts";
import { rpcCalls, withPostgrestStandIn, writesTo, type Row, type StandIn } from "./support/postgrest-stand-in.ts";

// REC-078 (phase 2): the hire hand-off, run against a database — not a fake store.
//
// tests/hire-handoff-steps.test.ts drives the ledger and the reconciler through an injected store, an
// injected lease and injected step functions. This file leaves the ledger's OWN database store, the
// OWN job lease and the OWN login and acceptance-audit lookups in place and points them at the shared
// in-memory PostgREST (tests/support/postgrest-stand-in.ts), so what is asserted is what lands in
// `hire_handoff_steps`, `offer_acceptances` and `claim_job_lease` (#360, REC-027):
//
//   1. A door's step leaves one ledger row per (employee, step) — written through the upsert key, with
//      only the whitelisted ids in its context — and the step's own answer comes back unchanged, even
//      when the ledger itself cannot be written.
//   2. The hourly reconciler retries exactly the due rows (failed past their back-off, pending left by
//      a door that never finished), records each outcome on the SAME row, gives up after five
//      attempts or on a step that can never succeed, and a second run repeats nothing.
//   3. It runs only while it holds the lease, and a ledger it cannot read fails the run loudly.
//
// The two cross-module writers a retry could reach for real (the login provisioning and the candidate
// sync) are recording fakes, so no login is created and nothing is sent; everything that is the
// hand-off's own reads and writes goes to the stand-in.

const NOW = new Date("2026-11-19T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();

function ledgerRow(hrId: string, step: string, fields: Row): Row {
  return {
    attempts: 1,
    context: {},
    created_at: hoursAgo(30),
    employee_hr_id: hrId,
    last_error: "it failed",
    source: "add_employee",
    status: "failed",
    step,
    updated_at: hoursAgo(3),
    ...fields,
  };
}

function ledger(): Row[] {
  return [
    ledgerRow("B-900", "acceptance_audit", { context: { idPhotosFiled: true, offerId: "offer-1" }, source: "joining_form" }),
    ledgerRow("B-900", "login", { context: { actorRole: "HR Operations" } }),
    ledgerRow("B-901", "cv", { attempts: 4, updated_at: hoursAgo(10) }),
    ledgerRow("B-903", "mailbox_task", { updated_at: new Date(NOW.getTime() - 60 * 1000).toISOString() }),
    ledgerRow("B-904", "candidate_hired", { context: { candidateId: "cand-9" }, status: "pending", updated_at: hoursAgo(2) }),
  ];
}

const rowOf = (standIn: StandIn, hrId: string, step: string) =>
  standIn.tables[HIRE_HANDOFF_TABLE].find((row) => row.employee_hr_id === hrId && row.step === step) as Row;

/** The real lookups and the real audit insert; the two writers that would create a login or move a candidate are recorded. */
function deps(calls: string[]): HireHandoffRetryDeps {
  return {
    ...defaultHireHandoffRetryDeps,
    async provisionNewHireAccess(input) {
      calls.push(`provision:${input.hrIds.join(",")}`);
      return { created: 1, failed: 0, results: [], skipped: 0 } as never;
    },
    async recordHireFromCandidate(input) {
      calls.push(`candidate:${input.candidateId}`);
      return { candidate: "hired", requisitionsClosed: 1 } as never;
    },
    async recordHireFromOfferLetter(input) {
      calls.push(`offer:${input.offerId}`);
      return { candidate: "hired", letterLinked: true } as never;
    },
    async openAndAnnounceNewHireMailboxes(input) {
      calls.push(`mailbox:${input.hrIds.join(",")}`);
      return { announced: 1, opened: 1, recipients: 1, skipped: 0, warnings: [] };
    },
    async attachEmployeeCvOnCreate(input) {
      calls.push(`cv:${input.hrId}`);
      return { attached: true, fileName: "cv.pdf", source: null, warnings: [] };
    },
  };
}

export async function runHireHandoffDatabaseBehaviourTests(): Promise<void> {
  // ── 1. A door's step leaves its ledger row, and its answer is untouched ─────────────────────────
  {
    const standIn: StandIn = { tables: { [HIRE_HANDOFF_TABLE]: [] } };
    await withPostgrestStandIn(standIn, async (seen) => {
      const tracker = startHireHandoff("B-950", "add_employee");
      const summary = { created: 0, failed: 1, results: [{ hrId: "B-950", message: "Rank too high for this door.", status: "failed" }], skipped: 0 };
      const answered = await tracker.run(
        "login",
        // A caller handing the ledger more than it may keep: only the whitelisted ids survive.
        { actorRole: "HR Operations", password: "Sato@2026!", nationalId: "29901010101010", salary: 18000 } as never,
        async () => summary,
        { failureOf: loginProvisioningFailure },
      );
      assert.equal(answered, summary, "HEADLINE (#360): the door gets the step's own answer back, unchanged");
      await assert.rejects(
        tracker.run("cv", { cvDraftId: "draft-1" }, async () => {
          throw new Error("storage refused the CV");
        }),
        /storage refused the CV/,
        "a step that threw is re-thrown exactly",
      );
      await tracker.flush();

      const writes = writesTo(seen, HIRE_HANDOFF_TABLE);
      assert.equal(writes.length, 4, "pending then failed, for each of the two steps");
      for (const write of writes) {
        assert.equal(write.params.get("on_conflict"), "employee_hr_id,step", "every write lands on the one row per employee and step");
      }
    });
    assert.equal(standIn.tables[HIRE_HANDOFF_TABLE].length, 2, "one row per step, never one per attempt");
    const login = rowOf(standIn, "B-950", "login");
    assert.equal(login.status, "failed", "a step that reported failure in its RESULT is recorded failed");
    assert.equal(login.attempts, 1);
    assert.match(String(login.last_error), /Rank too high for this door/);
    assert.deepEqual(login.context, { actorRole: "HR Operations" }, "no password, national id or salary reaches the ledger");
    const cv = rowOf(standIn, "B-950", "cv");
    assert.equal(cv.status, "failed");
    assert.equal(cv.last_error, "storage refused the CV");

    // The ledger cannot be written: the step still answers exactly as it would have.
    const broken: StandIn = {
      failWrites: { [HIRE_HANDOFF_TABLE]: { body: { code: "XX000", message: "stand-in write failure" }, status: 500 } },
      tables: { [HIRE_HANDOFF_TABLE]: [] },
    };
    await withPostgrestStandIn(broken, async () => {
      const tracker = startHireHandoff("B-951", "joining_form");
      const answer = await tracker
        .run("offer_stamp", { offerId: "offer-2" }, async () => "stamped")
        .catch((error: unknown) => `the hire failed: ${error instanceof Error ? error.message : String(error)}`);
      await tracker.flush();
      assert.equal(answer, "stamped", "HEADLINE (#360): a ledger that cannot be written never fails the hire");
    });
  }

  // ── 2. The reconciler retries the due rows, on the same rows, and gives up visibly ──────────────
  {
    const calls: string[] = [];
    const standIn: StandIn = {
      rpc: { claim_job_lease: () => [{ expires_at: hoursAgo(-1), held: true, holder: "this-run" }] },
      tables: {
        [HIRE_HANDOFF_TABLE]: ledger(),
        app_auth_users: [{ hr_id: "B-900", is_active: true, login_id: "b-900" }],
        offer_acceptances: [],
      },
    };
    await withPostgrestStandIn(standIn, async (seen) => {
      const result = await runHireHandoffReconciler({ deps: deps(calls), now: () => NOW });
      assert.equal(result.ran, true);
      assert.equal(result.examined, 5, "every failed and pending row is read");
      assert.equal(result.due, 4, "the mailbox row failed a minute ago and waits out its back-off");
      assert.deepEqual(
        { done: result.done, failed: result.failed, gaveUp: result.gaveUp },
        { done: 3, failed: 0, gaveUp: 1 },
        "HEADLINE (#360): three steps repaired, one given up, none left silently failing",
      );
      assert.ok(rpcCalls(seen, "claim_job_lease").length >= 1, "the run claimed its lease");
    });

    // The acceptance audit row, written by the real insert, says it was the retry.
    assert.equal(standIn.tables.offer_acceptances.length, 1, "the missing acceptance record was written once");
    const audit = standIn.tables.offer_acceptances[0];
    assert.equal(audit.offer_id, "offer-1");
    assert.equal(audit.employee_hr_id, "B-900");
    assert.equal((audit.payload as Row).recordedBy, "hire-handoff", "the record says the retry wrote it");
    assert.equal((audit.payload as Row).idPhotosFiled, true);

    // The login already existed: done by the read, and no login was provisioned.
    assert.ok(!calls.some((call) => call.startsWith("provision:")), "an existing login is DONE, never provisioned twice");
    assert.ok(calls.includes("candidate:cand-9"), "the stale pending step was run again");
    assert.ok(!calls.some((call) => call.startsWith("mailbox:")), "a row inside its back-off is not retried");

    assert.equal(rowOf(standIn, "B-900", "acceptance_audit").status, "done");
    assert.equal(rowOf(standIn, "B-900", "acceptance_audit").attempts, 2, "the retry is attempt 2 of the same row");
    assert.equal(rowOf(standIn, "B-900", "login").status, "done");
    assert.equal(rowOf(standIn, "B-904", "candidate_hired").status, "done");
    const cv = rowOf(standIn, "B-901", "cv");
    assert.equal(cv.status, "gave_up", "a CV with no source recorded can never succeed: given up, and shown");
    assert.equal(cv.attempts, 5);
    assert.match(String(cv.last_error), /No CV source was recorded/);
    assert.equal(rowOf(standIn, "B-903", "mailbox_task").attempts, 1, "the row inside its back-off is untouched");
    assert.equal(standIn.tables[HIRE_HANDOFF_TABLE].length, 5, "every outcome landed on its own row — no second row for a step");

    // A second run an hour later repeats nothing that is done or given up.
    const before = calls.length;
    await withPostgrestStandIn(standIn, async () => {
      const again = await runHireHandoffReconciler({ deps: deps(calls), now: () => new Date(NOW.getTime() + 60 * 60 * 1000) });
      assert.deepEqual({ done: again.done, gaveUp: again.gaveUp }, { done: 1, gaveUp: 0 }, "only the mailbox row, now past its back-off, is run");
    });
    assert.deepEqual(calls.slice(before), ["mailbox:B-903"], "nothing done or given up is retried again");
    assert.equal(standIn.tables.offer_acceptances.length, 1, "the acceptance record is never written twice");
  }

  // ── 3. The lease, and a ledger that cannot be read ──────────────────────────────────────────────
  {
    const calls: string[] = [];
    const elsewhere: StandIn = {
      rpc: { claim_job_lease: () => [{ expires_at: hoursAgo(-1), held: false, holder: "another-process" }] },
      tables: { [HIRE_HANDOFF_TABLE]: ledger() },
    };
    await withPostgrestStandIn(elsewhere, async (seen) => {
      const result = await runHireHandoffReconciler({ deps: deps(calls), now: () => NOW });
      assert.equal(result.ran, false, "another run holds the lease: this one does nothing");
      assert.equal(seen.filter((entry) => entry.table === HIRE_HANDOFF_TABLE).length, 0, "not even a read of the ledger");
    });
    assert.deepEqual(calls, []);

    const unreadable: StandIn = {
      failReads: { [HIRE_HANDOFF_TABLE]: { body: { code: "XX000", message: "stand-in read failure" }, status: 500 } },
      rpc: { claim_job_lease: () => [{ expires_at: hoursAgo(-1), held: true, holder: "this-run" }] },
      tables: { [HIRE_HANDOFF_TABLE]: ledger() },
    };
    await withPostgrestStandIn(unreadable, async () => {
      await assert.rejects(
        runHireHandoffReconciler({ deps: deps(calls), now: () => NOW }),
        /stand-in read failure/,
        "a ledger that cannot be read fails the run, so the cron answers 500 and the heartbeat says so — never a calm empty run",
      );
    });
  }
}
