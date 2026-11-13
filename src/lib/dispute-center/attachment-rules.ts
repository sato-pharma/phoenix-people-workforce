// Where a calendar or weekly-review dispute picture lives, and how many a message may carry — pure,
// so a test runs it bare. WHICH bytes are a picture is the deductions rule (comment-attachment-rules.ts):
// one sniffing rule for every dispute picture in the system, so a file refused on one screen is never
// accepted on another.

import type { DisputeAttachmentContentType } from "@/lib/deductions/comment-attachment-rules.ts";

export {
  checkDisputeImage,
  DISPUTE_ATTACHMENT_MAX_BYTES,
  DISPUTE_ATTACHMENT_MAX_FILES,
  type CheckedDisputeImage,
} from "@/lib/deductions/comment-attachment-rules.ts";

export const DISPUTE_CENTER_BUCKET = "dispute-attachments";

/** The kinds whose pictures live in the shared table; deductions keep their own (built 2026-10-08). */
export type SharedAttachmentKind = "calendar" | "digest" | "daily";

const EXTENSION_BY_TYPE: Record<DisputeAttachmentContentType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * Keyed on the case and the picture's OWN uuid — the uploaded file name never reaches the storage key,
 * so a name cannot collide, traverse or leak.
 */
export function buildDisputeCenterAttachmentPath(input: {
  attachmentId: string;
  caseKind: SharedAttachmentKind;
  caseRef: string;
  contentType: DisputeAttachmentContentType;
}): string {
  const safe = (value: string) => value.trim().replace(/[^a-zA-Z0-9-]+/g, "");
  const caseRef = safe(input.caseRef);
  const attachmentId = safe(input.attachmentId);
  if (input.caseKind !== "calendar" && input.caseKind !== "digest" && input.caseKind !== "daily") {
    throw new Error("Cannot store a picture for an unknown kind of dispute.");
  }
  if (!caseRef || !attachmentId) throw new Error("Cannot store a picture without the dispute it belongs to.");
  return `${input.caseKind}/${caseRef}/${attachmentId}.${EXTENSION_BY_TYPE[input.contentType]}`;
}

/** The same-origin route that serves one picture after checking who is asking. */
export function disputeCenterAttachmentUrl(attachmentId: string) {
  return `/api/dispute-center/attachments/${encodeURIComponent(attachmentId)}`;
}
