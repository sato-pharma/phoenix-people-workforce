/**
 * The Turbify revocation robot — the run itself.
 *
 * WHAT THIS CHANGES ABOUT THE REGISTER. Every row in `mailbox_offboarding_tasks` until now has been
 * an ATTESTATION: a named admin said they reset a password, and the actor columns exist so that
 * "said" stays visible. A robot row is the first OBSERVATION in this table — the console was driven
 * and it confirmed. That is a stronger claim, so it is recorded under its own actor
 * (`system:turbify-robot`) and never blended with a person's. A reader can always tell which kind
 * of evidence a row holds.
 *
 * TWO PHASES, ONE PER TASK PER RUN. The owner's rule is "reset now, delete after N days":
 *
 *   RESET  — done as soon as a leaver is overdue. Blocks web login and any new device immediately.
 *            Reversible, so it is the safe thing to do the moment someone leaves. The row goes to
 *            `in_progress`; the daily sweep keeps alerting, because a reset alone is NOT the closed
 *            door (Yahoo app passwords on already-configured phones survive it).
 *   DELETE — done only after the grace period, and ONLY on a mailbox the robot itself reset. This
 *            is the one that finally reaches `revoked`, because the console cannot clear app
 *            passwords — deletion is the only admin action that truly ends the mailbox. Permanent.
 *
 * WHICH PHASE A TASK IS IN is decided entirely by safety.ts (`decideRobotAction`), re-reading the
 * live employee master every run. This file drives a browser and writes what it saw; it decides
 * nothing about who is a leaver or when the grace is up.
 */

import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import {
  getEmployeeDirectoryRows,
  isActiveLifecycleStatus,
} from "@/lib/employees/employee-directory";
import { logError } from "@/lib/observability/log";
import {
  getMailboxOffboardingDashboardData,
  recordMailboxOffboardingStep,
} from "@/lib/mailbox-offboarding/service";
import type { MailboxOffboardingTask, MailboxTaskStatus } from "@/lib/mailbox-offboarding/types";

import { createDryRunDriver, type TurbifyConsoleDriver } from "./driver";
import {
  capForRun,
  decideRobotAction,
  ROBOT_ACTOR,
  ROBOT_DEFAULT_MAX_DELETES_PER_RUN,
  ROBOT_DEFAULT_MAX_PER_RUN,
  ROBOT_MIN_DAYS_BEFORE_DELETE,
  type RobotAction,
  type RobotEmployeeFacts,
  type RobotRefusal,
} from "./safety";

// Re-exported for the cron route and older imports; the constant now lives in the pure safety
// module because two gates there depend on it.
export { ROBOT_ACTOR } from "./safety";

/** The note stamped on the disposition row so a reader knows the delete was automated. */
const ROBOT_DELETE_NOTE = "Deleted by the Turbify revocation robot after the grace period." as const;

export type RobotOutcome = {
  employeeName: string;
  workEmail: string;
  taskId: string;
  result: "reset" | "deleted" | "refused" | "failed";
  /** Present on a refusal — which gate said no. */
  refusal: RobotRefusal | null;
  detail: string;
};

export type RobotRunResult = {
  dryRun: boolean;
  enabled: boolean;
  considered: number;
  /** Tasks eligible for a reset this run, before the per-run cap. */
  resetDue: number;
  /** Tasks eligible for a delete this run, before the (stricter) per-run cap. */
  deleteDue: number;
  /** Eligible tasks the per-run caps held back — picked up next run. */
  deferred: number;
  /** Reset by the robot, grace not yet elapsed. A quiet, expected state; counted for visibility. */
  awaitingGrace: number;
  /** Resets actually performed. */
  reset: number;
  /** Deletes actually performed. */
  deleted: number;
  /** Real blocks a person should read (excludes the quiet skips). */
  refused: number;
  failed: number;
  outcomes: RobotOutcome[];
};

export type RobotRunOptions = {
  /** Injected in tests and by the dry-run path; the cron route builds the real one. */
  driver?: TurbifyConsoleDriver;
  dryRun?: boolean;
  enabled?: boolean;
  /** Cap on resets per run. */
  maxPerRun?: number;
  /** Cap on deletes per run — stricter, because a delete is permanent. */
  maxDeletesPerRun?: number;
  /** Days after the robot's reset before it deletes. */
  minDaysBeforeDelete?: number;
  /** Injected in tests so a run is reproducible without a clock. */
  todayIso?: string;
};

