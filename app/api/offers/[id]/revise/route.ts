import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { offerJsonError } from "@/lib/offers/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { hrIdForStorage } from "@/lib/hr-id";
import { cancelOfferRevision, getOffer, startOfferRevision } from "@/lib/offers/service";
import { offerRevisionCancelRefusal, offerRevisionRefusal } from "@/lib/offers/revision-rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Update a sent offer (owner, 2026-11-10: "make an option for the updated job offer, i may need to
 * update a job offer").
 *
 *   { action: "start" }  — freeze the version that went out and open the same offer as a draft to edit.
 *   { action: "cancel" } — throw the edits away and put the version that went out back, as it was.
 *
 * Neither emails anybody. The update reaches the candidate only through the ordinary Send, which keeps
 * the HR Manager's approval in front of it. `create`, Send's own grant: starting an update takes the
 * candidate's offer out of their hands until the new one goes.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "offers", "create");

    const { id } = await context.params;
    const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
    const action = body?.action === "cancel" ? "cancel" : body?.action === "start" ? "start" : null;
    if (!action) {
      return NextResponse.json({ message: "Say whether to start or cancel the update.", success: false }, { status: 400 });
    }

    const current = await getOffer(id);
    const refusal = action === "start" ? offerRevisionRefusal(current) : offerRevisionCancelRefusal(current);
    if (refusal) {
      return NextResponse.json({ message: refusal, success: false }, { status: 409 });
    }

    const actor = hrIdForStorage(access.hrId) ?? null;
    const offer = action === "start" ? await startOfferRevision(id, actor) : await cancelOfferRevision(id);
    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? access.hrId,
      entityId: id,
      entityType: "job_offer",
      newValues: { candidateName: offer.candidateName, jobTitle: offer.title, revision: offer.revision ?? 0, status: offer.status },
      summary:
        action === "start"
          ? `Update started on the offer for ${offer.candidateName} (${offer.title}); the version sent is kept and the offer is back in draft — nothing emailed`
          : `Update cancelled on the offer for ${offer.candidateName} (${offer.title}); the version sent is back as it was — nothing emailed`,
    });

    return NextResponse.json({ offer, success: true });
  } catch (error) {
    return offerJsonError(error, "Failed to update this offer.");
  }
}
