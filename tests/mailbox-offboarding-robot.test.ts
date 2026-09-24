/**
 * The Turbify revocation robot — what this file protects.
 *
 * A robot with a Turbify admin session can reset the password of any of the company's 173
 * mailboxes. Nothing about that is reversible from Phoenix, nothing in the Turbify console asks
 * "are you sure about this person", and the victim of a mistake is an employee who arrives at work
 * unable to read their email. There is no API to undo it and no observation to catch it: the
 * register would simply record a successful revocation.
 *
 * So the gates in safety.ts are not defensive polish — they are the feature. Each one below
 * corresponds to a way this system is already known to produce a wrong answer:
 *
 *   - `last_working_date` is a COPY of one typed date, so a typo puts a working employee in the
 *     queue with a date in the past. Pinned by the too-recent and reversed-resignation cases.
 *   - A resigned person's address is legitimately REUSED for a new hire, so a leaver's task can
 *     name an address a working employee reads today. Pinned by the recycled-address case, which
 *     is the single most important assertion in this file.
 *
 * AND THE ORDER OF THE TWO CONSOLE STEPS IS PINNED HERE TOO, with a fake driver that records the
 * calls it received. App passwords must be cleared BEFORE the password is reset: a run that dies
 * between them then leaves the door shut with the password outstanding, rather than the
 * half-revoked state that looks finished in the control panel while every phone the leaver
 * configured is still connected. That property is a SEQUENCE OF CALLS, which no source-reading
 * assertion can honestly pin, so it is proven by driving it.
 */

import assert from "node:assert/strict";

import {
  capForRun,
  evaluateRevocationSafety,
  ROBOT_MIN_DAYS_OVERDUE,
  wholeDaysBetween,
  type RobotEmployeeFacts,
} from "../src/lib/mailbox-offboarding/robot/safety.ts";
import { revokeOneMailbox } from "../src/lib/mailbox-offboarding/robot/runner.ts";
import type { TurbifyConsoleDriver } from "../src/lib/mailbox-offboarding/robot/driver.ts";
import type { MailboxOffboardingTask } from "../src/lib/mailbox-offboarding/types.ts";

const TODAY = "2026-09-24";

/** A leaver whose mailbox is genuinely safe to revoke. Each case below breaks exactly one thing. */
function task(overrides: Partial<MailboxOffboardingTask> = {}): MailboxOffboardingTask {
  return {
    id: "task-1",
    employeeHrId: "B-99",
    employeeName: "Gehad Ahmed Mohamed Khalifa",
    workEmail: "gehad.ahmed@satopharma.com",
    jobTitle: "Medical Rep",
    lastWorkingDate: "2026-08-31",
    status: "pending",
    passwordResetAt: null,
    passwordResetBy: null,
    passwordResetByName: null,
    appPasswordsClearedAt: null,
    appPasswordsClearedBy: null,
    appPasswordsClearedByName: null,
    disposition: null,
    dispositionAt: null,
    dispositionBy: null,
    dispositionByName: null,
    forwardingTo: null,
    forwardingExpiresOn: null,
    reason: null,
    note: null,
    source: "resignation",
    openedAt: "2026-09-01T06:00:00Z",
    openedBy: "system:resignation",
    revokedAt: null,
    isOverdue: true,
    daysOverdue: 24,
    isHalfRevoked: false,
    isForwardingExpired: false,
    canRecordDisposition: true,
    ...overrides,
  };
}

function person(overrides: Partial<RobotEmployeeFacts> = {}): RobotEmployeeFacts {
  return {
    hrId: "B-99",
    displayName: "Gehad Ahmed",
    employmentStatus: "resigned",
    workEmail: "gehad.ahmed@satopharma.com",
    isActive: false,
    ...overrides,
  };
}

function verdict(input: {
  directory?: RobotEmployeeFacts[];
  enabled?: boolean;
  task?: MailboxOffboardingTask;
}) {
  return evaluateRevocationSafety({
    directory: input.directory ?? [person()],
    enabled: input.enabled ?? true,
    task: input.task ?? task(),
    todayIso: TODAY,
  });
}

/** Records the calls it received, in order, and touches nothing. */
function recordingDriver(): TurbifyConsoleDriver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async signIn() {
      calls.push("signIn");
    },
    async resetPassword(address: string) {
      calls.push(`resetPassword:${address}`);
      return "done";
    },
    async clearAppPasswords(address: string) {
      calls.push(`clearAppPasswords:${address}`);
      return "done";
    },
    async close() {
      calls.push("close");
    },
  };
}

