import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  deleteOfferTemplate,
  getOfferTemplate,
  setDefaultOfferTemplate,
  updateOfferTemplate,
} from "@/lib/offers/service";
import { isOfferTemplateVariant } from "@/lib/offers/builtin-templates";
import { offerJsonError } from "@/lib/offers/http";
import { resolveAccessContext } from "@/lib/auth/server";
import type { OfferBlock, OfferTemplateInput } from "@/lib/offers/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "offers", "read");
    const { id } = await context.params;
    return NextResponse.json({ success: true, template: await getOfferTemplate(id) });
  } catch (error) {
    return offerJsonError(error, "Failed to load this template.");
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "offers", "update");

    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    // Present keys only. Autosaving a colour change must not blank the blocks, and renaming must
    // not blank the theme — an optional field written unconditionally is a silent erase.
    const patch: Partial<OfferTemplateInput> = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (Array.isArray(body.blocks)) patch.blocks = body.blocks as OfferBlock[];
    if (body.theme !== undefined) patch.theme = body.theme as never;
    if (typeof body.fontFamily === "string") patch.fontFamily = body.fontFamily;
    if (body.fontSizePt !== undefined) patch.fontSizePt = Number(body.fontSizePt);
    if (isOfferTemplateVariant(body.variant)) patch.variant = body.variant;

    // `isDefault` is not part of the patch above. It is a cross-row fact — exactly one template
    // carries it, enforced by a partial unique index — so setting it means clearing another row,
    // which is a different write and cannot be a key in a field patch.
    if (body.isDefault === true) await setDefaultOfferTemplate(id);

    return NextResponse.json({ success: true, template: await updateOfferTemplate(id, patch) });
  } catch (error) {
    return offerJsonError(error, "Failed to save this template.");
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "offers", "delete");

    const { id } = await context.params;
    await deleteOfferTemplate(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return offerJsonError(error, "Failed to delete this template.");
  }
}
