"use client";

import { Upload } from "lucide-react";

import { Card } from "@/components/ui/card";

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
const TICKET_FILE_ACCEPT = "application/pdf,image/*";

export function TicketUploadCard({
  attachmentCount,
  onFilesSelected,
  required = true,
  transportationType,
  visible,
}: {
  attachmentCount: number;
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
    transportationType === "car"
      ? "Upload any supporting attachment for the trip if needed. The request amount still comes from the server calculation."
      : isTicketBased
        ? required
          ? "Attach go and return tickets — required to submit a train or bus request. They are kept as proof of travel. PDF or photo."
          : "Optional for your role. If you have the tickets, attach them as a PDF or a photo — you can take the photo here. The request submits either way."
        : "Attach any supporting document for this expense request.";

  return (
    <Card className="rounded-lg border border-gray-100 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-5">
      <span className="rounded-md bg-orange-50 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-orange-600">
        {isTicketBased && !required ? "Upload attachment · Optional" : "Upload attachment"}
      </span>
      <p className="mt-2 text-[13px] leading-relaxed text-slate-500">{description}</p>
      <label className="mt-3 flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-orange-300 bg-orange-50/50 px-3 py-4 text-[13px] font-semibold text-orange-700 transition hover:bg-orange-50">
        <Upload className="h-4 w-4" />
        {attachmentCount > 0
          ? `${attachmentCount} attachment(s) selected`
          : "Select attachment(s)"}
        <input
          accept={TICKET_FILE_ACCEPT}
          className="hidden"
          multiple
          onChange={(event) => onFilesSelected(event.target.files)}
          type="file"
        />
      </label>
    </Card>
  );
}
