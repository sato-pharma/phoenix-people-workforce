import { NextResponse } from "next/server";

import {
  assertSameOriginMutation,
  bool,
  num,
  readJsonObject,
  recruitmentApiError,
  recruitmentProblem,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";
import {
  deleteWhatsAppTemplate,
  updateWhatsAppTemplate,
  type WhatsAppTemplatePatch,
} from "@/lib/recruitment/whatsapp-templates/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Edit one template. Same `admin: update` gate as creating one — see the POST in ../route.ts.
 *
 * A PARTIAL PATCH, not a replace. Only the keys actually present in the body are written, so the
 * on/off switch in the list can send `{ isActive: false }` without carrying the whole body along and
 * risking a stale copy overwriting an edit made in another tab.
 *
 * `undefined` and `null` are therefore NOT the same thing here, and the coercers say so: `str()`
 * returns null for a blank field, so a key is only treated as "being set" when it was actually sent.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "admin", "update");
    const { id } = await params;

    const payload = await readJsonObject(request);
    const patch: WhatsAppTemplatePatch = {};
    if ("name" in payload) patch.name = str(payload.name) ?? "";
    if ("category" in payload) patch.category = str(payload.category) ?? "";
    if ("body" in payload) patch.body = str(payload.body) ?? "";
    if ("isActive" in payload) patch.isActive = bool(payload.isActive) ?? true;
    if ("sortOrder" in payload) patch.sortOrder = num(payload.sortOrder) ?? 0;

    if (Object.keys(patch).length === 0) {
      return recruitmentProblem("Nothing to change.", 400);
    }

    const template = await updateWhatsAppTemplate(id, patch, access.hrId ?? null);
    return NextResponse.json({ success: true, template });
  } catch (error) {
    return recruitmentApiError(error, "Failed to save the template.");
  }
}

/**
 * Delete a template for good.
 *
 * The messages already prepared from it SURVIVE — `ats_whatsapp_template_sends.template_id` is
 * `on delete set null`, and each row carries the fully rendered text it was sent with. Deleting a
 * template retires the wording; it does not rewrite the history of what candidates were told.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    await requireRecruitmentAccess(request, "admin", "update");
    const { id } = await params;

    await deleteWhatsAppTemplate(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to delete the template.");
  }
}
