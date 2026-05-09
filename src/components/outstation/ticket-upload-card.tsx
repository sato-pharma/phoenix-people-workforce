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
        ? "Attach go and return tickets. The workflow uses attachment presence as evidence for ticket-based requests."
        : "Attach any supporting document for this expense request.";

  return (
    <Card className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_18px_40px_rgba(15,23,42,0.06)]">
      <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-500">
        Upload Attachment
      </p>
      <p className="mt-2 text-sm leading-6 text-slate-600">
        {description}
      </p>
      <label className="mt-4 flex cursor-pointer items-center justify-center gap-3 rounded-2xl border border-dashed border-orange-300 bg-orange-50 px-4 py-5 text-sm font-semibold text-orange-700">
        <Upload className="h-4 w-4" />
        {attachmentCount > 0 ? `${attachmentCount} attachment(s) selected` : "Select attachment(s)"}
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