/**
 * How a step is recorded, given the action. Injected so the run's decisions can be proven in a test
 * without a database — see tests/mailbox-offboarding-robot.test.ts.
 */
export type RobotStepRecorder = (taskId: string, action: RobotAction) => Promise<MailboxTaskStatus>;

/**
 * Perform ONE action on ONE mailbox — console first, register second — and return the register's
 * resulting status.
 *
 * Extracted from the run loop so it is testable against a recording driver: the thing that matters
 * is which console method was actually called for which action, not the order two lines appear in.
 *
 * Throws on any failure. The caller counts it and carries on; the task stays where it is and the
 * daily sweep keeps alerting on it. On a dry run it returns the status the action WOULD produce
 * without recording anything.
 */
export async function performRobotAction(input: {
  driver: TurbifyConsoleDriver;
  action: RobotAction;
  dryRun: boolean;
  record: RobotStepRecorder;
  task: Pick<MailboxOffboardingTask, "id" | "workEmail">;
}): Promise<MailboxTaskStatus> {
  const { driver, action, dryRun, record, task } = input;

  if (action === "reset") {
    await driver.resetPassword(task.workEmail);
    if (dryRun) return "in_progress";
    return record(task.id, "reset");
  }

  // action === "delete" — the permanent one. The console confirms inside the driver before it
  // resolves; if it did not, the driver throws and we never reach the record call.
  await driver.deleteMailbox(task.workEmail);
  if (dryRun) return "revoked";
  return record(task.id, "delete");
}

