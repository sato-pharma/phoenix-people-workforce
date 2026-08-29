// Shared IMAP mailbox configuration parsing (pure, no I/O).
//
// Both inbound pollers in this system read their mailboxes from a single JSON-array env var —
// RECRUITMENT_EMAIL_INBOXES_JSON for CVs, SALES_EMAIL_INBOXES_JSON for distributor workbooks —
// matching this repo's existing precedent for multi-entry config-in-one-var (e.g.
// PHOENIX_RLS_TEST_USERS_JSON). The connection half of that shape is identical for both, so it is
// parsed once here and each domain layers its own fields on top.
//
// DEFENSIVE BY DESIGN, AND THAT IS THE WHOLE POINT. A missing or malformed value must never crash
// a poller: an unparseable env var means "no mailboxes are configured", which leaves intake inert.
// The alternative — throwing — turns a typo in a Railway variable into a cron job that fails every
// cycle, and a permanently red job is one nobody reads.

export type MailboxConnection = {
  label: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** The connection half of one entry, or null when a required field is missing. */
export function parseMailboxConnection(raw: unknown): { base: MailboxConnection; entry: Record<string, unknown> } | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  if (
    !isNonEmptyString(entry.label) ||
    !isNonEmptyString(entry.host) ||
    !isNonEmptyString(entry.user) ||
    !isNonEmptyString(entry.password)
  ) {
    return null;
  }
  const port = Number(entry.port);
  return {
    base: {
      host: entry.host.trim(),
      label: entry.label.trim(),
      password: entry.password,
      // 993 is IMAPS. A mailbox configured without a port is overwhelmingly a TLS one.
      port: Number.isFinite(port) && port > 0 ? port : 993,
      secure: entry.secure === undefined ? true : Boolean(entry.secure),
      user: entry.user.trim(),
    },
    entry,
  };
}

/**
 * Parses a mailbox-array env var. Never throws — invalid JSON, a non-array value, or an entry
 * missing a required field is simply dropped (and the whole result is `[]` for invalid JSON).
 *
 * `decorate` layers the calling domain's own fields onto the shared connection fields, so each
 * poller keeps its own config type without re-implementing the parsing or the defaults.
 */
export function parseMailboxesConfig<T extends MailboxConnection>(
  json: string | undefined | null,
  decorate: (base: MailboxConnection, entry: Record<string, unknown>) => T,
): T[] {
  const trimmed = (json ?? "").trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const mailboxes: T[] = [];
  for (const raw of parsed) {
    const one = parseMailboxConnection(raw);
    if (one) mailboxes.push(decorate(one.base, one.entry));
  }
  return mailboxes;
}
