import { randomUUID } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";
import { assertPermission } from "@/lib/auth/permissions";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { normalizeResendRequestId } from "@/lib/offers/resend-rules";
import { offerJsonError } from "@/lib/offers/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { resendOfferEmail } from "@/lib/offers/send";
import { writeRequiredAuditLog } from "@/lib/admin/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The same work as a first send — a PDF render and one email — so the same ceiling.
export const maxDuration = 60;

/**
 * Send a SENT offer's letter again (owner, 2026-09-28). Same letter, same address; the offer row is
 * not changed. Gated exactly like Send — it puts the company's terms in a stranger's inbox — and it
 * shares Send's rate-limit bucket, so the two together cannot be used to flood a candidate.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "offers", "create");

    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 10,
      scope: "offers:send",
      windowMs: 60 * 1000,
    });

    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { requestId?: unknown };
    // The browser mints one id per press, so a double-submit of that press sends once. A request
    // without one (or with anything odd in it) still works — it simply gets its own key.
    const requestId = normalizeResendRequestId(body.requestId) ?? randomUUID();

    const outcome = await resendOfferEmail(id, { requestId });

    if (!outcome.skipped) {
      await writeRequiredAuditLog({
        actorLoginId: access.loginId ?? access.hrId,
        entityId: id,
        entityType: "job_offer",
        newValues: {
          attachmentIncluded: outcome.attachmentIncluded,
          candidateName: outcome.offer.candidateName,
          from: outcome.from,
          jobTitle: outcome.offer.title,
          recipient: outcome.recipient,
          resend: true,
          startDate: outcome.offer.startDate,
          totalMonthly: outcome.offer.totalMonthly,
        },
        summary: `Offer of employment re-sent to ${outcome.offer.candidateName} <${outcome.recipient}> for ${outcome.offer.title}`,
      });
    }

    return NextResponse.json({ ...outcome, success: true });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { message: "Too many offers sent in the last minute. Wait a moment and try again.", success: false },
        { status: 429 },
      );
    }
    return offerJsonError(error, "Failed to resend this offer.");
  }
}
