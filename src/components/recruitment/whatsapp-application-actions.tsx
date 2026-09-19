"use client";

// Recruitment / ATS — the two buttons under an applicant's name on WhatsApp Applicants.
//
// The owner, 2026-09-19: beside the CV he already downloads, "download application" and "print
// application". Neither replaces the CV download, which is unchanged. What the application is — the CV as
// it was sent, then one page with every question and answer — is in
// src/lib/recruitment/whatsapp-application-sheet.ts and whatsapp-application-pdf.ts.
//
// PRINT is a link that opens the print page in a NEW tab. The list keeps the search he built (title,
// region, every filter), and none of it survives leaving the page, so a same-tab redirect would cost him
// his filters on every printout.
//
// DOWNLOAD is a button, not a link: building the file takes a few seconds, and a link gives no sign of
// life and turns a refusal (busy server, no permission) into a page of raw JSON. The button says it is
// working, saves the file when it arrives, and says in words when it could not.

import { Download, Loader2, Printer } from "lucide-react";
import * as React from "react";

import { Action, ActionLink } from "@/components/recruitment/workstation/workstation-look";
import { fetchWhatsAppApplication, saveBytesAsPdf } from "@/lib/recruitment/whatsapp-application-client";
import { applicationFileName, whatsAppApplicationPrintPath } from "@/lib/recruitment/whatsapp-application-file";
import { cn } from "@/lib/utils";

export function WhatsAppApplicationActions({
  applicantName,
  className,
  sessionId,
}: {
  applicantName: string;
  className?: string;
  sessionId: string;
}) {
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);

  const download = React.useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      const application = await fetchWhatsAppApplication(sessionId);
      saveBytesAsPdf(application.bytes, application.fileName || applicationFileName(applicantName));
    } catch (error) {
      setProblem(error instanceof Error && error.message.trim() !== "" ? error.message : "The application could not be produced right now.");
    } finally {
      setBusy(false);
    }
  }, [applicantName, sessionId]);

  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Action disabled={busy} onClick={() => void download()} title="Save the CV and the WhatsApp application sheet as one PDF">
          {busy ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <Download aria-hidden className="h-3.5 w-3.5" />}
          {busy ? "Preparing…" : "Download application"}
        </Action>
        <ActionLink
          href={whatsAppApplicationPrintPath(sessionId)}
          rel="noopener noreferrer"
          target="_blank"
          title="Open the CV and the WhatsApp application sheet, ready to print"
        >
          <Printer aria-hidden className="h-3.5 w-3.5" />
          Print application
        </ActionLink>
      </div>
      {problem ? (
        <p className="mt-1 break-words text-[11px] leading-snug text-red-700" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
