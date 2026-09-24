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
 * THE ORDER OF THE TWO STEPS IS LOAD-BEARING. App passwords are cleared BEFORE the password is
 * reset. Both orders close the door, but they fail differently, and only one fails safe:
 *
 *   reset → clear   : if the run dies between them, the mailbox is HALF-REVOKED — the state the
 *                     register calls its most dangerous, because it looks finished in the control
 *                     panel while every phone the leaver configured is still connected.
 *   clear → reset   : if the run dies between them, the clients are already off and only the
 *                     password is outstanding. The row stays `in_progress`, the sweep keeps
 *                     alerting, and nothing looks finished that is not.
 *
 * So the robot does the irreversible-looking one first and the cosmetic one second.
 *
 * NOTHING HERE DECIDES WHO IS A LEAVER — safety.ts does, and the database decides what `revoked`
 * means. This file drives a browser and writes what it saw.
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
import type { MailboxOffboardingTask } from "@/lib/mailbox-offboarding/types";

import { createDryRunDriver, type TurbifyConsoleDriver } from "./driver";
import {
  capForRun,
  evaluateRevocationSafety,
  ROBOT_DEFAULT_MAX_PER_RUN,
  type RobotEmployeeFacts,
  type RobotRefusal,
} from "./safety";

/**
 * The actor every robot write is recorded under.
 *
 * `system:` prefixed like the register's other automated actors (`system:resignation`,
 * `system:mailbox-sweep`), so the existing name-resolution renders it as itself rather than
 * pretending a person did it.
 */
export const ROBOT_ACTOR = "system:turbify-robot" as const;

export type RobotOutcome = {
  employeeName: string;
  workEmail: string;
  taskId: string;
  result: "revoked" | "partial" | "refused" | "failed";
  /** Present on a refusal — which gate said no. */
  refusal: RobotRefusal | null;
  detail: string;
};

export type RobotRunResult = {
  dryRun: boolean;
  enabled: boolean;
  considered: number;
  eligible: number;
  deferred: number;
  revoked: number;
  partial: number;
  refused: number;
  failed: number;
  outcomes: RobotOutcome[];
};

export type RobotRunOptions = {
  /** Injected in tests and by the dry-run path; the cron route builds the real one. */
  driver?: TurbifyConsoleDriver;
  dryRun?: boolean;
  enabled?: boolean;
  maxPerRun?: number;
  /** Injected in tests so a run is reproducible without a clock. */
  todayIso?: string;
};

/**
 * How a step is recorded. Injected so the order of the two console actions can be proven in a test
 * without a database — see tests/mailbox-offboarding-robot.test.ts, which asserts that the app
 * passwords are cleared BEFORE the password is reset.
 */
export type RobotStepRecorder = (
  taskId: string,
  step: "app_passwords_cleared" | "password_reset",
) => Promise<string>;

/**
 * Revoke ONE mailbox, console then register, in the order that fails safe.
 *
 * Extracted from the run loop so the ordering rule is testable: it is the kind of property that a
 * source-reading test cannot honestly pin, because the thing that matters is the sequence of calls
 * actually made, not the order two lines appear in.
 *
 * Throws on any failure. The caller counts it and carries on; the task stays pending and the daily
 * sweep keeps alerting on it.
 */
export async function revokeOneMailbox(input: {
  driver: TurbifyConsoleDriver;
  dryRun: boolean;
  record: RobotStepRecorder;
  task: Pick<MailboxOffboardingTask, "id" | "workEmail">;
}): Promise<string> {
  const { driver, dryRun, record, task } = input;

  // FIRST — the step that actually disconnects every configured phone and mail client. If the run
  // dies after this, the door is shut and only the password is outstanding. Doing it second would
  // leave the half-revoked state instead: looks finished, is not.
  await driver.clearAppPasswords(task.workEmail);
  if (!dryRun) await record(task.id, "app_passwords_cleared");

  await driver.resetPassword(task.workEmail);
  if (dryRun) return "revoked";
  return record(task.id, "password_reset");
}

