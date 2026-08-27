import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { offerJsonError } from "@/lib/offers/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { restoreBuiltinTemplate } from "@/lib/offers/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Put one of the shipped SATO designs back exactly as it ships.
 *
 * The originals live in code (`OFFER_BUILTIN_TEMPLATES`), not in rows, so this works no matter how
 * far a built-in has been edited — and it still works if somebody deleted the row entirely, since
 * the seeder recreates it first. That is the safety net behind "edit anything": nothing done in the
 * editor can cost a design that cannot be reconstructed by hand.
 *
 * The path still reads `restore-default` because that is what it does for the design new offers
 * open on; `key` names which built-in, and defaults to the classic letter for a caller that predates
 * the second design.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "offers", "update");

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const key = typeof body.key === "string" && body.key.trim() !== "" ? body.key.trim() : "classic";

    return NextResponse.json({ success: true, template: await restoreBuiltinTemplate(key) });
  } catch (error) {
    return offerJsonError(error, "Failed to restore that built-in template.");
  }
}
