// Handing the captured videos to the Future Talents Portal.
//
// The portal has no service-role key and never will, so it cannot read this bucket itself. It asks
// this app instead: list what is safe and unclaimed, with a short-lived download link for each, and
// then say which ones it has taken its own copy of. `handed_off_at` is the only column the portal
// ever causes to change, and it is written here, not there.

import { getSupabaseAdmin } from "@/lib/supabase/server";

import {
  HANDOFF_DOWNLOAD_TTL_SECONDS,
  MAX_HANDOFF_BATCH,
  type HandoffSenderId,
  type HandoffVideo,
} from "./handoff-contract";
import { WHATSAPP_VIDEOS_BUCKET } from "./inbox";

type UnclaimedRow = {
  wamid: string;
  wa_id: string;
  contact_name: string | null;
  file_name: string | null;
  caption: string | null;
  sent_at: string | null;
  byte_size: number | null;
  mime_type: string;
  historical: boolean;
  storage_path: string;
};

/** Everything whose bytes are in the bucket and that the portal has not claimed. Oldest send first. */
export async function listUnclaimedVideos(limit = MAX_HANDOFF_BATCH): Promise<HandoffVideo[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("whatsapp_inbound_video")
    .select("wamid, wa_id, contact_name, file_name, caption, sent_at, byte_size, mime_type, historical, storage_path")
    .not("storage_path", "is", null)
    .is("handed_off_at", null)
    .order("sent_at", { ascending: true, nullsFirst: false })
    .limit(Math.max(1, Math.min(MAX_HANDOFF_BATCH, Math.floor(limit))))
    .returns<UnclaimedRow[]>();
  if (error) throw new Error(`could not list unclaimed videos: ${error.message}`);

  const rows = data ?? [];
  if (rows.length === 0) return [];

  const { data: signed, error: signError } = await supabase.storage
    .from(WHATSAPP_VIDEOS_BUCKET)
    .createSignedUrls(
      rows.map((row) => row.storage_path),
      HANDOFF_DOWNLOAD_TTL_SECONDS,
    );
  if (signError) throw new Error(`could not sign download links: ${signError.message}`);

  const urlByPath = new Map<string, string>();
  for (const entry of signed ?? []) {
    if (entry.path && entry.signedUrl && !entry.error) urlByPath.set(entry.path, entry.signedUrl);
  }

  // A row whose link could not be signed is left out rather than sent with no link: the portal
  // would show a video it cannot play or copy, and the row stays unclaimed for the next call.
  const videos: HandoffVideo[] = [];
  for (const row of rows) {
    const downloadUrl = urlByPath.get(row.storage_path);
    if (!downloadUrl) continue;
    videos.push({
      byteSize: row.byte_size,
      caption: row.caption,
      contactName: row.contact_name,
      downloadUrl,
      fileName: row.file_name,
      historical: row.historical,
      mimeType: row.mime_type,
      sentAt: row.sent_at,
      waId: row.wa_id,
      wamid: row.wamid,
    });
  }
  return videos;
}

/**
 * Records that the portal has its own copy. Returns how many rows moved.
 *
 * Only a fetched, unclaimed row moves: claiming a video whose bytes never arrived would take it off
 * the list while the portal holds nothing, and re-claiming one is a no-op rather than a new stamp.
 */
export async function markVideosHandedOff(wamids: readonly string[]): Promise<number> {
  if (wamids.length === 0) return 0;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("whatsapp_inbound_video")
    .update({ handed_off_at: new Date().toISOString() })
    .in("wamid", [...wamids])
    .not("storage_path", "is", null)
    .is("handed_off_at", null)
    .select("wamid");
  if (error) throw new Error(`could not mark videos handed off: ${error.message}`);
  return (data ?? []).length;
}

type SenderIdRow = {
  wa_id: string;
  submission_ids: string[] | null;
  sent_at: string | null;
};

/**
 * The submission ids these senders have typed, oldest first.
 *
 * Throws when they cannot be read. The route turns that into `senderIdsAvailable: false` rather than
 * an empty list, because an empty list means "nobody sent one" and the portal acts on that.
 */
export async function listSubmissionIdsForSenders(waIds: readonly string[]): Promise<HandoffSenderId[]> {
  const senders = [...new Set(waIds.filter(Boolean))];
  if (senders.length === 0) return [];
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("whatsapp_inbound_submission_id")
    .select("wa_id, submission_ids, sent_at")
    .in("wa_id", senders)
    .order("sent_at", { ascending: true, nullsFirst: false })
    .limit(500)
    .returns<SenderIdRow[]>();
  if (error) throw new Error(`could not list submission ids: ${error.message}`);
  return (data ?? []).map((row) => ({
    sentAt: row.sent_at,
    submissionIds: row.submission_ids ?? [],
    waId: row.wa_id,
  }));
}
