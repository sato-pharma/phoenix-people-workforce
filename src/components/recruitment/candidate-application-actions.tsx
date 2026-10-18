"use client";

// Recruitment / ATS — "Download application" and "Print application" for ONE candidate, on the screening
// workstation's decision strip (owner, 2026-09-26: the WhatsApp Applicants buttons, on every CV in the
// screening page — "not only shortlisted, any CV").
//
// The candidate-keyed twin of WhatsAppApplicationActions. It behaves identically — Download builds the file
// and saves it, Print opens the print page in a new tab so the reader's list and filters survive — but it is
// keyed by CANDIDATE, so it reaches a CV whose person never applied on WhatsApp. There the file is the CV plus
// the Job application form filled from the record; where they did apply, it is the full WhatsApp application.
//
// DOWNLOAD is a button, not a link: building the file takes a few seconds, and a button can say it is working,
// save the file when it arrives, and say in words when it could not. PRINT is a link to a new tab.

import { AlertCircle, Download, Loader2, Printer } from "lucide-react";
import * as React from "react";

import { Action, ActionLink } from "@/components/recruitment/workstation/workstation-look";
import { fetchCandidateApplication, saveBytesAsPdf } from "@/lib/recruitment/whatsapp-application-client";
import { candidateApplicationFileName, candidateApplicationPrintPath } from "@/lib/recruitment/whatsapp-application-file";
import { cn } from "@/lib/utils";

export function CandidateApplicationActions({
  applicantName,
  candidateId,
  className,
}: {
  applicantName: string;
  candidateId: string;
  className?: string;
}) {
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);

  const download = React.useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      const application = await fetchCandidateApplication(candidateId);
      saveBytesAsPdf(application.bytes, application.fileName || candidateApplicationFileName(applicantName));
    } catch (error) {
      setProblem(
        error instanceof Error && error.message.trim() !== "" ? error.message : "The application could not be produced right now.",
      );
    } finally {
      setBusy(false);
    }
  }, [applicantName, candidateId]);

  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Action disabled={busy} onClick={() => void download()} title="Save the CV and the application sheet as one PDF">
          {busy ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <Download aria-hidden className="h-3.5 w-3.5" />}
          {busy ? "Preparing…" : "Download application"}
        </Action>
        <ActionLink
          href={candidateApplicationPrintPath(candidateId)}
          rel="noopener noreferrer"
          target="_blank"
          title="Open the CV and the application sheet, ready to print"
        >
          <Printer aria-hidden className="h-3.5 w-3.5" />
          Print application
        </ActionLink>
      </div>
      {/* Said in words under the two buttons, on a rose rule so it reads as this pair's own answer
          and not as a page error — and it WRAPS, because a server message has no length bound. */}
      {problem ? (
        <p
          className="mt-1.5 flex min-w-0 items-start gap-1.5 border-l-2 border-rose-500 bg-rose-50 px-2 py-1 text-[11px] font-semibold leading-snug text-rose-800"
          role="alert"
        >
          <AlertCircle aria-hidden className="mt-px h-3 w-3 shrink-0" />
          <span className="min-w-0 break-words">{problem}</span>
        </p>
      ) : null}
    </div>
  );
}
