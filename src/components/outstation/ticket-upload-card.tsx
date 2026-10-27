"use client";

import { Upload } from "lucide-react";

/**
 * What the file picker will offer. Named to match exactly what the server accepts in
 * parseOutstationTicketAttachmentDataUrl — PDF, JPG, PNG — so the picker cannot hand back a file
 * the upload is about to refuse.
 *
 * `image/*` rather than the two image MIME types alone: on a phone that is what puts "Take Photo"
 * in the share sheet beside "Choose File", which is how the owner asked for this ("upload or take
 * a photo of the ticket"). A HEIC shot from an iPhone is converted to JPEG by the browser before
 * it reaches us; anything that still arrives as an unsupported type is refused server-side with
 * the reason named, which is the right place for that answer.
 */
export const TICKET_FILE_ACCEPT = "application/pdf,image/*";

export function TicketUploadCard({
  attachmentCount,
  badge,
  description: descriptionOverride,
  onFilesSelected,
  required = true,
  transportationType,
  visible,
}: {
  attachmentCount: number;
  /** Replaces the badge text — the Meeting/Other expense names its upload an invoice or picture. */
  badge?: string;
  /** Replaces the wording under the badge; the transport-based default is for a trip. */
  description?: string;
  onFilesSelected: (files: FileList | null) => void;
  /**
   * Whether a train/bus request is refused without a ticket. False for the roles waived on
   * 2026-08-19 (src/lib/outstation/evidence-waiver.ts). Defaults to true so a caller that has not
   * thought about it keeps the stricter behaviour.
   */
  required?: boolean;
  transportationType: "car" | "train" | "bus" | "other";
  visible: boolean;
}) {
  if (!visible) return null;

  const isTicketBased = transportationType === "train" || transportationType === "bus";
  const description =
    descriptionOverride ??
    (transportationType === "car"
      ? "Upload any supporting attachment for the trip if needed. The request amount still comes from the server calculation."
      : isTicketBased
        ? required
          ? "Attach go and return tickets as a PDF or a photo — they are kept as proof of travel. Without them the claim still submits, but it is held for review until you attach them from My claims."
          : "Optional for your role. If you have the tickets, attach them as a PDF or a photo — you can take the photo here. The request submits either way."
        : "Attach any supporting document for this expense request.");

  // A block inside the Evidence step, not a card of its own — the step form already draws the one
  // card on the screen. Square, like every block of the form (the square-edge golden rule).
  return (
    <section aria-label={badge ?? "Ticket"} className="grid gap-3 border border-slate-200 bg-white p-4">
      <div>
        <p className="text-phx-2xs font-black uppercase tracking-[0.18em] text-orange-600">
          {badge ?? (isTicketBased ? (required ? "Ticket · Required" : "Ticket · Optional") : "Attachment")}
        </p>
        <p className="mt-1 text-sm leading-6 text-slate-600">{description}</p>
      </div>
      <label className="flex min-h-12 cursor-pointer items-center justify-center gap-2 border border-dashed border-orange-400 bg-orange-50 px-3 py-3 text-sm font-bold text-orange-800 transition hover:bg-orange-100">
        <Upload aria-hidden className="h-4 w-4" />
        {attachmentCount > 0
          ? `${attachmentCount} file${attachmentCount === 1 ? "" : "s"} attached — tap to change`
          : "Take a photo or choose a file"}
        <input
          accept={TICKET_FILE_ACCEPT}
          className="hidden"
          multiple
          onChange={(event) => onFilesSelected(event.target.files)}
          type="file"
        />
      </label>
    </section>
  );
}
