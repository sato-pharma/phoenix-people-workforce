import { NextResponse, type NextRequest } from "next/server";

import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";
import { assertPermission } from "@/lib/auth/permissions";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { offerJsonError } from "@/lib/offers/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { sendOfferEmail } from "@/lib/offers/send";
import { writeRequiredAuditLog } from "@/lib/admin/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The PDF render alone takes ~1.5s; a full send is well inside 60s but nowhere near instant.
export const maxDuration = 60;

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    // `create` rather than `update`: sending is the act that makes an offer real to somebody
    // outside the company, and it is the highest-consequence thing this module does.
    await assertPermission(access, "offers", "create");

    // Every send launches a Chromium and puts mail in a stranger's inbox. The rate limit is the
    // blast radius on a stuck retry loop, not a fairness measure.
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 10,
      scope: "offers:send",
      windowMs: 60 * 1000,
    });

    const { id } = await context.params;
    const outcome = await sendOfferEmail(id, { sentBy: access.hrId ?? null });

    // Only when mail actually left. A skipped send stamps nothing on the offer row and must not
    // leave a trail saying an offer was issued — that reading is worse than no row at all.
    if (!outcome.skipped) {
      await writeRequiredAuditLog({
        actorLoginId: access.loginId ?? access.hrId,
        entityId: id,
        entityType: "job_offer",
        // What the row has to answer later is "what exactly did this person commit us to, and to
        // whom" — a salary, a start date and a stranger's address. `template_snapshot` on the offer
        // holds the letter as sent; this holds the terms, so neither question needs the other.
        newValues: {
          attachmentIncluded: outcome.attachmentIncluded,
          candidateName: outcome.offer.candidateName,
          from: outcome.from,
          jobTitle: outcome.offer.title,
          recipient: outcome.recipient,
          startDate: outcome.offer.startDate,
          totalMonthly: outcome.offer.totalMonthly,
        },
        summary: `Offer of employment sent to ${outcome.offer.candidateName} <${outcome.recipient}> for ${outcome.offer.title}`,
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
    return offerJsonError(error, "Failed to send this offer.");
  }
}
