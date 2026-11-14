import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  describeUnexplainedDisappearances,
  unexplainedDisappearances,
  type PopulationDiff,
} from "../src/lib/automated-payroll/population-diff.ts";
import {
  assertNoTransitionInProgress,
  describeTransitionRefusal,
  TRANSITION_CLAIM_LAPSE_MINUTES,
  transitionInProgress,
} from "../src/lib/automated-payroll/transition-claim.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * ONE TRANSITION AT A TIME, AND A PART 2 THAT ASKS ABOUT PEOPLE WHO VANISHED.
 *
 * FINDING 50 — every phase change read the run, checked the phase in code, did seconds of work, then
 * wrote with no condition. Two overlapping requests both passed and the later writer won: a cancel
 * landing mid Part 2 confirm was overwritten back to `ready`, publishable again, with carry-forward
 * balances recorded against a cancelled run. A transition now claims the run before its first write in
 * one statement that re-checks the phase, and its phase write is conditioned on that claim.
 *
 * FINDING 46 — the population comparison was a banner and nothing more. Part 2 now stops on someone
 * paid last month who is missing with no resignation on file, until HR acknowledges on the record. And
 * the wizard sends every acknowledgement already given, because the buttons used to send only their own
 * flag and a month raising two gates looped between the prompts.
 */

function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `could not find the end of ${signature}`);
  return source.slice(start, end);
}

