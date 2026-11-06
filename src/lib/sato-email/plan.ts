import crypto from "crypto";

/**
 * The pure half of a Sato composer send: who it reaches, and how it is cut into emails.
 *
 * Resend refuses a message carrying more than 50 recipients, and every send also picks up the
 * neutral To that `fanoutToBcc` leaves behind (and, until 2026-11-06, the standing admin Bcc) — so
 * anything under ~48 clears the provider.
 *
 * 25 is the figure because it is what the rest of this system ALREADY enforces on a hand-written
 * email: validateManualEmailRecipientPolicy caps a manual send at PHOENIX_HR_EMAIL_MAX_RECIPIENTS,
 * default 25. Cutting a list into emails of 25 means every email this composer sends passes that
 * existing check unchanged. The alternative was raising the cap for this screen, which would have
 * raised it for the older HR reply composer too — nobody asked to widen that one.
 */
export const SATO_EMAIL_MAX_PER_EMAIL = 25;

export type SatoEmailRecipient = {
  email: string;
  hrId: string | null;
  name: string;
};

export type SatoEmailSendPlan = {
  recipients: SatoEmailRecipient[];
  batches: string[][];
};

export function buildSatoEmailSendPlan(
  recipients: readonly SatoEmailRecipient[],
  maxPerEmail: number = SATO_EMAIL_MAX_PER_EMAIL,
): SatoEmailSendPlan {
  const seen = new Set<string>();
  const unique: SatoEmailRecipient[] = [];
  for (const recipient of recipients) {
    const email = recipient.email.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    unique.push({ ...recipient, email });
  }

  const size = Math.max(1, Math.floor(maxPerEmail));
  const batches: string[][] = [];
  for (let index = 0; index < unique.length; index += size) {
    batches.push(unique.slice(index, index + size).map((recipient) => recipient.email));
  }
  return { batches, recipients: unique };
}

/**
 * Bracketed gaps a template leaves for the sender, like "[Date]". Reported before sending rather
 * than blocked: a genuine square bracket in a message is rare but legal.
 */
export function findUnfilledPlaceholders(...texts: string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(/\[[^\[\]\n]{2,40}\]/g)) found.add(match[0]);
  }
  return Array.from(found);
}

/** One key per email in a send, so a double-click re-sends nothing while a new send always goes. */
export function buildSatoEmailIdempotencyKey(input: {
  /**
   * What is clipped to the mail, in the key as well as the body.
   *
   * A send that failed at the provider, had a file removed and was pressed again is a DIFFERENT
   * email. Without this the two would hash the same whenever the wording was untouched, and the
   * provider would dedupe the corrected one away.
   */
  attachmentIds: readonly string[];
  batch: readonly string[];
  batchIndex: number;
  clientRequestId: string;
  html: string;
  /**
   * Which composer this send came from, so one screen's key never reads as another's at the provider.
   *
   * Defaults to the Sato composer, the only caller that existed when this was written. The CEO
   * composer passes its own. It is a LABEL and not a collision guard: the hashed payload already
   * differs between the two, because a different letterhead gives a different `html`.
   */
  scope?: string;
  senderId: string;
  subject: string;
}): string {
  const scope = input.scope?.trim() || "sato-email";
  const hash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        attachmentIds: [...input.attachmentIds].sort(),
        batch: [...input.batch].sort(),
        batchIndex: input.batchIndex,
        clientRequestId: input.clientRequestId,
        html: input.html,
        senderId: input.senderId,
        subject: input.subject,
      }),
    )
    .digest("hex");
  return `${scope}-${hash}`;
}
