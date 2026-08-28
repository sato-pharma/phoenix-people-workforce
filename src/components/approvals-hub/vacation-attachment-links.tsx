import { FileText } from "lucide-react";

import type { VacationRequestRecord } from "@/lib/vacation/types";

function attachmentUrl(row: VacationRequestRecord, kind: "compensatory" | "sick") {
  return `/api/vacations/requests/${encodeURIComponent(row.id)}/attachments/${kind}`;
}

// Mirrors VacationAttachmentLinks in src/components/vacation/vacation-report.tsx (same visual
// pattern) — kept as its own small component here rather than importing that one, so this new
// page never touches the existing report component.
export function VacationAttachmentLinks({
  canReviewAttachments,
  row,
}: {
  canReviewAttachments: boolean;
  row: VacationRequestRecord;
}) {
  if (!canReviewAttachments) return null;
  const attachments = [
    row.sickAttachmentObjectPath
      ? { href: attachmentUrl(row, "sick"), label: row.sickAttachmentOriginalName || "Medical document" }
      : null,
    row.compensatoryAttachmentObjectPath
      ? { href: attachmentUrl(row, "compensatory"), label: row.compensatoryAttachmentOriginalName || "Event photo" }
      : null,
  ].filter((attachment): attachment is { href: string; label: string } => Boolean(attachment));

  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {attachments.map((attachment) => (
        <a
          className="inline-flex items-center gap-1 rounded-sm border border-sky-200 bg-sky-50 px-2 py-1 text-phx-2xs font-bold text-sky-700 transition hover:border-sky-300 hover:bg-sky-100"
          href={attachment.href}
          key={attachment.href}
          rel="noreferrer"
          target="_blank"
          title={attachment.label}
        >
          <FileText className="h-3 w-3" />
          {attachment.label}
        </a>
      ))}
    </div>
  );
}
