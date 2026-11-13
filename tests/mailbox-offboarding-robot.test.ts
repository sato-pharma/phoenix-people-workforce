/**
 * The Turbify revocation robot — what this file protects.
 *
 * A robot with a Turbify admin session can reset the password of any of the company's mailboxes and,
 * after a grace period, DELETE it. A delete is permanent — Turbify offers no restore and this
 * company keeps no mail backup — and the victim of a mistake is an employee who arrives at work to
 * find their mailbox gone. There is no API to undo it and no observation to catch it: the register
 * would simply record a successful revocation.
 *
 * So the gates in safety.ts are not defensive polish — they are the feature. Each one below
 * corresponds to a way this system is already known to produce a wrong answer:
 *
 *   - `last_working_date` is a COPY of one typed date, so a typo puts a working employee in the
 *     queue with a date in the past. Pinned by the too-recent and reversed-resignation cases.
 *   - A resigned person's address is legitimately REUSED for a new hire, so a leaver's task can
 *     name an address a working employee reads today. Pinned by the recycled-address case, which
 *     is the single most important assertion in this file — and which is RE-RUN for the delete
 *     phase, because the recycle can happen in the 30 days between the reset and the delete.
 *
 * THE TWO PHASES are pinned here too: reset now, delete only after the grace AND only on a mailbox
 * the robot itself reset. `decideRobotAction` chooses; `performRobotAction` carries it out against a
 * recording driver, so which console method runs for which action is proven by driving it, not read
 * from the source.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import {
  capForRun,
  decideRobotAction,
  evaluateRevocationSafety,
  ROBOT_ACTOR,
  ROBOT_MIN_DAYS_BEFORE_DELETE,
  ROBOT_MIN_DAYS_OVERDUE,
  wholeDaysBetween,
  type RobotEmployeeFacts,
} from "../src/lib/mailbox-offboarding/robot/safety.ts";
import { performRobotAction } from "../src/lib/mailbox-offboarding/robot/runner.ts";
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
    appPasswordsMayBeLive: true,
    isForwardingExpired: false,
    canRecordDisposition: true,
    ...overrides,
  };
}

/** A task the robot has already reset, waiting on the delete grace. The delete-phase starting point. */
function resetByRobot(overrides: Partial<MailboxOffboardingTask> = {}): MailboxOffboardingTask {
  return task({
    status: "in_progress",
    passwordResetAt: "2026-08-15T09:00:00Z", // 40 days before TODAY — past the 30-day grace
    passwordResetBy: ROBOT_ACTOR,
    passwordResetByName: "Turbify revocation robot",
    ...overrides,
  });
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

function decide(input: {
  directory?: RobotEmployeeFacts[];
  enabled?: boolean;
  task?: MailboxOffboardingTask;
  minDaysBeforeDelete?: number;
}) {
  return decideRobotAction(
    {
      directory: input.directory ?? [person()],
      enabled: input.enabled ?? true,
      task: input.task ?? task(),
      todayIso: TODAY,
    },
    { minDaysBeforeDelete: input.minDaysBeforeDelete },
  );
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
    async deleteMailbox(address: string) {
      calls.push(`deleteMailbox:${address}`);
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
  assert.ok(ROBOT_MIN_DAYS_BEFORE_DELETE >= 1, "there is always a grace window before a delete");

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

  // ══ THE TWO-PHASE DECISION ═════════════════════════════════════════════════════════════════

  // Phase 1 — a fresh, safe leaver whose password has never been reset: RESET is due.
  {
    const decision = decide({});
    assert.equal(decision.action, "reset", "an un-reset, overdue leaver is reset first");
  }

  // Phase 2 — the robot reset it 40 days ago, past the grace, still a leaver: DELETE is due.
  {
    const decision = decide({ task: resetByRobot() });
    assert.equal(decision.action, "delete", "a robot-reset mailbox past the grace is deleted");
  }

  // Within the grace window, a robot-reset mailbox waits — quietly, not as an alarm.
  {
    const decision = decide({ task: resetByRobot({ passwordResetAt: "2026-09-20T09:00:00Z" }) });
    assert.equal(decision.action, null, "5 days after the reset is still inside the 30-day grace");
    assert.equal(decision.action === null && decision.refusal, "awaiting_delete_grace");
  }

  // A mailbox a PERSON reset is never auto-deleted by the robot — the human owns its disposition.
  {
    const decision = decide({
      task: resetByRobot({ passwordResetBy: "B-10", passwordResetByName: "Omar Gawish" }),
    });
    assert.equal(decision.action, null, "the robot never completes a pipeline a person started");
    assert.equal(decision.action === null && decision.refusal, "reset_not_by_robot");
  }

  // 🔴 THE DELETE PHASE RE-RUNS EVERY BASE GATE. In the 40 days since the reset, the address was
  // recycled to a new hire. The robot must NOT delete the mailbox out from under them — G7 fires
  // exactly as it does for a reset, and this is the assertion that proves the delete is gated.
  {
    const decision = decide({
      task: resetByRobot(),
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
    assert.equal(decision.action, null, "a recycled address is never DELETED, just as it is never reset");
    assert.equal(decision.action === null && decision.refusal, "address_belongs_to_an_active_employee");
  }

  // A reversed resignation stops the delete phase too — the base gate runs first.
  {
    const decision = decide({
      task: resetByRobot(),
      directory: [person({ employmentStatus: "active", isActive: true })],
    });
    assert.equal(decision.action, null, "a returned employee's mailbox is never deleted");
    assert.equal(decision.action === null && decision.refusal, "employee_not_a_leaver");
  }

  // The grace is configurable per run — a longer window pushes a due delete back to waiting.
  {
    const decision = decide({ task: resetByRobot(), minDaysBeforeDelete: 90 });
    assert.equal(decision.action, null, "raising the grace to 90 days defers a 40-day-old reset");
    assert.equal(decision.action === null && decision.refusal, "awaiting_delete_grace");
  }

  // ══ PERFORMING ONE ACTION — proven by driving a recording driver ═══════════════════════════

  // A reset drives resetPassword and records password_reset. The mailbox is NOT yet revoked.
  {
    const driver = recordingDriver();
    const recorded: Array<[string, string]> = [];
    const status = await performRobotAction({
      driver,
      action: "reset",
      dryRun: false,
      record: async (taskId, action) => {
        recorded.push([taskId, action]);
        return "in_progress";
      },
      task: { id: "task-1", workEmail: "gehad.ahmed@satopharma.com" },
    });
    assert.deepEqual(driver.calls, ["resetPassword:gehad.ahmed@satopharma.com"], "a reset resets only");
    assert.deepEqual(recorded, [["task-1", "reset"]], "the reset is recorded as itself");
    assert.equal(status, "in_progress", "a reset alone never reads as revoked");
  }

  // A delete drives deleteMailbox and records the delete; the register returns revoked.
  {
    const driver = recordingDriver();
    const recorded: Array<[string, string]> = [];
    const status = await performRobotAction({
      driver,
      action: "delete",
      dryRun: false,
      record: async (taskId, action) => {
        recorded.push([taskId, action]);
        return "revoked";
      },
      task: { id: "task-1", workEmail: "gehad.ahmed@satopharma.com" },
    });
    assert.deepEqual(driver.calls, ["deleteMailbox:gehad.ahmed@satopharma.com"], "a delete deletes only");
    assert.deepEqual(recorded, [["task-1", "delete"]], "the delete is recorded as itself");
    assert.equal(status, "revoked", "the status returned is the database's, never the robot's own");
  }

  // A dry run drives the console path but records NOTHING and reports what it would have produced.
  {
    for (const action of ["reset", "delete"] as const) {
      const driver = recordingDriver();
      const recorded: string[] = [];
      const status = await performRobotAction({
        driver,
        action,
        dryRun: true,
        record: async (_taskId, step) => {
          recorded.push(step);
          return "revoked";
        },
        task: { id: "task-1", workEmail: "gehad.ahmed@satopharma.com" },
      });
      assert.deepEqual(recorded, [], `a dry-run ${action} records nothing at all`);
      assert.equal(status, action === "reset" ? "in_progress" : "revoked");
    }
  }

  // A console failure records NOTHING — a recorded step that never happened is exactly the false
  // evidence this register exists to prevent.
  {
    const driver = recordingDriver();
    driver.deleteMailbox = async () => {
      throw new Error("Turbify did not confirm the deletion.");
    };
    const recorded: string[] = [];
    await assert.rejects(
      performRobotAction({
        driver,
        action: "delete",
        dryRun: false,
        record: async (_taskId, step) => {
          recorded.push(step);
          return "revoked";
        },
        task: { id: "task-1", workEmail: "gehad.ahmed@satopharma.com" },
      }),
      /did not confirm/,
    );
    assert.deepEqual(recorded, [], "a failed console action records no attestation");
  }

  // ONE VOCABULARY FOR "DOES THIS DIALOG NAME THIS MAILBOX?"
  //
  // The leaver driver carried its own copy of the tokenisation, and the copy carried the same defect
  // as the original: it lowercased the dialog's text before splitting, so the glue `textContent`
  // leaves between an address and the next label (`…satopharma.comOne-time password:`) could never be
  // broken and no token ever equalled the address. On the joiner that refused a reset Turbify had
  // already performed, and told the owner the dialog belonged to a different mailbox. The leaver path
  // would have failed identically on its first live reset, which nobody had run yet. Two copies is
  // how one fix lands on one path and silently leaves the other broken.
  {
    const source = stripComments(
      readFileSync(
        new URL(
          "src/lib/mailbox-offboarding/robot/turbify-console.ts",
          new URL("../", import.meta.url),
        ),
        "utf8",
      ),
    );
    assert.ok(
      source.includes("dialogNamesAddress("),
      "the leaver driver must decide which mailbox the one-time-password dialog names with the "
      + "shared dialogNamesAddress, never its own comparison",
    );
    assert.equal(
      /tokens\s*=\s*new Set\(/.test(source),
      false,
      "the leaver driver must not re-implement the dialog tokenisation",
    );
    // 🔴 AND THE SAME PATTERN AGAIN, FOUND 2026-10-03: this driver launched with NO viewport, so
    // puppeteer's default 800x600 applied — the exact condition under which Turbify's fixed cookie
    // banner covered the console's row actions and the JOINER's clicks landed on the banner and
    // reported success (`click-delivery.ts`, incident one). Here the click it would swallow is
    // **Reset password**, on a real employee's live mailbox, on a path nobody has run yet.
    assert.ok(
      source.includes("CONSOLE_VIEWPORT"),
      "the leaver driver must set an explicit viewport — at puppeteer's default 800x600 the cookie "
      + "banner covers the console's row actions and a blind click reports success",
    );
  }
}
