import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { readDisputeAttachmentForViewer } from "@/lib/deductions/comment-attachments.ts";
import { jsonError, resolveAccessContext } from "@/lib/deductions/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One picture from a deduction dispute reply, served only to the employee the deduction belongs to
// or to an admin reader of the Deductions module (readDisputeAttachmentForViewer decides, before a
// byte is read from the private bucket). The stored object is never linked directly.
//
// `no-store` + `nosniff`: the picture is evidence about one person's pay, so no shared cache keeps
// it, and the browser may not guess a different type from the bytes — the type served is the one
// sniffed from the file's own first bytes when it was uploaded.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const access = await resolveAccessContext(request);
    // The portal page's own gate (every role with a portal); the real check is who the picture belongs to.
    await assertPermission(access, "employee_profile", "read");

    const picture = await readDisputeAttachmentForViewer({ access, attachmentId: id });
    return new NextResponse(Buffer.from(picture.bytes), {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `inline; filename="${encodeURIComponent(picture.fileName)}"`,
        "Content-Length": String(picture.bytes.length),
        "Content-Type": picture.contentType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return jsonError(error, "Failed to load the picture.");
  }
}
