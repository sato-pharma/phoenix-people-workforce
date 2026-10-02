/**
 * Wiring the new-hire mailbox robot to the daily mailbox sweep.
 *
 * WHY THE SWEEP, NOT A NEW CRON. The same reasoning as the revocation robot's hook: the sweep
 * already runs daily, already reads the mailbox registers, and a new schedule means a new
 * cron-job.org registration against a REST API that allows 100 requests a DAY. The joiner queue is
 * read in the same pass as the leaver queue.
 *
 * WHY WIRING IT IS SAFE BEFORE IT IS TRUSTED. Four independent locks stand between this call and a
 * live mailbox, and merging this wiring trips none of them:
 *
 *   1. `PHOENIX_TURBIFY_JOINER_ENABLED` — absent or anything but "true" and the robot reads nothing.
 *      That is the default, so this changes the sweep's behaviour by nothing at all until somebody
 *      sets the flag deliberately.
 *   2. Dry run is the DEFAULT once enabled. Turning the flag on runs the gates against the real
 *      register and reports the PLAN — who it would provision, who it refused and why — touching
 *      nothing. A live run needs `PHOENIX_TURBIFY_JOINER_DRY_RUN=false`, typed on purpose.
 *   3. No company password, no run: the pass refuses before launching a browser, because a run that
 *      created a mailbox and then found no password to set would leave a live account on a one-time
 *      password nobody holds.
 *   4. Even a live run cannot create anything until the console driver signs in and finds the
 *      controls it expects; an unproven wording fails closed and names itself.
 *
 * BEST-EFFORT, LIKE ITS NEIGHBOURS. This never throws. The sweep's own dead-man's switch answers
 * "is a leaver holding a live mailbox?", and a joiner robot that could not sign in is a different
 * question that must not turn that switch red. A failure is logged under its own event and returned
 * for a person to read.
 */

import { logError, logInfo } from "@/lib/observability/log";

import { runTurbifyJoinerRobot, type JoinerRunResult, type JoinerRunnerDeps } from "./runner";
import type { JoinerConsoleDriver } from "./driver";

export type JoinerSweepConfig = {
  /** The kill switch. False and the robot reads nothing. */
  enabled: boolean;
  /** True reports the plan and touches nothing. The DEFAULT once enabled. */
  dryRun: boolean;
};

/**
 * Resolve the run mode from the environment.
 *
 * `dryRun` defaults to TRUE whenever enabled, and only the exact string "false" arms a live run. A
 * typo, an empty value or a forgotten variable all keep the robot in dry run; the one value that
 * creates a mailbox has to be typed deliberately.
 */
export function resolveJoinerSweepConfig(
  env: Record<string, string | undefined> = process.env,
): JoinerSweepConfig {
  return {
    dryRun: env.PHOENIX_TURBIFY_JOINER_DRY_RUN !== "false",
    enabled: env.PHOENIX_TURBIFY_JOINER_ENABLED === "true",
  };
}

export type JoinerSweepReport = {
  /** Did the robot read the register this run? False when disabled or when it errored out. */
  ran: boolean;
  enabled: boolean;
  dryRun: boolean;
  /** Set when the pass could not run at all — sign-in failed, or the driver could not be built. */
  error: string | null;
  result: JoinerRunResult | null;
};

/** Injected so the wiring can be proven without a browser or a database. */
export type JoinerSweepDeps = {
  resolveConfig: () => JoinerSweepConfig;
  createDriver: () => Promise<JoinerConsoleDriver>;
  runnerDeps: () => JoinerRunnerDeps;
  runRobot: (options: {
    enabled: boolean;
    dryRun: boolean;
    driver?: JoinerConsoleDriver;
    deps: JoinerRunnerDeps;
  }) => Promise<JoinerRunResult>;
};

/**
 * Run one joiner pass as part of the sweep. Never throws.
 *
 * On a dry run no driver is built, so nothing is launched — the runner makes its own that touches
 * nothing. On a live run the real driver is built FIRST, and a failure there is caught and reported
 * without a row having been read.
 */
export async function runJoinerSweepPass(deps: JoinerSweepDeps): Promise<JoinerSweepReport> {
  const config = deps.resolveConfig();

  if (!config.enabled) {
    return { dryRun: config.dryRun, enabled: false, error: null, ran: false, result: null };
  }

  try {
    const driver = config.dryRun ? undefined : await deps.createDriver();
    const result = await deps.runRobot({
      deps: deps.runnerDeps(),
      driver,
      dryRun: config.dryRun,
      enabled: true,
    });

    // A pass that created anything, left a mailbox half-finished, or refused for a real reason is
    // worth a line outside the sweep response too: this is automation making live accounts.
    if (result.provisioned > 0 || result.partial > 0 || result.refused > 0 || result.failed > 0) {
      logInfo("New hire mailbox robot ran during the sweep", {
        labels: {
          dryRun: result.dryRun,
          event: "new_hire_robot_sweep",
          failed: result.failed,
          partial: result.partial,
          provisioned: result.provisioned,
          refused: result.refused,
        },
      });
    }

    return { dryRun: config.dryRun, enabled: true, error: null, ran: true, result };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logError("New hire mailbox robot pass failed during the sweep", {
      error: error instanceof Error ? error : new Error(detail),
      labels: { dryRun: config.dryRun, event: "new_hire_robot_pass_failed" },
    });
    return { dryRun: config.dryRun, enabled: true, error: detail, ran: false, result: null };
  }
}
