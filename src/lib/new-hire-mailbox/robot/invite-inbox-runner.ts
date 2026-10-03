/**
 * Running the invite-inbox adoption: reset it in the Turbify console, take an app password, and hand
 * that app password to the mailbox monitor, which proves it over IMAP before storing it.
 *
 * Kept apart from `invite-inbox.ts` for the reason every runner in this module is: the decisions
 * there are pure and provable without a browser, and this file is the only part that touches the
 * world. The step ORDER is the safety property — a reset with no password set afterwards leaves the
 * mailbox unreachable, so `evaluateInviteInboxAdoption` refuses a missing company password BEFORE
 * anything is reset rather than discovering it halfway.
 *
 * 🔴 THE MONITOR IS THE PROOF, NOT THIS FILE. `addMonitor` runs `testMailboxConnection` and refuses
 * to store a credential that cannot open the mailbox. So "adopted" here means an IMAP login actually
 * succeeded — not that a password was typed somewhere and assumed to work. That distinction is the
 * whole point: three flows in this module have already shipped reporting success over a step that
 * did nothing.
 */

import { logError, logInfo } from "@/lib/observability/log";

import type { JoinerConsoleDriver } from "./driver";
import {
  evaluateInviteInboxAdoption,
  INVITE_INBOX_LABEL,
  inviteInboxHandoverNote,
  refusedInviteInbox,
  type InviteInboxResult,
} from "./invite-inbox";
import { ROBOT_ACTOR } from "./safety";

/** Everything this runner needs from the world, so the tests can hand it fakes. */
export type InviteInboxDeps = {
  /**
   * The company password the robot gives every mailbox it provisions.
   *
   * `null` is in the type on purpose: `readCompanyInitialPassword()` returns `string | null`, and an
   * unset password is the case this flow must refuse BEFORE the reset rather than coerce into an
   * empty string somewhere downstream. The runner normalises it and
   * `evaluateInviteInboxAdoption` refuses it.
   */
  companyPassword: () => Promise<string | null> | string | null;
  /**
   * Register the mailbox with the monitor. In production this is `addMonitor`, which TESTS the
   * credential over IMAP and throws when it cannot connect — so a failure here means the mailbox is
   * reset and holding the company password, but Phoenix still cannot read it.
   */
  monitor: (input: { appPassword: string; displayLabel: string; emailAddress: string }) => Promise<unknown>;
};

export async function runInviteInboxAdoption(options: {
  /** The address the caller asked for — compared against the configured invite inbox, never trusted. */
  address: string;
  /** Omitted on a dry run. */
  driver?: JoinerConsoleDriver | null;
  dryRun: boolean;
  deps: InviteInboxDeps;
}): Promise<InviteInboxResult> {
  const { address: requested, deps, dryRun } = options;

  let companyPassword = "";
  try {
    companyPassword = String((await deps.companyPassword()) ?? "");
  } catch {
    // Treated exactly as absent: a reset must not start on a password the robot could not read.
    companyPassword = "";
  }

  const verdict = evaluateInviteInboxAdoption(requested, companyPassword);
  if (!verdict.allowed) {
    logError("Invite inbox adoption refused", {
      error: new Error(verdict.detail),
      labels: { event: "invite_inbox_adopt_refused", refusal: verdict.refusal },
    });
    return refusedInviteInbox(verdict, dryRun);
  }
  const address = verdict.address;

  if (dryRun) {
    return {
      address,
      adopted: false,
      detail:
        `Would reset ${address}, take an app password for it, and register it with the mailbox `
        + "monitor — which tests the IMAP login before storing it. Nothing was touched.",
      dryRun: true,
      handover: null,
      refusal: null,
    };
  }

  if (!options.driver) {
    return {
      address,
      adopted: false,
      detail: "A live adoption was asked for without a console driver, so nothing was reset.",
      dryRun: false,
      handover: null,
      refusal: null,
    };
  }

  await options.driver.signIn();

  // The reset is what opens the window in which an app password can be minted at all, so from here
  // on a failure leaves the mailbox reset. It belongs to Phoenix, so nobody is locked out of their
  // mail — but the detail says plainly where it stopped, because the next run has to know.
  let reset = false;
  try {
    const captured = await options.driver.resetAndCapture({ address });
    reset = true;
    await options.driver.setMailboxPassword({
      address,
      newPassword: companyPassword,
      oneTimePassword: captured.oneTimePassword,
    });
    const { appPassword } = await options.driver.generateAppPassword({ address, password: companyPassword });

    // The monitor refuses a credential it cannot connect with, so reaching the next line means an
    // IMAP login against this mailbox really succeeded.
    await deps.monitor({ appPassword, displayLabel: INVITE_INBOX_LABEL, emailAddress: address });

    logInfo("Invite inbox adopted", {
      labels: { actor: ROBOT_ACTOR, address, event: "invite_inbox_adopted" },
    });
    return {
      address,
      adopted: true,
      detail: null,
      dryRun: false,
      handover: inviteInboxHandoverNote(address),
      refusal: null,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logError("Invite inbox adoption did not finish", {
      error: error instanceof Error ? error : new Error(detail),
      labels: { address, event: "invite_inbox_adopt_failed", reset: String(reset) },
    });
    return {
      address,
      adopted: false,
      detail: reset
        ? `${address} was reset and now holds the company password, but the run did not finish, so `
          + `Phoenix still cannot read it: ${detail}`
        : `${address} was not reset: ${detail}`,
      dryRun: false,
      handover: null,
      refusal: null,
    };
  }
}
