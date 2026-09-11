// Recruitment / ATS — who a candidate is on WhatsApp, which line they wrote to, and whether we are
// still allowed to answer them in our own words.
//
// This exists because a human reply has to answer two questions the automated flows never had to
// ask. The automated sends all run inside a webhook delivery, so they already hold the applicant's
// wa_id and the line the message landed on. A recruiter clicking Reply three hours later holds
// neither: they have a candidate row, and nothing else.
//
// ── The two ways a reply goes wrong, both silent ──────────────────────────────
//
//   1. REPLYING FROM THE WRONG LINE. Since the handset joined the platform on 2026-09-11 there are
//      two numbers feeding one webhook. Answering an applicant from the line they did NOT write to
//      does not fail — it opens a brand new conversation, from a number they do not recognise,
//      outside the free window, and it will usually be refused for having no template. So the line
//      is resolved from the message they actually sent, never from configuration.
//
//   2. WRITING PAST THE 24-HOUR WINDOW. WhatsApp only allows free-form text within 24 hours of the
//      person's last message. Past that, Meta refuses with a specific error and the recruiter sees
//      a failure they cannot interpret. Better to know before typing, so the window is computed
//      here and shown, rather than discovered by a rejection.
//
// The intake event is the source for both. It already records the sending line, the applicant's
// number and the arrival time against the candidate, so nothing new has to be stored.

import { recruitmentDb } from "@/lib/recruitment/db";

/** WhatsApp's free-form reply window. Meta's rule, not ours, and not configurable. */
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type CandidateReplyTarget = {
  /** The applicant's WhatsApp id, digits only, as Meta addresses it. */
  toWaId: string;
  /** The line to answer FROM — the one they wrote to. */
  phoneNumberId: string;
  /** That line in readable form, for showing a human which number the reply leaves from. */
  lineNumber: string | null;
  lastInboundAt: string;
  windowOpen: boolean;
  /** Whole minutes left in the window, floored at 0. For a warning as it runs down. */
  minutesLeft: number;
};

/**
 * Whether a free-form reply is still allowed, and how long is left.
 *
 * Pure and exported so the boundary can be tested without a database or a clock — an off-by-one
 * here is the difference between a reply the recruiter believes was sent and one Meta refused.
 */
export function replyWindow(lastInboundAt: Date, now: Date): { open: boolean; minutesLeft: number } {
  const elapsed = now.getTime() - lastInboundAt.getTime();
  const remaining = REPLY_WINDOW_MS - elapsed;
  if (remaining <= 0) return { minutesLeft: 0, open: false };
  return { minutesLeft: Math.floor(remaining / 60_000), open: true };
}

/** Digits only. Meta addresses `to` without a plus, and the stored identifier carries one. */
function toWaId(senderIdentifier: string | null): string | null {
  const digits = (senderIdentifier ?? "").replace(/[^0-9]/g, "");
  return digits.length >= 8 ? digits : null;
}

/**
 * The most recent WhatsApp message this candidate sent us, resolved into everything a reply needs.
 *
 * Returns null when they have never written to us on WhatsApp — a candidate whose CV arrived by
 * email has no conversation to answer, and offering a reply box there would produce a message from
 * a number they have never seen.
 */
export async function resolveCandidateReplyTarget(
  candidateId: string,
  now: Date = new Date(),
): Promise<CandidateReplyTarget | null> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_cv_intake_events")
    .select("sender_identifier, raw_metadata, created_at")
    .eq("candidate_id", candidateId)
    .eq("channel", "whatsapp")
    .order("created_at", { ascending: false })
    .limit(1);

  if (error || !data || data.length === 0) return null;

  const row = data[0] as {
    sender_identifier: string | null;
    raw_metadata: Record<string, unknown> | null;
    created_at: string;
  };

  const waId = toWaId(row.sender_identifier);
  const metadata = row.raw_metadata ?? {};
  const phoneNumberId = typeof metadata.deliveredToPhoneNumberId === "string" ? metadata.deliveredToPhoneNumberId : null;
  const lineNumber = typeof metadata.deliveredToDisplayNumber === "string" ? metadata.deliveredToDisplayNumber : null;

  // Both are required. Without the line we would fall back to the configured default, which is
  // trap 1 above — so a row that predates line recording yields no reply target rather than a reply
  // from the wrong number.
  if (!waId || !phoneNumberId) return null;

  const lastInboundAt = new Date(row.created_at);
  if (Number.isNaN(lastInboundAt.getTime())) return null;

  const window = replyWindow(lastInboundAt, now);
  return {
    lastInboundAt: row.created_at,
    lineNumber,
    minutesLeft: window.minutesLeft,
    phoneNumberId,
    toWaId: waId,
    windowOpen: window.open,
  };
}
