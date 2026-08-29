// Pure helpers for the mailbox monitor's connection step. No imapflow/mailparser imports here on
// purpose: the app-password normaliser and the error describer are both pure string logic, so they
// can be unit-tested without pulling a mail client (or a live socket) into the test suite.

// imapflow reports every server rejection (NO/BAD) with the generic message "Command failed" and
// puts the real detail on side fields. See node_modules/imapflow/lib/commands/login.js: a rejected
// LOGIN sets `authenticationFailed` + `serverResponseCode`, and the human-readable server text
// lands on `responseText`. A socket that never gets that far throws a Node error with a `code`.
export interface ImapErrorLike {
  authenticationFailed?: boolean;
  code?: string;
  message?: string;
  responseText?: string;
  serverResponseCode?: string;
}

// Network-level failure codes → a plain-English reason. These fire when the socket never reaches a
// working IMAP login (bad host, wrong port, firewall, DNS), as opposed to the server answering the
// LOGIN command with a rejection.
const NETWORK_ERROR_REASONS: Record<string, string> = {
  EAI_AGAIN: "the mail server host could not be resolved (temporary DNS failure)",
  ECONNREFUSED: "the mail server refused the connection (wrong host or port)",
  ECONNRESET: "the connection to the mail server was reset",
  ENOTFOUND: "the mail server host was not found (check the IMAP host)",
  ETIMEDOUT: "the connection to the mail server timed out",
};

/**
 * Yahoo/Turbify displays an app password as four space-separated blocks ("abcd efgh ijkl mnop"),
 * but the IMAP LOGIN must receive the 16 characters with no spaces. Strip ALL whitespace, not just
 * the ends, so a value pasted straight from the "Manage app passwords" screen still authenticates.
 */
export function normalizeAppPassword(raw: string): string {
  return (raw ?? "").replace(/\s+/g, "");
}

/**
 * Turn an imapflow error into a reason a human can act on, instead of the opaque "Command failed".
 * Order matters: an authentication rejection is reported as such (the common case — a bad app
 * password) before we fall back to network codes or the raw server text.
 */
export function describeImapError(error: unknown): string {
  if (!error || typeof error !== "object") return "IMAP connection failed.";
  const e = error as ImapErrorLike;

  // The server answered LOGIN with a rejection — almost always a bad/expired app password, or one
  // pasted with spaces. Yahoo/Turbify sends AUTHENTICATIONFAILED.
  if (e.authenticationFailed || e.serverResponseCode === "AUTHENTICATIONFAILED") {
    const detail = (e.responseText || "").trim();
    return detail
      ? `the mailbox rejected the app password — ${detail}`
      : "the mailbox rejected the app password (generate a fresh app password and paste it with no spaces)";
  }

  if (typeof e.code === "string" && NETWORK_ERROR_REASONS[e.code]) {
    return NETWORK_ERROR_REASONS[e.code];
  }

  // Any other server NO/BAD carries its own text (e.g. IMAP disabled for the mailbox).
  const responseText = (e.responseText || "").trim();
  if (responseText) return responseText;
  if (e.serverResponseCode) return `the mail server returned ${e.serverResponseCode}`;
  return typeof e.message === "string" && e.message.trim() ? e.message.trim() : "IMAP connection failed.";
}

// A failure reason is capped before it reaches the audit trail: a chatty server response should not
// bloat the jsonb column, and 400 characters is far more than any IMAP rejection text needs.
export const MAX_FAILURE_REASON_LENGTH = 400;

/**
 * Build the `detail` payload for an access-log row that records a failure.
 *
 * The reason is the whole point. A failed enrolment never creates a monitor row, so there is no
 * `last_error` column to fall back on, and a MailboxMonitorError is returned to the browser as a
 * plain 4xx that the error monitor never sees — so without the reason here, the only surviving
 * trace of a refused mailbox is `failed: true`, and *why* it was refused dies with the HTTP
 * response. Measured 2026-08-28: two failed enrolments, neither recoverable afterwards.
 *
 * `extra` is spread first so a caller can never overwrite `failed` or `reason`.
 */
export function failureDetail(reason: unknown, extra?: Record<string, unknown>): Record<string, unknown> {
  const text = typeof reason === "string" ? reason.trim() : "";
  return {
    ...(extra ?? {}),
    failed: true,
    reason: text ? text.slice(0, MAX_FAILURE_REASON_LENGTH) : null,
  };
}
