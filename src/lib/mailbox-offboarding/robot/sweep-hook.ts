/**
 * Wiring the Turbify revocation robot to the daily mailbox-offboarding sweep.
 *
 * WHY THE SWEEP, NOT A NEW CRON. The sweep already runs daily (cron-job.org `8350624`, 08:15 Cairo),
 * already reads the register, and its whole reason to exist is the leaver who can still read company
 * mail. The robot acts on exactly those rows. Hanging it here rather than on its own schedule is the
 * same choice the sweep already made for the departed-access sweep and the personal-mailbox purge:
 * a new job means a new cron-job.org registration, and that REST API allows 100 requests a DAY.
 *
 * WHY WIRING IT IS SAFE BEFORE IT IS CALIBRATED. Three independent locks stand between this call and
 * a live mailbox, and this module trips over none of them:
 *
 *   1. `PHOENIX_TURBIFY_ROBOT_ENABLED` — absent or anything but "true" and the robot does not read a
 *      single row. This is the default, so merging this wiring changes the sweep's behaviour by
 *      nothing at all until someone sets the flag on purpose.
 *   2. Dry run is the DEFAULT once enabled. Turning the enable flag on runs the gates against the
 *      real register and reports the PLAN — what it would reset, what it refused and why — while
 *      touching nothing. A live run must be asked for explicitly with
 *      `PHOENIX_TURBIFY_ROBOT_DRY_RUN=false`; the enable flag alone can never delete a mailbox.
 *   3. Even a live run cannot proceed until the console driver is calibrated:
 *      `createTurbifyConsoleDriver()` throws `TurbifyConsoleNotCalibratedError` while the selectors
 *      are placeholders. This module catches that, logs it, and reports it — a premature live
 *      enablement fails closed and loud, having touched nothing.
 *
 * BEST-EFFORT, LIKE ITS NEIGHBOURS. This never throws. The sweep's dead-man's switch answers one
 * question — "is a leaver holding a live mailbox?" — and a robot that could not sign in is a
 * different question that must not turn that switch red. A robot failure is logged under its own
 * event and returned in the response for a person to read; it does not fail the sweep.
 */

import { logError, logInfo } from "@/lib/observability/log";

import { createTurbifyConsoleDriver } from "./turbify-console";
import { runTurbifyRevocationRobot, type RobotRunResult } from "./runner";
import type { TurbifyConsoleDriver } from "./driver";

/** What the sweep decided to do with the robot this run, before it read anything. */
export type RobotSweepConfig = {
  /** The kill switch. False and the robot reads nothing. */
  enabled: boolean;
  /**
   * True and the run reports its plan without touching a mailbox. The DEFAULT once enabled — a live
   * run is opt-in via `PHOENIX_TURBIFY_ROBOT_DRY_RUN=false`, so enabling alone is always harmless.
   */
  dryRun: boolean;
};

/**
 * Resolve the robot's run mode from the environment.
 *
 * `dryRun` defaults to TRUE whenever enabled, and only the exact string "false" arms a live run.
 * That asymmetry is the safety: a typo, an empty value or a forgotten variable all keep the robot in
 * dry run, and the one value that touches a mailbox has to be typed deliberately.
 */
export function resolveRobotSweepConfig(
  env: Record<string, string | undefined> = process.env,
): RobotSweepConfig {
  const enabled = env.PHOENIX_TURBIFY_ROBOT_ENABLED === "true";
  const dryRun = env.PHOENIX_TURBIFY_ROBOT_DRY_RUN !== "false";
  return { enabled, dryRun };
}

/** A compact, JSON-safe account of the robot pass, added to the sweep response. */
export type RobotSweepReport = {
  /** Did the robot actually read the register this run? False when disabled or when it errored out. */
  ran: boolean;
  enabled: boolean;
  dryRun: boolean;
  /** Set when the pass could not run — e.g. the driver is not yet calibrated, or sign-in failed. */
  error: string | null;
  /** The run's counts, when it ran. Null when disabled or errored before the run. */
  result: RobotRunResult | null;
};

/**
 * Injected so the hook can be proven without a browser or a database. The sweep passes nothing and
 * gets the real robot; the test passes fakes and asserts on the wiring — which config produces which
 * call — without ever reaching Supabase or Turbify.
 */
export type RobotSweepDeps = {
  resolveConfig: () => RobotSweepConfig;
  createDriver: () => Promise<TurbifyConsoleDriver>;
  runRobot: (options: {
    enabled: boolean;
    dryRun: boolean;
    driver?: TurbifyConsoleDriver;
  }) => Promise<RobotRunResult>;
};

const defaultDeps: RobotSweepDeps = {
  resolveConfig: () => resolveRobotSweepConfig(),
  createDriver: createTurbifyConsoleDriver,
  runRobot: runTurbifyRevocationRobot,
};

/**
 * Run one robot pass as part of the sweep. Never throws.
 *
 * On a dry run the driver is left undefined and the runner builds its own dry-run driver, so nothing
 * is launched. On a live run the real console driver is built first — and if it is not calibrated,
 * that build throws here, is caught, and the pass reports the reason without having touched anything.
 */
export async function runRobotSweepPass(
  deps: RobotSweepDeps = defaultDeps,
): Promise<RobotSweepReport> {
  const config = deps.resolveConfig();

  if (!config.enabled) {
    return { ran: false, enabled: false, dryRun: config.dryRun, error: null, result: null };
  }

  try {
    // Live run: build the real driver first. An uncalibrated driver throws here, before any row is
    // read — the fail-closed path. Dry run never builds a driver; the runner makes its own.
    const driver = config.dryRun ? undefined : await deps.createDriver();

    const result = await deps.runRobot({ enabled: true, dryRun: config.dryRun, driver });

    // A run that reset or deleted anything, or refused for a real reason, is worth a line in the log
    // even on success — this is automation acting on live mailboxes and the record should be legible
    // outside the sweep response too.
    if (result.reset > 0 || result.deleted > 0 || result.refused > 0 || result.failed > 0) {
      logInfo("Turbify revocation robot ran during the sweep", {
        labels: {
          event: "turbify_robot_run",
          dryRun: result.dryRun,
          reset: result.reset,
          deleted: result.deleted,
          refused: result.refused,
          failed: result.failed,
          deferred: result.deferred,
        },
      });
    }

    return {
      ran: true,
      enabled: true,
      dryRun: config.dryRun,
      error: null,
      result,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logError("Turbify revocation robot pass failed during the sweep", {
      labels: { event: "turbify_robot_pass_failed", dryRun: config.dryRun },
      error: error instanceof Error ? error : new Error(detail),
    });
    return { ran: false, enabled: true, dryRun: config.dryRun, error: detail, result: null };
  }
}
