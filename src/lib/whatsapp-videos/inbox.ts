// Videos received on WhatsApp, captured and held for another application to claim.
//
// This is NOT recruitment code and deliberately does not live under `src/lib/recruitment/`. Nothing
// here creates a candidate, reads the ATS, or touches an intake event. It exists because the Future
// Talents programme's closing videos were sent to the advertised HR handset, and once that handset
// is linked to the Cloud API (coexistence) Meta replays its whole backlog through the recruitment
// webhook — which, until this module, would have answered 200 OK and discarded every video in it.
//
// TWO STEPS, DELIBERATELY SPLIT.
//
//   capture — synchronous, inside the webhook, writes one row and nothing else. The webhook's
//     contract is to acknowledge in well under a second, because Meta disables a webhook that keeps
//     timing out; a video download inside the request would be a self-inflicted Meta block during
//     the exact burst this feature exists to survive.
//
//   fetch — the cron tick, redeems the media id for bytes and puts them in the bucket. Separate
//     because that is the slow, failure-prone half, and because a media id is a claim with an
//     expiry: the replay hands out ids for messages weeks old, so the fetch is a race against
//     Meta's retention that a webhook has no business running.
//
// Every function here is best-effort from the webhook's point of view. Losing a video is bad;
// returning non-200 to Meta is worse, because Meta then retries the entire payload and the CVs in
// it get re-handled alongside.

import crypto from "node:crypto";

import { logError, logInfo } from "@/lib/observability/log";
import { downloadWhatsAppMedia } from "@/lib/recruitment/inbound/whatsapp-media";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const WHATSAPP_VIDEOS_BUCKET = "whatsapp-videos";

/**
 * The largest video this app will pull out of Meta and into memory.
 *
 * 100MB is WhatsApp's own ceiling for a document, which is the shape a sender uses to avoid the
 * compression applied to a `type: video` message (capped at 16MB by WhatsApp itself). So this is
 * not a policy choice about what is reasonable — it is the largest thing that can actually arrive,
 * and matching the bucket's own file_size_limit means a file is never downloaded only to be
 * refused on upload.
 */
export const MAX_INBOUND_VIDEO_BYTES = 104_857_600;

/**
 * How many times a failing fetch is retried before it is left alone.
 *
 * An expired media id fails permanently, and there is no status code that distinguishes "expired"
 * from "Meta is having a bad minute" — both are a non-200 from the Graph API. So the retry budget
 * is the only thing standing between one dead row and an unbounded number of pointless Graph calls
 * on every tick, forever. The row is never deleted: a permanent `fetch_error` is the record that
 * this video existed and could not be recovered, which is worth strictly more than a clean table.
 */
export const MAX_FETCH_ATTEMPTS = 5;

/**
 * `waId` is the sender's phone number, or null for a sender who uses a WhatsApp username and whose
 * phone Meta did not share; `userId` (the business-scoped user id) then identifies them. The table
 * refuses a row with neither.
 */
export type InboundVideoCapture = {
  wamid: string;
  waId: string | null;
  userId: string | null;
  username: string | null;
  contactName: string | null;
  mediaId: string;
  mimeType: string;
  fileName: string | null;
  caption: string | null;
  sentAt: string | null;
  historical: boolean;
  deliveredToPhoneNumberId: string | null;
  deliveredToDisplayNumber: string | null;
};

export type CaptureOutcome = "captured" | "duplicate" | "failed";

/**
 * Records one inbound video. Idempotent on `wamid`.
 *
 * `duplicate` is the normal, expected second outcome, not an error: Meta retries a delivery whose
 * response it did not like, and a coexistence replay can carry a message that also arrived live.
 * The unique index is what makes capturing twice produce one row, so this reports which happened
 * rather than trying to check first — a read-then-write would race two concurrent deliveries of the
 * same payload.
 */
