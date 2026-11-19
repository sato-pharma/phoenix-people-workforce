import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createAccessContext } from "../src/lib/auth/permissions.ts";
import {
  draftPatchColumns,
  listCellWritesSince,
  readCellWatermark,
  renewRunTransition,
} from "../src/lib/automated-payroll/draft-store.ts";
import {
  assertCellsUnchangedSince,
  cancelRun,
  publishToPayslips,
  unconfirmPart1,
  unconfirmPart2,
} from "../src/lib/automated-payroll/run-service.ts";
import { STALE_STEP_OPENING } from "../src/lib/automated-payroll/imports/step-file-revision.ts";
import { cellsChangedSince, encodeStepRevision, parseStepRevision } from "../src/lib/automated-payroll/step-revision.ts";
import { TRANSITION_CLAIM_LAPSE_MINUTES } from "../src/lib/automated-payroll/transition-claim.ts";
import type { DraftRowPatch } from "../src/lib/automated-payroll/types.ts";
import { stripComments } from "./support/comment-strip.ts";
import {
  atomically,
  RpcRaise,
  rpcCalls,
  snapshot,
  withStandIn,
  writesTo,
  type Row,
  type RpcAnswer,
  type Tables,
} from "./support/postgrest-transaction-stand-in.ts";

/**
 * THE PAYROLL RUN'S MONEY PATHS, AS BEHAVIOUR (REC-078 money half, REC-038 close-out, 19 Nov 2026).
 *
 * Each section calls the REAL run-service function against the in-memory PostgREST (tests/support/
 * postgrest-transaction-stand-in.ts) and checks what is stored afterwards. The database functions the code calls are
 * modelled from their migrations — the claim (20260912050000), cancel and Reopen Part 2 (20261119120941),
 * Reopen Part 1 (20261114170804) — each as one indivisible step that keeps nothing when it raises.
 *
 *   1. Cancel a run (F-PAY-016, REC-038): refused while finance holds its bank files unless a reason of 10+
 *      characters is given; a refusal, a failed download read and a failure INSIDE the one call all leave
 *      the run, its reserved late trips, its carry-forward ledger and its audit exactly as they were; two
 *      cancels at once give one winner.
 *   2. Reopen Part 2 and Reopen Part 1: the same, each with its own download rule.
 *   3. Publish (F-PAY-014): a publish that meets another live claim is refused before it works out a single
 *      figure; a live claim renewed by its holder cannot be taken over, and a claim that was taken over
 *      refuses its old holder's next write.
 *   4. A step save (F-PAY-017): a figure that changed after the screen read the step refuses the save; a
 *      figure of another person or another column, or an older screen with no watermark, does not.
 */

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_RUN = "22222222-2222-4222-8222-222222222222";
const SUPER_ADMIN = createAccessContext({ hrId: "B-10", loginId: "b-10", role: "Super Admin" });
const OTHER_ADMIN = createAccessContext({ hrId: "B-12", loginId: "b-12", role: "Super Admin" });
const REASON = "Bank confirmed the transfer was never executed";
const CLAIM_RPC = "phx_claim_automated_payroll_run_transition";
const CANCEL_RPC = "phx_cancel_automated_payroll_run";
const REOPEN_PART2_RPC = "phx_reopen_automated_payroll_part2";
const REOPEN_PART1_RPC = "phx_reopen_automated_payroll_part1";

function runRow(phase: string, extra: Row = {}): Row {
  return {
    created_at: "2026-11-01T08:00:00+00:00",
    created_by: "B-10",
    id: RUN_ID,
    month: 10,
    month_key: "2026-10",
    part1_confirmed_at: "2026-10-20T10:00:00+00:00",
    part1_confirmed_by: "B-10",
    part2_confirmed_at: phase === "ready" ? "2026-11-02T10:00:00+00:00" : null,
    part2_confirmed_by: phase === "ready" ? "B-10" : null,
    phase,
    published_at: null,
    published_batch_id: null,
    published_by: null,
    transition_action: null,
    transition_started_at: null,
    transition_token: null,
    updated_at: "2026-11-02T10:00:00+00:00",
    year: 2026,
    ...extra,
  };
}

