import { NextResponse } from "next/server";

import { assertSameOriginMutation, recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";
import { layoutOwnerKey } from "@/lib/navigation/personal-layout";
import { isPoolColumnLayouts } from "@/lib/recruitment/pool-column-layout-rules";
import { loadPoolColumnLayouts, savePoolColumnLayouts } from "@/lib/recruitment/pool-column-layout-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The signed-in reader's own candidate-pool column layouts (owner, 2026-10-19 — "Columns follow you").
 * GET reads them (null when nothing is saved), PUT replaces them whole.
 *
 * Whose layouts is ALWAYS the session's — `layoutOwnerKey(access)`, the sidebar layouts' own rule —
 * and never a field of the request, so nobody can read or rearrange another reader's pool.
 * candidates:read is the gate: anyone who can see the pool may arrange how they see it, and a layout
 * names column keys only, so it can never show more than that reader already sees.
 */

export async function GET(request: Request) {
  try {
    const access = await requireRecruitmentAccess(request, "candidates", "read");
    const layouts = await loadPoolColumnLayouts(layoutOwnerKey(access));
    return NextResponse.json({ data: layouts, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Unable to load your column layout.");
  }
}

export async function PUT(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "read");
    const body: unknown = await request.json().catch(() => null);
    const layouts = (body as { layouts?: unknown } | null)?.layouts;
    if (!isPoolColumnLayouts(layouts)) {
      return NextResponse.json(
        { error: "invalid_layout", message: "That column layout is not in a shape this version understands.", success: false },
        { status: 400 },
      );
    }
    await savePoolColumnLayouts(layoutOwnerKey(access), layouts);
    return NextResponse.json({ success: true });
  } catch (error) {
    return recruitmentApiError(error, "Unable to save your column layout.");
  }
}
