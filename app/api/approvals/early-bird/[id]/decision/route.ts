// A District Manager's decision on a fortnightly Early Birds recommendation.
//
// `id` is the SNAPSHOT id (one open recommendation per district per fortnight); the candidate id
// rides in the body so the RPC can detect a stale tab and refuse rather than deciding the wrong rep.
import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";
import { decideEarlyBirdsCandidate } from "@/lib/early-birds/decisions";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const csrf = assertSameOriginMutation(request);
  if (csrf) return csrf;

  try {
    const access = await resolveAccessContext(request);
    const { id } = await context.params;

    const body = (await request.json().catch(() => ({}))) as {
      decision?: string;
      candidateId?: string;
      comment?: string;
    };

    if (body.decision !== "approve" && body.decision !== "reject") {
      return NextResponse.json({ error: "invalid_decision" }, { status: 400 });
    }
    if (!body.candidateId) {
      return NextResponse.json({ error: "missing_candidate" }, { status: 400 });
    }

    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.hrId || access.loginId, request }),
      limit: 20,
      scope: "early-birds-decision",
      windowMs: 60_000,
    });

    const result = await decideEarlyBirdsCandidate(access, {
      snapshotId: id,
      candidateId: body.candidateId,
      decision: body.decision,
      comment: body.comment,
    });

    if (!result.ok) {
      const status =
        result.error === "forbidden" ? 403 : result.error === "stale_candidate" ? 409 : 400;
      return NextResponse.json({ error: result.error, message: result.message }, { status });
    }

    return NextResponse.json({ success: true, status: result.status, winnerId: result.winnerId });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", retryAfterSeconds: error.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(error.retryAfterSeconds) } },
      );
    }
    const message = clientSafeErrorMessage(error, "The decision could not be recorded.");
    if (message.startsWith("Forbidden:")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    return NextResponse.json({ error: "failed", message }, { status: 500 });
  }
}
