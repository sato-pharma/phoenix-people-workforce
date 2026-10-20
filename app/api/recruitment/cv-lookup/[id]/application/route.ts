import { NextResponse } from "next/server";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
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
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * CV LOOKUP — one candidate's CV with their application, as a single PDF.
 *
 * "full cv and application that she only search of find its cv with its application" is what the
 * owner asked for on 2026-09-30, so a hit opens exactly the file the screening page's own button
 * opens: the CV as it was sent, then the application sheet. The bytes come from
 * `buildCandidateApplicationFile`, shared with app/api/recruitment/candidates/[id]/application, so
 * the two doors cannot hand over different documents.
 *
 * ── WHY THIS ROUTE EXISTS RATHER THAN A WIDENED GATE NEXT DOOR ──────────────────────────────────
 *
 * The screening route asserts `candidates:read` and `canOpenWhatsAppApplications` — an HR authority
 * role holding recruitment:read AND candidates:read. Adding "…or cv_lookup:read" to that predicate
 * would have been one line, and it would have put the narrow grant inside the gate that guards the
 * pool's own file surface, where the next widening of either half reaches both. This route asserts
 * `cv_lookup:read` and nothing else; the screening route is untouched.
 *
 * ── THE FILE IS AUDITED, AND THAT ROW IS REQUIRED ───────────────────────────────────────────────
 *
 * `writeRequiredAuditLog`, not the best-effort writer the search uses: this is a real person's CV,
 * phone number and e-mail leaving the building, and an open that leaves no trace is treated as a
 * failed open rather than a quiet success. The row names the candidate, so "which CVs did this seat
 * actually read" is answerable without reconstructing it from search terms.
 *
 * The export rate limit is the same one the screening route carries, under its own scope so a busy
 * recruiter and this seat cannot exhaust each other's allowance.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "cv_lookup", "read");
    const { id } = await params;
    if (!isUuid(id)) {
      return NextResponse.json({ error: "not_found", message: "Application not found.", success: false }, { status: 404 });
    }
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant's file answers as if absent.
    await assertCandidateVisible(access, id, "Application not found.");
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:recruitment:cv-lookup-application",
    });

    const built = await buildCandidateApplicationFile(id);
    if (!built) {
      return NextResponse.json({ error: "not_found", message: "Application not found.", success: false }, { status: 404 });
    }

    const actor = access.loginId ?? access.hrId ?? null;
    await writeRequiredAuditLog({
      actorLoginId: actor,
      entityId: id,
      entityType: "cv_lookup_open",
      newValues: { candidateId: id, candidateName: built.name, cvPages: built.cvPages },
      summary: `CV Lookup opened the CV and application of ${built.name}`,
    });

    // The saved file's name travels in a header (percent-encoded: a name may be Arabic) so the browser
    // can save the very bytes it rendered from, without building the PDF a second time.
    const headers: Record<string, string> = {
      "Cache-Control": "private, no-store",
      [APPLICATION_CV_PAGES_HEADER]: String(built.cvPages),
      [APPLICATION_FILE_NAME_HEADER]: encodeURIComponent(built.fileName),
      [APPLICATION_SHEET_PAGES_HEADER]: String(built.sheetPages),
    };

    // Base64 text for the in-page reader: a response that looks like a downloadable PDF is what a
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
        { error: "pdf_unavailable", message: "The file could not be produced right now. Try again in a minute.", success: false },
        { status: 503 },
      );
    }
    return recruitmentApiError(error, "The file could not be produced right now.");
  }
}