const download = (scope: string, at = "2026-11-03T09:00:00+00:00"): Row => ({
  action: "bank_file_downloaded",
  actor_hr_id: "B-41",
  created_at: at,
  detail: { file: "fab", fileName: `FAB-${scope}.xlsx`, scope },
  run_id: RUN_ID,
});

/** A run that confirmed Part 2: one late trip reserved, one earlier debt recovered, one debt of its own. */
function confirmedRunTables(phase = "ready", audit: Row[] = []): Tables {
  return {
    automated_payroll_audit: audit,
    automated_payroll_carried_expenses: [
      { expense_id: "trip-71", run_id: RUN_ID, hr_id: "B-77", amount: 640 },
      { expense_id: "trip-90", run_id: OTHER_RUN, hr_id: "B-90", amount: 210 },
    ],
    automated_payroll_carry_forward: [
      // An earlier month's overpayment this run recovered: released back to outstanding on undo.
      { id: "cf-1", source_run_id: OTHER_RUN, employee_hr_id_compact: "b77", amount: 500, applied_run_id: RUN_ID, applied_at: "2026-11-02T10:00:00+00:00" },
      // A debt this run created that nobody recovered: discarded on undo.
      { id: "cf-2", source_run_id: RUN_ID, employee_hr_id_compact: "b88", amount: 300, applied_run_id: null, applied_at: null },
      // A debt this run created that a LATER run already recovered: that recovery is real and stays.
      { id: "cf-3", source_run_id: RUN_ID, employee_hr_id_compact: "b99", amount: 120, applied_run_id: OTHER_RUN, applied_at: "2026-11-05T10:00:00+00:00" },
    ],
    automated_payroll_runs: [runRow(phase)],
  };
}

let tokenCounter = 0;

/** phx_claim_automated_payroll_run_transition, from 20260912050000: one statement, the phase and the lapse. */
function claimModel(nowMs: () => number = () => Date.now()) {
  return (args: Record<string, unknown>, tables: Tables): RpcAnswer => {
    const run = (tables.automated_payroll_runs ?? []).find((row) => row.id === args.p_run_id);
    const expected = (args.p_expected_phases as string[]) ?? [];
    const lapsed =
      run && (!run.transition_token || Date.parse(String(run.transition_started_at)) < nowMs() - TRANSITION_CLAIM_LAPSE_MINUTES * 60_000);
    if (!run || !expected.includes(String(run.phase)) || !lapsed) return { body: null, status: 200 };
    tokenCounter += 1;
    const token = `00000000-0000-4000-8000-${String(tokenCounter).padStart(12, "0")}`;
    Object.assign(run, {
      transition_action: args.p_action,
      transition_started_at: new Date(nowMs()).toISOString(),
      transition_token: token,
    });
    return { body: token, status: 200 };
  };
}

/**
 * phx_cancel_automated_payroll_run / phx_reopen_automated_payroll_part2, from 20261119120941, statement by
 * statement. `failAfter` raises after that many of its writes — the forced failure inside the one call.
 */
function undoModel(kind: "cancel" | "reopen_part2", failAfter: number | null = null) {
  return (args: Record<string, unknown>, tables: Tables): RpcAnswer =>
    atomically(tables, (db) => {
      let writes = 0;
      const wrote = () => {
        writes += 1;
        if (failAfter !== null && writes >= failAfter) throw new RpcRaise("XX000", `stand-in: statement ${writes + 1} of the ${kind} failed`);
      };
      const phases = kind === "cancel" ? ["part1", "part2", "ready"] : ["ready"];
      const run = (db.automated_payroll_runs ?? []).find(
        (row) => row.id === args.p_run_id && row.transition_token === args.p_transition_token && phases.includes(String(row.phase)),
      );
      if (!run) throw new RpcRaise("P0001", `automated_payroll_transition_claim_lost: [transition-claim-lost] the ${kind} did not land`);
      Object.assign(
        run,
        kind === "cancel" ? { phase: "cancelled" } : { phase: "part2", part2_confirmed_at: null, part2_confirmed_by: null },
        { transition_action: null, transition_started_at: null, transition_token: null, updated_at: "2026-11-19T10:00:00+00:00" },
      );
      wrote();
      const audit = (db.automated_payroll_audit ??= []);
      if (args.p_override_detail) {
        audit.push({ action: "undo_after_download_overridden", actor_hr_id: args.p_actor_hr_id, detail: args.p_override_detail, run_id: args.p_run_id });
        wrote();
      }
      db.automated_payroll_carried_expenses = (db.automated_payroll_carried_expenses ?? []).filter((row) => row.run_id !== args.p_run_id);
      wrote();
      let released = 0;
      for (const row of db.automated_payroll_carry_forward ?? []) {
        if (row.applied_run_id === args.p_run_id) {
          row.applied_run_id = null;
          row.applied_at = null;
          released += 1;
        }
      }
      wrote();
      const before = (db.automated_payroll_carry_forward ?? []).length;
      db.automated_payroll_carry_forward = (db.automated_payroll_carry_forward ?? []).filter(
        (row) => !(row.source_run_id === args.p_run_id && row.applied_run_id == null),
      );
      const discarded = before - db.automated_payroll_carry_forward.length;
      wrote();
      const override = args.p_override_detail as { reason?: string } | null;
      audit.push({
        action: kind === "cancel" ? "run_cancelled" : "part2_unconfirmed",
        actor_hr_id: args.p_actor_hr_id,
        detail: {
          carryForwardDiscarded: discarded,
          carryForwardReleased: released,
          ...(override ? { [kind === "cancel" ? "cancelledAfterBankFileDownload" : "reopenedAfterBankFileDownload"]: true, overrideReason: override.reason } : {}),
        },
        run_id: args.p_run_id,
      });
      wrote();
      return { body: { discarded, released, run: { ...run } }, status: 200 };
    });
}

