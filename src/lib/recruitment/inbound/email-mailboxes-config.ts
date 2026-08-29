// Recruitment / ATS — inbound-CV mailbox configuration (pure, no I/O).
//
// RECRUITMENT_EMAIL_INBOXES_JSON is a JSON array so multiple mailboxes (careers@, hr@) share one
// env var, matching this repo's existing precedent for multi-entry config-in-one-var (e.g.
// PHOENIX_RLS_TEST_USERS_JSON). Defensive by design: a missing or malformed value must never
// crash the poller — it just means no mailboxes are configured yet.
//
// The connection fields (label/host/port/secure/user/password) and their defaults are parsed by
// the shared `@/lib/email-intake/mailbox-config`, which the sales mailbox intake uses too. Only
// `cvGate` is recruitment's own, and it is layered on below.

import { parseMailboxesConfig } from "@/lib/email-intake/mailbox-config";
import { parseInboxCvGate, resolveInboxCvGate, type InboxCvGate } from "@/lib/recruitment/inbound/inbox-cv-gate";

export type RecruitmentMailboxConfig = {
  label: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  // How strictly this mailbox may turn an attachment into a candidate — see inbox-cv-gate.ts.
  // Optional in the JSON: absent means "decide from the label", which is right for both live
  // mailboxes and needs no env change to take effect.
  cvGate: InboxCvGate;
};

/**
 * Parses RECRUITMENT_EMAIL_INBOXES_JSON. Never throws — invalid JSON, a non-array value, or an
 * entry missing a required field is simply dropped (and the whole result is `[]` for invalid
 * JSON), so a misconfigured env var disables email intake instead of crashing the cron job.
 */
export function parseRecruitmentEmailInboxesConfig(json: string | undefined | null): RecruitmentMailboxConfig[] {
  return parseMailboxesConfig<RecruitmentMailboxConfig>(json, (base, entry) => ({
    ...base,
    cvGate: resolveInboxCvGate(base.label, parseInboxCvGate(entry.cvGate)),
  }));
}

export function loadConfiguredMailboxes(): RecruitmentMailboxConfig[] {
  return parseRecruitmentEmailInboxesConfig(process.env.RECRUITMENT_EMAIL_INBOXES_JSON);
}

/**
 * The gate for the mailbox an inbound message arrived through, by label.
 *
 * A label that no longer matches any configured mailbox still resolves — from the label alone —
 * rather than falling back to permissive. A mailbox can be renamed or removed while its messages
 * are still sitting in the durable intake queue, and the safe reading of "I no longer recognise
 * this inbox" is not "let everything through".
 */
export function inboxCvGate(mailboxLabel: string | null | undefined): InboxCvGate {
  const label = (mailboxLabel ?? "").trim();
  const configured = label
    ? loadConfiguredMailboxes().find((mailbox) => mailbox.label.toLowerCase() === label.toLowerCase())
    : undefined;
  return configured ? configured.cvGate : resolveInboxCvGate(mailboxLabel);
}
