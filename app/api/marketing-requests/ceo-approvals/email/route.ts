import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, toApiError } from "@/lib/http/api-errors";
import { sendMarketingCeoApprovalsEmail } from "@/lib/marketing-requests/ceo-approvals-email-service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The "Approved requests" email from CEO Approvals (owner, 2026-11-08).
 *
 * `dryRun: true` answers who it would reach and the subject, and sends nothing — the page shows that
 * before the Marketing Manager confirms. Without it the email goes, and the in-app and Telegram copies
 * follow after the answer. Who may send is decided in the service, before any row is read.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => null)) as
      | { dryRun?: unknown; from?: unknown; rows?: unknown; to?: unknown }
      | null;
    const result = await sendMarketingCeoApprovalsEmail(access, body ?? {});
    return NextResponse.json({ result });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    const apiError = toApiError(error, "The approved requests email could not be sent.");
    return NextResponse.json(
      { error: apiError.code === "internal_error" ? "approved_requests_email_failed" : apiError.code, message: apiError.message },
      { status: apiError.status },
    );
  }
}
