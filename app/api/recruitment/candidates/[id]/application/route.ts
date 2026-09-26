import { NextResponse } from "next/server";

import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";
import { findWhatsAppApplicationSessionId } from "@/lib/recruitment/whatsapp-applicants-loader";
import { canOpenWhatsAppApplications } from "@/lib/recruitment/whatsapp-application-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — does THIS candidate have a WhatsApp application to open, and under which conversation?
//
// The screening workstation reads it to decide whether to draw the "Download application" and "Print
// application" buttons the WhatsApp Applicants page already carries (owner, 2026-09-26). It answers a
// conversation id and nothing about the person — `{ application: { sessionId } }` when they applied on
// WhatsApp, `{ application: null }` when they did not — and builds no file: the two buttons reuse the
// WhatsApp Applicants download route and print page, each of which re-checks the caller on its own.
//
// Gated by the same predicate as the file itself (`canOpenWhatsAppApplications`): an HR authority role
// holding recruitment:read AND candidates:read. Knowing a person applied on WhatsApp — and that the file
// behind it holds their phone, email and salary answer — is the same sensitivity as opening it, so the
// answer is offered to nobody the download route would refuse. This is the same shape the interview
// calendar's own application lookup takes; the difference is only its door, which here is the ordinary
// candidates:read registry gate the screening page already passes.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "candidates", "read");
    if (!(await canOpenWhatsAppApplications(access))) {
      return NextResponse.json(
        { error: "forbidden", message: "Your account cannot open WhatsApp applications.", success: false },
        { status: 403 },
      );
    }
    const { id } = await params;
    const sessionId = await findWhatsAppApplicationSessionId(id);
    return NextResponse.json(
      { application: sessionId ? { sessionId } : null, success: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return recruitmentApiError(error, "Failed to check for a WhatsApp application.");
  }
}