export async function captureInboundVideo(input: InboundVideoCapture): Promise<{ outcome: CaptureOutcome }> {
  try {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from("whatsapp_inbound_video").insert({
      caption: input.caption,
      contact_name: input.contactName,
      delivered_to_display_number: input.deliveredToDisplayNumber,
      delivered_to_phone_number_id: input.deliveredToPhoneNumberId,
      file_name: input.fileName,
      historical: input.historical,
      media_id: input.mediaId,
      mime_type: input.mimeType,
      sent_at: input.sentAt,
      user_id: input.userId,
      username: input.username,
      wa_id: input.waId,
      wamid: input.wamid,
    });

    // 23505 is the unique violation on wamid — the idempotency working, not a failure.
    if (error) {
      if (error.code === "23505") return { outcome: "duplicate" };
      logError("Failed to capture an inbound WhatsApp video", {
        error,
        labels: { event: "whatsapp_video_capture_failed", wamid: input.wamid },
      });
      return { outcome: "failed" };
    }

    logInfo("Captured an inbound WhatsApp video", {
      labels: {
        event: "whatsapp_video_captured",
        historical: input.historical,
        mimeType: input.mimeType,
        wamid: input.wamid,
      },
    });
    return { outcome: "captured" };
  } catch (error) {
    logError("Inbound WhatsApp video capture threw", {
      error,
      labels: { event: "whatsapp_video_capture_threw", wamid: input.wamid },
    });
    return { outcome: "failed" };
  }
}

/** Keyed like a video: a phone number, a business-scoped user id, or both. */
export type InboundSubmissionIdCapture = {
  wamid: string;
  waId: string | null;
  userId: string | null;
  username: string | null;
  contactName: string | null;
  submissionIds: string[];
  sentAt: string | null;
  historical: boolean;
  deliveredToPhoneNumberId: string | null;
  deliveredToDisplayNumber: string | null;
};

/**
 * Records a message carrying a Future Talents submission id. Idempotent on `wamid`, like a video.
 *
 * Kept so the portal can tell whose videos a chat holds when the phone they came from is not the
 * one on the intern's profile. Nothing else is done with it — no reply, no candidate, no
 * notification — which is the point: without this the intern would be asked for a CV.
 */
export async function captureInboundSubmissionId(input: InboundSubmissionIdCapture): Promise<{ outcome: CaptureOutcome }> {
  try {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from("whatsapp_inbound_submission_id").insert({
      contact_name: input.contactName,
      delivered_to_display_number: input.deliveredToDisplayNumber,
      delivered_to_phone_number_id: input.deliveredToPhoneNumberId,
      historical: input.historical,
      sent_at: input.sentAt,
      submission_ids: input.submissionIds,
      user_id: input.userId,
      username: input.username,
      wa_id: input.waId,
      wamid: input.wamid,
    });

    if (error) {
      if (error.code === "23505") return { outcome: "duplicate" };
      logError("Failed to capture an inbound submission id", {
        error,
        labels: { event: "whatsapp_submission_id_capture_failed", wamid: input.wamid },
      });
      return { outcome: "failed" };
    }

    logInfo("Captured an inbound submission id", {
      labels: { event: "whatsapp_submission_id_captured", historical: input.historical, wamid: input.wamid },
    });
    return { outcome: "captured" };
  } catch (error) {
    logError("Inbound submission id capture threw", {
      error,
      labels: { event: "whatsapp_submission_id_capture_threw", wamid: input.wamid },
    });
    return { outcome: "failed" };
  }
}

type PendingRow = {
  id: string;
  wamid: string;
  media_id: string;
  mime_type: string;
  file_name: string | null;
  fetch_attempts: number;
};

/** `videos/<wamid hash>/<name>` — the wamid is not URL-safe, so it is hashed rather than escaped. */
function storagePathFor(row: PendingRow): string {
  const digest = crypto.createHash("sha256").update(row.wamid).digest("hex").slice(0, 32);
  const extension = row.mime_type === "video/quicktime" ? "mov" : (row.mime_type.split("/")[1] ?? "mp4");
  const safeName = (row.file_name ?? `video.${extension}`).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `videos/${digest}/${safeName || `video.${extension}`}`;
}

