/**
 * One adoption pass: reset a named existing mailbox, then take its app password.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 THIS IS NOT ON THE SWEEP, AND MUST NOT BE PUT ON IT. A reset locks a working employee out of
 * webmail until a human hands them the new password, so adoption runs only when somebody names the
 * addresses, one by one. `runMailboxAdoption` takes that list as an argument and has no queue of its
 * own — there is nothing here that could grow into a reset nobody asked for. The joiner robot is the
 * scheduled one; this is a remediation for the five mailboxes made by hand before it existed.
 *
 * THE ORDER, and why each step is where it is:
 *
 *   1. `resetAndCapture`      — reopens the window. Phoenix holds a password again.
 *   2. `setMailboxPassword`   — the company pattern, which is what the owner hands over.
 *   3. `generateAppPassword`  — the whole point. No retry: once the employee changes their password
 *                               nobody but they can mint one.
 *
 * 🔴 AND AFTER STEP 1 THE PERSON IS ALREADY LOCKED OUT. That makes a half-finished run worse here
 * than in the create path: a new hire whose provisioning fails halfway has simply not started yet,
 * but an adopted employee whose run dies after the reset cannot read their mail and nobody has told
 * them why. So a failure after step 1 is reported as `lockedOut` — its own outcome, distinct from a
 * plain failure — carrying the exact sentence to send them, and the pass STOPS rather than walking
 * on to the next person. One locked-out employee is recoverable in a minute; five is an incident.
 */

import { logError, logInfo } from "@/lib/observability/log";

import { ADOPTION_STEP_ORDER, adoptionHandoverNote, evaluateAdoption, type AdoptionCandidate, type AdoptionRefusal } from "./adopt";
import { ROBOT_ACTOR } from "./safety";
import { createDryRunJoinerDriver, type JoinerConsoleDriver } from "./driver";
import { explainUnusableInitialPassword, isUsableInitialPassword } from "./initial-password";

export type AdoptionOutcome = {
  hrId: string;
  displayName: string;
  address: string;
  status: "adopted" | "locked_out" | "refused" | "failed";
  refusal?: AdoptionRefusal;
  detail?: string;
  /** Set on `adopted` and on `locked_out`: what the employee has to be told. */
  handover?: string;
};

export type AdoptionRunResult = {
  dryRun: boolean;
  considered: number;
  adopted: number;
  /** Reset but not finished — the person cannot read their mail and must be told NOW. */
  lockedOut: number;
  refused: number;
  failed: number;
  /** Set when the pass refused before touching anything. */
  blocked: string | null;
  /** True when the pass stopped early because somebody was left locked out. */
  stoppedEarly: boolean;
  outcomes: AdoptionOutcome[];
};

export type AdoptionDeps = {
  loadCandidates: (named: readonly string[]) => Promise<readonly AdoptionCandidate[]>;
  companyPassword: () => string | null;
  record: (input: {
    hrId: string;
    address: string;
    appPassword: string;
    initialPassword: string;
    actor: string;
  }) => Promise<void>;
};

function empty(dryRun: boolean, blocked: string | null = null): AdoptionRunResult {
  return { adopted: 0, blocked, considered: 0, dryRun, failed: 0, lockedOut: 0, outcomes: [], refused: 0, stoppedEarly: false };
}

/**
 * Adopt the named mailboxes.
 *
 * `named` is required and may not be empty: an adoption pass with nothing named is a mistake, not a
 * no-op worth running, and treating it as "adopt whatever is in the queue" is the failure this
 * whole module is shaped to prevent.
 */
export async function runMailboxAdoption(options: {
  named: readonly string[];
  dryRun: boolean;
  driver?: JoinerConsoleDriver;
  deps: AdoptionDeps;
}): Promise<AdoptionRunResult> {
  const { deps, dryRun, named } = options;

  if (named.length === 0) {
    return empty(dryRun, "No addresses were named, so no mailbox was adopted. Adoption never acts on a queue.");
  }

  const companyPassword = deps.companyPassword();
  if (!companyPassword || !isUsableInitialPassword(companyPassword)) {
    const blocked = explainUnusableInitialPassword(companyPassword)
      ?? "The company mailbox password is not usable, so no mailbox was reset.";
    logError("Mailbox adoption refused the whole pass", { error: new Error(blocked), labels: { event: "mailbox_adopt_blocked" } });
    return empty(dryRun, blocked);
  }

  const candidates = await deps.loadCandidates(named);
  const result = empty(dryRun);
  result.considered = candidates.length;

  const queue: Array<{ candidate: AdoptionCandidate; address: string }> = [];
  for (const candidate of candidates) {
    const verdict = evaluateAdoption(candidate, named);
    if (verdict.allowed) {
      queue.push({ address: verdict.address, candidate });
      continue;
    }
    result.refused += 1;
    result.outcomes.push({
      address: candidate.address,
      detail: verdict.detail,
      displayName: candidate.displayName,
      hrId: candidate.hrId,
      refusal: verdict.refusal,
      status: "refused",
    });
  }
  if (queue.length === 0) return result;

  const driver = dryRun ? createDryRunJoinerDriver() : options.driver;
  if (!driver) {
    result.blocked = "A live adoption was asked for without a console driver, so nothing was reset.";
    return result;
  }

  try {
    await driver.signIn();

    for (const { address, candidate } of queue) {
      const { displayName, hrId } = candidate;
      let reset = false;
      try {
        const captured = await driver.resetAndCapture({ address });
        reset = true;
        await driver.setMailboxPassword({ address, newPassword: companyPassword, oneTimePassword: captured.oneTimePassword });
        const { appPassword } = await driver.generateAppPassword({ address, password: companyPassword });
        if (!dryRun) {
          await deps.record({ actor: ROBOT_ACTOR, address, appPassword, hrId, initialPassword: companyPassword });
        }
        result.adopted += 1;
        result.outcomes.push({ address, displayName, handover: adoptionHandoverNote(displayName, address), hrId, status: "adopted" });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (reset) {
          // 🔴 The person is locked out RIGHT NOW and does not know it. Report it with the sentence
          // to send them, and STOP — walking on would lock out the rest for the same reason.
          result.lockedOut += 1;
          result.stoppedEarly = true;
          result.outcomes.push({
            address,
            detail: `The mailbox was reset but the run did not finish, so ${displayName} cannot read their mail until you give them the password: ${detail}`,
            displayName,
            handover: adoptionHandoverNote(displayName, address),
            hrId,
            status: "locked_out",
          });
          logError("Mailbox adoption left an employee locked out", {
            error: error instanceof Error ? error : new Error(detail),
            labels: { address, event: "mailbox_adopt_locked_out", hrId },
          });
          break;
        }
        result.failed += 1;
        result.outcomes.push({ address, detail, displayName, hrId, status: "failed" });
        logError("Mailbox adoption failed before the reset", {
          error: error instanceof Error ? error : new Error(detail),
          labels: { address, event: "mailbox_adopt_failed", hrId },
        });
      }
    }
  } finally {
    await driver.close().catch(() => {});
  }

  if (result.adopted > 0 || result.lockedOut > 0) {
    logInfo("Mailbox adoption ran", {
      labels: { adopted: result.adopted, dryRun, event: "mailbox_adopt_run", lockedOut: result.lockedOut },
    });
  }
  return result;
}

export { ADOPTION_STEP_ORDER };
