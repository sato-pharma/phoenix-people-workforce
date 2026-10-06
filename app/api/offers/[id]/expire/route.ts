import { NextResponse, type NextRequest } from "next/server";

import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";
import { assertPermission } from "@/lib/auth/permissions";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { expireOfferEmail } from "@/lib/offers/send";
import { offerJsonError } from "@/lib/offers/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { writeRequiredAuditLog } from "@/lib/admin/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One email, no PDF render — but the same ceiling as Send, so a slow provider call never trips it.
export const maxDuration = 60;

/**
 * Tell a SENT offer's candidate it has expired, and withdraw the offer (owner, 2026-10-07).
 *
 * The candidate-facing half Withdraw never had. Gated exactly like Send and Resend — it puts a
 * message in a stranger's inbox — and it shares Send's rate-limit bucket, so expiry, send and resend
 * together cannot be used to flood a candidate. A stable idempotency key (see `expireOfferEmail`)
 * means a double-submit sends a single notice.
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
    const outcome = await expireOfferEmail(id);

    if (!outcome.skipped) {
      await writeRequiredAuditLog({
        actorLoginId: access.loginId ?? access.hrId,
        entityId: id,
        entityType: "job_offer",
        newValues: {
          candidateName: outcome.offer.candidateName,
          expired: true,
          from: outcome.from,
          jobTitle: outcome.offer.title,
          recipient: outcome.recipient,
          status: outcome.offer.status,
        },
        summary: `Offer ${outcome.offer.reference} to ${outcome.offer.candidateName} <${outcome.recipient}> marked expired and withdrawn; candidate notified`,
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
    return offerJsonError(error, "Failed to mark this offer expired.");
  }
}
