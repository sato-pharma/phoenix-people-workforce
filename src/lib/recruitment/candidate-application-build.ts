// Recruitment / ATS — building ONE candidate's application file: the CV as it was sent, then the
// application sheet.
//
// Lifted out of app/api/recruitment/candidates/[id]/application/route.ts on 2026-09-30, unchanged,
// because a SECOND route now sends the same file: CV Lookup, the search-only CV access the owner
// asked for that day. The two routes are gated on different resources on purpose — the screening
// page's on `candidates:read`, CV Lookup's on `cv_lookup:read` — but they must hand over the same
// bytes, or "the CV with its application" would mean two different documents depending on which
// screen you opened.
//
// Server-only: it reaches Chromium, sharp and mammoth through whatsapp-application-pdf.ts, none of
// which may enter a browser bundle. The small facts both halves need — the header names and the
// saved file's name — live in whatsapp-application-file.ts instead, which imports nothing.

import { loadCandidateApplication } from "@/lib/recruitment/candidate-application";
import { primaryCvFile } from "@/lib/recruitment/cv-file-choice";
import { getFileForDownload, listCandidateFiles } from "@/lib/recruitment/files";
import { applicationFileName, candidateApplicationFileName } from "@/lib/recruitment/whatsapp-application-file";
import { buildWhatsAppApplicationPdf, type ApplicationCvSource } from "@/lib/recruitment/whatsapp-application-pdf";

export type BuiltCandidateApplication = {
  bytes: Uint8Array;
  /** How many CV pages come first. Zero when the CV could not be included. */
  cvPages: number;
  fileName: string;
  /** The candidate's own name, for an audit row that says WHOSE file left the building. */
  name: string;
  sheetPages: number;
};

/**
 * The CV to put first, or the reason there is none.
 *
 * A CV that cannot be fetched does not stop the application: the sheet is still made and its footer
 * says the CV is missing and why. Mirrors the WhatsApp route's own loader so the two produce the
 * same footer sentences.
 */
async function loadCv(candidateId: string): Promise<{ cv: ApplicationCvSource | null; missingCvReason: string }> {
  try {
    const file = primaryCvFile(await listCandidateFiles(candidateId));
    if (!file) return { cv: null, missingCvReason: "no CV file is on record for this candidate." };
    const download = await getFileForDownload(file.id);
    if (!download) return { cv: null, missingCvReason: "the CV file is no longer in storage." };
    if (download.kind === "external") {
      return { cv: null, missingCvReason: "the CV is kept as a link, not a file. Open it from the candidate's page." };
    }
    return { cv: { bytes: download.bytes, fileName: download.fileName, mimeType: download.mimeType }, missingCvReason: "" };
  } catch {
    return {
      cv: null,
      missingCvReason:
        "the CV file could not be fetched from storage just now. Print again in a minute, or open it from the candidate's page.",
    };
  }
}

/** Null when the id names no candidate. Never throws for a missing CV — that becomes a footer line. */
export async function buildCandidateApplicationFile(candidateId: string): Promise<BuiltCandidateApplication | null> {
  const loaded = await loadCandidateApplication(candidateId);
  if (!loaded) return null;
  const { application, hasWhatsApp } = loaded;

  const { cv, missingCvReason } = await loadCv(application.row.candidateId);
  const built = await buildWhatsAppApplicationPdf({ application, cv, hasWhatsApp, missingCvReason });

  return {
    bytes: built.bytes,
    cvPages: built.cvPages,
    fileName: hasWhatsApp ? applicationFileName(application.row.name) : candidateApplicationFileName(application.row.name),
    name: application.row.name,
    sheetPages: built.sheetPages,
  };
}
