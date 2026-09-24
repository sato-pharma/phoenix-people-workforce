/**
 * Wiring the revocation robot to the daily sweep — what this file protects.
 *
 * The robot itself is pinned by mailbox-offboarding-robot.test.ts. This file pins the WIRING: the
 * three locks that make it safe to merge the robot into the live sweep before the console driver is
 * calibrated, proven by driving `runRobotSweepPass` with fakes so no browser and no database is
 * touched.
 *
 *   1. OFF BY DEFAULT. With no env set the pass reads nothing — it must not call the runner at all.
 *   2. DRY RUN IS THE DEFAULT ONCE ENABLED, and only the exact string "false" arms a live run. A
 *      typo, an empty value or "0" all keep it in dry run. This asymmetry is the safety and it is
 *      asserted directly.
 *   3. FAIL CLOSED. A live run builds the real driver FIRST; when that driver is uncalibrated it
 *      throws, and the pass must catch it, report it, and NEVER reach the runner — nothing touched.
 *
 * And the contract the sweep depends on: the pass NEVER throws, whatever the robot does, because its
 * outcome must not turn the sweep's dead-man's switch red.
 */

import assert from "node:assert/strict";

import {
  resolveRobotSweepConfig,
  runRobotSweepPass,
  type RobotSweepDeps,
} from "../src/lib/mailbox-offboarding/robot/sweep-hook.ts";
import type { RobotRunResult } from "../src/lib/mailbox-offboarding/robot/runner.ts";
import type { TurbifyConsoleDriver } from "../src/lib/mailbox-offboarding/robot/driver.ts";

function runResult(overrides: Partial<RobotRunResult> = {}): RobotRunResult {
  return {
    dryRun: true,
    enabled: true,
    considered: 0,
    resetDue: 0,
    deleteDue: 0,
    deferred: 0,
    awaitingGrace: 0,
    reset: 0,
    deleted: 0,
    refused: 0,
    failed: 0,
    outcomes: [],
    ...overrides,
  };
}

type SeenOptions = { enabled: boolean; dryRun: boolean; driver?: TurbifyConsoleDriver };

const neverDriver: TurbifyConsoleDriver = {
  async signIn() {},
  async resetPassword() {
    return "done";
  },
  async deleteMailbox() {
    return "done";
  },
  async close() {},
};

