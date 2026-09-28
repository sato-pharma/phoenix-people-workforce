// The weekly attendance review's notices to the employee: a week released for an answer, and a
// disputed day decided.
//
// Owner rule (2026-09-17, replacing the 2026-09-15 "never email"): each notice goes by EMAIL to the
// employee's own work address, by TELEGRAM, and to the in-app bell. The email-block guard this file
// used to hold is gone on purpose. The notices name the employee as their only recipient, so the email
// goes to that person's work email and, when there is none, it is skipped, never redirected to the HR
// inbox (resolveNotificationDelivery, GUARD 1). Because the employee is named as the subject, the
// email system also copies their DIRECT MANAGER (CC), as it does for every email addressed to an
// employee; the owner chose to keep that copy for these notices (2026-09-17). The admin's hidden copy
// and Telegram mirror apply as to every automated email.
//
// The notice reads as a short letter in paragraphs (owner, same day). On Telegram it keeps its
// paragraph breaks and carries no "Module:" line; in the email its line breaks show as breaks.
// Every other module keeps its one-block message in both, except that outstation's EMAIL keeps its
// breaks too (see emailKeepsLineBreaks).
//
// Keyed on MODULE alone, so a notice added to the module later reads the same way.

const ATTENDANCE_DIGEST_MODULE = "attendance_digest";

/**
 * The "what needs you" daily board (src/lib/needs-you/). It is a LIST — a section heading, then one
 * item per paragraph — so it needs the same treatment as the attendance letter for a different
 * reason: without paragraphs, `cleanTelegramText` collapses every break and the whole board arrives
 * as one run-on sentence, which at 900 characters is also the shape most likely to be cut mid-word.
 */
const NEEDS_YOU_MODULE = "needs_you";

export function isAttendanceDigestModule(module: string | null | undefined): boolean {
  return String(module ?? "").trim().toLowerCase() === ATTENDANCE_DIGEST_MODULE;
}

export function isNeedsYouModule(module: string | null | undefined): boolean {
  return String(module ?? "").trim().toLowerCase() === NEEDS_YOU_MODULE;
}

/** Whether a Telegram message for this module keeps its paragraph breaks and drops the "Module:" line. */
export function telegramKeepsParagraphs(module: string | null | undefined): boolean {
  return isAttendanceDigestModule(module) || isNeedsYouModule(module);
}

/**
 * Whether this module's email shows the message's own line breaks, so its paragraphs stay apart.
 *
 * Outstation too (owner, 2026-09-21: the submit mail "must be tidied and premium polished"). Its
 * summary is one fact per line — who and how much, the trip, the captured place, the checks, the
 * employee's note — and without breaks the email ran them together into one block. Its other
 * mails are a single line, so this changes nothing for them.
 */
export function emailKeepsLineBreaks(module: string | null | undefined): boolean {
  return (
    isAttendanceDigestModule(module) ||
    // The board is a list, and an email body is HTML where a bare break collapses into a space —
    // without this its sections and items arrive as one paragraph.
    isNeedsYouModule(module) ||
    String(module ?? "").trim().toLowerCase() === "outstation"
  );
}