export function runAutomatedPayrollRunTransitionClaimTests() {
  // ==== The claim, as a rule =====================================================================
  const now = Date.parse("2026-09-20T10:00:00.000Z");
  const fresh = { phase: "part2" as const, transitionAction: "Confirming Part 2", transitionStartedAt: "2026-09-20T09:58:00.000Z" };
  const lapsed = { ...fresh, transitionStartedAt: "2026-09-20T09:40:00.000Z" };
  const none = { phase: "part2" as const, transitionAction: null, transitionStartedAt: null };

  assert.equal(transitionInProgress(fresh, now), true, "a claim two minutes old is live");
  assert.equal(transitionInProgress(lapsed, now), false, "a claim older than the lapse was left by a request that died");
  assert.equal(transitionInProgress(none, now), false, "an unclaimed run is free");
  assert.throws(
    () => assertNoTransitionInProgress(fresh, now),
    /^Error: Conflict: Confirming Part 2 is in progress on this run/,
    "a step save meets a live claim and is refused before it writes",
  );
  assert.doesNotThrow(() => assertNoTransitionInProgress(lapsed, now), "a lapsed claim never blocks a save");
  assert.match(
    describeTransitionRefusal(fresh, ["part2"], now),
    /^Conflict: Confirming Part 2 is already in progress on this run/,
    "a second transition is told what is already happening",
  );
  assert.match(
    describeTransitionRefusal({ ...none, phase: "cancelled" }, ["part2"], now),
    /^Conflict: this run is now cancelled, not in Part 2/,
    "a transition whose phase moved underneath it is told where the run now stands",
  );

  const migration = readFileSync("supabase/migrations/20260912050000_automated_payroll_run_transition_claim.sql", "utf8");
  assert.ok(
    migration.includes(`interval '${TRANSITION_CLAIM_LAPSE_MINUTES} minutes'`),
    "the SQL claim and the app must agree on when a claim lapses",
  );
  assert.match(migration, /and phase = any \(p_expected_phases\)/, "the claim re-checks the phase in the same statement");
  assert.match(
    migration,
    /and \(transition_token is null or transition_started_at < now\(\) - interval/,
    "and refuses while another live claim holds the run",
  );
  assert.match(
    migration,
    /revoke execute on function public\.phx_claim_automated_payroll_run_transition\(uuid, text\[\], text\) from public, anon, authenticated;/,
    "nobody outside the server can claim a run",
  );
  assert.match(
    migration,
    /grant execute on function public\.phx_claim_automated_payroll_run_transition\(uuid, text\[\], text\) to service_role;/,
  );

  // ==== Every transition claims before it writes ==================================================
  const source = stripComments(readFileSync("src/lib/automated-payroll/run-service.ts", "utf8"));
  const transitions: Array<[string, string, string]> = [
    ["cancelRun", '["part1", "part2", "ready"]', "await releaseCarryForwardForCancelledRun("],
    ["confirmPart1", '["part1"]', "await upsertDraftRows(runId, patches)"],
    ["unconfirmPart1", '["part2"]', "await reopenPart1Atomically("],
    ["unconfirmPart2", '["ready"]', "await releaseCarryForwardForCancelledRun("],
    ["confirmPart2", '["part2"]', "await recordOverpaidCarryForward("],
    ["publishToPayslips", '["ready"]', "await findSalaryBatchForPeriod("],
  ];
  for (const [name, phases, firstWrite] of transitions) {
    const body = bodyOf(source, `export async function ${name}(`);
    const claimAt = body.indexOf(`claimTransition(runId, ${phases},`);
    assert.ok(claimAt > 0, `HEADLINE: ${name} must claim the run (${phases}) before it writes`);
    const writeAt = body.indexOf(firstWrite);
    assert.ok(writeAt > claimAt, `${name} must claim BEFORE its first write (${firstWrite})`);
    assert.match(body, /\{ transitionToken: transition \}/, `${name}'s phase write must be conditioned on its own claim`);
    assert.match(body, /whileClaimed\(runId, transition, async \(\) => \{/, `${name} must let the claim go if its writes fail part-way`);
  }

  const cancel = bodyOf(source, "export async function cancelRun(");
  assert.ok(
    cancel.indexOf("await releaseCarryForwardForCancelledRun(") < cancel.indexOf('phase: "cancelled"'),
    "cancelling still releases the ledger BEFORE the run is marked cancelled",
  );
  const publish = bodyOf(source, "export async function publishToPayslips(");
  assert.ok(
    publish.indexOf('run.phase === "published" && run.publishedBatchId') < publish.indexOf("claimTransition("),
    "an already-published run returns before any claim, so a retried publish stays idempotent",
  );

  const claim = bodyOf(source, "async function claimTransition(");
  assert.match(claim, /claimRunTransition\(runId, expected, action\)/, "the claim is the atomic database call");
  assert.match(claim, /throw new Error\(describeTransitionRefusal\(/, "and a refused claim throws, never continues");
  assert.match(
    bodyOf(source, "async function whileClaimed<"),
    /catch \(error\) \{[\s\S]*releaseRunTransition\(runId, token\)[\s\S]*throw error;/,
    "a failure part-way releases the claim and still fails",
  );

  assert.match(bodyOf(source, "function assertStepPhaseAllowed("), /assertNoTransitionInProgress\(run\)/, "step saves wait for a transition");
  assert.match(bodyOf(source, "export async function excludeEmployeeFromRun("), /assertNoTransitionInProgress\(run\)/, "so does an exclusion");
  assert.match(bodyOf(source, "export async function includeEmployeeInRun("), /assertNoTransitionInProgress\(run\)/, "and a re-inclusion");

  const store = stripComments(readFileSync("src/lib/automated-payroll/draft-store.ts", "utf8"));
  const update = bodyOf(store, "export async function updateRun(");
  assert.match(update, /query = query\.eq\("transition_token", options\.transitionToken\)/, "the phase write matches only its own claim");
  assert.match(update, /dbPatch\.transition_token = null;/, "and clears it in the same statement");
  assert.match(bodyOf(store, "export async function claimRunTransition("), /rpc\("phx_claim_automated_payroll_run_transition"/);
  assert.match(bodyOf(store, "export async function releaseRunTransition("), /\.eq\("transition_token", token\)/, "a release lets go only of its own claim");

  // ==== 46: Part 2 asks about people who vanished ===================================================
  const diff: PopulationDiff = {
    currentHeadcount: 2,
    previousHeadcount: 4,
    joined: [],
    left: [],
    disappeared: [
      { hrId: "B-7", fullName: "Mona Adel" },
      { hrId: "AI-0004", fullName: "Abdelrahman Alaa" },
    ],
    noBaseline: false,
  };
  const unexplained = unexplainedDisappearances(diff, [{ employeeHrIdCompact: "ai0004", excluded: true }]);
  assert.deepEqual(
    unexplained.map((person) => person.hrId),
    ["B-7"],
    "someone HR excluded with a reason is explained; only the person who vanished asks",
  );
  assert.match(
    describeUnexplainedDisappearances(unexplained),
    /^1 employee who was paid last month is missing from this run with no resignation on file: Mona Adel \(B-7\)\./,
    "the prompt names who, by name",
  );

  const confirmPart2 = bodyOf(source, "export async function confirmPart2(");
  assert.match(
    confirmPart2,
    /assertPopulationDiffAcknowledged\(\{[\s\S]*?acknowledgmentToken: options\.acknowledgePopulationDiffToken/,
    "HEADLINE: Part 2 confirm runs the population gate",
  );
  const gate = bodyOf(source, "async function assertPopulationDiffAcknowledged(");
  assert.match(
    gate,
    /requireAcknowledgment\(\{[\s\S]*?marker: POPULATION_DIFF_ACK_REQUIRED/,
    "an unacknowledged disappearance stops the confirm",
  );
  assert.match(gate, /action: "population_diff_acknowledged"/, "an acknowledged one is recorded");

  const route = readFileSync("app/api/automated-payroll/runs/[runId]/part2/confirm/route.ts", "utf8");
  assert.match(
    route,
    /acknowledgePopulationDiffToken: token\(body\.acknowledgePopulationDiffToken\)/,
    "the route passes the token through",
  );
  assert.match(route, /requiresPopulationDiffAcknowledgment: true/, "and turns the gate into a prompt, not a dead end");

  const wizard = readFileSync("src/components/automated-payroll/automated-payroll-wizard.tsx", "utf8");
  assert.match(
    wizard,
    /const acks = \{ \.\.\.part2AckTokens, \.\.\.acknowledged \};/,
    "HEADLINE: every retry sends every acknowledgement already given, so two gates can no longer loop",
  );
  assert.match(wizard, /acknowledgePopulationDiffToken: acks\.populationDiff \?\? null/, "including the new one");
  assert.match(wizard, /requiresPopulationDiffAcknowledgment/, "and the wizard prompts on it");
  assert.doesNotMatch(
    wizard,
    /confirmPart2WithOverpaidGate\([^)]*, (true|false)\)/,
    "no button may send a positional flag, which is what dropped the other acknowledgements",
  );

  // ==== An acknowledgement answers ONE attempt, and dies with it ==================================
  // Accumulating them fixed the loop and opened something worse: an acknowledgement that outlived its
  // attempt would answer a LATER, different disappearance with no prompt at all — invisible, which is
  // the exact shape of the bug finding 46 exists to catch. It dies on reload and on a failed request.
  const wizardCode = stripComments(wizard);
  assert.match(
    wizardCode,
    /setDataQuality\(null\);\s*setPart2AckTokens\(\{\}\);/,
    "HEADLINE: reloading the run forgets every acknowledgement, because the reload is what can change the answer",
  );
  assert.match(
    wizardCode,
    /catch \(actionError\) \{\s*setPart2AckTokens\(\{\}\);/,
    "HEADLINE: a dropped or non-JSON response answers nothing, so the next attempt asks every gate again",
  );

  // ==== A lost claim never says nothing happened ==================================================
  // Every transition writes something before its phase write, and publish writes REAL MONEY: salary
  // records, an approved batch, a settled ledger. Telling HR nothing happened invites the two moves
  // that make it worse — publishing again, or reopening Part 2 and releasing a debt truly collected.
  assert.match(update, /TRANSITION_CLAIM_LOST/, "a lost claim is marked, so publish can recognise it");
  assert.match(
    update,
    /Work this action had already saved may still/,
    "HEADLINE: a refused conditioned write never claims that nothing was written",
  );
  assert.match(publish, /batchAlreadyWritten = batchId;/, "publish remembers the batch it wrote before the phase write");
  assert.match(
    publish,
    /message\.includes\(TRANSITION_CLAIM_LOST\) && batchAlreadyWritten/,
    "HEADLINE: a publish that loses its claim names the live batch instead of reporting a plain conflict",
  );
  assert.match(
    publish,
    /salary batch \$\{batchAlreadyWritten\} is approved and/,
    "and names it, because someone has to reconcile the run against its batch by hand",
  );
}
