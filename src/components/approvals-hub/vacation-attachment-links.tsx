import { FileText } from "lucide-react";

import { LANDING_FOCUS, LANDING_INK } from "@/components/employee-portal/landing-kit";
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
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {attachments.map((attachment) => (
        <a
          className={`inline-flex min-w-0 items-center gap-1 break-all text-phx-xs font-bold underline decoration-slate-300 underline-offset-4 transition-colors hover:decoration-[#08111f] motion-reduce:transition-none ${LANDING_INK} ${LANDING_FOCUS}`}
          href={attachment.href}
          key={attachment.href}
          rel="noreferrer"
          target="_blank"
          title={attachment.label}
        >
          <FileText aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          {attachment.label}
        </a>
      ))}
    </div>
  );
}
