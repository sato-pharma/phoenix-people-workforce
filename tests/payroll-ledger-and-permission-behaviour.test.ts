import assert from "node:assert/strict";

import { loadHeldBalances } from "../src/lib/automated-payroll/held-settlements.ts";
import { markRunPublished } from "../src/lib/automated-payroll/draft-store.ts";
import { TRANSITION_CLAIM_LOST } from "../src/lib/automated-payroll/transition-claim.ts";
import { recordDecision } from "../src/lib/deductions/service.ts";
import { clearModuleLockCache, NEVER_LOCKABLE_RESOURCES } from "../src/lib/auth/module-locks.ts";
import {
  assertPermission,
  canAccess,
  clearPermissionMatrixCache,
  createAccessContext,
  permissionMatrix,
  portalMinimumPermissions,
  type PermissionAction,
  type PermissionResource,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { SignedOutRefusal } from "../src/lib/auth/signed-out-refusal.ts";
import {
  atomically,
  RpcRaise,
  snapshot,
  withStandIn,
  writesTo,
  type Failure,
  type Row,
  type RpcAnswer,
  type Seen,
  type StandIn,
  type Tables,
} from "./support/postgrest-stand-in.ts";

// REC-078 (enterprise audit 2026-11-13): behaviour tests, not source pins, for three things a payroll or
// an access decision rests on. Each runs the REAL domain code against a stand-in PostgREST held in memory
// — no network, no environment file, nothing from production — and asserts what the code DOES:
//
//   1. The held-salary record (F-PAY-002). loadHeldBalances is the ledger every release offer reads, so
//      it may never answer "nobody is held" by accident: a published run with no `published` record, or
//      a ledger table that cannot be read, must refuse instead of returning []. markRunPublished must
//      hand the held list to the one database call that publishes, and say plainly when it did not land.
//   2. The deduction decision gates (F-PAY-003/004). Only the Super Admin decides; a candidate a
//      publication locked is refused before any write; and the database trigger's late refusal (the
//      lock landed between the read and the write) reaches the reviewer as a Conflict, never "saved".
//      The compare-and-set itself is pinned in tests/dispute-and-deduction-atomic.test.ts.
//   3. The permission lookups. A deny row in role_permission_overrides takes a compiled grant away; a
//      later failed reload keeps the last matrix that loaded (it neither restores the revoked grant nor
//      takes the others away); a module lock suspends a grant the role still holds; a signed-out caller
//      gets the signed-out refusal. The cold start is pinned in tests/permission-matrix-cold-start.test.ts.

const auditWrites = (seen: Seen[]) =>
  seen.filter((request) => request.method !== "GET" && /audit/i.test(request.table ?? "") && !/automated_payroll/.test(request.table ?? ""));

// ─────────────────────────────────────────────────────────────────────────────── 1. held-salary record

const RETRIED_EARLIER = {
  action: "published",
  created_at: "2026-10-05T09:00:00+00:00",
  // The interrupted first attempt at the same publish. If its list were read, B-77 would owe 9,999 and
  // B-99, who was never held in the publish that stands, would appear.
  detail: {
    held: [
      { hrId: "B-77", name: "Held Person", secondPartWithheld: 9999 },
      { hrId: "B-99", name: "Never Held", secondPartWithheld: 100 },
    ],
  },
  run_id: "run-sep",
};
const PUBLISHED_STANDS = {
  action: "published",
  created_at: "2026-10-05T10:00:00+00:00",
  detail: {
    deferred: [{ amount: 1500, hrId: "B-88", name: "Deferred Person", releaseIn: "2026-12" }],
    held: [
      {
        firstPartAlreadyPaid: 4000,
        firstPartWithheld: 0,
        hrId: "B-77",
        name: "Held Person",
        reason: "Bank account not confirmed",
        secondPartWithheld: 6000,
      },
    ],
  },
  run_id: "run-sep",
};

function heldTables(): Record<string, Row[]> {
  return {
    // Oldest first ON PURPOSE: the newest `published` row must win by the read's own ordering, not by
    // the order the rows happen to sit in.
    automated_payroll_audit: [
      { action: "part2_confirmed", created_at: "2026-10-04T09:00:00+00:00", detail: {}, run_id: "run-sep" },
      structuredClone(RETRIED_EARLIER),
      structuredClone(PUBLISHED_STANDS),
    ],
    automated_payroll_held_entered: [],
    automated_payroll_held_part1_unpaid: [],
    automated_payroll_held_releases: [],
    automated_payroll_held_settlements: [],
    automated_payroll_runs: [{ id: "run-sep", month: 9, month_key: "2026-09", phase: "published", year: 2026 }],
  };
}

async function heldRecordReads(): Promise<void> {
  // (a) The ledger reads who is held, from the publish that stands.
  await withStandIn({ tables: heldTables() }, async () => {
    const balances = await loadHeldBalances();
    const byHrId = new Map(balances.map((balance) => [balance.hrId, balance]));
    assert.deepEqual([...byHrId.keys()].sort(), ["B-77", "B-88"], "the held and the deferred person, and nobody from the retried attempt");
    const held = byHrId.get("B-77")!;
    assert.equal(held.month, 9);
    assert.equal(held.year, 2026);
    assert.equal(held.secondPartWithheld, 6000, "the second instalment the run withheld");
    assert.equal(held.firstPartAlreadyPaid, 4000);
    assert.equal(held.reason, "Bank account not confirmed");
    assert.equal(held.outstanding, 6000, "nothing settled or released, so the whole withheld amount is owed");
    const deferred = byHrId.get("B-88")!;
    assert.equal(deferred.deferred, 1500);
    assert.equal(deferred.deferredTo, "2026-12");
    assert.equal(deferred.outstanding, 1500);
  });

  // (b) HEADLINE (F-PAY-002): a published run whose record of who was held is missing is REFUSED by
  // name — never answered with a list that silently leaves its people out.
  {
    const tables = heldTables();
    tables.automated_payroll_runs.push({ id: "run-oct", month: 10, month_key: "2026-10", phase: "published", year: 2026 });
    await withStandIn({ tables }, async () => {
      await assert.rejects(
        loadHeldBalances(),
        (error: Error) =>
          /^Conflict: Held salary cannot be shown: the payroll for October 2026 is published but its record of who was held is missing/.test(
            error.message,
          ),
        "HEADLINE: a published run with no `published` record refuses, naming the month, instead of returning a short list",
      );
    });
  }

  // …and a published run with no record is refused even when NO run has a record — the empty answer is
  // exactly the one that must not come back.
  {
    const tables = heldTables();
    tables.automated_payroll_audit = [];
    await withStandIn({ tables }, async () => {
      await assert.rejects(
        loadHeldBalances(),
        (error: Error) => /^Conflict: Held salary cannot be shown: the payroll for September 2026/.test(error.message),
        "no record at all for a published run is a refusal, never []",
      );
    });
  }

  // (c) A ledger table that cannot be read refuses — a failed read never becomes "nobody is held".
  for (const table of ["automated_payroll_audit", "automated_payroll_runs", "automated_payroll_held_releases", "automated_payroll_held_part1_unpaid"]) {
    await withStandIn(
      { failReads: { [table]: { body: { code: "XX000", details: null, hint: null, message: "stand-in read failure" }, status: 500 } }, tables: heldTables() },
      async () => {
        await assert.rejects(
          loadHeldBalances(),
          (error: { message?: string }) => error?.message === "stand-in read failure",
          `an unreadable ${table} refuses instead of answering with fewer held people`,
        );
      },
    );
  }

  // (d) The audit table missing from the environment is a refusal too: unlike the optional tables, the
  // ledger has no "not migrated yet" answer.
  await withStandIn(
    { failReads: { automated_payroll_audit: { body: { code: "PGRST205", details: null, hint: null, message: "Could not find the table 'public.automated_payroll_audit' in the schema cache" }, status: 404 } }, tables: heldTables() },
    async () => {
      await assert.rejects(loadHeldBalances(), (error: { code?: string }) => error?.code === "PGRST205", "a missing ledger table refuses");
    },
  );
}

async function markPublishedHandsOverTheHeldList(): Promise<void> {
  const detail = {
    held: [{ firstPartAlreadyPaid: 4000, hrId: "B-77", name: "Held Person", reason: "Bank account not confirmed", secondPartWithheld: 6000 }],
    heldCount: 1,
  };
  const input = { action: "published" as const, batchId: "batch-sep", detail, publishedBy: "B-10" };

  // The phase and the held record travel in ONE database call, with the held list exactly as given.
  await withStandIn(
    {
      rpc: {
        phx_mark_automated_payroll_run_published: () => ({
          body: [{ id: "run-sep", month: 9, month_key: "2026-09", phase: "published", published_batch_id: "batch-sep", published_by: "B-10", year: 2026 }],
          status: 200,
        }),
      },
      tables: {},
    },
    async (seen) => {
      const run = await markRunPublished("run-sep", input, { transitionToken: "token-1" });
      assert.equal(run.phase, "published");
      assert.equal(run.publishedBatchId, "batch-sep");
      const calls = seen.filter((request) => request.rpc === "phx_mark_automated_payroll_run_published");
      assert.equal(calls.length, 1, "one call publishes the run and records who was held");
      const args = calls[0].body as Record<string, unknown>;
      assert.equal(args.p_run_id, "run-sep");
      assert.equal(args.p_transition_token, "token-1", "under the publish's own claim on the run");
      assert.equal(args.p_batch_id, "batch-sep");
      assert.equal(args.p_published_by, "B-10");
      assert.deepEqual(args.p_detail, detail, "the held list reaches the database unchanged");
      assert.equal(
        seen.filter((request) => request.table === "automated_payroll_runs" && request.method !== "GET").length,
        0,
        "the phase is never written by a second, separate call that could land without the held record",
      );
    },
  );

  // A failed call says the run was NOT marked published and warns against reopening — never a bare failure.
  await withStandIn(
    {
      rpc: {
        phx_mark_automated_payroll_run_published: () => ({
          body: { code: "P0001", details: null, hint: null, message: "automated_payroll_mark_published_failed: held list missing" },
          status: 400,
        }),
      },
      tables: {},
    },
    async () => {
      await assert.rejects(
        markRunPublished("run-sep", input, { transitionToken: "token-1" }),
        (error: Error) =>
          error.message.startsWith("Conflict: the payslips for this run WERE written") &&
          error.message.includes("NOT marked published") &&
          error.message.includes("Do NOT reopen or cancel this run"),
        "a publish whose held record could not be written says so, as a Conflict",
      );
    },
  );

  // A lost claim (another action took the run) is its own Conflict, naming the claim.
  await withStandIn(
    {
      rpc: {
        phx_mark_automated_payroll_run_published: () => ({
          body: { code: "P0001", details: null, hint: null, message: "automated_payroll_transition_claim_lost" },
          status: 400,
        }),
      },
      tables: {},
    },
    async () => {
      await assert.rejects(
        markRunPublished("run-sep", input, { transitionToken: "token-1" }),
        (error: Error) => error.message.startsWith(`Conflict: ${TRANSITION_CLAIM_LOST}`),
        "a lapsed claim is reported as the claim, not as a database failure",
      );
    },
  );

  // No row back means no run: refused, never mapped into an empty run.
  await withStandIn(
    { rpc: { phx_mark_automated_payroll_run_published: () => ({ body: [], status: 200 }) }, tables: {} },
    async () => {
      await assert.rejects(
        markRunPublished("run-sep", input, { transitionToken: "token-1" }),
        (error: Error) => error.message === "Not found: payroll run does not exist.",
      );
    },
  );
}

/**
 * phx_mark_automated_payroll_run_published, from 20261113160132, statement by statement: refuse a detail with no
 * held list, move the run to published under the publish's claim, then insert the `published` record. One
 * indivisible step: a raise anywhere keeps nothing. `failAfterPhase` raises after the phase write — the forced
 * failure after the first write (REC-038 close-out, 19 Nov 2026).
 */
function markPublishedModel(failAfterPhase = false) {
  return (args: Record<string, unknown>, tables: Tables): RpcAnswer =>
    atomically(tables, (db) => {
      const detail = args.p_detail as { held?: unknown } | null;
      if (!detail || !Array.isArray(detail.held)) {
        throw new RpcRaise("P0001", "automated_payroll_publish_hold_record_missing: the publish record has no held list");
      }
      const run = (db.automated_payroll_runs ?? []).find(
        (row) => row.id === args.p_run_id && row.phase === "ready" && row.transition_token === args.p_transition_token,
      );
      if (!run) throw new RpcRaise("P0001", "automated_payroll_transition_claim_lost: [transition-claim-lost] the run was not marked published");
      Object.assign(run, {
        phase: "published",
        published_batch_id: args.p_batch_id,
        published_by: args.p_published_by,
        transition_action: null,
        transition_started_at: null,
        transition_token: null,
      });
      if (failAfterPhase) throw new RpcRaise("XX000", "stand-in: the held record could not be inserted");
      (db.automated_payroll_audit ??= []).push({ action: "published", actor_hr_id: args.p_actor_hr_id, detail: args.p_detail, run_id: args.p_run_id });
      return { body: [{ ...run }], status: 200 };
    });
}

/**
 * THE HELD RECORD IS ALL OR NOTHING, AND ONE PUBLISH WINS (REC-038 close-out, 19 Nov 2026). The two tests the
 * money-integrity close-out asks of every operation, driven through markRunPublished against the modelled function:
 * (a) a failure after the first write leaves the run `ready` with no record — never published without one; (b) two
 * publishes holding the same claim at once land exactly once, with one record.
 */
export async function runHeldRecordAtomicityBehaviourTests(): Promise<void> {
  const ready = (): Tables => ({
    automated_payroll_audit: [],
    automated_payroll_runs: [
      { id: "run-oct", month: 10, month_key: "2026-10", phase: "ready", transition_action: "Publishing to payslips", transition_started_at: "2026-11-19T09:00:00+00:00", transition_token: "token-oct", year: 2026 },
    ],
  });
  const input = {
    action: "published" as const,
    batchId: "batch-oct",
    detail: { held: [{ hrId: "B-77", name: "Held Person", reason: "Bank account not confirmed", secondPartWithheld: 6000 }] },
    publishedBy: "B-10",
  };

  // (a) The forced failure after the first write.
  {
    const tables = ready();
    const before = snapshot(tables);
    await withStandIn({ rpc: { phx_mark_automated_payroll_run_published: markPublishedModel(true) }, tables }, async (seen) => {
      await assert.rejects(
        markRunPublished("run-oct", input, { transitionToken: "token-oct" }),
        (error: Error) => error.message.startsWith("Conflict: the payslips for this run WERE written") && error.message.includes("Press Publish again"),
        "HEADLINE: a publish whose record failed after the phase moved is told to press Publish again",
      );
      assert.deepEqual(tables, before, "HEADLINE (F-PAY-002): the run is still ready and no half record exists — never published without who was held");
      assert.equal(writesTo(seen, "automated_payroll_runs").length + writesTo(seen, "automated_payroll_audit").length, 0, "and nothing was written outside the one call");
    });
  }

  // (b) Two publishes at once, both holding the claim token: one lands, the other meets the cleared claim.
  {
    const tables = ready();
    await withStandIn({ rpc: { phx_mark_automated_payroll_run_published: markPublishedModel() }, tables }, async () => {
      const results = await Promise.allSettled([
        markRunPublished("run-oct", input, { transitionToken: "token-oct" }),
        markRunPublished("run-oct", input, { transitionToken: "token-oct" }),
      ]);
      const won = results.filter((result) => result.status === "fulfilled");
      const lost = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      assert.equal(won.length, 1, "HEADLINE: exactly one of two simultaneous publishes marks the run");
      assert.equal(lost.length, 1, "and the other is refused");
      assert.ok(String(lost[0].reason?.message).startsWith(`Conflict: ${TRANSITION_CLAIM_LOST}`), "as a claim another action took, never a second publish");
      assert.equal((tables.automated_payroll_audit ?? []).filter((row) => row.action === "published").length, 1, "one record of who was held");
      assert.equal((tables.automated_payroll_runs ?? [])[0]?.phase, "published", "and the run is published once");
    });
  }
}

export async function runHeldSalaryRecordBehaviourTests(): Promise<void> {
  await heldRecordReads();
  await markPublishedHandsOverTheHeldList();
}

// ─────────────────────────────────────────────────────────────────────────────── 2. deduction decisions

const SEEN_REVISION = "2026-11-13T09:00:00.654321+00:00";
const SUPER_ADMIN = { hrId: "B-10", loginId: "b-10", role: "Super Admin" } as const;

function decisionTables(lockedAt: string | null): Record<string, Row[]> {
  return {
    deductions_candidates: [
      {
        category: "dsm_no_record",
        dates: ["2026-10-05", "2026-10-06"],
        employee_hr_id: "B-77",
        employee_hr_id_compact: "b77",
        estimated_amount: 600,
        id: "cand-41",
        locked_at: lockedAt,
        month_key: "2026-10",
        raw_value: 2,
        unit: "days",
      },
    ],
    deductions_decisions: [
      {
        actor_role_at_decision: "Super Admin",
        applied_amount: null,
        applied_dates: null,
        applied_value: null,
        candidate_id: "cand-41",
        decided_at: null,
        decided_by: null,
        decision_reason: "",
        decision_status: "Pending",
        hr_note: "",
        id: "dec-41",
        updated_at: SEEN_REVISION,
      },
    ],
  };
}

const LATE_LOCK_REFUSAL: Failure = {
  body: { code: "55000", details: null, hint: null, message: "deduction candidate cand-41 is locked by a publication" },
  status: 400,
};

export async function runDeductionDecisionGateBehaviourTests(): Promise<void> {
  // (a) Only the Super Admin decides — refused before a single read, so nothing is even looked up.
  for (const role of ["HR Operations", "Finance Manager", "CEO"]) {
    await withStandIn({ tables: decisionTables(null) }, async (seen) => {
      await assert.rejects(
        recordDecision({ actor: { hrId: "B-20", loginId: "b-20", role } as never, candidateId: "cand-41", decisionReason: "", decisionStatus: "Approved for Payroll" }),
        (error: Error) => error.message === "Forbidden: only Super Admin can record or update a deduction decision.",
        `${role} cannot decide a deduction`,
      );
      assert.equal(seen.length, 0, `${role}'s refused decision reads nothing and writes nothing`);
    });
  }

  // (b) HEADLINE: a candidate a publication has locked is refused BEFORE any write.
  for (const expectedUpdatedAt of [undefined, SEEN_REVISION] as const) {
    const tables = decisionTables("2026-11-01T08:00:00+00:00");
    const before = structuredClone(tables);
    await withStandIn({ tables }, async (seen) => {
      await assert.rejects(
        recordDecision({ actor: SUPER_ADMIN, candidateId: "cand-41", decisionReason: "", decisionStatus: "Do Not Take Action", expectedUpdatedAt }),
        (error: Error) => error.message === "Conflict: this candidate is locked by a publication — it can no longer be decided directly.",
        "HEADLINE: a locked candidate cannot be decided directly",
      );
      assert.equal(writesTo(seen, "deductions_decisions").length, 0, "no decision write was even attempted");
      assert.equal(auditWrites(seen).length, 0, "and no audit row for a decision that did not happen");
    });
    assert.deepEqual(tables, before, "the locked decision is exactly as it was");
  }

  // (c) The lock landed between the read and the write: the trigger refuses it, and the reviewer reads a
  // Conflict — for the plain upsert (bridges, leave balance) and for the compare-and-set alike.
  for (const expectedUpdatedAt of [undefined, SEEN_REVISION] as const) {
    const tables = decisionTables(null);
    const before = structuredClone(tables);
    await withStandIn({ failWrites: { deductions_decisions: LATE_LOCK_REFUSAL }, tables }, async (seen) => {
      await assert.rejects(
        recordDecision({ actor: SUPER_ADMIN, candidateId: "cand-41", decisionReason: "", decisionStatus: "Do Not Take Action", expectedUpdatedAt }),
        (error: Error) =>
          error.message === "Conflict: this candidate was locked by a publication a moment ago — it can no longer be decided directly.",
        `the database's late lock refusal is a Conflict (${expectedUpdatedAt === undefined ? "upsert" : "compare-and-set"})`,
      );
      assert.equal(writesTo(seen, "deductions_decisions").length, 1, "exactly the one refused write");
      assert.equal(auditWrites(seen).length, 0, "no audit row claims a decision the database refused");
    });
    assert.deepEqual(tables, before, "nothing changed");
  }

  // (d) An open candidate still saves through the plain upsert, with the amount derived from the
  // candidate on record — so the refusals above are about the lock, not a decision path that never saves.
  {
    const tables = decisionTables(null);
    await withStandIn({ tables }, async (seen) => {
      const saved = await recordDecision({
        actor: SUPER_ADMIN,
        appliedDates: ["2026-10-05"],
        candidateId: "cand-41",
        decisionReason: "One day confirmed",
        decisionStatus: "Do Not Take Action",
      });
      assert.equal(saved.decisionStatus, "Do Not Take Action");
      const [write] = writesTo(seen, "deductions_decisions");
      assert.ok(write, "the decision was written");
      const body = (Array.isArray(write.body) ? write.body[0] : write.body) as Row;
      assert.deepEqual(body.applied_dates, ["2026-10-05"], "the day the reviewer chose");
      assert.equal(body.applied_value, 1);
      assert.equal(body.applied_amount, 300, "half of the 600 the candidate holds for two days, derived here — never taken from the request");
      assert.equal(body.decided_by, "B-10");
      assert.equal(body.actor_role_at_decision, "Super Admin");
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────── 3. permission lookups

type Grant = [PermissionResource, PermissionAction];

function grantsOf(role: PhoenixRole): Grant[] {
  const map = permissionMatrix[role] ?? {};
  return (Object.entries(map) as Array<[PermissionResource, PermissionAction[] | undefined]>).flatMap(([resource, actions]) =>
    (actions ?? []).map((action) => [resource, action] as Grant),
  );
}

const isFloor = (role: PhoenixRole, [resource, action]: Grant) =>
  portalMinimumPermissions.some((floor) => floor.resource === resource && floor.action === action && floor.roles.includes(role));

/** A signed-in role with two grants on two different modules, the first not a portal floor (a floor survives a deny row by design). */
function pickSubject(): { role: PhoenixRole; revoked: Grant; kept: Grant } {
  for (const role of Object.keys(permissionMatrix) as PhoenixRole[]) {
    if (role === "Super Admin") continue;
    const scope = createAccessContext({ hrId: "STAND-IN-1", loginId: "stand.in", role, source: "session" }).scope;
    if (scope === "system" || scope === "none") continue;
    const grants = grantsOf(role).filter(([resource]) => !NEVER_LOCKABLE_RESOURCES.includes(resource));
    const revoked = grants.find((grant) => !isFloor(role, grant));
    const kept = revoked && grants.find(([resource]) => resource !== revoked[0]);
    if (revoked && kept) return { kept, revoked, role };
  }
  throw new Error("no role has two lockable grants on two modules — the permission matrix changed shape");
}

export async function runPermissionLookupBehaviourTests(): Promise<void> {
  const { role, revoked, kept } = pickSubject();
  const person = createAccessContext({ hrId: "STAND-IN-1", loginId: "stand.in", role, source: "session" });
  const colleague = createAccessContext({ hrId: "STAND-IN-2", loginId: "stand.in.two", role, source: "session" });
  const denyRow = { action: revoked[1], is_allowed: false, resource: revoked[0], role_name: role };
  const realNow = Date.now;

  // (a) HEADLINE: a deny row in role_permission_overrides takes a compiled grant away, through the very
  // assertPermission every route calls; the role's other grants stand.
  const standIn: StandIn = { tables: { role_permission_overrides: [denyRow], user_module_locks: [] } };
  await withStandIn(standIn, async () => {
    clearPermissionMatrixCache();
    clearModuleLockCache();
    assert.equal(await canAccess(person, revoked[0], revoked[1]), false, `HEADLINE: the deny row takes ${revoked[1]} ${revoked[0]} from ${role}`);
    await assert.rejects(
      assertPermission(person, revoked[0], revoked[1]),
      (error: Error) => error.message === `Forbidden: ${role} cannot ${revoked[1]} ${revoked[0]}.`,
      "the route sees the standard refusal",
    );
    assert.equal(await canAccess(person, kept[0], kept[1]), true, `${role} keeps ${kept[1]} ${kept[0]}`);

    // (b) The override table then becomes unreadable and the cached matrix goes stale: the last matrix
    // that loaded is kept — the revoked grant does NOT come back from the compiled defaults, and the
    // role's other grants are NOT taken away.
    standIn.failReads = { role_permission_overrides: { body: { code: "XX000", message: "stand-in read failure" }, status: 500 } };
    Date.now = () => realNow() + 10 * 60 * 1000;
    try {
      assert.equal(await canAccess(person, revoked[0], revoked[1]), false, "a failed reload never restores a revoked grant");
      assert.equal(await canAccess(person, kept[0], kept[1]), true, "…and never takes the others away");
    } finally {
      Date.now = realNow;
    }
  });

  // (c) A module lock suspends a grant the role still holds — for that person only, and only while it runs.
  await withStandIn(
    {
      tables: {
        role_permission_overrides: [],
        user_module_locks: [
          {
            hr_id: "STAND-IN-1",
            id: "lock-1",
            locked_at: "2026-11-19T00:00:00+00:00",
            locked_by_login_id: "b-10",
            locked_by_name: "Owner",
            login_id: "stand.in",
            module_key: kept[0],
            note: null,
            released_at: null,
            released_by_name: null,
            unlock_at: null,
          },
        ],
      },
    },
    async () => {
      clearPermissionMatrixCache();
      clearModuleLockCache();
      assert.equal(await canAccess(person, kept[0], kept[1]), false, "a running lock suspends the grant");
      await assert.rejects(
        assertPermission(person, kept[0], kept[1]),
        (error: Error) => error.message === `Forbidden: ${kept[0]} is temporarily locked by the system administrator.`,
        "the locked person is told it is a lock, not that the role lacks it",
      );
      assert.equal(await canAccess(colleague, kept[0], kept[1]), true, "the same role on another account is untouched");
    },
  );
  await withStandIn(
    {
      tables: {
        role_permission_overrides: [],
        user_module_locks: [
          {
            hr_id: "STAND-IN-1",
            id: "lock-2",
            locked_at: "2026-11-01T00:00:00+00:00",
            locked_by_login_id: "b-10",
            locked_by_name: "Owner",
            login_id: "stand.in",
            module_key: kept[0],
            note: null,
            released_at: null,
            released_by_name: null,
            unlock_at: "2026-11-02T00:00:00+00:00",
          },
        ],
      },
    },
    async () => {
      clearPermissionMatrixCache();
      clearModuleLockCache();
      assert.equal(await canAccess(person, kept[0], kept[1]), true, "a lock past its unlock time no longer applies");
    },
  );

  // (d) A signed-out caller gets the signed-out refusal, still starting "Forbidden:" for the routes'
  // 403 handling — and no lookup is spent on it.
  await withStandIn({ tables: { role_permission_overrides: [], user_module_locks: [] } }, async (seen) => {
    const guest = createAccessContext({ source: "guest" });
    await assert.rejects(
      assertPermission(guest, kept[0], kept[1]),
      (error: Error) => error instanceof SignedOutRefusal && error.message.startsWith("Forbidden:"),
      "a signed-out caller is refused as signed out",
    );
    assert.equal(seen.length, 0, "a guest is refused without a database read");
  });
}
