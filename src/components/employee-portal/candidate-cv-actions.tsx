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
export function CandidateCvActions({ candidateId }: { candidateId: string }) {
  const [files, setFiles] = useState<CandidateFileSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await fetch(`/api/recruitment/hiring-manager/candidates/${candidateId}/files`);
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) throw new Error("files unavailable");
        if (!active) return;
        setFiles(Array.isArray(data.files) ? (data.files as CandidateFileSummary[]) : []);
      } catch {
        /* leave empty — the card still shows the candidate's own details */
      } finally {
        if (active) setLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [candidateId]);

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
