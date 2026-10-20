// Recruitment / ATS — which attachment IS the CV.
//
// Screening mode shows one document and never asks the reader to pick, so the choice has to be
// made here rather than by putting a file list on screen. A candidate can carry several
// attachments: earlier CV versions, a certificate photographed and sent over WhatsApp, an ID
// scan. Only files stored as `kind: "cv"` are candidates, only the ones this app can actually
// draw are eligible, and the newest wins.

import { detectCvFileKind } from "@/lib/recruitment/cv-file-kind";
import type { RecruitmentFile } from "@/lib/recruitment/types";

/**
 * The newest attachment that is both filed as a CV and renderable, or null.
 *
 * Null is a real answer and the caller must show it as one: 23 of the WhatsApp "photo CVs" in
 * production are certificates. Silently rendering nothing would read as a broken screen; saying
 * "no readable CV attached" is a fact the screener can act on.
 *
 * A legacy binary `.doc` was never excluded here — it answers "docx", a Word file — and since
 * 2026-09-27 it is genuinely drawable: read as text on the server (legacy-doc-text.ts).
 */
export function primaryCvFile(files: readonly RecruitmentFile[]): RecruitmentFile | null {
  const renderable = files.filter(
    (file) => file.kind === "cv" && detectCvFileKind(file.mimeType ?? "", file.fileName) !== "unsupported",
  );
  if (renderable.length === 0) return null;
  // Newest first. `createdAt` is an ISO string from Postgres, so a plain string compare is a
  // correct chronological compare and avoids constructing 426 Date objects to pick one file.
  return [...renderable].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))[0];
}

/** The CV file's own download — an attachment by default, exactly what the viewer's Download link points at. */
export function cvFileDownloadPath(fileId: string): string {
  return `/api/recruitment/files/${encodeURIComponent(fileId)}/download`;
}
