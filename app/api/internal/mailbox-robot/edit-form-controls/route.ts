import { runEditFormControlsAction } from "@/lib/new-hire-mailbox/robot/actions/edit-form-controls-action";
import { handleInternalRobotRequest } from "@/lib/new-hire-mailbox/robot/actions/internal-route";

// Puppeteer cannot run on the edge, and a cached reading would be a stale answer about a live page.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The leaver's Edit-form reading, on the ROBOT SERVICE (audit REC-075). Its only caller is the
 * website's `POST /api/mailbox-offboarding/edit-form-controls`, which forwards after its own session,
 * CSRF, role, register and rate-limit checks. The action asks the register again before a browser
 * is built, because here the address comes from the forwarded body.
 */
export async function POST(request: Request) {
  return handleInternalRobotRequest(request, "edit-form-controls", async ({ actor, request: forwarded }) =>
    runEditFormControlsAction({ actor, address: forwarded.address }),
  );
}