export async function runMailboxRobotSweepHookTests() {
  // ---- resolveRobotSweepConfig: the enable flag ----
  assert.equal(
    resolveRobotSweepConfig({}).enabled,
    false,
    "no env → disabled",
  );
  assert.equal(
    resolveRobotSweepConfig({ PHOENIX_TURBIFY_ROBOT_ENABLED: "true" }).enabled,
    true,
    'exactly "true" → enabled',
  );
  for (const value of ["false", "1", "yes", "TRUE", ""]) {
    assert.equal(
      resolveRobotSweepConfig({ PHOENIX_TURBIFY_ROBOT_ENABLED: value }).enabled,
      false,
      `"${value}" is not "true" → disabled`,
    );
  }

  // ---- resolveRobotSweepConfig: dry run defaults ON, only "false" arms a live run ----
  assert.equal(
    resolveRobotSweepConfig({}).dryRun,
    true,
    "no dry-run env → dry run (safe default)",
  );
  assert.equal(
    resolveRobotSweepConfig({ PHOENIX_TURBIFY_ROBOT_DRY_RUN: "false" }).dryRun,
    false,
    'exactly "false" → live run',
  );
  for (const value of ["true", "0", "no", "FALSE", ""]) {
    assert.equal(
      resolveRobotSweepConfig({ PHOENIX_TURBIFY_ROBOT_DRY_RUN: value }).dryRun,
      true,
      `"${value}" is not "false" → stays in dry run`,
    );
  }

  // ---- disabled: reads nothing ----
  {
    let createdDriver = false;
    let ranRobot = false;
    const deps: RobotSweepDeps = {
      resolveConfig: () => ({ enabled: false, dryRun: true }),
      createDriver: async () => {
        createdDriver = true;
        return neverDriver;
      },
      runRobot: async () => {
        ranRobot = true;
        return runResult();
      },
    };
    const report = await runRobotSweepPass(deps);
    assert.equal(report.ran, false, "disabled → did not run");
    assert.equal(report.result, null, "disabled → no result");
    assert.equal(createdDriver, false, "disabled → no driver built");
    assert.equal(ranRobot, false, "disabled → runner never called");
  }

  // ---- enabled + dry run: runner called with NO driver (it builds its own dry-run driver) ----
  {
    let createdDriver = false;
    const calls: SeenOptions[] = [];
    const deps: RobotSweepDeps = {
      resolveConfig: () => ({ enabled: true, dryRun: true }),
      createDriver: async () => {
        createdDriver = true;
        return neverDriver;
      },
      runRobot: async (options) => {
        calls.push(options);
        return runResult({ dryRun: true, considered: 13, resetDue: 5 });
      },
    };
    const report = await runRobotSweepPass(deps);
    assert.equal(report.ran, true, "dry run → ran");
    assert.equal(createdDriver, false, "dry run → does NOT build the real console driver");
    assert.equal(calls.length, 1, "dry run → runner called once");
    const opts = calls[0];
    assert.ok(opts);
    assert.equal(opts.dryRun, true, "dry run → runner told dryRun:true");
    assert.equal(opts.driver, undefined, "dry run → runner gets no driver, builds its own");
    assert.equal(report.result?.resetDue, 5, "dry run → the plan is reported back");
  }

  // ---- enabled + live: real driver built and handed to the runner ----
  {
    const calls: SeenOptions[] = [];
    const deps: RobotSweepDeps = {
      resolveConfig: () => ({ enabled: true, dryRun: false }),
      createDriver: async () => neverDriver,
      runRobot: async (options) => {
        calls.push(options);
        return runResult({ dryRun: false, reset: 5 });
      },
    };
    const report = await runRobotSweepPass(deps);
    assert.equal(report.ran, true, "live → ran");
    assert.equal(calls.length, 1, "live → runner called once");
    const opts = calls[0];
    assert.ok(opts);
    assert.equal(opts.dryRun, false, "live → runner told dryRun:false");
    assert.equal(opts.driver, neverDriver, "live → the real driver is handed to the runner");
    assert.equal(report.result?.reset, 5, "live → counts reported back");
  }

  // ---- enabled + live but the driver is uncalibrated: fail closed, runner NEVER reached ----
  {
    let ranRobot = false;
    const deps: RobotSweepDeps = {
      resolveConfig: () => ({ enabled: true, dryRun: false }),
      createDriver: async () => {
        throw new Error("The Turbify console driver has not been calibrated");
      },
      runRobot: async () => {
        ranRobot = true;
        return runResult();
      },
    };
    const report = await runRobotSweepPass(deps);
    assert.equal(report.ran, false, "uncalibrated → did not run");
    assert.match(report.error ?? "", /not been calibrated/, "uncalibrated → reports the reason");
    assert.equal(ranRobot, false, "uncalibrated → the runner is NEVER reached; no mailbox touched");
    assert.equal(report.result, null, "uncalibrated → no result");
  }

  // ---- the runner throwing is caught: the pass never throws, so the sweep switch is untouched ----
  {
    const deps: RobotSweepDeps = {
      resolveConfig: () => ({ enabled: true, dryRun: true }),
      createDriver: async () => neverDriver,
      runRobot: async () => {
        throw new Error("register read failed");
      },
    };
    const report = await runRobotSweepPass(deps);
    assert.equal(report.ran, false, "runner threw → ran:false");
    assert.match(report.error ?? "", /register read failed/, "runner threw → reason reported");
  }
}
