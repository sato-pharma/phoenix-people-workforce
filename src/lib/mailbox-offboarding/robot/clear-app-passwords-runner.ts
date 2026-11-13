/**
 * One pass that clears named leavers' app passwords.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 NOT ON THE SWEEP, AND IT MUST NOT BE PUT ON ONE. This disconnects the mail client on a phone,
 * so it runs only on addresses somebody names — same shape, and the same reason, as mailbox
 * adoption. The leaver register's own sweep resets passwords; this is the step that finishes the
 * job, and it finishes it only when a human asks for a named mailbox.
 *
 * 🔴 IT REFUSES BEFORE IT TOUCHES A BROWSER while the list-and-delete controls are uncalibrated.
 * `appPasswordClearCalibrationRefusal()` is read FIRST, for the whole pass, so an uncalibrated build
 * cannot reset anybody's password on the way to a step it was never going to be able to finish.
 * That ordering is the difference between "nothing happened" and "every named leaver's password was
 * reset for nothing".
 *
 * 🔴 A FAILURE AFTER THE RESET IS SAFE, UNLIKE ADOPTION. An adopted employee is locked out of a
 * mailbox they use; a leaver who ends up reset-but-not-cleared is in exactly the half-revoked state
 * they were already in. So this pass does NOT stop early — it carries on to the next person and
 * reports each one. What it must never do is record `app_passwords_cleared_at` for a mailbox whose
 * app passwords are still there, because that turns a real hole into one the register says is shut.
 */

import { logError, logInfo } from "@/lib/observability/log";

import {
  APP_PASSWORD_CLEAR_STEP_ORDER,
  appPasswordClearCalibrationRefusal,
  appPasswordClearNote,
  evaluateAppPasswordClear,
  throwawayPassword,
  type AppPasswordClearCandidate,
  type AppPasswordClearRefusal,
} from "./clear-app-passwords";

/** The actor written on the register row, so an attestation is never anonymous. */
export const APP_PASSWORD_CLEAR_ACTOR = "system:turbify-app-password-robot";

export type AppPasswordClearOutcome = {
  hrId: string;
  displayName: string;
  address: string;
  status: "cleared" | "reset_only" | "refused" | "failed";
  refusal?: AppPasswordClearRefusal;
  detail?: string;
  /** How many app passwords were removed. Only meaningful on `cleared`. */
  removed?: number;
  /** Set on `cleared`: what the owner is told. */
  note?: string;
};

export type AppPasswordClearResult = {
  dryRun: boolean;
  considered: number;
  cleared: number;
  /** Reset but the app passwords are still there — still half-revoked, and must be said so. */
  resetOnly: number;
  refused: number;
  failed: number;
  /** Set when the pass refused before touching anything. */
  blocked: string | null;
  outcomes: AppPasswordClearOutcome[];
};

/**
 * The console steps, done by signing in AS the mailbox.
 *
 * Narrow on purpose: this is not the admin driver. `clearAppPasswords` returns how many it removed,
 * and must only return once it has positively observed that none are left — a count it cannot prove
 * is a failure, not a success.
 */
export type AppPasswordClearDriver = {
  signIn(): Promise<void>;
  resetAndCapture(input: { address: string }): Promise<{ address: string; oneTimePassword: string }>;
  setMailboxPassword(input: { address: string; newPassword: string; oneTimePassword: string }): Promise<unknown>;
  clearAppPasswords(input: { address: string; password: string }): Promise<{ removed: number }>;
  close(): Promise<void>;
};

export type AppPasswordClearDeps = {
  loadCandidates: (named: readonly string[]) => Promise<readonly AppPasswordClearCandidate[]>;
  /** Today in Cairo, `YYYY-MM-DD`. */
  today: () => string;
  /** Write `app_passwords_cleared_at` / `_by` on the register row. */
  recordCleared: (input: { hrId: string; address: string; actor: string; removed: number }) => Promise<void>;
};

