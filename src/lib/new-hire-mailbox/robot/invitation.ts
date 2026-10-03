/**
 * Reading Turbify's mailbox-activation invitation. Pure: no I/O, no browser, no network, so every
 * rule here runs for real in tests/new-hire-mailbox-invitation.test.ts.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 WHY THIS EXISTS, and why it is the whole provisioning flow rather than a detail.
 *
 * Turbify's CREATE does not hand back a password. It makes the mailbox `Pending` and emails an
 * invitation — measured on production 2026-10-03, after a create that produced no
 * "One-time password" dialog and no `print` control anywhere on the post-save view. The robot was
 * built expecting that dialog (which belongs only to the RESET path), so every mailbox it created
 * was stranded `Pending` with no password, and the sweep reported `provisioned: 0` while real
 * mailboxes existed.
 *
 * The invitation itself carries the credential, in plain text. Read from the real message
 * (`no-reply@turbify.com`, 2026-10-03 10:56 Cairo):
 *
 *     Subject: An administrator for [satopharma.com] has invited you to activate
 *              [hr.mailbox@satopharma.com]
 *
 *     Username: hr.mailbox@satopharma.com
 *     Temp Password: <15 characters>
 *     Activate your account <https://mail.turbify.com/login?>
 *
 * So the chain closes without a human: the robot addresses the invitation to a mailbox Phoenix can
 * read, reads the temp password out of it, activates, sets the company password, and takes the app
 * password in that same window.
 *
 * 🔴 THE ADDRESS IS MATCHED BY IDENTITY, NEVER BY `includes`. One invite inbox receives the
 * invitations for EVERY new hire, so "the newest Turbify email" is the wrong message as soon as two
 * are provisioned in one sweep — and a substring test is worse than wrong here, because
 * `adel.sayed@satopharma.com` contains `el.sayed@satopharma.com`. That exact pair already cost this
 * robot a wrongly-refused new hire and nearly a reset of a working employee's mailbox (#5223). An
 * invitation matched that way would hand back a temp password that opens somebody else's mailbox.
 *
 * 🔴 AND A TEMP PASSWORD IS NEVER PUT IN A MESSAGE, A LOG OR AN ERROR. The refusals below name the
 * address and what was missing, never what was found. `redactLabel` in `@/lib/turbify/control-report`
 * is the second line of defence for page reads; this module's first line is simply never returning
 * the value except through `InvitationCredentials`, which only the driver consumes.
 */

/** Turbify's own sender for an activation invitation. Confirmed on the live message. */
export const INVITATION_SENDER = "no-reply@turbify.com" as const;

/** Where the invitation says to activate. The query string carries nothing; the login form does. */
export const INVITATION_ACTIVATION_URL = "https://mail.turbify.com/login" as const;

/** The label the temp password sits behind, as Turbify writes it. */
const TEMP_PASSWORD_LABEL = "Temp Password";

/** What a usable invitation yields. Never logged, never stringified into a message. */
export type InvitationCredentials = {
  /** The mailbox this invitation activates, lower-cased. */
  address: string;
  /** Turbify's one-use temp password for that mailbox. */
  tempPassword: string;
};

export type InvitationReading =
  | { credentials: InvitationCredentials }
  | { refusal: string };

/** One message as the reader hands it over — only the fields this module judges. */
export type InvitationMessage = {
  body: string;
  from?: string | null;
  subject?: string | null;
};

function normalise(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Every address the subject or body claims this invitation is for.
 *
 * Turbify writes the address inside square brackets in the subject and after `Username:` in the
 * body. Both are read, because a subject line can be truncated or re-wrapped by a mail client while
 * the body survives, and the two must agree before anything is handed back.
 */
export function invitationAddresses(message: InvitationMessage): string[] {
  const found = new Set<string>();
  const pattern = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  for (const source of [message.subject ?? "", message.body ?? ""]) {
    // Bracketed first: the subject's own form, and the one that cannot pick up Turbify's own
    // no-reply address or a help link.
    for (const match of String(source).matchAll(/\[([^\]]+)\]/g)) {
      const inner = match[1].match(pattern);
      if (inner) for (const address of inner) found.add(address.toLowerCase());
    }
    for (const line of String(source).split(/\r?\n/)) {
      const labelled = line.match(/^\s*\**\s*username\s*:?\**\s*(\S+)/i);
      if (!labelled) continue;
      const address = labelled[1].match(pattern);
      if (address) found.add(address[0].toLowerCase());
    }
  }
  // Turbify's own sender address shows up in headers and footers; it is never the subject mailbox.
  found.delete(INVITATION_SENDER);
  return [...found];
}

