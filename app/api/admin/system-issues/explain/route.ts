import { NextResponse, type NextRequest } from "next/server";

import { explainError } from "@/lib/error-monitor/ai-triage";
import { hasAiApiKey, PhoenixOpenAiError } from "@/lib/ai/openai-client";
import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    const allowed = access.role === "CEO" || canAccessSystemAdministratorWorkspace(access);
    if (!allowed) {
      return NextResponse.json({ message: "Forbidden: insufficient permissions." }, { status: 403 });
    }
    if (!hasAiApiKey()) {
      return NextResponse.json({ message: "AI triage is not configured (no OpenAI key)." }, { status: 503 });
    }
    // AI calls cost money and hold a serverless slot — throttle per actor.
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.hrId || access.loginId, request }),
      limit: 15,
      scope: "system_issues_ai_explain",
      windowMs: 60_000,
    });

    const body = (await request.json().catch(() => ({}))) as {
      message?: unknown;
      route?: unknown;
      moduleLabel?: unknown;
      severity?: unknown;
      stack?: unknown;
    };
    const message = typeof body.message === "string" ? body.message : "";
    if (!message.trim()) {
      return NextResponse.json({ message: "An error message is required." }, { status: 400 });
    }

    const explanation = await explainError({
      message,
      moduleLabel: typeof body.moduleLabel === "string" ? body.moduleLabel : null,
      route: typeof body.route === "string" ? body.route : null,
      severity: typeof body.severity === "string" ? body.severity : null,
      stack: typeof body.stack === "string" ? body.stack : null,
    });

    return NextResponse.json({ explanation });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { message: error.message },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    if (error instanceof PhoenixOpenAiError) {
      const status = error.code === "not_configured" ? 503 : error.code === "rate_limited" || error.code === "quota_exceeded" ? 429 : 502;
      return NextResponse.json({ message: error.message }, { status });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "Failed to explain error.") },
      { status: 500 },
    );
  }
}
