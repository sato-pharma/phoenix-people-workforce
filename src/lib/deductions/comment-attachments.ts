// Pictures on a deduction dispute reply — the server half: store the bytes, list them on the
// comments that carry them, and hand one back to the person allowed to see it. The rules (which bytes
// are a picture, where they live) are in comment-attachment-rules.ts so a test can run them bare.

import { randomUUID } from "node:crypto";

import type { AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { compactDeductionsHrId } from "./candidate-key.ts";
import {
  buildDisputeAttachmentPath,
  DISPUTE_ATTACHMENT_BUCKET,
  type CheckedDisputeImage,
  type DisputeAttachmentContentType,
} from "./comment-attachment-rules.ts";
import { isDeductionsReadActor } from "./permissions.ts";
import type { DeductionsComment, DeductionsCommentAttachment } from "./types.ts";

type AttachmentRow = {
  candidate_id: string;
  comment_id: string;
  content_type: string;
  file_name: string;
  id: string;
  size_bytes: number | string;
  storage_path: string;
};

const ATTACHMENT_COLUMNS = "id, comment_id, candidate_id, storage_path, file_name, content_type, size_bytes";

/** The same-origin route that serves one picture after checking who is asking. */
export function disputeAttachmentUrl(attachmentId: string) {
  return `/api/deductions/comments/attachments/${encodeURIComponent(attachmentId)}`;
}

function mapAttachment(row: AttachmentRow): DeductionsCommentAttachment {
  return {
    contentType: row.content_type,
    fileName: row.file_name,
    id: row.id,
    sizeBytes: Number(row.size_bytes) || 0,
    url: disputeAttachmentUrl(row.id),
  };
}

/**
 * Upload the checked pictures and index them against the reply.
 *
 * The object and its row must not drift: an object with no row is unfindable and a row with no
 * object is a broken picture on the employee's screen. So if any step fails, every object already
 * uploaded is removed and the caller is told — and the caller then removes the reply itself, so the
 * employee is never shown half a message.
 */
export async function storeDisputeAttachments(input: {
  candidateId: string;
  commentId: string;
  images: CheckedDisputeImage[];
}): Promise<DeductionsCommentAttachment[]> {
  if (input.images.length === 0) return [];
  const supabase = getSupabaseAdmin();
  const uploaded: string[] = [];
  try {
    const rows: Array<Omit<AttachmentRow, "size_bytes"> & { size_bytes: number }> = [];
    for (const image of input.images) {
      const id = randomUUID();
      const path = buildDisputeAttachmentPath({
        attachmentId: id,
        candidateId: input.candidateId,
        contentType: image.contentType,
      });
      const upload = await supabase.storage.from(DISPUTE_ATTACHMENT_BUCKET).upload(path, image.bytes, {
        cacheControl: "3600",
        contentType: image.contentType,
        upsert: false,
      });
      if (upload.error) throw new Error(`Unable to store a picture: ${upload.error.message}`);
      uploaded.push(path);
      rows.push({
        candidate_id: input.candidateId,
        comment_id: input.commentId,
        content_type: image.contentType,
        file_name: image.fileName,
        id,
        size_bytes: image.bytes.length,
        storage_path: path,
      });
    }
    const { data, error } = await supabase
      .from("deductions_comment_attachments")
      .insert(rows)
      .select(ATTACHMENT_COLUMNS);
    if (error) throw new Error(`Unable to record the pictures: ${error.message}`);
    return ((data ?? []) as AttachmentRow[]).map(mapAttachment);
  } catch (error) {
    if (uploaded.length > 0) await supabase.storage.from(DISPUTE_ATTACHMENT_BUCKET).remove(uploaded);
    throw error;
  }
}

/** Remove a reply whose pictures could not be stored, so nobody sees half a message. */
export async function discardDisputeComment(commentId: string) {
  await getSupabaseAdmin().from("deductions_comments").delete().eq("id", commentId);
}

/**
 * Put each comment's pictures on it. Best-effort by design: a failed read of the picture index must
 * not hide the conversation, so the comments come back without pictures rather than not at all.
 */
export async function attachCommentAttachments(comments: DeductionsComment[]): Promise<DeductionsComment[]> {
  const ids = comments.map((comment) => comment.id);
  if (ids.length === 0) return comments;
  const byComment = new Map<string, DeductionsCommentAttachment[]>();
  try {
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await getSupabaseAdmin()
        .from("deductions_comment_attachments")
        .select(ATTACHMENT_COLUMNS)
        .in("comment_id", ids.slice(i, i + 100))
        .order("created_at", { ascending: true });
      if (error) return comments;
      for (const row of (data ?? []) as AttachmentRow[]) {
        const list = byComment.get(row.comment_id) ?? [];
        list.push(mapAttachment(row));
        byComment.set(row.comment_id, list);
      }
    }
  } catch {
    return comments;
  }
  return comments.map((comment) => ({ ...comment, attachments: byComment.get(comment.id) ?? [] }));
}

/**
 * One picture, for the person allowed to see it: the employee the deduction belongs to, or an admin
 * reader of the Deductions module. Anyone else is refused before a byte is read from storage.
 */
export async function readDisputeAttachmentForViewer(input: {
  access: AccessContext;
  attachmentId: string;
}): Promise<{ bytes: Uint8Array; contentType: DisputeAttachmentContentType; fileName: string }> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("deductions_comment_attachments")
    .select(ATTACHMENT_COLUMNS)
    .eq("id", input.attachmentId)
    .maybeSingle();
  if (error) throw error;
  const row = data as AttachmentRow | null;
  if (!row) throw new Error("Not found: that picture does not exist.");

  if (!isDeductionsReadActor(input.access)) {
    const { data: owner, error: ownerError } = await supabase
      .from("deductions_candidates")
      .select("employee_hr_id_compact")
      .eq("id", row.candidate_id)
      .maybeSingle();
    if (ownerError) throw ownerError;
    const ownerCompact = (owner as { employee_hr_id_compact?: string | null } | null)?.employee_hr_id_compact ?? null;
    const viewerCompact = compactDeductionsHrId(input.access.hrId ?? input.access.loginId);
    if (!ownerCompact || !viewerCompact || ownerCompact !== viewerCompact) {
      throw new Error("Forbidden: you cannot open this picture.");
    }
  }

  const download = await supabase.storage.from(DISPUTE_ATTACHMENT_BUCKET).download(row.storage_path);
  if (download.error || !download.data) throw new Error("Not found: that picture is no longer stored.");
  return {
    bytes: new Uint8Array(await download.data.arrayBuffer()),
    contentType: row.content_type as DisputeAttachmentContentType,
    fileName: row.file_name,
  };
}
