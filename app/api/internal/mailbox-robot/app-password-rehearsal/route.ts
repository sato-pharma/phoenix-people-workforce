import { runAppPasswordRehearsalAction } from "@/lib/new-hire-mailbox/robot/actions/app-password-rehearsal-action";
import { handleInternalRobotRequest, refuseUnlessLive } from "@/lib/new-hire-mailbox/robot/actions/internal-route";

// Puppeteer cannot run on the edge, and a cached answer about a live mailbox would be worse than none.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The mint-and-remove rehearsal, on the ROBOT SERVICE (audit REC-075). Its only caller is the
 * website's `POST /api/new-hire-mailboxes/app-password-rehearsal`, which answers a dry run itself and
 * forwards only a live run, after its own session, CSRF, role and rate-limit checks.
 */
export async function POST(request: Request) {
  return handleInternalRobotRequest(request, "app-password-rehearsal", async ({ actor, request: forwarded }) => {
    const notLive = refuseUnlessLive(forwarded);
    if (notLive) return notLive;
    return runAppPasswordRehearsalAction({ actor });
  });
}
