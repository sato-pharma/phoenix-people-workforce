import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { offerJsonError } from "@/lib/offers/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { afterResponse } from "@/lib/http/after-response";
import { hrIdForStorage } from "@/lib/hr-id";
import { getOffer, returnOfferToDraft } from "@/lib/offers/service";
import { announceOfferApprovalDecision, offerReturnRefusal } from "@/lib/offers/approval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The longest note kept with a rejection — a sentence or two for Talent Acquisition, not a letter. */
const REASON_MAX = 500;

/**
 * The HR Manager rejects an offer waiting for his approval (owner, 2026-11-10: "If I reject or leave
 * it pending, it leaves as it is"). It goes back to draft, unsent, with his note; nothing reaches the
 * candidate. `offers:approve`, which only the Super Admin holds — Talent Acquisition cannot reject,
 * and so cannot clear its own request either.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "offers", "approve");

    const { id } = await context.params;
    const body = (await request.json().catch(() => null)) as { reason?: unknown } | null;
    const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, REASON_MAX) : "";

    const current = await getOffer(id);
    const refusal = offerReturnRefusal(current.status, true);
    if (refusal) {
      return NextResponse.json({ message: refusal, success: false }, { status: 409 });
    }

    const actor = hrIdForStorage(access.hrId) ?? null;
    const offer = await returnOfferToDraft(id, actor, reason);
    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? access.hrId,
      entityId: id,
      entityType: "job_offer",
      newValues: { candidateName: offer.candidateName, jobTitle: offer.title, reason: reason || null, status: "draft" },
      summary: `Offer for ${offer.candidateName} (${offer.title}) rejected by the HR Manager and returned to draft — nothing emailed` +
        (reason ? `; note: ${reason}` : ""),
    });
    const requestedBy = current.approval?.requestedBy ?? null;
    await afterResponse("offers.approvalReturned", () =>
      announceOfferApprovalDecision(offer, { by: actor, outcome: "returned", reason, requestedBy }),
    );

    return NextResponse.json({ offer, success: true });
  } catch (error) {
    return offerJsonError(error, "Failed to reject this offer.");
  }
}