function emptyResult(overrides: Partial<RobotRunResult>): RobotRunResult {
  return {
    dryRun: false,
    enabled: false,
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

/** The live facts the gates need, shaped from the directory. */
export function toRobotFacts(
  rows: Array<{
    hrId: string;
    displayName: string;
    fullName: string;
    employmentStatus: string | null;
    workEmail: string | null;
  }>,
): RobotEmployeeFacts[] {
  return rows.map((row) => ({
    hrId: row.hrId,
    displayName: row.displayName || row.fullName,
    employmentStatus: row.employmentStatus,
    workEmail: row.workEmail,
    // A NULL status normalises to "active" here, which is the safe direction: an unknown person
    // counts as a live holder of their address and therefore BLOCKS a revocation rather than
    // allowing one.
    isActive: isActiveLifecycleStatus(row.employmentStatus),
  }));
}

/** Record a step for the given action under the robot actor. */
function recordForAction(taskId: string, action: RobotAction): Promise<MailboxTaskStatus> {
  if (action === "reset") {
    return recordMailboxOffboardingStep({ taskId, step: "password_reset" }, ROBOT_ACTOR);
  }
  return recordMailboxOffboardingStep(
    { taskId, step: "disposition", disposition: "deleted", note: ROBOT_DELETE_NOTE },
    ROBOT_ACTOR,
  );
}

/**
 * Run one pass.
 *
 * Never throws for a single bad mailbox: one failure must not cost the rest of the run, and a
 * thrown action deliberately leaves its task where it is so the daily sweep keeps alerting on it.
 */
export async function runTurbifyRevocationRobot(options: RobotRunOptions = {}): Promise<RobotRunResult> {
  const enabled = options.enabled ?? false;
  const dryRun = options.dryRun ?? false;
  const maxPerRun = options.maxPerRun ?? ROBOT_DEFAULT_MAX_PER_RUN;
  const maxDeletesPerRun = options.maxDeletesPerRun ?? ROBOT_DEFAULT_MAX_DELETES_PER_RUN;
  const minDaysBeforeDelete = options.minDaysBeforeDelete ?? ROBOT_MIN_DAYS_BEFORE_DELETE;
  const todayIso = options.todayIso ?? currentCairoDateOnlyIso();

  if (!enabled) return emptyResult({ enabled: false, dryRun });

  const [dashboard, directoryRows] = await Promise.all([
    getMailboxOffboardingDashboardData(),
    getEmployeeDirectoryRows({ includeInactive: true }),
  ]);
  const directory = toRobotFacts(directoryRows);

  const outcomes: RobotOutcome[] = [];
  const resetQueue: MailboxOffboardingTask[] = [];
  const deleteQueue: MailboxOffboardingTask[] = [];
  let awaitingGrace = 0;

  for (const task of dashboard.tasks) {
    const decision = decideRobotAction({ directory, enabled, task, todayIso }, { minDaysBeforeDelete });
    if (decision.action === "reset") {
      resetQueue.push(task);
      continue;
    }
    if (decision.action === "delete") {
      deleteQueue.push(task);
      continue;
    }

    // A null action carries a reason. Three of them are expected, quiet states — the register is
    // mostly `already_revoked`, and `reset_not_by_robot` / `awaiting_delete_grace` are the normal
    // waiting states of the two-phase model. Listing them would bury the refusals worth reading.
    if (decision.refusal === "awaiting_delete_grace") {
      awaitingGrace += 1;
      continue;
    }
    if (decision.refusal === "already_revoked" || decision.refusal === "reset_not_by_robot") {
      continue;
    }
    outcomes.push({
      employeeName: task.employeeName,
      workEmail: task.workEmail,
      taskId: task.id,
      result: "refused",
      refusal: decision.refusal,
      detail: decision.detail,
    });
  }

  const { run: resetRun, deferred: resetDeferred } = capForRun(resetQueue, maxPerRun);
  const { run: deleteRun, deferred: deleteDeferred } = capForRun(deleteQueue, maxDeletesPerRun);
  const plan: Array<{ action: RobotAction; task: MailboxOffboardingTask }> = [
    // Resets first: cheap and reversible, so a sign-in that survives long enough to do them buys the
    // most safety per action before the run reaches anything permanent.
    ...resetRun.map((task) => ({ action: "reset" as const, task })),
    ...deleteRun.map((task) => ({ action: "delete" as const, task })),
  ];

  const driver = options.driver ?? (dryRun ? createDryRunDriver() : null);
  if (!driver) {
    throw new Error("The revocation robot was asked to run for real with no console driver.");
  }

  let reset = 0;
  let deleted = 0;
  let failed = 0;

  if (plan.length > 0) {
    try {
      await driver.signIn();
    } catch (error) {
      // A failed sign-in fails the WHOLE run, loudly. The alternative — carrying on and having
      // every action quietly do nothing — would report a clean run against live mailboxes.
      await driver.close().catch(() => {});
      const detail = error instanceof Error ? error.message : String(error);
      logError("Turbify revocation robot could not sign in", {
        error: error instanceof Error ? error : new Error(detail),
        labels: { event: "turbify_robot_signin_failed" },
      });
      throw new Error(`The revocation robot could not sign in to the Turbify console: ${detail}`);
    }

    for (const { action, task } of plan) {
      try {
        const status = await performRobotAction({
          driver,
          action,
          dryRun,
          record: recordForAction,
          task,
        });

        if (action === "reset") {
          reset += 1;
          outcomes.push({
            employeeName: task.employeeName,
            workEmail: task.workEmail,
            taskId: task.id,
            result: "reset",
            refusal: null,
            detail: dryRun
              ? "Would reset the password."
              : `Password reset; web login and new devices blocked. Register reads ${status}.`,
          });
          continue;
        }

        // A delete must reach `revoked`; anything else means the console did not confirm what we
        // asked, and that is a failure to look at, never a quiet success.
        if (status === "revoked") {
          deleted += 1;
          outcomes.push({
            employeeName: task.employeeName,
            workEmail: task.workEmail,
            taskId: task.id,
            result: "deleted",
            refusal: null,
            detail: dryRun ? "Would delete the mailbox." : "Mailbox deleted.",
          });
        } else {
          failed += 1;
          outcomes.push({
            employeeName: task.employeeName,
            workEmail: task.workEmail,
            taskId: task.id,
            result: "failed",
            refusal: null,
            detail: `Delete ran but the register still reads ${status}.`,
          });
        }
      } catch (error) {
        failed += 1;
        const detail = error instanceof Error ? error.message : String(error);
        outcomes.push({
          employeeName: task.employeeName,
          workEmail: task.workEmail,
          taskId: task.id,
          result: "failed",
          refusal: null,
          detail,
        });
        logError("Turbify revocation robot failed on one mailbox", {
          error: error instanceof Error ? error : new Error(detail),
          labels: { event: "turbify_robot_step_failed", action, workEmail: task.workEmail },
        });
      }
    }

    await driver.close().catch(() => {});
  }

  return {
    dryRun,
    enabled,
    considered: dashboard.tasks.length,
    resetDue: resetQueue.length,
    deleteDue: deleteQueue.length,
    deferred: resetDeferred.length + deleteDeferred.length,
    awaitingGrace,
    reset,
    deleted,
    refused: outcomes.filter((outcome) => outcome.result === "refused").length,
    failed,
    outcomes,
  };
}
