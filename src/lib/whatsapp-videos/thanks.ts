// Future Talents closing videos — "Thanks, well received. Good luck!", once per batch, after the videos.
//
// Owner 2026-09-12: when an intern sends their closing videos to the HR handset, answer them.
// Owner 2026-09-13: answer AFTER the videos. The webhook used to reply to the first message of the
// day, which for most interns was their submission ID — so the thank-you arrived before any video did.
// Now the inbound-intake cron (every two minutes) finds senders who have gone quiet with an unanswered
// video and thanks them once. The rules live in ./thanks-contract.ts (dueFtpVideoThanks).
//
// 🔴 THE CLAIM COMES BEFORE THE SEND. Two overlapping ticks can both see the same batch as due. Each
// inserts (wa_id, last wamid) into whatsapp_ftp_video_thanks_batch first, and only the tick whose
// insert won sends; the other gets 23505 and stays silent. The price is deliberate: a send that then
// fails is not retried for that batch.
//
// "Last thanked" is read from three places, newest wins: this table, the per-day table it replaced
// (whatsapp_ftp_video_thanks, written by the webhook until this change), and every accepted
// ftp_video_thanks_send in the outbound log — which also covers the owner's one-off send of 13 Sep.
//
// Shares RECRUITMENT_WHATSAPP_TEXT_REPLY_ENABLED with every other reply on this line. Never throws.

import { sendWhatsAppText } from "@/lib/recruitment/inbound/whatsapp-interactive";
import { logError, logInfo } from "@/lib/observability/log";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import {
  FTP_VIDEO_THANKS_EVENT,
  FTP_VIDEO_THANKS_TEXT,
  FTP_VIDEO_THANKS_WINDOW_MS,
  type FtpVideoThanksMessage,
  cairoDay,
  dueFtpVideoThanks,
} from "./thanks-contract";

/** A tick answers at most this many senders; the rest are still due on the next one. */
const MAX_THANKS_PER_TICK = 25;

export type ThanksRunResult = {
  disabled: boolean;
  due: number;
  sent: number;
  alreadyThanked: number;
  sendFailed: number;
  failed: number;
};

export function isFtpVideoThanksEnabled(): boolean {
  return String(process.env.RECRUITMENT_WHATSAPP_TEXT_REPLY_ENABLED ?? "true").trim().toLowerCase() !== "false";
}

type MessageRow = { wa_id: string; wamid: string; received_at: string; delivered_to_phone_number_id: string | null };

function latestByWaId(target: Map<string, string>, rows: readonly { wa_id: string; created_at: string }[]) {
  for (const row of rows) {
    const current = target.get(row.wa_id);
    if (!current || Date.parse(row.created_at) > Date.parse(current)) target.set(row.wa_id, row.created_at);
  }
}

