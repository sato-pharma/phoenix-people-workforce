"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { CvPreviewModal } from "@/components/recruitment/cv-preview-modal";
import { ScheduleInterviewButton } from "@/components/recruitment/interview-calendar/schedule-interview-button";
import { detectCvFileKind } from "@/lib/recruitment/cv-file-kind";

type CandidateFileSummary = { id: string; fileName: string; kind: string; mimeType: string | null };

/**
 * View CV, for any candidate the caller is allowed to see — and Download, for the manager holding the
 * "I will call" reservation on this CV.
 *
 * THE DOWNLOAD FOLLOWS THE PHONE NUMBER. The owner blocked it on 2026-09-09 (*"the download to be
 * blocked of the cv"*) and on 2026-10-13 asked for managers to download any CV; the original file
 * prints the number the reservation reveals, so he chose: download only after "I will call". The
 * same flag that unmasks the number (`showPhoneNumbers`) therefore opens the download, so the two
 * cannot drift. Before the reservation the preview renders the real thing — pages, tables,
 * photographed CVs — with the numbers painted out, and nothing he needs to judge somebody is missing.
 *
 * THE SERVER IS WHAT ENFORCES IT. This file only decides what to OFFER; the route behind it serves
 * the bytes as a file solely to the reservation holder and otherwise answers only the in-page base64
 * render — see app/api/recruitment/hiring-manager/candidates/[candidateId]/files/[fileId]/route.ts.
 * A button that is not there while the URL still works is not a block, and that URL is one
 * right-click away.
 *
 * WHY "VIEW CV" WAS NEVER A LINK, WHICH IS WHY THIS STILL WORKS. The bare file route used to serve
 * Content-Disposition: attachment unless asked for "inline", so a plain link saved the file and
 * showed the manager nothing — and a download-manager extension would intercept it besides. The
 * preview modal renders the real document, so it always WAS the view action; only the save-a-copy
 * link beside it has gone.
 */
export function CandidateCvActions({
  candidateId,
  candidateName,
  initialFiles,
  showPhoneNumbers = false,
}: {
  candidateId: string;
  /**
   * Who the CV belongs to, for the preview's Schedule interview button. That button draws only for
   * someone the interview calendar's owner made an editor, so on most managers' screens it is absent.
   */
  candidateName?: string | null;
  /**
   * TRUE only for the manager holding the reservation on this candidate.
   *
   * HIDING THE FIELD WAS NEVER THE WHOLE JOB. A CV prints its own contact details, so the number
   * the card had just taken away was back in 14pt the moment anyone pressed View CV. The owner saw
   * exactly that on 2026-09-09. This is the same rule as the Phone field beside it, applied to the
   * document: one manager may read the number, and until somebody takes the call, nobody may.
   */
  showPhoneNumbers?: boolean;
  /**
   * The candidate's files, when the caller already has them.
   *
   * A list screen must hand these down rather than let each card ask. The team view renders one card
   * per CV, and per-card fetching meant one request each, every one of them re-authorising by
   * walking the org chart — the buttons took about fifteen seconds to appear, which the owner
   * correctly read as the CV control being missing. When this is given, no request is made at all.
   */
  initialFiles?: CandidateFileSummary[] | null;
}) {
  // Only the FETCHED case needs state. When the caller hands the files down there is nothing to
  // load, nothing to store and nothing to wait for, so the props are read straight through during
  // render — no effect runs, and no state is set synchronously inside one (which this repo lints as
  // an error, correctly: it is a cascading re-render on every card).
  const [fetched, setFetched] = useState<CandidateFileSummary[] | null>(null);
  const [fetchSettled, setFetchSettled] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    // An empty ARRAY is still an answer — "the list already looked, this candidate has no files" —
    // so it must not fall through to a fetch that would ask the same question again per card.
    if (initialFiles) return;
    let active = true;
    void (async () => {
      try {
        const res = await fetch(`/api/recruitment/hiring-manager/candidates/${candidateId}/files`);
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) throw new Error("files unavailable");
        if (!active) return;
        setFetched(Array.isArray(data.files) ? (data.files as CandidateFileSummary[]) : []);
      } catch {
        /* leave empty — the card still shows the candidate's own details */
      } finally {
        if (active) setFetchSettled(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [candidateId, initialFiles]);

  const files = initialFiles ?? fetched ?? [];
  const loaded = Boolean(initialFiles) || fetchSettled;

  const cvFile = files.find((file) => file.kind === "cv");
  // "unsupported" means the preview cannot render this file type at all. There is nothing to open,
  // so the card says so in words rather than opening a preview whose only content would be the same
  // sentence; the reservation holder gets the Download link below instead.
  //
  // A WORD 97-2003 .doc IS NO LONGER ONE OF THEM. It answers "docx" here (a Word file), and since
  // 2026-09-27 the preview reads it as text on the server — legacy-doc-text.ts. So a manager gets
  // View CV for those 13 files instead of a sentence, and this branch is left for the formats that
  // genuinely have no reader.
  const cvKind = cvFile ? detectCvFileKind(cvFile.mimeType ?? "", cvFile.fileName) : "unsupported";
  const href = cvFile ? `/api/recruitment/hiring-manager/candidates/${candidateId}/files/${cvFile.id}` : "";

  if (!loaded) return null;
  if (!cvFile) return <p className="text-xs text-slate-400">No CV file on record.</p>;

  return (
    <>
      {/* THE FILE NAME IS ITS OWN LINE, not part of the button label, and that is a measurement
          rather than a preference. A Button here is `shrink-0 whitespace-nowrap`, so "View CV —
          Upper Egypt district Manager Sales.pdf" pinned the control to 415px inside a 351px column
          at 375px — and the page does not scroll sideways, so the name was CLIPPED, which is the
          worse half of the owner's fits-the-screen rule: content unreachable rather than merely off
          to the side. Wrapping is the permitted answer and truncation is never one, so the whole
          name is printed underneath and breaks where it must. */}
      <div className="space-y-1">
        {cvKind !== "unsupported" ? (
          <>
            <Button variant="secondary" onClick={() => setPreviewOpen(true)}>
              View CV
            </Button>
            <p className="break-words text-xs text-slate-500" dir="auto">
              {cvFile.fileName}
            </p>
          </>
        ) : showPhoneNumbers ? (
          <p className="break-words text-xs text-slate-400" dir="auto">
            {cvFile.fileName} is an older format that cannot be shown on screen. Download it below.
          </p>
        ) : (
          <p className="break-words text-xs text-slate-400" dir="auto">
            {cvFile.fileName} is an older format that cannot be shown on screen. Press &ldquo;I will
            call&rdquo; to download it.
          </p>
        )}
        {showPhoneNumbers ? (
          <a
            className="inline-block text-xs font-semibold text-slate-700 underline underline-offset-2 hover:text-slate-900"
            href={href}
            rel="noreferrer"
            target="_blank"
          >
            Download CV
          </a>
        ) : (
          <p className="text-xs text-slate-400">Press &ldquo;I will call&rdquo; to download this CV.</p>
        )}
      </div>
      {previewOpen ? (
        <CvPreviewModal
          allowDownload={showPhoneNumbers}
          downloadUrl={href}
          fileName={cvFile.fileName}
          headerActions={
            candidateName ? <ScheduleInterviewButton candidate={{ id: candidateId, name: candidateName }} /> : null
          }
          mimeType={cvFile.mimeType}
          onClose={() => setPreviewOpen(false)}
          redactPhones={!showPhoneNumbers}
        />
      ) : null}
    </>
  );
}
