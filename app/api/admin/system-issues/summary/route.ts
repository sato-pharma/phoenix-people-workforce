import { NextResponse, type NextRequest } from "next/server";

import { summarizeErrorClusters } from "@/lib/error-monitor/ai-triage";
import { getErrorClusterAggregates } from "@/lib/error-monitor/service";
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
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.hrId || access.loginId, request }),
      limit: 8,
      scope: "system_issues_ai_summary",
      windowMs: 60_000,
    });

    const clusters = await getErrorClusterAggregates(7);
    const summary = await summarizeErrorClusters(clusters);

    return NextResponse.json({ clusterCount: clusters.length, summary });
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
      { message: clientSafeErrorMessage(error, "Failed to summarize errors.") },
      { status: 500 },
    );
  }
}
