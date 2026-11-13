import { NextResponse } from "next/server";

import { parseAdoptionRequest } from "@/lib/new-hire-mailbox/robot/adopt";
import { runAdoptAction } from "@/lib/new-hire-mailbox/robot/actions/adopt-action";
import { handleInternalRobotRequest } from "@/lib/new-hire-mailbox/robot/actions/internal-route";

// Puppeteer cannot run on the edge, and a cached answer about a live mailbox would be worse than none.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Adoption, on the ROBOT SERVICE (audit REC-075). Its only caller is the website's
 * `POST /api/new-hire-mailboxes/adopt`, after that route has checked the Super Admin's session, CSRF,
 * role and rate limit; this door checks the CRON_SECRET bearer and the process role
 * (`handleInternalRobotRequest`), re-parses the request with the same parser, and runs the one shared
 * implementation. Never on a schedule.
 */
export async function POST(request: Request) {
  return handleInternalRobotRequest(request, "adopt", async ({ actor, request: forwarded }) => {
    const parsed = parseAdoptionRequest(forwarded);
    if (!parsed.ok) {
      return NextResponse.json({ message: parsed.message, success: false }, { status: 400 });
    }
    return runAdoptAction({ actor, dryRun: parsed.dryRun, named: parsed.named });
  });
}
