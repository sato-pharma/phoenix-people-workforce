import { NextResponse } from "next/server";

import { assertSameOriginMutation, requireRecruitmentAccess, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { assertPageOpenForRole } from "@/lib/auth/seat-page-fences";
import { logInfo } from "@/lib/observability/log";
import {
  WHATSAPP_CONNECT_LINK_FRAGMENT,
  issueWhatsAppConnectLink,
} from "@/lib/recruitment/inbound/whatsapp-connect-link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Makes a one-time WhatsApp connect link (S01, F-PLT-008): opened on the handset, it lets that phone's
// WhatsApp Business number be connected to recruitment intake once, within 30 minutes. Super Admin
// only — the recruitment update grant AND the system scope — because the link connects a number to
// the whole intake. Nothing is stored: the link is a signed ticket, spent by the exchange route.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    // Inbound Intake Health is fenced off the Talent Acquisition seat (src/lib/auth/seat-page-fences.ts).
    assertPageOpenForRole(access.role, "/recruitment/intake-health");
    if (access.scope !== "system") {
      return NextResponse.json(
        { error: "forbidden", message: "Only a Super Admin can make a WhatsApp connect link.", success: false },
        { status: 403 },
      );
    }
    const madeBy = access.hrId || access.loginId || "";
    const issued = issueWhatsAppConnectLink(madeBy);
    if (!issued) {
      return NextResponse.json(
        { error: "not_configured", message: "Connect links cannot be made on this server.", success: false },
        { status: 503 },
      );
    }
    logInfo("WhatsApp connect link made", { labels: { event: "whatsapp_connect_link_made", made_by: madeBy } });
    // A path, not an address: the screen puts its own origin in front, so the link opens on the
    // deployment it was made on.
    const path = `/whatsapp-connect#${WHATSAPP_CONNECT_LINK_FRAGMENT}=${issued.ticket}`;
    return NextResponse.json({ expiresAt: new Date(issued.expiresAt * 1000).toISOString(), path, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to make the WhatsApp connect link.");
  }
}