/** phx_reopen_automated_payroll_part1, from 20261114170804: the phase, the freeze and the held reservations. */
function reopenPart1Model(failAfterFirstWrite = false) {
  return (args: Record<string, unknown>, tables: Tables): RpcAnswer =>
    atomically(tables, (db) => {
      const run = (db.automated_payroll_runs ?? []).find(
        (row) => row.id === args.p_run_id && row.phase === "part2" && row.transition_token === args.p_transition_token,
      );
      if (!run) throw new RpcRaise("P0001", "automated_payroll_transition_claim_lost: [transition-claim-lost] Part 1 was not reopened");
      Object.assign(run, { part1_confirmed_at: null, part1_confirmed_by: null, phase: "part1", transition_action: null, transition_started_at: null, transition_token: null });
      if (failAfterFirstWrite) throw new RpcRaise("XX000", "stand-in: the freeze could not be cleared");
      for (const row of db.automated_payroll_draft_rows ?? []) {
        if (row.run_id === args.p_run_id) Object.assign(row, { first_part_frozen: null, settled_in_part1: null, part1_withheld: null });
      }
      db.automated_payroll_held_releases = (db.automated_payroll_held_releases ?? []).filter((row) => row.paying_run_id !== args.p_run_id);
      return { body: [{ ...run }], status: 200 };
    });
}

const undoRpcs = (failAfter: number | null = null) => ({
  [CANCEL_RPC]: undoModel("cancel", failAfter),
  [CLAIM_RPC]: claimModel(),
  [REOPEN_PART2_RPC]: undoModel("reopen_part2", failAfter),
});

const runOf = (tables: Tables) => (tables.automated_payroll_runs ?? []).find((row) => row.id === RUN_ID) ?? {};
const actionsOf = (tables: Tables) => (tables.automated_payroll_audit ?? []).map((row) => String(row.action));

// ─────────────────────────────────────────────────────────────────────────── 1. cancel (F-PAY-016, REC-038)

