// Future Talents closing videos — the rules of the one message Phoenix sends an intern.
//
// Pure on purpose (no imports), so the test suite can pin the wording, the day boundary and who is
// thanked without a database or a Graph call. The send itself lives in ./thanks.ts.

/** The owner's words, 2026-09-12. */
export const FTP_VIDEO_THANKS_TEXT = "Thanks, well received. Good luck!";

/** The `event` recorded on ats_whatsapp_outbound_messages for this send. */
export const FTP_VIDEO_THANKS_EVENT = "ftp_video_thanks_send";

export type ThanksOutcome = "sent" | "already_thanked" | "send_failed" | "disabled" | "failed";

/**
 * The Egyptian calendar day (YYYY-MM-DD, Africa/Cairo) a moment falls on. The server runs in UTC,
 * so a video sent at 00:30 Cairo is still "yesterday" in UTC — and would share yesterday's thank-you.
 */
export function cairoDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(at);
}

/**
 * Only a message seen for the first time, live, earns a thank-you. A redelivery (`duplicate`) was
 * already thanked or refused the first time; a failed capture means the video is NOT well received;
 * and a history replay is a message typed before the handset was linked, answered days late.
 */
export function shouldThankFtpSender(input: { outcome: string; historical: boolean }): boolean {
  return input.outcome === "captured" && !input.historical;
}
