import type { AccessContext } from "@/lib/auth/permissions";
import type { DisputeAttachmentContentType } from "@/lib/deductions/comment-attachment-rules.ts";
import { notFoundError } from "@/lib/http/api-errors";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { DISPUTE_CENTER_BUCKET } from "./attachment-rules.ts";
import { ATTACHMENT_COLUMNS, type AttachmentRow } from "./attachment-store.ts";
import { resolveCaseParticipant } from "./participants.ts";

export { listDisputeCenterAttachments, storeDisputeCenterAttachments } from "./attachment-store.ts";

/** One picture, for someone in the case. Anyone else is refused before a byte is read. */
export async function readDisputeCenterAttachment(input: {
  access: AccessContext;
  attachmentId: string;
}): Promise<{ bytes: Uint8Array; contentType: DisputeAttachmentContentType; fileName: string }> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("dispute_attachments").select(ATTACHMENT_COLUMNS).eq("id", input.attachmentId).maybeSingle();
  if (error) throw error;
  const row = data as AttachmentRow | null;
  if (!row) throw notFoundError("That picture does not exist.");
  await resolveCaseParticipant(input.access, row.case_kind, row.case_ref);
  const download = await supabase.storage.from(DISPUTE_CENTER_BUCKET).download(row.storage_path);
  if (download.error || !download.data) throw notFoundError("That picture is no longer stored.");
  return {
    bytes: new Uint8Array(await download.data.arrayBuffer()),
    contentType: row.content_type as DisputeAttachmentContentType,
    fileName: row.file_name,
  };
}