function emptyResult(overrides: Partial<RobotRunResult>): RobotRunResult {
  return {
    dryRun: false,
    enabled: false,
    considered: 0,
    eligible: 0,
    deferred: 0,
    revoked: 0,
    partial: 0,
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

/**
 * Run one pass.
 *
 * Never throws for a single bad mailbox: one failure must not cost the rest of the run, and a
 * thrown step deliberately leaves its task pending so the daily sweep keeps alerting on it.
 */
export async function runTurbifyRevocationRobot(options: RobotRunOptions = {}): Promise<RobotRunResult> {
  const enabled = options.enabled ?? false;
  const dryRun = options.dryRun ?? false;
  const maxPerRun = options.maxPerRun ?? ROBOT_DEFAULT_MAX_PER_RUN;
  const todayIso = options.todayIso ?? currentCairoDateOnlyIso();

  if (!enabled) return emptyResult({ enabled: false, dryRun });

  const [dashboard, directoryRows] = await Promise.all([
    getMailboxOffboardingDashboardData(),
    getEmployeeDirectoryRows({ includeInactive: true }),
  ]);
  const directory = toRobotFacts(directoryRows);

  const outcomes: RobotOutcome[] = [];
  const eligible: MailboxOffboardingTask[] = [];

  for (const task of dashboard.tasks) {
    const verdict = evaluateRevocationSafety({ directory, enabled, task, todayIso });
    if (verdict.allowed) {
      eligible.push(task);
      continue;
    }
    // `already_revoked` is the overwhelming majority of the register and is not interesting — it
    // would bury the refusals a person should actually read. Counted, never listed.
    if (verdict.refusal !== "already_revoked") {
      outcomes.push({
        employeeName: task.employeeName,
        workEmail: task.workEmail,
        taskId: task.id,
        result: "refused",
        refusal: verdict.refusal,
        detail: verdict.detail,
      });
    }
  }

  const { run, deferred } = capForRun(eligible, maxPerRun);
  const driver = options.driver ?? (dryRun ? createDryRunDriver() : null);
  if (!driver) {
    throw new Error("The revocation robot was asked to run for real with no console driver.");
  }

  let revoked = 0;
  let partial = 0;
  let failed = 0;

  if (run.length > 0) {
    try {
      await driver.signIn();
    } catch (error) {
      // A failed sign-in fails the WHOLE run, loudly. The alternative — carrying on and having
      // every step quietly do nothing — would report a clean run against live mailboxes.
      await driver.close().catch(() => {});
      const detail = error instanceof Error ? error.message : String(error);
      logError("Turbify revocation robot could not sign in", {
        error: error instanceof Error ? error : new Error(detail),
        labels: { event: "turbify_robot_signin_failed" },
      });
      throw new Error(`The revocation robot could not sign in to the Turbify console: ${detail}`);
    }

    for (const task of run) {
      try {
        const status = await revokeOneMailbox({
          driver,
          dryRun,
          record: (taskId, step) => recordMailboxOffboardingStep({ taskId, step }, ROBOT_ACTOR),
          task,
        });

        // The DATABASE decides what revoked means; this only reports what it returned.
        if (status === "revoked") {
          revoked += 1;
          outcomes.push({
            employeeName: task.employeeName,
            workEmail: task.workEmail,
            taskId: task.id,
            result: "revoked",
            refusal: null,
            detail: dryRun ? "Would have been revoked." : "App passwords cleared and password reset.",
          });
        } else {
          partial += 1;
          outcomes.push({
            employeeName: task.employeeName,
            workEmail: task.workEmail,
            taskId: task.id,
            result: "partial",
            refusal: null,
            detail: `Both steps ran but the register still reads ${status}.`,
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
          labels: { event: "turbify_robot_step_failed", workEmail: task.workEmail },
        });
      }
    }

    await driver.close().catch(() => {});
  }

  return {
    dryRun,
    enabled,
    considered: dashboard.tasks.length,
    eligible: eligible.length,
    deferred: deferred.length,
    revoked,
    partial,
    refused: outcomes.filter((outcome) => outcome.result === "refused").length,
    failed,
    outcomes,
  };
}
