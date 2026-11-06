import { randomUUID } from "node:crypto";

import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import {
  buildDisputeCenterAttachmentPath,
  disputeCenterAttachmentUrl,
  DISPUTE_CENTER_BUCKET,
  type CheckedDisputeImage,
  type SharedAttachmentKind,
} from "./attachment-rules.ts";
import type { DisputeAttachment } from "./types.ts";

// Pictures on a calendar or weekly-review dispute — from either side (owner, 2026-10-09: "upload a
// picture in both"). The server half: store the bytes, list them on the messages that carry them,
// and hand one back only to someone in the case (attachments.ts, which checks who is asking). Kept
// apart from that check on purpose: the calendar and weekly-review services store pictures through
// this file, and the participant check imports them back. Deduction pictures keep their own table and
// route (deductions/comment-attachments.ts); this is the same design for the other two modules.

export type AttachmentRow = {
  case_kind: SharedAttachmentKind;
  case_ref: string;
  content_type: string;
  file_name: string;
  id: string;
  message_id: string | null;
  size_bytes: number | string;
  storage_path: string;
};

export const ATTACHMENT_COLUMNS = "id, case_kind, case_ref, message_id, storage_path, file_name, content_type, size_bytes";

export function mapAttachment(row: AttachmentRow): DisputeAttachment {
  return {
    contentType: row.content_type,
    fileName: row.file_name,
    id: row.id,
    sizeBytes: Number(row.size_bytes) || 0,
    url: disputeCenterAttachmentUrl(row.id),
  };
}

/**
 * Upload checked pictures and index them. The object and its row must not drift, so on any failure
 * every object already uploaded is removed and the error is thrown — the caller then removes the
 * message itself, so nobody is shown half a message.
 */
export async function storeDisputeCenterAttachments(input: {
  kind: SharedAttachmentKind;
  ref: string;
  messageId: string | null;
  uploadedByHrId: string;
  images: CheckedDisputeImage[];
}): Promise<DisputeAttachment[]> {
  if (input.images.length === 0) return [];
  const supabase = getSupabaseAdmin();
  const uploaded: string[] = [];
  try {
    const rows: Array<Omit<AttachmentRow, "size_bytes"> & { size_bytes: number; uploaded_by_hr_id: string }> = [];
    for (const image of input.images) {
      const id = randomUUID();
      const path = buildDisputeCenterAttachmentPath({
        attachmentId: id,
        caseKind: input.kind,
        caseRef: input.ref,
        contentType: image.contentType,
      });
      const upload = await supabase.storage.from(DISPUTE_CENTER_BUCKET).upload(path, image.bytes, {
        cacheControl: "3600",
        contentType: image.contentType,
        upsert: false,
      });
      if (upload.error) throw new Error(`Unable to store a picture: ${upload.error.message}`);
      uploaded.push(path);
      rows.push({
        case_kind: input.kind,
        case_ref: input.ref,
        content_type: image.contentType,
        file_name: image.fileName,
        id,
        message_id: input.messageId,
        size_bytes: image.bytes.length,
        storage_path: path,
        uploaded_by_hr_id: input.uploadedByHrId,
      });
    }
    const { data, error } = await supabase.from("dispute_attachments").insert(rows).select(ATTACHMENT_COLUMNS);
    if (error) throw new Error(`Unable to record the pictures: ${error.message}`);
    return ((data ?? []) as AttachmentRow[]).map(mapAttachment);
  } catch (error) {
    if (uploaded.length > 0) await supabase.storage.from(DISPUTE_CENTER_BUCKET).remove(uploaded);
    throw error;
  }
}

/**
 * Every picture on a set of cases, grouped: `opening` holds the ones on the request itself (no
 * message), `byMessage` the ones on each reply. Best-effort — a failed read returns empty maps so the
 * conversation still renders.
 */
export async function listDisputeCenterAttachments(
  kind: SharedAttachmentKind,
  refs: string[],
): Promise<{ opening: Map<string, DisputeAttachment[]>; byMessage: Map<string, DisputeAttachment[]> }> {
  const opening = new Map<string, DisputeAttachment[]>();
  const byMessage = new Map<string, DisputeAttachment[]>();
  const ids = Array.from(new Set(refs.filter(Boolean)));
  if (ids.length === 0) return { byMessage, opening };
  try {
    for (let i = 0; i < ids.length; i += 200) {
      // Every picture of this batch of cases, page by page; a failed page lands in the catch below,
      // which keeps the conversation rendering without pictures exactly as a failed read did before.
      const rows = await fetchAllRows<AttachmentRow>(
        () =>
          getSupabaseAdmin()
            .from("dispute_attachments")
            .select(ATTACHMENT_COLUMNS)
            .eq("case_kind", kind)
            .in("case_ref", ids.slice(i, i + 200))
            .order("created_at", { ascending: true }),
        "id",
      );
      for (const row of rows) {
        const target = row.message_id ? byMessage : opening;
        const key = row.message_id ?? row.case_ref;
        const list = target.get(key) ?? [];
        list.push(mapAttachment(row));
        target.set(key, list);
      }
    }
  } catch {
    return { byMessage, opening };
  }
  return { byMessage, opening };
}

