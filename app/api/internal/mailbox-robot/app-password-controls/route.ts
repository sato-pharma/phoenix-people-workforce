import { runAppPasswordControlsAction } from "@/lib/new-hire-mailbox/robot/actions/app-password-controls-action";
import { handleInternalRobotRequest, refuseUnlessLive } from "@/lib/new-hire-mailbox/robot/actions/internal-route";

// Puppeteer cannot run on the edge, and a cached reading would be a stale answer about a live page.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The App Passwords capture, on the ROBOT SERVICE (audit REC-075). Its only caller is the website's
 * `POST /api/new-hire-mailboxes/app-password-controls`, which answers a dry run itself and forwards
 * only a live run, after its own session, CSRF, role and rate-limit checks.
 */
export async function POST(request: Request) {
  return handleInternalRobotRequest(request, "app-password-controls", async ({ actor, request: forwarded }) => {
    const notLive = refuseUnlessLive(forwarded);
    if (notLive) return notLive;
    return runAppPasswordControlsAction({ actor });
  });
}
