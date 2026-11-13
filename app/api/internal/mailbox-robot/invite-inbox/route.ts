import { runInviteInboxAction } from "@/lib/new-hire-mailbox/robot/actions/invite-inbox-action";
import { handleInternalRobotRequest, refuseUnlessLive } from "@/lib/new-hire-mailbox/robot/actions/internal-route";

// Puppeteer cannot run on the edge, and a cached answer about a live mailbox would be worse than none.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The invite-inbox adoption, on the ROBOT SERVICE (audit REC-075). Its only caller is the website's
 * `POST /api/new-hire-mailboxes/invite-inbox`, which answers a dry run itself and forwards only a live
 * run, after its own session, CSRF, role and rate-limit checks. The address is the constant inside
 * the shared action; nothing from the request can name a mailbox.
 */
export async function POST(request: Request) {
  return handleInternalRobotRequest(request, "invite-inbox", async ({ actor, request: forwarded }) => {
    const notLive = refuseUnlessLive(forwarded);
    if (notLive) return notLive;
    return runInviteInboxAction({ actor, dryRun: false });
  });
}
