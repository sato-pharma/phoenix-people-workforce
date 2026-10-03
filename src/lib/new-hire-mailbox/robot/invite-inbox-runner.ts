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
 *
 * 🔴 AND BECAUSE THE MONITOR IS THE PROOF, THE APP PASSWORD IS OPTIONAL **HERE AND ONLY HERE**. It
 * used to sit on the critical path, so the one step nothing had ever reached could fail an adoption
 * whose real work — reset, then set the company password — had already succeeded. Phoenix owns this
 * inbox and nobody rotates its password, so the app password's one advantage (surviving a password
 * change) buys nothing; for an EMPLOYEE's mailbox it is decisive and `runner.ts` /
 * `adopt-runner.ts` still require it. The fallback cannot fake a success, because the monitor still
 * has to log in with whatever credential it is handed.
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

  // 🔴 THE RESET CLICK HAPPENS INSIDE `resetAndCapture`, BEFORE IT RETURNS — so anything it throws
  // leaves the mailbox POSSIBLY reset, and this flag is armed BEFORE the call rather than after it.
  //
  // Armed after, it reported "was not reset" for a failure that happened while reading the dialog
  // that only exists BECAUSE Turbify had reset the mailbox. The owner was told the opposite of what
  // had happened to a live mailbox (2026-10-03). A flag that can only overstate the damage is the
  // right way round: the mailbox belongs to Phoenix, so nobody is locked out either way, and the
  // next run has to know a one-time password may be outstanding.
  let mayBeReset = false;
  try {
    mayBeReset = true;
    const captured = await options.driver.resetAndCapture({ address });
    await options.driver.setMailboxPassword({
      address,
      newPassword: companyPassword,
      oneTimePassword: captured.oneTimePassword,
    });
    // 🔴 THE APP PASSWORD IS NOT WHAT MAKES **THIS** MAILBOX READABLE, SO IT MUST NOT BE ABLE TO
    // FAIL THE ADOPTION. It sat on the critical path and it is the one step nothing in Phoenix has
    // ever reached, so every failure of it reported "MAY ALREADY HAVE BEEN RESET" and sent the owner
    // back to click again — on a mailbox that was by then reset and already holding the company
    // password Phoenix had set correctly one step earlier.
    //
    // The ONE thing an app password buys over the mailbox password is that it SURVIVES a later
    // password change. For an EMPLOYEE's mailbox that is decisive — they change the password at
    // handover and Phoenix loses access — which is why `runner.ts` and `adopt-runner.ts` still
    // REQUIRE it. For THIS mailbox it buys nothing: Phoenix owns `TURBIFY_INVITE_RECIPIENT`, no
    // employee ever signs into it, and nobody is going to rotate its password out from under us.
    //
    // 🔴 And the fallback cannot INVENT a success, which is what makes it safe rather than merely
    // convenient: `addMonitor` runs `testMailboxConnection` and refuses a credential it cannot log
    // in with (422, nothing stored). So whichever credential is passed below, `adopted: true` still
    // means a real IMAP login against this mailbox succeeded. If the company password is refused
    // too, the monitor throws and the catch reports it — the same honest failure as before.
    let appPassword: string | null = null;
    let appPasswordRefusal: string | null = null;
    try {
      appPassword = (await options.driver.generateAppPassword({ address, password: companyPassword })).appPassword;
    } catch (error) {
      appPasswordRefusal = error instanceof Error ? error.message : String(error);
      logError("Invite inbox app password not minted — falling back to the company password", {
        error: error instanceof Error ? error : new Error(appPasswordRefusal),
        labels: { actor: ROBOT_ACTOR, address, event: "invite_inbox_app_password_failed" },
      });
    }

    // The monitor refuses a credential it cannot connect with, so reaching the next line means an
    // IMAP login against this mailbox really succeeded.
    await deps.monitor({
      appPassword: appPassword ?? companyPassword,
      displayLabel: INVITE_INBOX_LABEL,
      emailAddress: address,
    });

    logInfo("Invite inbox adopted", {
      labels: {
        actor: ROBOT_ACTOR,
        address,
        credential: appPassword ? "app_password" : "company_password",
        event: "invite_inbox_adopted",
      },
    });
    return {
      address,
      adopted: true,
      // Says WHICH credential is stored. Silence would hide that the app-password step failed, and
      // that step still matters for every EMPLOYEE mailbox even though it does not for this one.
      detail: appPasswordRefusal === null
        ? null
        : "Adopted on the company password, proven by a real IMAP login. No app password could be "
          + "minted inside the mailbox, which does not affect this inbox — Phoenix owns it and nobody "
          + `changes its password. The app-password step reported: ${appPasswordRefusal}`,
      dryRun: false,
      handover: inviteInboxHandoverNote(address),
      refusal: null,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logError("Invite inbox adoption did not finish", {
      error: error instanceof Error ? error : new Error(detail),
      labels: { address, event: "invite_inbox_adopt_failed", mayBeReset: String(mayBeReset) },
    });
    return {
      address,
      adopted: false,
      // Never claims the mailbox was untouched. The reset is clicked before the dialog is read, so a
      // failure anywhere in that step may already have rotated the password to a one-time one that
      // nothing captured — and saying "was not reset" sent the owner looking for the wrong problem.
      detail: mayBeReset
        ? `${address} MAY ALREADY HAVE BEEN RESET — the reset is clicked before the robot can read `
          + "the dialog, so a one-time password may be outstanding and Phoenix cannot read the "
          + `mailbox until an adoption completes. Run it again once this is fixed: ${detail}`
        : `${address} was not reset: ${detail}`,
      dryRun: false,
      handover: null,
      refusal: null,
    };
  }
}
