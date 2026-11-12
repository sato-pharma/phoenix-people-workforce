import { NextResponse } from "next/server";

import { bulkDecideApprovals, parseBulkDecisionInput } from "@/lib/approvals-hub/bulk-decide";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Tick several leave or excuse requests in the approvals inbox, then Approve all or Reject all.
// Every request is decided by the same service as its own decision page — see bulk-decide.ts.
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 10,
      scope: "approvals:bulk-decision",
      windowMs: 60_000,
    });
    const parsed = parseBulkDecisionInput(await request.json().catch(() => ({})));
    if (!parsed.ok) {
      return NextResponse.json({ error: "invalid_request", message: parsed.message, success: false }, { status: 400 });
    }
    const results = await bulkDecideApprovals(access, parsed.value);
    const decided = results.filter((row) => row.ok).length;
    return NextResponse.json({ decided, failed: results.length - decided, results, success: true });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: "Too many bulk decisions in a minute — wait a moment and try again.", success: false },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    const message = clientSafeErrorMessage(error, "The bulk decision failed.");
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "bulk_decision_failed", message, success: false },
      { status: isForbiddenError(error) ? 403 : 400 },
    );
  }
}
