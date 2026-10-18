"use client";

// Recruitment / ATS — the CV, open, in the middle of the screen.
//
// THIS IS THE POINT OF THE REBUILD. The document a recruiter is judging is the largest thing on the
// workstation and it is never behind a modal, a drawer or a click. Everything else on this screen —
// the queue, the list, the intelligence panel — is arranged around the fact that this pane is
// occupied for the whole session and only its contents change.
//
// THE RENDERER IS THE EXISTING ONE, UNTOUCHED. `CvDocumentView` already solves every hard part:
// pdf.js rasterising multi-page PDFs onto canvases (because a browser configured to download PDFs
// silently force-downloads an iframe preview), docx-preview painting real Word page layout,
// photographed CVs from WhatsApp as zoomable images, fit-to-width that re-measures when the column
// resizes, and manual zoom in CSS `zoom` so scrolling stays correct. Reimplementing any of that here
// would fork six months of production lessons into a second copy that drifts.
//
// SO THIS FILE IS ONLY THE FRAME: which file to show, what to say when there is none, and the two
// escapes a reader needs when a preview cannot render — download, and open in a tab.
//
// LOADING ONE CV NEVER BLOCKS THE PAGE. The pane owns its own loading and error states and the
// document is keyed by file id, so switching candidate tears the old document down rather than
// painting the new one underneath it — and the list, header and intelligence panel stay live and
// interactive the whole time.

import { Download, ExternalLink, FileWarning, Loader2 } from "lucide-react";

import { CvDocumentView } from "@/components/recruitment/cv-preview-modal";
import { ActionLink } from "@/components/recruitment/workstation/workstation-look";
import { EmptyNote, PaneHead } from "@/components/recruitment/workstation/workstation-ui";

export type CvPaneFile = {
  id: string;
  fileName: string;
  mimeType: string | null;
};

export function WorkstationCvPane({
  attachedCount,
  error,
  file,
  loading,
  notACv,
}: {
  /** How many files are on the record at all — the difference between "none" and "none readable". */
  attachedCount: number;
  error: string | null;
  file: CvPaneFile | null;
  loading: boolean;
  /** The CV reader judged the attached document not to be a CV. `isCv === false`, never `!isCv`. */
  notACv: boolean;
}) {
  const downloadUrl = file ? `/api/recruitment/files/${file.id}/download` : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-phx-surface-2">
      <PaneHead title="CV">
        {file && downloadUrl ? (
          <span className="ml-auto flex shrink-0 items-center gap-2">
            <span className="hidden max-w-[220px] break-all text-[11px] text-slate-300 md:inline">
              {file.fileName}
            </span>
            {/* Both are escapes, not actions — they exist for the day the preview cannot draw the
                file — so they take the quietest volume the kit has and get out of the document's
                way. They were two more hand-typed copies of the page's one button. On the pane's
                dark band since 2026-10-19, so they wear the kit's on-dark tone. */}
            <ActionLink
              className="px-2 py-1 text-[11px]"
              href={`${downloadUrl}?disposition=inline`}
              rel="noreferrer"
              target="_blank"
              title="Open this CV in its own browser tab"
              tone="onDark"
            >
              <ExternalLink aria-hidden className="h-3 w-3" />
              New tab
            </ActionLink>
            <ActionLink
              className="px-2 py-1 text-[11px]"
              href={downloadUrl}
              title="Save this CV to your machine"
              tone="onDark"
            >
              <Download aria-hidden className="h-3 w-3" />
              Download
            </ActionLink>
          </span>
        ) : null}
      </PaneHead>

      {notACv && file ? (
        /* Stated ABOVE the document rather than instead of it. The reader's verdict is frequently
           right and occasionally wrong — a scanned certificate and a photographed CV look alike to
           it — so the document still opens and a person still decides. */
        <p className="shrink-0 border-b border-phx-warn-line bg-phx-warn-bg px-3 py-1.5 text-[12px] font-semibold leading-tight text-phx-warn">
          The CV reader judged this document not to be a CV. It is shown anyway — read it and decide.
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="flex h-full items-center justify-center p-6 text-center">
            <p className="max-w-sm text-[13px] leading-relaxed text-phx-danger">{error}</p>
          </div>
        ) : loading ? (
          <div className="flex h-full items-center justify-center gap-2 p-6 text-phx-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-[13px]">Loading the CV…</span>
          </div>
        ) : file ? (
          <CvDocumentView
            className="min-h-full"
            downloadUrl={`/api/recruitment/files/${file.id}/download`}
            fileName={file.fileName}
            key={file.id}
            mimeType={file.mimeType}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center">
            {/* Two different facts, said differently, because they need different actions: chase the
                applicant, or open the file by hand. Said with the module's own empty state. */}
            <EmptyNote icon={<FileWarning aria-hidden className="h-5 w-5" />} title="No readable CV attached">
              {attachedCount === 0
                ? "No file is attached to this candidate."
                : `${attachedCount} file${attachedCount === 1 ? "" : "s"} on the record, none of them a CV this viewer can draw. Download from the candidate's folder to open it.`}
            </EmptyNote>
          </div>
        )}
      </div>
    </div>
  );
}