/**
 * Read the temp password for ONE named address out of ONE message.
 *
 * `wanted` is required rather than optional on purpose: there is no "whichever mailbox this is for"
 * caller, and an optional target is how a flow ends up acting on the wrong mailbox.
 */
export function readInvitation(message: InvitationMessage, wanted: string): InvitationReading {
  const target = normalise(wanted);
  if (target.length === 0) {
    return { refusal: "No address was given, so no invitation could be matched." };
  }

  const sender = normalise(message.from);
  if (sender.length > 0 && !sender.includes(INVITATION_SENDER)) {
    // The sender is checked as a containment test ONLY because a From header is
    // `Turbify <no-reply@turbify.com>`; the ADDRESS match below is the identity test that matters.
    return {
      refusal:
        `The message offered for ${target} was not sent by ${INVITATION_SENDER}, so it is not a `
        + "Turbify invitation. Nothing was read from it.",
    };
  }

  const addresses = invitationAddresses(message);
  if (addresses.length === 0) {
    return { refusal: `No mailbox address appears in the invitation offered for ${target}.` };
  }
  if (!addresses.includes(target)) {
    return {
      refusal:
        `The invitation offered for ${target} activates ${addresses.length === 1 ? addresses[0] : addresses.join(", ")} `
        + "instead, so it belongs to a different mailbox. One invite inbox receives every new hire's "
        + "invitation, and a near-miss address is a real pair here — nothing was read from it.",
    };
  }
  if (addresses.length > 1) {
    return {
      refusal:
        `The invitation offered for ${target} names more than one mailbox (${addresses.join(", ")}), `
        + "so the robot cannot tell which one its temp password opens. Nothing was read from it.",
    };
  }

  const temp = readTempPassword(message.body);
  if (!temp) {
    return {
      refusal:
        `The invitation for ${target} carries no "${TEMP_PASSWORD_LABEL}" line, so there is no `
        + "credential in it. Turbify's wording may have changed — read the message and re-calibrate "
        + "rather than guessing at another label.",
    };
  }
  return { credentials: { address: target, tempPassword: temp } };
}

/**
 * Pull the value out of the `Temp Password:` line.
 *
 * Exported for its own test, and deliberately strict: it takes one whitespace-delimited token on
 * that line and nothing else. A looser read (the rest of the line, or the next non-empty line) would
 * pick up the asterisks and soft wrapping Turbify's HTML-to-text conversion leaves behind, and a
 * password with a stray `*` on the end fails a login with no indication of why.
 */
export function readTempPassword(body: string | null | undefined): string | null {
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const match = line.match(/^\s*\**\s*temp\s*password\s*:?\**\s*(\S+)\s*$/i);
    if (!match) continue;
    const value = match[1].replace(/^\**|\**$/g, "");
    if (value.length > 0) return value;
  }
  return null;
}

/**
 * Of the messages the inbox returned, the newest invitation that activates THIS address.
 *
 * The caller hands them over newest-first; this walks them in that order and takes the first whose
 * address matches exactly. A mailbox re-invited after a failed activation therefore gets its latest
 * temp password rather than a spent one — Turbify's are one-use.
 */
export function pickInvitation(
  messages: readonly InvitationMessage[] | null | undefined,
  wanted: string,
): InvitationReading {
  if (!Array.isArray(messages)) {
    return {
      refusal:
        `Could not read the invite inbox for ${normalise(wanted)}, so the robot cannot tell whether an `
        + "invitation arrived. It stopped rather than treat an unreadable inbox as an empty one.",
    };
  }
  const refusals: string[] = [];
  for (const message of messages) {
    const reading = readInvitation(message, wanted);
    if ("credentials" in reading) return reading;
    refusals.push(reading.refusal);
  }
  if (refusals.length === 0) {
    return {
      refusal:
        `No invitation for ${normalise(wanted)} has arrived in the invite inbox yet. Turbify sends it `
        + "on creation, so this is normally a timing matter — the next pass will find it.",
    };
  }
  return {
    refusal:
      `None of the ${refusals.length} message(s) in the invite inbox is an invitation for `
      + `${normalise(wanted)}. The closest reason: ${refusals[0]}`,
  };
}
