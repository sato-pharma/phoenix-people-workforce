import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { visualAidsErrorResponse } from "@/lib/visual-aids/http";
import { startVisualAidUpload } from "@/lib/visual-aids/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A one-time signed URL the browser PUTs the file to, straight into the private bucket, so a large
// flyer never passes through this app's request body limit. Writes no row: nothing exists until the
// create (or replace) call reads the file back and records it with its audit row.
export async function POST(request: Request) {
  const csrf = assertSameOriginMutation(request);
  if (csrf) return csrf;
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "visual_aids", "create");
    const body = (await request.json().catch(() => ({}))) as { contentType?: unknown; size?: unknown };
    const upload = await startVisualAidUpload(access, body);
    return NextResponse.json(upload);
  } catch (error) {
    return visualAidsErrorResponse(error, "Could not start the upload.");
  }
}
