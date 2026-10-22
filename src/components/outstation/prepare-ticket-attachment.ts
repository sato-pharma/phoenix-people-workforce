"use client";

import {
  checkTicketAttachmentFile,
  jpegFileName,
  TICKET_IMAGE_FALLBACK_QUALITY,
  TICKET_IMAGE_MAX_DIMENSION,
  TICKET_IMAGE_QUALITY,
  TICKET_PDF_MAX_BYTES,
} from "@/lib/outstation/ticket-attachment-limits";

/**
 * Turning a picked ticket file into what the server accepts — ONE copy, shared by the submit
 * wizard and the card that attaches a ticket a claim arrived without (missing-ticket-card.tsx).
 * Two copies of a file-to-upload path is how one of them starts refusing what the other sends.
 */

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read the selected file."));
    reader.readAsDataURL(file);
  });
}

/**
 * One ticket or invoice, ready to send.
 *
 * A photo is decoded and re-encoded as a JPEG no longer than TICKET_IMAGE_MAX_DIMENSION on its
 * long side — the same canvas route the arrival photo takes — because the server refuses anything
 * over 5 MB and a phone camera shot is routinely larger, and a HEIC or WebP file (which the picker
 * offers as `image/*`) is not a type the server accepts at all. A PDF cannot be shrunk here, so it
 * goes as it is; checkTicketAttachmentFile has already held it to the size cap.
 */
export async function prepareTicketAttachment(file: File): Promise<{ dataUrl: string; name: string }> {
  const verdict = checkTicketAttachmentFile(file);
  if (!verdict.ok) throw new Error(verdict.message);

  if (verdict.kind === "pdf") {
    return { dataUrl: await fileToDataUrl(file), name: file.name };
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () =>
        reject(
          new Error(
            `"${file.name}" could not be read as a photo on this phone. Take the photo again, or choose a JPG, PNG or PDF.`,
          ),
        );
      element.src = objectUrl;
    });

    const scale = Math.min(
      1,
      TICKET_IMAGE_MAX_DIMENSION / Math.max(image.naturalWidth || 1, image.naturalHeight || 1),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round((image.naturalWidth || 1) * scale));
    canvas.height = Math.max(1, Math.round((image.naturalHeight || 1) * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Unable to process the selected photo.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    let dataUrl = canvas.toDataURL("image/jpeg", TICKET_IMAGE_QUALITY);
    // Roughly 4.5 MB decoded: over that, try once more at a lower quality before giving up.
    if (dataUrl.length > TICKET_PDF_MAX_BYTES * 1.37) {
      dataUrl = canvas.toDataURL("image/jpeg", TICKET_IMAGE_FALLBACK_QUALITY);
    }
    return { dataUrl, name: jpegFileName(file.name) };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
