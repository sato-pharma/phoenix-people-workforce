import { NextResponse } from "next/server";

import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isUuid } from "@/lib/http/uuid";
import { ChromiumUnavailableError } from "@/lib/pdf/chromium";
import { buildCandidateApplicationFile } from "@/lib/recruitment/candidate-application-build";
import {
  APPLICATION_CV_PAGES_HEADER,
  APPLICATION_FILE_NAME_HEADER,
  APPLICATION_SHEET_PAGES_HEADER,
  attachmentDisposition,
} from "@/lib/recruitment/whatsapp-application-file";
import { canOpenWhatsAppApplications } from "@/lib/recruitment/whatsapp-application-access";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";
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
//
// THE BYTES ARE BUILT IN `candidate-application-build.ts`, NOT HERE — moved out on 2026-09-30, unchanged,
// when CV Lookup (app/api/recruitment/cv-lookup/[id]/application) became a second sender of the same file
// under a different gate. Two copies of the builder would let "the CV with its application" mean two
// different documents depending on which screen it was opened from.
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
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant's file answers as if absent.
    await assertCandidateVisible(access, id, "Application not found.");
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:recruitment:candidate-application",
    });

    const built = await buildCandidateApplicationFile(id);
    if (!built) {
      return NextResponse.json({ error: "not_found", message: "Application not found.", success: false }, { status: 404 });
    }

    // The saved file's name travels in a header (percent-encoded: a name may be Arabic) so the browser can
    // save the very bytes it printed from, without asking the server to build the PDF a second time.
    const headers: Record<string, string> = {
      "Cache-Control": "private, no-store",
      [APPLICATION_CV_PAGES_HEADER]: String(built.cvPages),
      [APPLICATION_FILE_NAME_HEADER]: encodeURIComponent(built.fileName),
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
        "Content-Disposition": attachmentDisposition(built.fileName),
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
