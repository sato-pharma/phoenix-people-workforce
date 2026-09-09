"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { CvPreviewModal } from "@/components/recruitment/cv-preview-modal";
import { detectCvFileKind } from "@/lib/recruitment/cv-file-kind";

type CandidateFileSummary = { id: string; fileName: string; kind: string; mimeType: string | null };

/**
 * View CV, for any candidate the caller is allowed to see. READ ONLY — there is no download here.
 *
 * THE DOWNLOAD IS GONE, AND ITS ABSENCE IS THE FEATURE. The owner, 2026-09-09: *"the download to be
 * blocked of the cv"*. A manager reads the CV on the screen and answers on the screen; he does not
 * keep the document. The preview renders the real thing — pages, tables, photographed CVs — so
 * nothing he needs in order to judge somebody has been taken away with it.
 *
 * THE SERVER IS WHAT ENFORCES IT. This file only stops OFFERING the control; the route behind it
 * refuses to serve the bytes as a file at all and answers only the in-page base64 render — see
 * app/api/recruitment/hiring-manager/candidates/[candidateId]/files/[fileId]/route.ts. Removing a
 * button while the URL still works is not blocking a download, and that URL is one right-click away.
 *
 * WHY "VIEW CV" WAS NEVER A LINK, WHICH IS WHY THIS STILL WORKS. The bare file route used to serve
 * Content-Disposition: attachment unless asked for "inline", so a plain link saved the file and
 * showed the manager nothing — and a download-manager extension would intercept it besides. The
 * preview modal renders the real document, so it always WAS the view action; only the save-a-copy
 * link beside it has gone.
 */
export function CandidateCvActions({
  candidateId,
  initialFiles,
  showPhoneNumbers = false,
}: {
  candidateId: string;
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
  // "unsupported" means the preview cannot render this file type — a legacy binary .doc, in
  // practice. That used to be the one case where the CV button was allowed to be a download, and it
  // no longer can be: there is nowhere left for such a file to go, so the card says so in words
  // rather than opening a preview whose only content would be the same sentence.
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
        ) : (
          <p className="break-words text-xs text-slate-400" dir="auto">
            {cvFile.fileName} is an older Word format that cannot be shown on screen. Ask the
            recruitment team to send you a readable copy.
          </p>
        )}
      </div>
      {previewOpen ? (
        <CvPreviewModal
          allowDownload={false}
          downloadUrl={href}
          fileName={cvFile.fileName}
          mimeType={cvFile.mimeType}
          onClose={() => setPreviewOpen(false)}
          redactPhones={!showPhoneNumbers}
        />
      ) : null}
    </>
  );
}