export async function thankDueFtpVideoSenders(now: Date = new Date()): Promise<ThanksRunResult> {
  const result: ThanksRunResult = { alreadyThanked: 0, disabled: false, due: 0, failed: 0, sendFailed: 0, sent: 0 };
  if (!isFtpVideoThanksEnabled()) return { ...result, disabled: true };

  try {
    const supabase = getSupabaseAdmin();
    const since = new Date(now.getTime() - FTP_VIDEO_THANKS_WINDOW_MS).toISOString();
    const columns = "wa_id, wamid, received_at, delivered_to_phone_number_id";

    // Rows with no phone number are skipped: a sender who uses a WhatsApp username is addressed by a
    // business-scoped user id, which Meta takes in a `recipient` field rather than `to`. Until the
    // owner decides otherwise, the thank-you goes only where it always went — a phone number.
    // The two message reads are paged, every row of the window: a sender cut off by a row ceiling is never thanked.
    // A page that fails throws into the catch below, which answers failed: 1 like the other reads.
    const [videos, ids, batches, days, sends] = await Promise.all([
      fetchAllRows<MessageRow>(
        () => supabase.from("whatsapp_inbound_video").select(columns).eq("historical", false).not("wa_id", "is", null).gt("received_at", since),
        "id",
      ),
      fetchAllRows<MessageRow>(
        () => supabase.from("whatsapp_inbound_submission_id").select(columns).eq("historical", false).not("wa_id", "is", null).gt("received_at", since),
        "id",
      ),
      supabase.from("whatsapp_ftp_video_thanks_batch").select("wa_id, created_at").gt("created_at", since).returns<{ wa_id: string; created_at: string }[]>(),
      supabase.from("whatsapp_ftp_video_thanks").select("wa_id, created_at").gt("created_at", since).returns<{ wa_id: string; created_at: string }[]>(),
      supabase
        .from("ats_whatsapp_outbound_messages")
        .select("to_wa_id, created_at")
        .eq("event", FTP_VIDEO_THANKS_EVENT)
        .eq("ok", true)
        .gt("created_at", since)
        .returns<{ to_wa_id: string; created_at: string }[]>(),
    ]);

    const readError = batches.error ?? days.error ?? sends.error;
    if (readError) {
      logError("Could not read who is owed an FTP video thank-you", {
        error: readError,
        labels: { event: "ftp_video_thanks_read_failed" },
      });
      return { ...result, failed: 1 };
    }

    const messages: FtpVideoThanksMessage[] = [
      ...videos.map((row) => ({ kind: "video" as const, row })),
      ...ids.map((row) => ({ kind: "submission_id" as const, row })),
    ].map(({ kind, row }) => ({
      kind,
      phoneNumberId: row.delivered_to_phone_number_id,
      receivedAt: row.received_at,
      waId: row.wa_id,
      wamid: row.wamid,
    }));

    const lastThankedAt = new Map<string, string>();
    latestByWaId(lastThankedAt, batches.data ?? []);
    latestByWaId(lastThankedAt, days.data ?? []);
    latestByWaId(
      lastThankedAt,
      (sends.data ?? []).map((row) => ({ created_at: row.created_at, wa_id: row.to_wa_id })),
    );

    const due = dueFtpVideoThanks({ lastThankedAt, messages, now }).slice(0, MAX_THANKS_PER_TICK);
    result.due = due.length;

    for (const item of due) {
      const { error: claimError } = await supabase
        .from("whatsapp_ftp_video_thanks_batch")
        .insert({ cairo_day: cairoDay(now), triggered_by_wamid: item.lastWamid, wa_id: item.waId });

      if (claimError) {
        // 23505: another tick already claimed this batch — the guard working.
        if (claimError.code === "23505") {
          result.alreadyThanked += 1;
          continue;
        }
        logError("Failed to claim an FTP video thank-you", {
          error: claimError,
          labels: { event: "ftp_video_thanks_claim_failed", wamid: item.lastWamid },
        });
        result.failed += 1;
        continue;
      }

      const sent = await sendWhatsAppText({
        event: FTP_VIDEO_THANKS_EVENT,
        phoneNumberId: item.phoneNumberId,
        text: FTP_VIDEO_THANKS_TEXT,
        toWaId: item.waId,
      });

      const { error: markError } = await supabase
        .from("whatsapp_ftp_video_thanks_batch")
        .update({ sent_ok: sent.ok })
        .eq("wa_id", item.waId)
        .eq("triggered_by_wamid", item.lastWamid);
      if (markError) {
        logError("Failed to record the FTP video thank-you result", {
          error: markError,
          labels: { event: "ftp_video_thanks_mark_failed", wamid: item.lastWamid },
        });
      }

      if (sent.ok) result.sent += 1;
      else result.sendFailed += 1;
    }

    if (result.due > 0) {
      logInfo("FTP video thank-yous sent", { labels: { event: "ftp_video_thanks_tick", ...result } });
    }
    return result;
  } catch (error) {
    logError("FTP video thank-you tick threw", {
      error,
      labels: { event: "ftp_video_thanks_threw" },
    });
    return { ...result, failed: result.failed + 1 };
  }
}
