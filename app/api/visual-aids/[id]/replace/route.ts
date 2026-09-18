import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { visualAidsErrorResponse } from "@/lib/visual-aids/http";
import { replaceVisualAid } from "@/lib/visual-aids/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Replace: the uploaded newer version goes live and the old one retires pointing at it.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const csrf = assertSameOriginMutation(request);
  if (csrf) return csrf;
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "visual_aids", "update");
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const created = await replaceVisualAid(access, id, body);
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    return visualAidsErrorResponse(error, "Could not replace the visual aid.");
  }
}
