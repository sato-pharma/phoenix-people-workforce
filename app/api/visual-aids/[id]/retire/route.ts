import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { visualAidsErrorResponse } from "@/lib/visual-aids/http";
import { retireVisualAid } from "@/lib/visual-aids/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Retire: hidden from every rep at once. The row and the file are kept — never a delete.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const csrf = assertSameOriginMutation(request);
  if (csrf) return csrf;
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "visual_aids", "update");
    const { id } = await context.params;
    await retireVisualAid(access, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return visualAidsErrorResponse(error, "Could not retire the visual aid.");
  }
}
