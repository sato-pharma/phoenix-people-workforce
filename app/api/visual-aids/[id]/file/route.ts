import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { visualAidsErrorResponse } from "@/lib/visual-aids/http";
import { openVisualAidFile } from "@/lib/visual-aids/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The bytes of one aid, for the full-screen viewer — streamed from the private bucket after the
// permission AND the line check (openVisualAidFile). Inline, never an attachment, never cached: the
// page renders it onto a canvas and offers no download.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "visual_aids", "read");
    const { id } = await context.params;
    const file = await openVisualAidFile(access, id);
    return new NextResponse(file.body, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": "inline",
        "content-length": String(file.size),
        "content-type": file.mimeType,
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return visualAidsErrorResponse(error, "Could not open the visual aid.");
  }
}
