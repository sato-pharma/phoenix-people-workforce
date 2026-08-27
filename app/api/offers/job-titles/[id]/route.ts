import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { deleteOfferJobTitle, updateOfferJobTitle } from "@/lib/offers/service";
import { offerJsonError } from "@/lib/offers/http";
import { resolveAccessContext } from "@/lib/auth/server";
import type { OfferJobTitleInput } from "@/lib/offers/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "offers", "update");

    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const patch: Partial<OfferJobTitleInput> = {};
    if (typeof body.title === "string") patch.title = body.title;
    if (body.costOfLiving !== undefined) {
      const value = Number(body.costOfLiving);
      if (!Number.isFinite(value) || value < 0) {
        return NextResponse.json(
          { message: "The cost of living must be zero or more.", success: false },
          { status: 400 },
        );
      }
      patch.costOfLiving = value;
    }
    if (body.reportsTo !== undefined) patch.reportsTo = body.reportsTo === null ? null : String(body.reportsTo);
    if (body.contractTerm !== undefined) {
      patch.contractTerm = body.contractTerm === null ? null : String(body.contractTerm);
    }
    // Optional-field discipline: an ABSENT key leaves the binding alone; an explicit null or blank
    // clears it back to "use the default". Coercing an absent key to null here is exactly how
    // saving a cost-of-living figure would silently unbind that title's letter design.
    if (body.templateId !== undefined) {
      patch.templateId = body.templateId === null ? null : String(body.templateId);
    }
    if (body.active !== undefined) patch.active = body.active !== false;

    return NextResponse.json({ jobTitle: await updateOfferJobTitle(id, patch), success: true });
  } catch (error) {
    return offerJsonError(error, "Failed to update this job title.");
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "offers", "delete");

    const { id } = await context.params;
    await deleteOfferJobTitle(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return offerJsonError(error, "Failed to delete this job title.");
  }
}