export async function runMailboxOffboardingRobotTests() {
  // ── The happy path, so every refusal below is known to be caused by the one thing it breaks ──
  {
    const result = verdict({});
    assert.equal(result.allowed, true, "a genuine leaver 24 days past their last working day is revocable");
  }

  // ── G1 — the kill switch ───────────────────────────────────────────────────────────────────
  {
    const result = verdict({ enabled: false });
    assert.equal(result.allowed, false);
    assert.equal(result.allowed === false && result.refusal, "robot_disabled");
  }

  // ── G7 — THE ONE THAT MATTERS MOST ─────────────────────────────────────────────────────────
  // A resigned person's address is reused for a new hire. The leaver's task still names it, the
  // leaver is still resigned, the date is still long past — every other gate passes. Only this one
  // stands between the robot and locking a working employee out of their email.
  {
    const result = verdict({
      directory: [
        person(),
        person({
          hrId: "B-120",
          displayName: "Nour Ahmed",
          employmentStatus: "active",
          isActive: true,
          workEmail: "gehad.ahmed@satopharma.com",
        }),
      ],
    });
    assert.equal(result.allowed, false, "an address a working employee holds is never revoked");
    assert.equal(result.allowed === false && result.refusal, "address_belongs_to_an_active_employee");
    assert.match(
      result.allowed === false ? result.detail : "",
      /Nour Ahmed/,
      "the refusal names the person it protected, so a reader can act on it",
    );
  }

  // THE CASE ONLY G7 CAN CATCH, and the reason it is not redundant with G8.
  //
  // When someone leaves, their work email is often blanked on the employee record before the
  // address is handed to a new hire. The address then appears on exactly ONE record — the working
  // employee's — so the "more than one holder" gate sees nothing wrong and passes. Only the active
  // holder check stands between the robot and that person's mailbox.
  //
  // Discovered by breaking G7 and watching which assertion fired: the two-holder case above went
  // red on G8 instead, which meant it was not proving G7 at all.
  {
    const result = verdict({
      directory: [
        person({ workEmail: null }),
        person({
          hrId: "B-120",
          displayName: "Nour Ahmed",
          employmentStatus: "active",
          isActive: true,
          workEmail: "gehad.ahmed@satopharma.com",
        }),
      ],
    });
    assert.equal(
      result.allowed,
      false,
      "a recycled address with a SINGLE active holder is refused — G8 cannot see this one",
    );
    assert.equal(result.allowed === false && result.refusal, "address_belongs_to_an_active_employee");
  }

  // The leaver holding their OWN address is the normal case and must not trip G7.
  {
    const result = verdict({ directory: [person({ isActive: false })] });
    assert.equal(result.allowed, true, "the leaver's own address must not read as another holder's");
  }

  // ── G5 — the live status, not the task's snapshot ──────────────────────────────────────────
  // A reversed resignation. The task row still says leaver; the employee master is the truth.
  {
    const result = verdict({ directory: [person({ employmentStatus: "active", isActive: true })] });
    assert.equal(result.allowed, false, "a reversed resignation is refused");
    assert.equal(result.allowed === false && result.refusal, "employee_not_a_leaver");
  }

  // A NULL status must refuse too — it normalises to active, which is the safe direction.
  {
    const result = verdict({ directory: [person({ employmentStatus: null, isActive: true })] });
    assert.equal(result.allowed, false, "an unknown status is never treated as a leaver");
  }

  // ── G6 — the date, with a margin ───────────────────────────────────────────────────────────
  {
    const result = verdict({ task: task({ lastWorkingDate: TODAY }) });
    assert.equal(result.allowed, false, "a same-day last working date is the shape a typo makes");
    assert.equal(result.allowed === false && result.refusal, "too_recent");
  }
  {
    const result = verdict({ task: task({ lastWorkingDate: "2026-12-31" }) });
    assert.equal(result.allowed, false, "a future last working date is refused");
  }
  {
    const result = verdict({ task: task({ lastWorkingDate: null }) });
    assert.equal(result.allowed === false && result.refusal, "no_last_working_date");
  }

  // ── G3 — the address must be one Turbify hosts for this company ────────────────────────────
  {
    const result = verdict({
      directory: [person({ workEmail: "gehad@gmail.com" })],
      task: task({ workEmail: "gehad@gmail.com" }),
    });
    assert.equal(result.allowed, false, "the robot is never pointed at a non-company address");
    assert.equal(result.allowed === false && result.refusal, "not_a_company_address");
  }

  // ── G2 — a closed row is never re-acted on ─────────────────────────────────────────────────
  for (const status of ["revoked", "not_applicable"] as const) {
    const result = verdict({ task: task({ status }) });
    assert.equal(result.allowed, false, `a ${status} row is left alone`);
    assert.equal(result.allowed === false && result.refusal, "already_revoked");
  }

  // ── G4 — a task whose person is gone is a question, not an action ──────────────────────────
  {
    const result = verdict({ directory: [] });
    assert.equal(result.allowed === false && result.refusal, "employee_not_found");
  }

  // ── The date arithmetic the margin rests on ────────────────────────────────────────────────
  assert.equal(wholeDaysBetween("2026-08-31", "2026-09-24"), 24);
  assert.equal(wholeDaysBetween("2026-09-24", "2026-09-24"), 0);
  assert.equal(wholeDaysBetween("2026-09-25", "2026-09-24"), -1, "a future date is negative, never 0");
  assert.ok(ROBOT_MIN_DAYS_OVERDUE >= 1, "the margin is never zero — that is what a typo looks like");

  // ── The per-run cap ────────────────────────────────────────────────────────────────────────
  {
    const { run, deferred } = capForRun([1, 2, 3, 4, 5, 6, 7], 5);
    assert.equal(run.length, 5, "a run touches at most the cap");
    assert.equal(deferred.length, 2, "the rest are deferred, never dropped");
  }
  {
    const { run, deferred } = capForRun([1, 2, 3], 0);
    assert.equal(run.length, 0, "a cap of zero touches nothing");
    assert.equal(deferred.length, 3);
  }

  // ── THE ORDER OF THE TWO CONSOLE STEPS ─────────────────────────────────────────────────────
  // Proven by driving it, because the property is the sequence of calls actually made.
  {
    const driver = recordingDriver();
    const recorded: string[] = [];
    const status = await revokeOneMailbox({
      driver,
      dryRun: false,
      record: async (taskId, step) => {
        recorded.push(step);
        return step === "password_reset" ? "revoked" : "in_progress";
      },
      task: { id: "task-1", workEmail: "gehad.ahmed@satopharma.com" },
    });

    assert.deepEqual(
      driver.calls,
      ["clearAppPasswords:gehad.ahmed@satopharma.com", "resetPassword:gehad.ahmed@satopharma.com"],
      "app passwords are cleared BEFORE the password is reset — the order that fails safe",
    );
    assert.deepEqual(
      recorded,
      ["app_passwords_cleared", "password_reset"],
      "each console action is recorded immediately after it happened, in the same order",
    );
    assert.equal(status, "revoked", "the status returned is the database's, never the robot's own");
  }

  // A dry run drives the console's read path but writes NOTHING to the register.
  {
    const driver = recordingDriver();
    const recorded: string[] = [];
    const status = await revokeOneMailbox({
      driver,
      dryRun: true,
      record: async (_taskId, step) => {
        recorded.push(step);
        return "revoked";
      },
      task: { id: "task-1", workEmail: "gehad.ahmed@satopharma.com" },
    });
    assert.deepEqual(recorded, [], "a dry run records nothing at all");
    assert.equal(status, "revoked");
  }

  // A console failure on the FIRST step must not record anything — a recorded clearing that never
  // happened is exactly the false evidence this register exists to prevent.
  {
    const driver = recordingDriver();
    driver.clearAppPasswords = async () => {
      throw new Error("Turbify did not confirm the clearing.");
    };
    const recorded: string[] = [];
    await assert.rejects(
      revokeOneMailbox({
        driver,
        dryRun: false,
        record: async (_taskId, step) => {
          recorded.push(step);
          return "in_progress";
        },
        task: { id: "task-1", workEmail: "gehad.ahmed@satopharma.com" },
      }),
      /did not confirm/,
    );
    assert.deepEqual(recorded, [], "a failed console step records no attestation");
  }

  // And a failure on the SECOND step leaves the first one recorded — which is correct, because it
  // really did happen, and the register will read the row as in_progress rather than revoked.
  {
    const driver = recordingDriver();
    driver.resetPassword = async () => {
      throw new Error("Turbify did not confirm the reset.");
    };
    const recorded: string[] = [];
    await assert.rejects(
      revokeOneMailbox({
        driver,
        dryRun: false,
        record: async (_taskId, step) => {
          recorded.push(step);
          return "in_progress";
        },
        task: { id: "task-1", workEmail: "gehad.ahmed@satopharma.com" },
      }),
      /did not confirm/,
    );
    assert.deepEqual(
      recorded,
      ["app_passwords_cleared"],
      "the step that really happened stays recorded; the row is in_progress, never revoked",
    );
  }
}
