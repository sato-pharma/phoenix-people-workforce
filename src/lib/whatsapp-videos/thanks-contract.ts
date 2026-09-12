// Future Talents closing videos — the rules of the one message Phoenix sends an intern.
//
// Pure on purpose (no imports), so the test suite can pin the wording, the day boundary and who is
// thanked without a database or a Graph call. The send itself lives in ./thanks.ts.

/** The owner's words, 2026-09-12. */
export const FTP_VIDEO_THANKS_TEXT = "Thanks, well received. Good luck!";

/** The `event` recorded on ats_whatsapp_outbound_messages for this send. */
export const FTP_VIDEO_THANKS_EVENT = "ftp_video_thanks_send";

/**
 * How long a sender must be quiet before their batch is answered.
 *
 * Owner 2026-09-13: thank an intern AFTER their videos, not before. Until then the first message
 * earned the reply, and most interns type their submission ID first — so the thank-you landed before
 * a single video had arrived, and the videos that followed were met with silence. Three minutes of
 * quiet is "they have finished sending"; the cron that checks runs every two.
 */
export const FTP_VIDEO_THANKS_QUIET_MS = 3 * 60_000;

/**
 * The oldest batch still answered. WhatsApp allows a free-form reply only within 24 hours of the
 * sender's last message; an hour's margin keeps a slow tick from sending into a closed window.
 */
export const FTP_VIDEO_THANKS_WINDOW_MS = 23 * 60 * 60_000;

export type FtpVideoThanksMessage = {
  waId: string;
  wamid: string;
  kind: "video" | "submission_id";
  receivedAt: string;
  phoneNumberId: string | null;
};

export type FtpVideoThanksDue = {
  waId: string;
  /** The batch's last message: the claim key, so one batch is thanked once. */
  lastWamid: string;
  /** The line that message arrived on — the reply goes FROM it. */
  phoneNumberId: string | null;
};

/**
 * The Egyptian calendar day (YYYY-MM-DD, Africa/Cairo) a moment falls on. The server runs in UTC,
 * so a video sent at 00:30 Cairo is still "yesterday" in UTC.
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
 * Who is owed a thank-you now.
 *
 * A sender's BATCH is every live video and submission-ID message received after they were last
 * thanked. It is due when it holds at least one video — "well received" is about the videos, so an ID
 * on its own waits for them — and the sender has been quiet for FTP_VIDEO_THANKS_QUIET_MS, and the
 * last message is still inside the reply window. Callers pass only live (non-historical) messages.
 */
export function dueFtpVideoThanks(input: {
  messages: readonly FtpVideoThanksMessage[];
  lastThankedAt: ReadonlyMap<string, string>;
  now: Date;
}): FtpVideoThanksDue[] {
  const nowMs = input.now.getTime();
  const bySender = new Map<string, FtpVideoThanksMessage[]>();
  for (const message of input.messages) {
    if (!Number.isFinite(Date.parse(message.receivedAt))) continue;
    const list = bySender.get(message.waId) ?? [];
    list.push(message);
    bySender.set(message.waId, list);
  }

  const due: FtpVideoThanksDue[] = [];
  for (const [waId, messages] of bySender) {
    const thankedMs = Date.parse(input.lastThankedAt.get(waId) ?? "");
    const since = Number.isFinite(thankedMs) ? thankedMs : Number.NEGATIVE_INFINITY;
    const batch = messages
      .filter((message) => Date.parse(message.receivedAt) > since)
      .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt) || a.wamid.localeCompare(b.wamid));
    if (batch.length === 0 || !batch.some((message) => message.kind === "video")) continue;

    const last = batch[batch.length - 1];
    const age = nowMs - Date.parse(last.receivedAt);
    if (age < FTP_VIDEO_THANKS_QUIET_MS || age > FTP_VIDEO_THANKS_WINDOW_MS) continue;
    due.push({ lastWamid: last.wamid, phoneNumberId: last.phoneNumberId, waId });
  }
  return due.sort((a, b) => a.waId.localeCompare(b.waId));
}
