// The HR handset's 14-day clock (owner, 2026-11-03).
//
// The handset's number runs on the Cloud API in coexistence with the WhatsApp Business app, and Meta
// drops the link when the app has not been opened for 14 days. Applicants' messages on that line stop
// arriving and nothing here would say why. The app's opening cannot be seen from here. A message SENT
// from the phone can, because Meta echoes it to the webhook, so the clock runs from the last send.
//
// That makes the wording a matter of honesty: "no message sent from the phone for N days", never
// "the phone has not been opened". A send proves an open; an open with no send looks the same as
// nothing. Pure, so every stage is testable with no database.

const DAY_MS = 24 * 60 * 60 * 1000;

export const HANDSET_LIMIT_DAYS = 14;

export type HandsetReminderStage = "seven" | "ten" | "twelve" | "thirteen" | "over";

/** Whole 24-hour days since the last send. Elapsed time, because Meta's limit is. */
export function handsetDaysSinceSend(lastSendAt: string, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(lastSendAt)) / DAY_MS));
}

/** Under 7 days nothing is said. A missed fire is caught next day: each stage holds until the next. */
export function handsetReminderStage(days: number): HandsetReminderStage | null {
  if (days < 7) return null;
  if (days < 10) return "seven";
  if (days < 12) return "ten";
  if (days === 12) return "twelve";
  if (days === 13) return "thirteen";
  return "over";
}

export type HandsetReminderPlan = {
  channels: Array<"in_app" | "telegram" | "push">;
  idempotencyKey: string;
  priority: "normal" | "high";
};

/**
 * The first two stages speak once per silence, keyed on the send they count from. The last three repeat
 * every day, keyed on the Cairo date. Day 7 stays quiet on purpose: seven days is well inside the limit.
 */
export function handsetReminderPlan(stage: HandsetReminderStage, lastSendAt: string, cairoDay: string): HandsetReminderPlan {
  if (stage === "seven") {
    return { channels: ["in_app"], idempotencyKey: `whatsapp-handset-open:seven:${lastSendAt}`, priority: "normal" };
  }
  if (stage === "ten") {
    return {
      channels: ["in_app", "telegram", "push"],
      idempotencyKey: `whatsapp-handset-open:ten:${lastSendAt}`,
      priority: "normal",
    };
  }
  return { channels: ["in_app", "telegram", "push"], idempotencyKey: `whatsapp-handset-open:${stage}:${cairoDay}`, priority: "high" };
}

function cairoStamp(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "long",
    timeZone: "Africa/Cairo",
  }).format(new Date(iso));
}

export function handsetLimitAt(lastSendAt: string): string {
  return new Date(Date.parse(lastSendAt) + HANDSET_LIMIT_DAYS * DAY_MS).toISOString();
}

export function handsetReminderTitle(stage: HandsetReminderStage, days: number): string {
  return stage === "over"
    ? `The HR handset may have lost WhatsApp: ${days} days with no send`
    : `Open WhatsApp Business on the HR handset: ${days} days with no send`;
}

export function handsetReminderMessage(stage: HandsetReminderStage, days: number, lastSendAt: string): string {
  const lead = `No message has been sent from the HR handset for ${days} days. The last one was ${cairoStamp(lastSendAt)} Cairo.`;
  const limit = cairoStamp(handsetLimitAt(lastSendAt));
  const action =
    "Open WhatsApp Business on the phone and send one real reply. That resets this clock. Do not tap the \"Connected platform\" card.";
  if (stage === "over") {
    return [
      lead,
      `The 14 days ended ${limit} Cairo, unless the app was opened with nothing sent, which cannot be seen from here. The link may have dropped, so check the number in WhatsApp Manager.`,
      action,
    ].join("\n\n");
  }
  return [lead, `WhatsApp drops the link if the app stays closed for 14 days. That would be ${limit} Cairo.`, action].join("\n\n");
}

export const HANDSET_ECHOES_OFF_TITLE = "The HR handset's own messages have stopped reaching Phoenix";
export const HANDSET_ECHOES_OFF_MESSAGE =
  "Meta no longer has the smb_message_echoes field subscribed on the WhatsApp webhook, so messages sent from the phone do not reach Phoenix and the 14-day clock cannot be trusted. Re-subscribe the field in the Meta app's webhook settings.";