async function cancelTests(): Promise<void> {
  // (a) Finance downloaded a Part 2 file: a cancel with no reason is refused and changes NOTHING.
  for (const override of [undefined, { reason: "too short" }]) {
    const tables = confirmedRunTables("ready", [download("part2")]);
    const before = snapshot(tables);
    await withStandIn({ rpc: undoRpcs(), tables }, async (seen) => {
      await assert.rejects(
        cancelRun(SUPER_ADMIN, RUN_ID, { overrideDownloaded: override ?? null }),
        /^Error: Conflict: finance has already downloaded a file for this run/,
        `HEADLINE (F-PAY-016): a cancel after a recorded bank-file download is refused ${override ? "with a reason under 10 characters" : "without an override"}`,
      );
      assert.deepEqual(tables, before, "a refused cancel leaves the run, its trips, its ledger and its audit exactly as they were");
      assert.equal(rpcCalls(seen, CANCEL_RPC).length, 0, "and never reaches the cancel itself");
      assert.equal(writesTo(seen, "automated_payroll_audit").length, 0, "nor records anything");
    });
  }

  // (a2) The downloads cannot be read: refused, nothing changed — "unknown" never reads as "nothing left".
  {
    const tables = confirmedRunTables("ready");
    const before = snapshot(tables);
    await withStandIn(
      { failReads: { automated_payroll_audit: { body: { code: "XX000", message: "stand-in read failure" }, status: 500 } }, rpc: undoRpcs(), tables },
      async (seen) => {
        await assert.rejects(cancelRun(SUPER_ADMIN, RUN_ID), /could not read whether finance has already downloaded/i, "a failed read refuses");
        assert.deepEqual(tables, before, "and changes nothing");
        assert.equal(rpcCalls(seen, CANCEL_RPC).length, 0, "never reaching the cancel");
      },
    );
  }

  // (a3) THE FORCED FAILURE AFTER THE FIRST WRITE: the one call raises after it has moved the phase (and after
  // each later statement in turn). Nothing it did is kept, the claim is let go, and the person is told so.
  // With the override the call makes six writes: phase, override, trips, ledger release, ledger discard, audit.
  for (const failAfter of [1, 2, 3, 4, 5, 6]) {
    const tables = confirmedRunTables("ready", [download("part2")]);
    const before = snapshot(tables);
    await withStandIn({ rpc: undoRpcs(failAfter), tables }, async (seen) => {
      await assert.rejects(
        cancelRun(SUPER_ADMIN, RUN_ID, { overrideDownloaded: { reason: REASON } }),
        /^Error: Conflict: the run could not be cancelled, so nothing was changed/,
        `HEADLINE (REC-038): a failure after write ${failAfter} of the cancel is reported as nothing changed`,
      );
      assert.deepEqual(tables, before, `after a failure at write ${failAfter}: the run is still ready, its trips still set aside, its ledger untouched, no override row`);
      assert.equal(rpcCalls(seen, CANCEL_RPC).length, 1, "the cancel is ONE database call");
      for (const table of ["automated_payroll_carried_expenses", "automated_payroll_carry_forward", "automated_payroll_audit"]) {
        assert.equal(writesTo(seen, table).length, 0, `the app writes ${table} only inside that call`);
      }
    });
  }

  // (b) The override, given: one call records the reason, releases the trips and the ledger, and cancels.
  {
    const tables = confirmedRunTables("ready", [download("part2")]);
    await withStandIn({ rpc: undoRpcs(), tables }, async (seen) => {
      const run = await cancelRun(SUPER_ADMIN, RUN_ID, { overrideDownloaded: { reason: REASON } });
      assert.equal(run.phase, "cancelled", "the run is cancelled");
      const [call] = rpcCalls(seen, CANCEL_RPC);
      const detail = (call.body as { p_override_detail?: { move?: string; reason?: string; files?: unknown[] } }).p_override_detail;
      assert.equal(detail?.move, "cancel", "the override names the move");
      assert.equal(detail?.reason, REASON, "and his reason");
      assert.equal(detail?.files?.length, 1, "and the file finance took");
      assert.deepEqual(actionsOf(tables), ["bank_file_downloaded", "undo_after_download_overridden", "run_cancelled"], "the override is recorded with the cancel, never apart from it");
      assert.deepEqual((tables.automated_payroll_carried_expenses ?? []).map((row) => row.expense_id), ["trip-90"], "this run's late trip goes back on the list; another run's stays reserved");
      const ledger = Object.fromEntries((tables.automated_payroll_carry_forward ?? []).map((row) => [row.id, row.applied_run_id]));
      assert.deepEqual(ledger, { "cf-1": null, "cf-3": OTHER_RUN }, "recovered debt released, its own unrecovered debt discarded, a later run's recovery kept");
      assert.equal(runOf(tables).transition_token, null, "and the claim is let go");
    });
  }

  // (c) TWO CANCELS AT ONCE: one wins, the other is refused, and the ledger is undone exactly once.
  {
    const tables = confirmedRunTables("ready");
    await withStandIn({ rpc: undoRpcs(), tables }, async (seen) => {
      const results = await Promise.allSettled([cancelRun(SUPER_ADMIN, RUN_ID), cancelRun(OTHER_ADMIN, RUN_ID)]);
      const won = results.filter((result) => result.status === "fulfilled");
      const lost = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      assert.equal(won.length, 1, "HEADLINE (REC-038): exactly one of two simultaneous cancels lands");
      assert.equal(lost.length, 1, "and the other is refused");
      assert.match(String(lost[0].reason?.message), /^Conflict: (Cancelling this run is already in progress|this run is now cancelled)/, "with the words of a run another action took");
      assert.equal(rpcCalls(seen, CANCEL_RPC).length, 1, "only the winner reaches the cancel");
      assert.deepEqual(actionsOf(tables), ["run_cancelled"], "one cancel on the record");
      assert.equal((tables.automated_payroll_carry_forward ?? []).length, 2, "the run's own debt is discarded once, nothing more");
    });
  }
}

