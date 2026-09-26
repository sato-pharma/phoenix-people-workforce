import { NextResponse } from "next/server";

import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isUuid } from "@/lib/http/uuid";
import { ChromiumUnavailableError } from "@/lib/pdf/chromium";
import { loadCandidateApplication } from "@/lib/recruitment/candidate-application";
import { primaryCvFile } from "@/lib/recruitment/cv-file-choice";
import { getFileForDownload, listCandidateFiles } from "@/lib/recruitment/files";
import {
  APPLICATION_CV_PAGES_HEADER,
  APPLICATION_FILE_NAME_HEADER,
  APPLICATION_SHEET_PAGES_HEADER,
  applicationFileName,
  attachmentDisposition,
  candidateApplicationFileName,
} from "@/lib/recruitment/whatsapp-application-file";
import { buildWhatsAppApplicationPdf, type ApplicationCvSource } from "@/lib/recruitment/whatsapp-application-pdf";
import { canOpenWhatsAppApplications } from "@/lib/recruitment/whatsapp-application-access";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET — one CANDIDATE's application as a PDF: the CV as it was sent, then the application sheet. It is the
// screening page's "Download application" on ANY CV (owner, 2026-09-26), not only the WhatsApp applicants:
// when the person applied on WhatsApp the sheet carries their questions and answers, and when they did not
// it is the plain Job application form filled from the record. "Print application" opens the print page,
// which asks for `?format=base64` and draws these same pages, so the two cannot differ.
//
// Gated by the same predicate as the WhatsApp file itself (`canOpenWhatsAppApplications`): an HR authority
// role with recruitment:read AND candidates:read, because the file names a person, their phone and email and
// opens their CV. The id is a candidate; the screening page that offers the button already passes this gate.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "candidates", "read");
    if (!(await canOpenWhatsAppApplications(access))) {
      return NextResponse.json(
        { error: "forbidden", message: "Your account cannot open applications.", success: false },
        { status: 403 },
      );
    }
    const { id } = await params;
    if (!isUuid(id)) {
      return NextResponse.json({ error: "not_found", message: "Application not found.", success: false }, { status: 404 });
    }
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:recruitment:candidate-application",
    });

    const loaded = await loadCandidateApplication(id);
    if (!loaded) {
      return NextResponse.json({ error: "not_found", message: "Application not found.", success: false }, { status: 404 });
    }
    const { application, hasWhatsApp } = loaded;

    const { cv, missingCvReason } = await loadCv(application.row.candidateId);
    const built = await buildWhatsAppApplicationPdf({ application, cv, hasWhatsApp, missingCvReason });

    // The saved file's name travels in a header (percent-encoded: a name may be Arabic) so the browser can
    // save the very bytes it printed from, without asking the server to build the PDF a second time.
    const fileName = hasWhatsApp
      ? applicationFileName(application.row.name)
      : candidateApplicationFileName(application.row.name);
    const headers: Record<string, string> = {
      "Cache-Control": "private, no-store",
      [APPLICATION_CV_PAGES_HEADER]: String(built.cvPages),
      [APPLICATION_FILE_NAME_HEADER]: encodeURIComponent(fileName),
      [APPLICATION_SHEET_PAGES_HEADER]: String(built.sheetPages),
    };

    // The print page's renderer asks for text: a response that looks like a downloadable PDF is what a
    // download-manager extension cancels (src/lib/recruitment/file-response.ts).
    if (new URL(request.url).searchParams.get("format") === "base64") {
      return new NextResponse(Buffer.from(built.bytes).toString("base64"), {
        headers: { ...headers, "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" },
        status: 200,
      });
    }
    return new NextResponse(Buffer.from(built.bytes) as unknown as BodyInit, {
      headers: {
        ...headers,
        "Content-Disposition": attachmentDisposition(fileName),
        "Content-Type": "application/pdf",
      },
      status: 200,
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: error.message, success: false },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    if (error instanceof ChromiumUnavailableError) {
      return NextResponse.json(
        { error: "pdf_unavailable", message: "The application could not be produced right now. Try again in a minute.", success: false },
        { status: 503 },
      );
    }
    return recruitmentApiError(error, "The application could not be produced right now.");
  }
}

/**
 * The CV to put first, or the reason there is none. A CV that cannot be fetched does not stop the
 * application: the sheet is still made and its footer says the CV is missing and why. Mirrors the WhatsApp
 * route's own loader so the two produce the same footer sentences.
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
      missingCvReason: "the CV file could not be fetched from storage just now. Print again in a minute, or open it from the candidate's page.",
    };
  }
}
