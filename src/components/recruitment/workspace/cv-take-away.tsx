"use client";

// Recruitment workspace — taking a CV away on paper or as a file (owner, 20 Oct 2026: "download CV,
// download CV plus application, print CV and application").
//
// Three buttons on the opened CV, one beside the other:
//   • Download CV — the CV file itself, as it was received (the same file the viewer draws).
//   • Download CV + application — ONE PDF: the CV, then the application sheet (every WhatsApp question
//     and answer, or the Job application form filled from the record when the person never chatted).
//   • Print CV + application — the same PDF on its print page, in a new tab so the list, its filters and
//     the opened CV survive.
//
// NOTHING NEW IS BUILT HERE. The combined file, its print page and its gate are the screening page's own
// (`/api/recruitment/candidates/<id>/application`, `/print/candidate-application/<id>`), keyed by the
// candidate, so a CV whose person never applied on WhatsApp is reached too. They need `candidates: read`
// and the Talent Acquisition fence answers an HR applicant as not-found, so the CEO — who reads the
// workspace without that grant — is not offered them (the caller draws this only for a seat that works).
//
// The CV file's id is read when the button is pressed, not before: the viewer already holds the list for
// its own use, and a second read per opened CV for a press that may never come is waste.

import { AlertCircle, Download, FileDown, Loader2, Printer } from "lucide-react";
import { useCallback, useState } from "react";

import { getJson } from "@/components/recruitment/recruitment-fetch";
import { cvGhostButton } from "@/components/recruitment/workspace/cv-actions";
import { errorText } from "@/components/recruitment/workspace/workspace-format";
import { cvFileDownloadPath, primaryCvFile } from "@/lib/recruitment/cv-file-choice";
import type { RecruitmentFile } from "@/lib/recruitment/types";
import { fetchCandidateApplication, saveBytesAsPdf } from "@/lib/recruitment/whatsapp-application-client";
import { candidateApplicationFileName, candidateApplicationPrintPath } from "@/lib/recruitment/whatsapp-application-file";
import { cn } from "@/lib/utils";

/** Hands a URL to the browser as a save, through a temporary link. */
function saveFromUrl(url: string, fileName: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function CvTakeAway({ candidateId, className, name }: { candidateId: string; className?: string; name: string }) {
  const [busy, setBusy] = useState<"cv" | "application" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const downloadCv = useCallback(async () => {
    setBusy("cv");
    setProblem(null);
    try {
      const data = await getJson(`/api/recruitment/candidates/${encodeURIComponent(candidateId)}`);
      const profile = (data.profile ?? {}) as { files?: RecruitmentFile[] };
      const file = primaryCvFile(profile.files ?? []);
      if (!file) throw new Error("No readable CV is attached to this candidate.");
      saveFromUrl(cvFileDownloadPath(file.id), file.fileName);
    } catch (error) {
      setProblem(errorText(error, "The CV could not be downloaded right now."));
    } finally {
      setBusy(null);
    }
  }, [candidateId]);

  const downloadApplication = useCallback(async () => {
    setBusy("application");
    setProblem(null);
    try {
      const application = await fetchCandidateApplication(candidateId);
      saveBytesAsPdf(application.bytes, application.fileName || candidateApplicationFileName(name));
    } catch (error) {
      setProblem(errorText(error, "The application could not be produced right now."));
    } finally {
      setBusy(null);
    }
  }, [candidateId, name]);

  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          className={cvGhostButton}
          disabled={busy !== null}
          onClick={() => void downloadCv()}
          title="Save the CV file as it was received"
          type="button"
        >
          {busy === "cv" ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <FileDown aria-hidden className="h-3.5 w-3.5" />}
          Download CV
        </button>
        <button
          className={cvGhostButton}
          disabled={busy !== null}
          onClick={() => void downloadApplication()}
          title="Save the CV and the application sheet as one PDF"
          type="button"
        >
          {busy === "application" ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <Download aria-hidden className="h-3.5 w-3.5" />}
          {busy === "application" ? "Preparing…" : "Download CV + application"}
        </button>
        <a
          className={cvGhostButton}
          href={candidateApplicationPrintPath(candidateId)}
          rel="noopener noreferrer"
          target="_blank"
          title="Open the CV and the application sheet, ready to print"
        >
          <Printer aria-hidden className="h-3.5 w-3.5" />
          Print CV + application
        </a>
      </div>
      {problem ? (
        <p
          className="mt-1.5 flex min-w-0 items-start gap-1.5 border-l-2 border-rose-500 bg-rose-50 px-2 py-1 text-xs font-semibold leading-snug text-rose-800"
          role="alert"
        >
          <AlertCircle aria-hidden className="mt-px h-3 w-3 shrink-0" />
          <span className="min-w-0 break-words">{problem}</span>
        </p>
      ) : null}
    </div>
  );
}
