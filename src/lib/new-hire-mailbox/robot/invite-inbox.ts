/**
 * Adopting the INVITE INBOX — the one mailbox Phoenix reads rather than hands to a person.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS. Turbify's create hands back no password: it makes the mailbox `Pending` and
 * emails a `Temp Password:` line (`./invitation.ts`). So the robot can only finish a mailbox it
 * created if it can READ the inbox that invitation went to — and that inbox is
 * `hr.mailbox@satopharma.com`, which Phoenix owns for this and nothing else.
 *
 * Reading it needs a credential in the mailbox monitor, because that is where
 * `@/lib/mailbox-monitor/imap-client` takes its connection from. `addMonitor` both PROVES the
 * credential works (`testMailboxConnection`) and stores it, and its `employeeHrId` is optional — so
 * a mailbox belonging to no employee is a shape it already supports. Nothing new stores a secret.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 THE ONE SAFETY PROPERTY: THIS CAN ONLY EVER TOUCH THE INVITE INBOX.
 *
 * The chain it runs is a password RESET, and the same chain pointed at an employee's address locks
 * that employee out of their mail with nobody told — the failure `adopt-runner.ts` reports as
 * `locked_out`. So the address is not a parameter the caller chooses: it is compared against
 * `TURBIFY_INVITE_RECIPIENT` by identity and refused otherwise. There is deliberately no option, no
 * override and no "force" — a flow that can reset any mailbox is a different, far more dangerous
 * feature than this one, and it would arrive by someone adding exactly that parameter.
 *
 * 🔴 AND IT IS NOT ON A SCHEDULE. Like adoption (`adopt.ts`), the only caller is a Super-Admin
 * route. The invite inbox needs adopting ONCE; a sweep that re-ran it would reset the inbox the
 * robot is mid-way through reading, and rotate a credential the monitor had just proved.
 */

import { TURBIFY_INVITE_RECIPIENT } from "./initial-password";

/** The mailbox this flow may act on, and the only one. Stated once, from the invite recipient. */
export const INVITE_INBOX_ADDRESS = TURBIFY_INVITE_RECIPIENT;

/** A label for the monitor row, so a human reading that list knows what the mailbox is for. */
export const INVITE_INBOX_LABEL = "Invite inbox — new hire mailbox robot" as const;

export type InviteInboxRefusal =
  | "not_the_invite_inbox"
  | "no_company_password"
  | "no_invite_inbox_configured";

export type InviteInboxVerdict =
  | { address: string; allowed: true }
  | { allowed: false; detail: string; refusal: InviteInboxRefusal };

/**
 * May this run? Pure, so the refusals are provable without a browser or a database.
 *
 * `companyPassword` is passed only so its ABSENCE can be refused before anything is reset — the
 * value is never read here, never compared, and never returned.
 */
export function evaluateInviteInboxAdoption(
  requested: string | null | undefined,
  companyPassword: string | null | undefined,
): InviteInboxVerdict {
  const configured = String(INVITE_INBOX_ADDRESS ?? "").trim().toLowerCase();
  if (configured.length === 0) {
    return {
      allowed: false,
      detail:
        "No invite inbox is configured (TURBIFY_INVITE_RECIPIENT is empty), so there is no mailbox to "
        + "adopt. With it empty, Turbify emails each new mailbox's only credential nowhere at all.",
      refusal: "no_invite_inbox_configured",
    };
  }

  const asked = String(requested ?? "").trim().toLowerCase();
  if (asked !== configured) {
    return {
      allowed: false,
      detail:
        `This flow adopts the invite inbox only, and the invite inbox is ${configured}. It resets a `
        + "mailbox password, and the same chain pointed at an employee's address locks them out of "
        + "their mail with nobody told — so the address is compared, never chosen. Nothing was reset.",
      refusal: "not_the_invite_inbox",
    };
  }

  if (String(companyPassword ?? "").length === 0) {
    return {
      allowed: false,
      detail:
        "PHOENIX_NEW_MAILBOX_INITIAL_PASSWORD is not set, so the robot has no password to give the "
        + "invite inbox after resetting it. Nothing was reset — a reset without one leaves the "
        + "mailbox unreachable.",
      refusal: "no_company_password",
    };
  }

  return { address: configured, allowed: true };
}

/**
 * What to tell the Super Admin afterwards. Deliberately carries NO credential: the app password went
 * straight into the monitor, and the company password is the one the robot already holds.
 */
export function inviteInboxHandoverNote(address: string): string {
  return (
    `${address} is now monitored, so the robot can read the activation invitations Turbify sends `
    + "there and finish each new hire's mailbox itself. Nothing to hand to anybody — this mailbox "
    + "belongs to Phoenix, not to a person."
  );
}

export type InviteInboxResult = {
  /** The address acted on, or null when nothing was. */
  address: string | null;
  /** True once the monitor has accepted and PROVED the credential. */
  adopted: boolean;
  /** Why it did not run, when it did not. */
  detail: string | null;
  dryRun: boolean;
  refusal: InviteInboxRefusal | null;
  /** The sentence for the operator, present only on success. */
  handover: string | null;
};

export function refusedInviteInbox(verdict: InviteInboxVerdict, dryRun: boolean): InviteInboxResult {
  if (verdict.allowed) throw new Error("refusedInviteInbox called with an allowed verdict");
  return {
    address: null,
    adopted: false,
    detail: verdict.detail,
    dryRun,
    handover: null,
    refusal: verdict.refusal,
  };
}
