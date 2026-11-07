// Recruitment / Medical Rep hiring — did this CV reach a company WhatsApp (§1–§2)?
//
// The email names ONE channel; the owner then counted the second company line too (7 Nov 2026,
// "Count the 010 line too"): both 01159888247 (the HR handset) and 01098500699 (the recruitment line)
// are official. Inbound intake stores the line a message was delivered to in
// `ats_cv_intake_events.raw_metadata->>'deliveredToPhoneNumberId'`, so the answer is read off the
// stored event rather than guessed from the candidate's `source`.
//
// An event from before that field was recorded carries no line at all. It is counted as official:
// the webhook only receives messages addressed to the company's own numbers, and a CV that old is
// from before the workflow started, so it could never be held anyway. A line that IS recorded and is
// not one of the two inbox lines — the approvals number, say — is not official.

import { whatsAppInboxLineLabel, whatsAppInboxLines } from "@/lib/whatsapp-inbox/lines";

export type MrIntakeEventFact = {
  candidateId: string;
  channel: string | null;
  deliveredToPhoneNumberId: string | null;
  createdAt: string;
};

/** The phone number ids of the two official lines. */
export function officialLineIds(): Set<string> {
  return new Set(whatsAppInboxLines().map((line) => line.phoneNumberId).filter(Boolean));
}

/** Whether one intake event arrived on a company WhatsApp. */
export function isOfficialWhatsAppEvent(event: Pick<MrIntakeEventFact, "channel" | "deliveredToPhoneNumberId">, official: Set<string>): boolean {
  if (String(event.channel ?? "").toLowerCase() !== "whatsapp") return false;
  const line = event.deliveredToPhoneNumberId?.trim();
  return !line || official.has(line);
}

/** The first official arrival, for the timeline's first line: when, and on which line. */
export function firstOfficialArrival(
  events: readonly MrIntakeEventFact[],
  official: Set<string> = officialLineIds(),
): { at: string; lineLabel: string } | null {
  let first: MrIntakeEventFact | null = null;
  for (const event of events) {
    if (!isOfficialWhatsAppEvent(event, official)) continue;
    if (!first || event.createdAt < first.createdAt) first = event;
  }
  if (!first) return null;
  return {
    at: first.createdAt,
    lineLabel: first.deliveredToPhoneNumberId ? whatsAppInboxLineLabel(first.deliveredToPhoneNumberId) : "Company WhatsApp",
  };
}
