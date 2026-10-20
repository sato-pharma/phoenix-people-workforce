import { NextResponse } from "next/server";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

import { CvExtractionError, extractCandidateFieldsFromCv } from "@/lib/recruitment/cv-extraction";
import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";
import { assertSameOriginMutation, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";
import { isForbiddenError } from "@/lib/auth/server";
import { ApiError, clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Comfortably above the OpenAI client's own worst case (OPENAI_ROUTE_BUDGET_MS timeout x up
// to 2 attempts with maxRetries: 1), same reasoning as app/api/admin/email-ai/draft/route.ts.
export const maxDuration = 150;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "update");
    // Each call holds a serverless slot for up to 60s of upstream OpenAI time plus local PDF/
    // DOCX parsing — a per-actor limiter keeps even an authorized Talent Acquisition user from
    // amplifying spend by re-running extraction on the same or many CVs in a burst.
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.hrId || access.loginId, request }),
      limit: 10,
      scope: "recruitment_cv_extract",
      windowMs: 60_000,
    });
    const { id } = await params;
    await assertCandidateVisible(access, id);
    const body = (await request.json().catch(() => ({}))) as { positionKey?: unknown };
    const positionKey = typeof body.positionKey === "string" && body.positionKey ? body.positionKey : undefined;
    const result = await extractCandidateFieldsFromCv(id, access, positionKey);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: clientSafeErrorMessage(error, "Forbidden."), success: false },
        { status: 403 },
      );
    }
    // The Talent Acquisition fence's "not found" (owner, 2026-10-20), never an extraction failure.
    if (error instanceof ApiError && error.status === 404) {
      return NextResponse.json({ error: error.code, message: error.message, success: false }, { status: 404 });
    }
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: error.message, success: false },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    if (error instanceof CvExtractionError) {
      const status =
        error.code === "ai_not_configured"
          ? 503
          : error.code === "ai_rate_limited"
            ? 429
            : error.code === "no_cv_file" || error.code === "unsupported_file"
              ? 400
              : 502;
      return NextResponse.json({ error: error.code, message: error.message, success: false }, { status });
    }
    const message = clientSafeErrorMessage(error, "CV extraction failed.");
    return NextResponse.json({ error: "ai_failed", message, success: false }, { status: 500 });
  }
}