export type FetchResult = {
  considered: number;
  fetched: number;
  failed: number;
  exhausted: number;
};

/**
 * Redeems pending media ids for bytes and puts them in the bucket. Oldest first.
 *
 * Sequential on purpose. Each item is up to 100MB held in memory, and this runs on the same
 * container as everything else — three in parallel is 300MB of buffers against a RAM ceiling shared
 * with the payroll and closing paths. A backlog of 133 videos drains over a few ticks instead of
 * one, which costs nothing that matters.
 */
export async function fetchPendingInboundVideos(maxItems = 5): Promise<FetchResult> {
  const supabase = getSupabaseAdmin();
  const result: FetchResult = { considered: 0, exhausted: 0, failed: 0, fetched: 0 };

  const { data, error } = await supabase
    .from("whatsapp_inbound_video")
    .select("id, wamid, media_id, mime_type, file_name, fetch_attempts")
    .is("storage_path", null)
    .lt("fetch_attempts", MAX_FETCH_ATTEMPTS)
    .order("received_at", { ascending: true })
    .limit(Math.max(1, Math.min(25, Math.floor(maxItems))))
    .returns<PendingRow[]>();

  if (error) {
    // A missing table is the expected shape before the migration has been applied: this drains
    // nothing and says so, rather than failing the whole cron tick that also drains the CV queue.
    logError("Could not list pending inbound WhatsApp videos", {
      error,
      labels: { event: "whatsapp_video_list_failed" },
    });
    return result;
  }

  for (const row of data ?? []) {
    result.considered += 1;
    try {
      const { bytes, mimeType } = await downloadWhatsAppMedia(row.media_id, { maxBytes: MAX_INBOUND_VIDEO_BYTES });
      const path = storagePathFor(row);
      const { error: uploadError } = await supabase.storage.from(WHATSAPP_VIDEOS_BUCKET).upload(path, bytes, {
        cacheControl: "31536000",
        // Meta's reported type wins over the one recorded at capture: the message node and the
        // media endpoint can disagree, and the upload is refused if the bucket's allowed list does
        // not match what is actually being written.
        contentType: mimeType || row.mime_type,
        upsert: true,
      });
      if (uploadError) throw new Error(`storage upload failed: ${uploadError.message}`);

      // fetched_at and storage_path move together — a CHECK constraint on the table enforces that,
      // so a half-written row cannot claim the bytes are safe.
      const { error: updateError } = await supabase
        .from("whatsapp_inbound_video")
        .update({
          byte_size: bytes.length,
          fetch_attempts: row.fetch_attempts + 1,
          fetch_error: null,
          fetched_at: new Date().toISOString(),
          mime_type: mimeType || row.mime_type,
          storage_path: path,
        })
        .eq("id", row.id);
      if (updateError) throw new Error(`row update failed: ${updateError.message}`);

      result.fetched += 1;
    } catch (fetchError) {
      const attempts = row.fetch_attempts + 1;
      const message = fetchError instanceof Error ? fetchError.message : String(fetchError);
      if (attempts >= MAX_FETCH_ATTEMPTS) result.exhausted += 1;
      result.failed += 1;
      await supabase
        .from("whatsapp_inbound_video")
        .update({ fetch_attempts: attempts, fetch_error: message.slice(0, 500) })
        .eq("id", row.id)
        .then(undefined, () => undefined);
      logError("Could not fetch an inbound WhatsApp video", {
        error: fetchError,
        labels: {
          attempts,
          event: attempts >= MAX_FETCH_ATTEMPTS ? "whatsapp_video_fetch_exhausted" : "whatsapp_video_fetch_failed",
          wamid: row.wamid,
        },
      });
    }
  }

  if (result.fetched > 0 || result.failed > 0) {
    logInfo("Inbound WhatsApp video fetch pass finished", {
      labels: {
        considered: result.considered,
        event: "whatsapp_video_fetch_pass",
        exhausted: result.exhausted,
        failed: result.failed,
        fetched: result.fetched,
      },
    });
  }

  return result;
}
