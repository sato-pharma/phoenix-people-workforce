import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { visualAidsErrorResponse } from "@/lib/visual-aids/http";
import { createVisualAid, listVisualAids } from "@/lib/visual-aids/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The library. A rep (and his DM, RM and NSM) gets the ACTIVE aids of his own line; an uploader gets
// every row, retired ones included. The line narrowing lives in listVisualAids, below the permission.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "visual_aids", "read");
    const library = await listVisualAids(access);
    return NextResponse.json(library, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return visualAidsErrorResponse(error, "Could not load the visual aids.");
  }
}

// Save an uploaded file as a new visual aid. The file already sits in the private bucket (the
// browser put it there through /api/visual-aids/upload-url); this reads it back, proves it is the
// caller's own PDF, JPG or PNG, and writes the row plus a required audit row.
export async function POST(request: Request) {
  const csrf = assertSameOriginMutation(request);
  if (csrf) return csrf;
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "visual_aids", "create");
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const created = await createVisualAid(access, body);
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    return visualAidsErrorResponse(error, "Could not save the visual aid.");
  }
}
