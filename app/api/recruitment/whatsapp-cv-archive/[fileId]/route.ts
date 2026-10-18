import { NextResponse } from "next/server";

import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";
import { canAccess, isHrAuthorityRole } from "@/lib/auth/permissions";
import { isUuid } from "@/lib/http/uuid";
import { recruitmentFileResponse } from "@/lib/recruitment/file-response";
import { getWhatsAppCvArchiveFile } from "@/lib/recruitment/whatsapp-cv-archive-loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — one CV from the WhatsApp CV Archive (the old WhatsApp applicants the owner kept on
// 2026-10-18; src/lib/recruitment/whatsapp-cv-archive.ts says why they are not candidates).
//
// Gated the way the page that lists them is: HR authority AND recruitment:read, and the candidates
// grant on top, because the file is a person's CV. The id is an Archive file's own id, so a guessed id
// can only ever reach the Archive's bucket, never a candidate's file.
export async function GET(request: Request, { params }: { params: Promise<{ fileId: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "candidates", "read");
    if (!isHrAuthorityRole(access.role) || !(await canAccess(access, "recruitment", "read"))) {
      return NextResponse.json(
        { error: "forbidden", message: "Your account cannot open the WhatsApp CV Archive.", success: false },
        { status: 403 },
      );
    }
    const { fileId } = await params;
    if (!isUuid(fileId)) {
      return NextResponse.json({ error: "not_found", message: "File not found.", success: false }, { status: 404 });
    }
    const file = await getWhatsAppCvArchiveFile(fileId);
    if (!file) {
      return NextResponse.json({ error: "not_found", message: "File not found.", success: false }, { status: 404 });
    }
    return recruitmentFileResponse(request, file);
  } catch (error) {
    return recruitmentApiError(error, "Archived CV download failed.");
  }
}