// ────────────────────────────────────────────────────────────────────────────────── 2. Reopen Part 2 and Part 1

async function reopenTests(): Promise<void> {
  // A Part 1 file alone never asks for a reason to reopen Part 2 (REC-035); a Part 2 file does.
  {
    const tables = confirmedRunTables("ready", [download("part1")]);
    await withStandIn({ rpc: undoRpcs(), tables }, async () => {
      const run = await unconfirmPart2(SUPER_ADMIN, RUN_ID);
      assert.equal(run.phase, "part2", "a Part 1 download does not hold Reopen Part 2");
      assert.equal(run.part2ConfirmedAt, null, "the Part 2 confirmation is cleared");
      assert.deepEqual(actionsOf(tables), ["bank_file_downloaded", "part2_unconfirmed"], "no override was needed, so none is recorded");
    });
  }
  {
    const tables = confirmedRunTables("ready", [download("part2")]);
    const before = snapshot(tables);
    await withStandIn({ rpc: undoRpcs(), tables }, async (seen) => {
      await assert.rejects(unconfirmPart2(SUPER_ADMIN, RUN_ID), /finance has already downloaded/, "a Part 2 download refuses Reopen Part 2 without a reason");
      assert.deepEqual(tables, before, "and changes nothing");
      assert.equal(rpcCalls(seen, REOPEN_PART2_RPC).length, 0, "never reaching the reopen");
    });
  }
  // (a) Forced failure after the first write of Reopen Part 2's one call.
  // With no override the call makes five writes: phase, trips, ledger release, ledger discard, audit.
  for (const failAfter of [1, 2, 3, 4, 5]) {
    const tables = confirmedRunTables("ready");
    const before = snapshot(tables);
    await withStandIn({ rpc: undoRpcs(failAfter), tables }, async (seen) => {
      await assert.rejects(unconfirmPart2(SUPER_ADMIN, RUN_ID), /^Error: Conflict: Part 2 could not be reopened, so nothing was changed/, "HEADLINE: a failed reopen says nothing changed");
      assert.deepEqual(tables, before, `after a failure at write ${failAfter}: still ready, trips still reserved, ledger untouched`);
      assert.equal(writesTo(seen, "automated_payroll_carried_expenses").length, 0, "the trips are released only inside the one call");
    });
  }
  // (b) Two reopens at once: one winner.
  {
    const tables = confirmedRunTables("ready");
    await withStandIn({ rpc: undoRpcs(), tables }, async (seen) => {
      const results = await Promise.allSettled([unconfirmPart2(SUPER_ADMIN, RUN_ID), unconfirmPart2(OTHER_ADMIN, RUN_ID)]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1, "HEADLINE: one of two simultaneous Reopen Part 2 lands");
      assert.equal(rpcCalls(seen, REOPEN_PART2_RPC).length, 1, "only the winner reaches the database call");
      assert.deepEqual(actionsOf(tables), ["part2_unconfirmed"], "one reopen on the record");
    });
  }

  // Reopen Part 1: refused after ANY recorded download without a reason; a failure inside its one call
  // changes nothing; two at once give one winner.
  const part1Tables = (audit: Row[] = []): Tables => ({
    automated_payroll_audit: audit,
    automated_payroll_carried_expenses: [],
    automated_payroll_draft_rows: [{ employee_hr_id: "B-77", employee_hr_id_compact: "b77", first_part_frozen: 9000, run_id: RUN_ID }],
    automated_payroll_held_releases: [{ amount: 1200, hr_id: "B-55", paying_run_id: RUN_ID }],
    automated_payroll_runs: [runRow("part2")],
  });
  const part1Rpcs = (fail = false) => ({ [CLAIM_RPC]: claimModel(), [REOPEN_PART1_RPC]: reopenPart1Model(fail) });
  {
    const tables = part1Tables([download("part1")]);
    const before = snapshot(tables);
    await withStandIn({ rpc: part1Rpcs(), tables }, async (seen) => {
      await assert.rejects(unconfirmPart1(SUPER_ADMIN, RUN_ID), /finance has already downloaded/, "a Part 1 download refuses Reopen Part 1 without a reason");
      assert.deepEqual(tables, before, "and changes nothing");
      assert.equal(rpcCalls(seen, REOPEN_PART1_RPC).length, 0, "never reaching the reopen");
    });
  }
  {
    const tables = part1Tables();
    const before = snapshot(tables);
    await withStandIn({ rpc: part1Rpcs(true), tables }, async () => {
      await assert.rejects(unconfirmPart1(SUPER_ADMIN, RUN_ID), /^Error: Conflict: Part 1 could not be reopened, so nothing was changed/, "HEADLINE: a failed Reopen Part 1 says nothing changed");
      assert.deepEqual(tables, before, "the first instalment stays frozen, the held reservation stays, the run stays in Part 2");
    });
  }
  {
    const tables = part1Tables();
    await withStandIn({ rpc: part1Rpcs(), tables }, async (seen) => {
      const results = await Promise.allSettled([unconfirmPart1(SUPER_ADMIN, RUN_ID), unconfirmPart1(OTHER_ADMIN, RUN_ID)]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1, "HEADLINE: one of two simultaneous Reopen Part 1 lands");
      assert.equal(rpcCalls(seen, REOPEN_PART1_RPC).length, 1, "only the winner reaches the database call");
      assert.equal(runOf(tables).phase, "part1", "the run is back in Part 1 once");
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────── 3. publish (F-PAY-014)

const FIGURE_TABLES = ["automated_payroll_draft_rows", "employees", "automated_payroll_step_state", "deductions_decisions", "outstation_expenses"];

async function publishClaimTests(): Promise<void> {
  // A publish that meets another live publish's claim is refused BEFORE it reads a single figure: under the old
  // order it assembled the whole sheet first and checked the claim only when it was about to write.
  const minuteAgo = new Date(Date.now() - 60_000).toISOString();
  const tables: Tables = {
    automated_payroll_runs: [runRow("ready", { transition_action: "Publishing to payslips", transition_started_at: minuteAgo, transition_token: "00000000-0000-4000-8000-0000000000aa" })],
  };
  const before = snapshot(tables);
  await withStandIn({ rpc: { [CLAIM_RPC]: claimModel() }, tables }, async (seen) => {
    await assert.rejects(
      publishToPayslips(SUPER_ADMIN, RUN_ID),
      /^Error: Conflict: Publishing to payslips is already in progress on this run/,
      "HEADLINE (F-PAY-014): a second publish meets the first one's claim and is refused",
    );
    const figureReads = seen.filter((request) => request.table !== null && FIGURE_TABLES.includes(request.table));
    assert.deepEqual(figureReads.map((request) => request.table), [], "HEADLINE (F-PAY-014): and it read no figure before the claim refused it");
    assert.deepEqual(tables, before, "and changed nothing");
  });

  // The claim's lapse is for a request that DIED. A live holder renews it before each money write, so a claim
  // first taken 20 minutes ago but renewed a minute ago cannot be taken over; a stale one can, and its old
  // holder's next renewal fails, so its next write is refused rather than made.
  const longAgo = new Date(Date.now() - 20 * 60_000).toISOString();
  const held: Tables = { automated_payroll_runs: [runRow("ready", { transition_action: "Publishing to payslips", transition_started_at: longAgo, transition_token: "00000000-0000-4000-8000-0000000000bb" })] };
  await withStandIn({ rpc: { [CLAIM_RPC]: claimModel() }, tables: held }, async () => {
    assert.equal(await renewRunTransition(RUN_ID, "00000000-0000-4000-8000-0000000000bb"), true, "the holder renews its own claim");
    assert.ok(Date.now() - Date.parse(String(runOf(held).transition_started_at)) < 5_000, "and its clock restarts now");
    await assert.rejects(cancelRun(SUPER_ADMIN, RUN_ID), /Publishing to payslips is already in progress/, "HEADLINE: a renewed claim is not taken over by a cancel");
    assert.equal(runOf(held).transition_token, "00000000-0000-4000-8000-0000000000bb", "the publish still holds the run");
  });
  const lapsed: Tables = { automated_payroll_runs: [runRow("ready", { transition_action: "Publishing to payslips", transition_started_at: longAgo, transition_token: "00000000-0000-4000-8000-0000000000cc" })] };
  await withStandIn({ rpc: { [CLAIM_RPC]: claimModel() }, tables: lapsed }, async () => {
    const takeover = await (async () => {
      const { claimRunTransition } = await import("../src/lib/automated-payroll/draft-store.ts");
      return claimRunTransition(RUN_ID, ["ready"], "Reopening Part 2");
    })();
    assert.ok(takeover, "a claim nobody renewed for 15 minutes is taken over");
    assert.equal(await renewRunTransition(RUN_ID, "00000000-0000-4000-8000-0000000000cc"), false, "HEADLINE: the old holder's renewal fails");
    assert.equal(runOf(lapsed).transition_token, takeover, "and changes nothing of the new holder's claim");
  });

  // Every money write in publish is preceded by a renewal, and the claim precedes the figures.
  const publish = bodyOfExport(stripComments(readFileSync("src/lib/automated-payroll/run-service.ts", "utf8")), "publishToPayslips");
  const claimAt = publish.indexOf('claimTransition(runId, ["ready"], "Publishing to payslips")');
  assert.ok(claimAt > 0 && claimAt < publish.indexOf("await assembleForRun("), "HEADLINE (F-PAY-014): publish claims before it assembles a single row");
  for (const write of ["createSalaryBatch({", "replaceSalaryBatch(batchId", "finalizeApproved(batchId", "markCarryForwardApplied({", "recordHeldReleases({"]) {
    const writeAt = publish.indexOf(write);
    assert.ok(writeAt > 0, `publish still makes ${write}`);
    const renewAt = publish.lastIndexOf("await keepClaim(runId, transition,", writeAt);
    assert.ok(renewAt > 0 && publish.slice(renewAt, writeAt).split("await ").length <= 4, `HEADLINE (F-PAY-014): the claim is renewed right before ${write}`);
  }
}

function bodyOfExport(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const end = source.indexOf("\nexport ", start + 10);
  return source.slice(start, end > 0 ? end : undefined);
}

// ───────────────────────────────────────────────────────────────────────────────────────── 4. step save (F-PAY-017)

async function stepSaveCellTests(): Promise<void> {
  // The revision a screen carries: the step's own stamp, plus the run's cell watermark.
  assert.equal(encodeStepRevision("2026-11-19T08:00:00.123+00:00", 512), "2026-11-19T08:00:00.123+00:00|cells:512");
  assert.equal(encodeStepRevision(null, 7), "none|cells:7", "a step never saved still carries a watermark");
  assert.equal(encodeStepRevision("2026-11-19T08:00:00Z", null), "2026-11-19T08:00:00Z", "no watermark: the old revision, unchanged");
  assert.deepEqual(parseStepRevision("2026-11-19T08:00:00Z|cells:512"), { step: "2026-11-19T08:00:00Z", watermark: 512 });
  assert.deepEqual(parseStepRevision("none|cells:7"), { step: null, watermark: 7 });
  assert.deepEqual(parseStepRevision("2026-11-19T08:00:00Z"), { step: "2026-11-19T08:00:00Z", watermark: null }, "an older screen's revision is read as before");
  assert.deepEqual(parseStepRevision(null), { step: null, watermark: null });
  assert.deepEqual(parseStepRevision(undefined), { step: undefined, watermark: null });

  // The figures a patch writes are named as the cell history names them.
  const expensesPatch = { employeeHrId: "B-77", expenses: 640, editedBy: "B-10", source: "inline" } as unknown as DraftRowPatch;
  assert.deepEqual(draftPatchColumns(expensesPatch), ["expenses"], "only the figure, never the bookkeeping columns");

  const history: Row[] = [
    { changed_at: "2026-11-19T07:59:00+00:00", changed_by: "B-10", column_name: "expenses", employee_hr_id_compact: "b77", id: 498, run_id: RUN_ID, write_reason: "step_saved" },
    { changed_at: "2026-11-19T08:01:00+00:00", changed_by: "system", column_name: "expenses", employee_hr_id_compact: "b77", id: 501, run_id: RUN_ID, write_reason: "expense_resync" },
    { changed_at: "2026-11-19T08:02:00+00:00", changed_by: "system", column_name: "crm", employee_hr_id_compact: "b88", id: 502, run_id: RUN_ID, write_reason: "deduction_resync" },
    { changed_at: "2026-11-19T08:03:00+00:00", changed_by: "B-10", column_name: "expenses", employee_hr_id_compact: "b77", id: 900, run_id: OTHER_RUN, write_reason: "step_saved" },
  ];
  await withStandIn({ tables: { automated_payroll_draft_cell_history: history } }, async (seen) => {
    assert.equal(await readCellWatermark(RUN_ID), 502, "the watermark is the run's highest line, never another run's");
    assert.deepEqual((await listCellWritesSince(RUN_ID, 500)).map((write) => write.id), [501, 502], "the lines above a watermark, this run only, oldest first");

    // A screen read the step at watermark 500; an expense decision then cleared B-77's figure (line 501).
    const revision = encodeStepRevision("2026-11-19T07:59:00+00:00", 500);
    await assert.rejects(
      assertCellsUnchangedSince(RUN_ID, revision, [expensesPatch], "screen"),
      (error: Error) => error.message.startsWith(`Conflict: ${STALE_STEP_OPENING}`) && error.message.includes("B-77"),
      "HEADLINE (F-PAY-017): a save that would write B-77's expenses over the change it never saw is refused, naming B-77",
    );
    // Another person's figure, or another column of the same person, never refuses the save.
    await assertCellsUnchangedSince(RUN_ID, revision, [{ employeeHrId: "B-99", expenses: 10 } as unknown as DraftRowPatch], "screen");
    await assertCellsUnchangedSince(RUN_ID, revision, [{ employeeHrId: "B-77", incentive: 5000 } as unknown as DraftRowPatch], "screen");
    // A screen that read the step after the change (watermark 501) saves.
    await assertCellsUnchangedSince(RUN_ID, encodeStepRevision("2026-11-19T07:59:00+00:00", 501), [expensesPatch], "screen");
    // An older screen or file carries no watermark: judged on the step alone, as before, with no read.
    const readsBefore = seen.length;
    await assertCellsUnchangedSince(RUN_ID, "2026-11-19T07:59:00+00:00", [expensesPatch], "file");
    assert.equal(seen.length, readsBefore, "a revision without a watermark reads nothing");
  });
  assert.deepEqual(
    cellsChangedSince(
      [{ changedBy: "system", column: "expenses", compact: "B77", id: 501, writeReason: "expense_resync" }],
      500,
      new Map([["b77", new Set(["expenses"])]]),
    ).length,
    1,
    "the comparison ignores the case of the HR id",
  );

  // Wiring: the check runs under the run's hold, before the figures are written; the step read takes the
  // watermark before the figures; the screen keeps the server's revision.
  const service = stripComments(readFileSync("src/lib/automated-payroll/run-service.ts", "utf8"));
  const save = bodyOfExport(service, "saveStep");
  const hold = save.indexOf("holdRun(");
  const checkAt = save.indexOf("await assertCellsUnchangedSince(", hold);
  assert.ok(hold > 0 && checkAt > hold && checkAt < save.indexOf("await upsertDraftRows(runId, patches)", hold), "HEADLINE (F-PAY-017): saveStep checks the figures under the hold, before it writes");
  const read = bodyOfExport(service, "getStepRecommendation");
  assert.ok(read.indexOf("await readCellWatermark(runId)") < read.indexOf("await loadStepView("), "the watermark is read BEFORE the figures the screen will show");
  const screen = stripComments(readFileSync("src/components/automated-payroll/recommendation-step.tsx", "utf8"));
  assert.match(screen, /typeof data\.revision === "string"\s*\?\s*data\.revision/, "the step screen sends back the revision the server gave it");
}

export async function runPayrollRunMoneyPathsBehaviourTests(): Promise<void> {
  await cancelTests();
  await reopenTests();
  await publishClaimTests();
  await stepSaveCellTests();
}
