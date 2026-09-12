// Future Talents closing videos — "Thanks, well received. Good luck!", once per intern per day.
//
// Owner 2026-09-12: when an intern sends their closing videos to the HR handset, answer them. Fired by
// the first NEW video or submission-id message from a sender on a Cairo day; every later one that day
// is silent, however many videos they send.
//
// 🔴 THE CLAIM COMES BEFORE THE SEND. Six videos arrive as six near-simultaneous webhook deliveries.
// Each inserts (wa_id, cairo_day) into whatsapp_ftp_video_thanks first, and only the delivery whose
// insert won sends; the rest get 23505 and stay silent. A read-then-send would thank the intern six
// times. The price is deliberate: if the send then fails, that intern is not thanked again that day.
//
// Shares RECRUITMENT_WHATSAPP_TEXT_REPLY_ENABLED with every other reply on this line, so one switch
// silences everything Phoenix writes there. Never throws: a non-200 makes Meta retry the payload.

import { sendWhatsAppText } from "@/lib/recruitment/inbound/whatsapp-interactive";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { FTP_VIDEO_THANKS_EVENT, FTP_VIDEO_THANKS_TEXT, type ThanksOutcome, cairoDay } from "./thanks-contract";

export function isFtpVideoThanksEnabled(): boolean {
  return String(process.env.RECRUITMENT_WHATSAPP_TEXT_REPLY_ENABLED ?? "true").trim().toLowerCase() !== "false";
}

export async function thankFtpVideoSender(input: {
  waId: string;
  phoneNumberId: string | null;
  wamid: string;
  now?: Date;
}): Promise<ThanksOutcome> {
  if (!isFtpVideoThanksEnabled()) return "disabled";

  const day = cairoDay(input.now ?? new Date());
  try {
    const supabase = getSupabaseAdmin();
    const { error: claimError } = await supabase
      .from("whatsapp_ftp_video_thanks")
      .insert({ cairo_day: day, triggered_by_wamid: input.wamid, wa_id: input.waId });

    if (claimError) {
      // 23505: another delivery already claimed today for this sender — the guard working.
      if (claimError.code === "23505") return "already_thanked";
      logError("Failed to claim the FTP video thank-you", {
        error: claimError,
        labels: { event: "ftp_video_thanks_claim_failed", wamid: input.wamid },
      });
      return "failed";
    }

    const sent = await sendWhatsAppText({
      event: FTP_VIDEO_THANKS_EVENT,
      phoneNumberId: input.phoneNumberId,
      text: FTP_VIDEO_THANKS_TEXT,
      toWaId: input.waId,
    });

    const { error: markError } = await supabase
      .from("whatsapp_ftp_video_thanks")
      .update({ sent_ok: sent.ok })
      .eq("wa_id", input.waId)
      .eq("cairo_day", day);
    if (markError) {
      logError("Failed to record the FTP video thank-you result", {
        error: markError,
        labels: { event: "ftp_video_thanks_mark_failed", wamid: input.wamid },
      });
    }

    return sent.ok ? "sent" : "send_failed";
  } catch (error) {
    logError("FTP video thank-you threw", {
      error,
      labels: { event: "ftp_video_thanks_threw", wamid: input.wamid },
    });
    return "failed";
  }
}
