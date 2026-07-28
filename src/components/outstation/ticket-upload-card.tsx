"use client";

import { Upload } from "lucide-react";

import { Card } from "@/components/ui/card";

export function TicketUploadCard({
  attachmentCount,
  onFilesSelected,
  transportationType,
  visible,
}: {
  attachmentCount: number;
  onFilesSelected: (files: FileList | null) => void;
  transportationType: "car" | "train" | "bus" | "other";
  visible: boolean;
}) {
  if (!visible) return null;

  const description =
    transportationType === "car"
      ? "Upload any supporting attachment for the trip if needed. The request amount still comes from the server calculation."
      : transportationType === "train" || transportationType === "bus"
        ? "Attach go and return tickets. Ticket-based requests use the attached tickets as proof of travel."
        : "Attach any supporting document for this expense request.";

  return (
    <Card className="rounded-lg border border-gray-100 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-5">
      <span className="rounded-md bg-orange-50 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-orange-600">
        Upload attachment
      </span>
      <p className="mt-2 text-[13px] leading-relaxed text-slate-500">{description}</p>
      <label className="mt-3 flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-orange-300 bg-orange-50/50 px-3 py-4 text-[13px] font-semibold text-orange-700 transition hover:bg-orange-50">
        <Upload className="h-4 w-4" />
        {attachmentCount > 0
          ? `${attachmentCount} attachment(s) selected`
          : "Select attachment(s)"}
        <input
          className="hidden"
          multiple
          onChange={(event) => onFilesSelected(event.target.files)}
          type="file"
        />
      </label>
    </Card>
  );
}
