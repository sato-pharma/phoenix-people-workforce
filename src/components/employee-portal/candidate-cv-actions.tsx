"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { CvPreviewModal } from "@/components/recruitment/cv-preview-modal";
import { detectCvFileKind } from "@/lib/recruitment/cv-file-kind";

type CandidateFileSummary = { id: string; fileName: string; kind: string; mimeType: string | null };

/**
 * View CV / Download, for any candidate the caller is allowed to see.
 *
 * Shared by both cards below because the rule it encodes is not obvious and must not be re-derived:
 * "View CV" has to actually VIEW the CV. The bare file route serves Content-Disposition: attachment
 * unless asked for "inline", so a plain link saves the file and shows the manager nothing — and a
 * download manager will intercept it besides. The preview modal renders the real document, so it IS
 * the view action here; saving a copy sits beside it rather than being the only behaviour.
 */
export function CandidateCvActions({
  candidateId,
  initialFiles,
}: {
  candidateId: string;
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
  // "unsupported" means the preview modal cannot render this file type, so saving it is the only way
  // to read it — that is the one case where the CV button may still be a download.
  const cvKind = cvFile ? detectCvFileKind(cvFile.mimeType ?? "", cvFile.fileName) : "unsupported";
  const href = cvFile ? `/api/recruitment/hiring-manager/candidates/${candidateId}/files/${cvFile.id}` : "";

  if (!loaded) return null;
  if (!cvFile) return <p className="text-xs text-slate-400">No CV file on record.</p>;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {cvKind !== "unsupported" ? (
          <Button variant="secondary" onClick={() => setPreviewOpen(true)}>
            View CV — {cvFile.fileName}
          </Button>
        ) : null}
        <a
          className="inline-flex w-fit items-center rounded-md border border-gray-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"
          href={href}
          rel="noreferrer"
          target="_blank"
        >
          {cvKind === "unsupported" ? `Download — ${cvFile.fileName}` : "Download"}
        </a>
      </div>
      {previewOpen ? (
        <CvPreviewModal
          downloadUrl={href}
          fileName={cvFile.fileName}
          mimeType={cvFile.mimeType}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}
    </>
  );
}