function empty(dryRun: boolean, blocked: string | null = null): AppPasswordClearResult {
  return { blocked, cleared: 0, considered: 0, dryRun, failed: 0, outcomes: [], refused: 0, resetOnly: 0 };
}

/** A driver that walks the steps and touches nothing, for a dry run. */
export function createDryRunAppPasswordClearDriver(): AppPasswordClearDriver {
  return {
    async signIn() {},
    async resetAndCapture({ address }) { return { address, oneTimePassword: "dry-run" }; },
    async setMailboxPassword() { return "dry-run"; },
    async clearAppPasswords() { return { removed: 0 }; },
    async close() {},
  };
}

export async function runAppPasswordClear(options: {
  named: readonly string[];
  dryRun: boolean;
  driver?: AppPasswordClearDriver;
  deps: AppPasswordClearDeps;
  /** The calibration refusal to obey. Left out — every caller — it is read live; tests hold the uncalibrated case. */
  calibrationRefusal?: string | null;
}): Promise<AppPasswordClearResult> {
  const { deps, dryRun, named } = options;

  if (named.length === 0) {
    return empty(dryRun, "No addresses were named, so nothing was cleared. This never acts on a queue.");
  }

  // 🔴 FIRST, for the whole pass. An uncalibrated build must not reset a single password.
  const calibration = options.calibrationRefusal !== undefined ? options.calibrationRefusal : appPasswordClearCalibrationRefusal();
  if (calibration && !dryRun) {
    logError("App password clearing refused the whole pass", {
      error: new Error(calibration),
      labels: { event: "mailbox_app_password_clear_blocked" },
    });
    return empty(dryRun, calibration);
  }

  const candidates = await deps.loadCandidates(named);
  const today = deps.today();
  const result = empty(dryRun);
  result.considered = candidates.length;

  const queue: Array<{ candidate: AppPasswordClearCandidate; address: string }> = [];
  for (const candidate of candidates) {
    const verdict = evaluateAppPasswordClear(candidate, today);
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

  const driver = dryRun ? createDryRunAppPasswordClearDriver() : options.driver;
  if (!driver) {
    result.blocked = "A live pass was asked for without a console driver, so nothing was touched.";
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
        // Held in a local and nowhere else: never sealed, never logged, never returned.
        // A live credential: throwawayPassword draws every character from the crypto source.
        const password = throwawayPassword();
        await driver.setMailboxPassword({ address, newPassword: password, oneTimePassword: captured.oneTimePassword });
        const { removed } = await driver.clearAppPasswords({ address, password });

        if (!dryRun) {
          await deps.recordCleared({ actor: APP_PASSWORD_CLEAR_ACTOR, address, hrId, removed });
        }
        result.cleared += 1;
        result.outcomes.push({
          address,
          displayName,
          hrId,
          note: appPasswordClearNote(displayName, address, removed),
          removed,
          status: "cleared",
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (reset) {
          // Safe but NOT done. The mailbox is where it already was: half-revoked.
          result.resetOnly += 1;
          result.outcomes.push({
            address,
            detail: `The password was reset but the app passwords are still there, so ${displayName}'s phone and Outlook still sync: ${detail}`,
            displayName,
            hrId,
            status: "reset_only",
          });
        } else {
          result.failed += 1;
          result.outcomes.push({ address, detail, displayName, hrId, status: "failed" });
        }
        logError("Clearing a leaver's app passwords did not finish", {
          error: error instanceof Error ? error : new Error(detail),
          labels: { address, event: "mailbox_app_password_clear_failed", hrId, reset: String(reset) },
        });
      }
    }
  } finally {
    await driver.close().catch(() => {});
  }

  if (result.cleared > 0 || result.resetOnly > 0) {
    logInfo("App password clearing ran", {
      labels: { cleared: result.cleared, dryRun, event: "mailbox_app_password_clear_run", resetOnly: result.resetOnly },
    });
  }
  return result;
}

export { APP_PASSWORD_CLEAR_STEP_ORDER };
