// Sales mailbox intake — deciding which email attachments are candidate distributor workbooks.
//
// Pure, no I/O: this is the one place that says what the poller will pick up out of a mailbox that
// also carries ordinary human correspondence, and it is worth being able to test that decision
// with plain fixture objects rather than against a live inbox.

/** What the importer itself accepts (`salesSpreadsheetValidation`). Kept deliberately identical:
 *  offering the wizard a file it will then refuse is worse than not offering it at all. */
const WORKBOOK_EXTENSIONS = [".xlsx", ".xls"] as const;

/**
 * The largest attachment worth pulling out of a mailbox and parking in storage.
 *
 * Deliberately well ABOVE the importer's own 10MB limit rather than equal to it. A 12MB workbook
 * is a real distributor file that a person needs to know arrived — the import will refuse it with
 * a message they can act on ("ask them to split it"), which is a far better outcome than the file
 * never being mentioned. The ceiling exists only to stop something pathological — a video, a
 * mis-sent archive — being copied into the bucket.
 */
export const MAX_ARRIVAL_BYTES = 25 * 1024 * 1024;

export type MailAttachment = {
  filename?: string | false | null;
  contentType?: string | null;
  size?: number | null;
  content?: Buffer | null;
  /** mailparser marks inline images (signatures, logos) with a content-id / inline disposition. */
  contentDisposition?: string | null;
  related?: boolean;
};

export type WorkbookAttachment = {
  /** Position among the message's workbook attachments — part of the arrival's identity key. */
  index: number;
  fileName: string;
  contentType: string | null;
  bytes: Buffer;
  size: number;
};

export function hasWorkbookExtension(fileName: string): boolean {
  const lower = String(fileName ?? "").trim().toLowerCase();
  return WORKBOOK_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * The workbook attachments of one message, in order, with everything else dropped.
 *
 * Filtered by FILE EXTENSION rather than by MIME type on purpose. Distributor exports reach this
 * mailbox from a wide spread of ERP systems and mail clients, and a workbook routinely arrives
 * labelled `application/octet-stream` — matching on MIME would silently miss real files, and the
 * cost of being wrong in the other direction is only that a person sees one row they dismiss.
 *
 * Inline parts (`related`) are excluded: an email signature's logo is an attachment too, and it is
 * never a sales file.
 */
export function pickWorkbookAttachments(
  attachments: readonly MailAttachment[] | undefined | null,
): WorkbookAttachment[] {
  const picked: WorkbookAttachment[] = [];
  for (const attachment of attachments ?? []) {
    if (!attachment) continue;
    if (attachment.related) continue;
    const fileName = typeof attachment.filename === "string" ? attachment.filename.trim() : "";
    if (!fileName || !hasWorkbookExtension(fileName)) continue;
    const bytes = attachment.content;
    if (!bytes || bytes.length === 0) continue;
    if (bytes.length > MAX_ARRIVAL_BYTES) continue;
    picked.push({
      bytes,
      contentType: attachment.contentType ?? null,
      fileName,
      index: picked.length,
      size: bytes.length,
    });
  }
  return picked;
}

/** Attachments that look like workbooks but were too large to park. Reported, never dropped
 *  silently — a distributor whose file suddenly stops arriving must be visible somewhere. */
export function countOversizeWorkbooks(attachments: readonly MailAttachment[] | undefined | null): number {
  let count = 0;
  for (const attachment of attachments ?? []) {
    if (!attachment || attachment.related) continue;
    const fileName = typeof attachment.filename === "string" ? attachment.filename.trim() : "";
    if (!fileName || !hasWorkbookExtension(fileName)) continue;
    const length = attachment.content?.length ?? 0;
    if (length > MAX_ARRIVAL_BYTES) count += 1;
  }
  return count;
}

/**
 * A storage-safe object name for an arrival.
 *
 * The distributor's own file name is preserved as far as it can be, because it is what the person
 * will recognise in the wizard ("EGD_July.xlsx"), but it reaches us from arbitrary mail clients
 * and can carry anything at all — including path separators.
 */
export function sanitizeArrivalFileName(name: string): string {
  const cleaned = String(name ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const safe = cleaned || "arrival.xlsx";
  const named = hasWorkbookExtension(safe) ? safe : `${safe}.xlsx`;
  // A wholly non-Latin name ("تقرير.xlsx", an entirely ordinary thing for an Egyptian distributor
  // to send) reduces to nothing but its extension. Storage would take the key, but it is not a
  // name — so it gets one. The row's `file_name` keeps the original regardless, and that is what
  // the wizard shows the reader.
  return named.startsWith(".") ? `arrival${named}` : named;
}
