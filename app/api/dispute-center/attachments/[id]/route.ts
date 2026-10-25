import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { readDisputeCenterAttachment } from "@/lib/dispute-center/attachments.ts";
import { disputeCenterError } from "@/lib/dispute-center/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One picture from a calendar or weekly-review dispute. The bucket is private and the bytes are
// served only to somebody in the case — readDisputeCenterAttachment checks that before it downloads
// anything. Deduction pictures keep their own route (/api/deductions/comments/attachments/:id).
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    const { id } = await context.params;
    const picture = await readDisputeCenterAttachment({ access, attachmentId: decodeURIComponent(id) });
    return new NextResponse(Buffer.from(picture.bytes), {
      headers: {
        // A dispute photo is evidence one person may see: never kept in a browser cache, where the
        // next person on a shared machine could open it after access was taken away.
        "Cache-Control": "private, no-store",
        "Content-Disposition": `inline; filename="${encodeURIComponent(picture.fileName)}"`,
        "Content-Type": picture.contentType,
      },
    });
  } catch (error) {
    return disputeCenterError(error, "Unable to open this picture.");
  }
}
