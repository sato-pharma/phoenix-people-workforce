import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { resendOutstationDeparturePhotoReminder } from "@/lib/outstation/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Ask an employee again for the departure photo his expense is held behind.
 *
 * Super Admin only, enforced inside the service (assertOutstationAdminAccess with "approve") —
 * this sends real mail to a real person, so it is not a view-level action. The route does not
 * re-implement that check: one authority for it, in the domain.
 *
 * It lives at its own path rather than as another `action` on the workload route so that sending
 * mail to an employee can never be reached by posting an unexpected value to an endpoint meant
 * for something else. It takes no body at all — there is nothing to vary, and nothing an admin
 * types goes into the message.
 */
function reminderStatus(error: unknown) {
  if (isForbiddenError(error)) return 403;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  // Not a failure — a statement that this is the wrong row for this button.
  if (message.includes("not waiting on its departure photo") || message.includes("has not finished yet")) {
    return 409;
  }
  if (message.includes("not available")) return 404;
  return 500;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);

    const { id: rawId } = await params;
    const id = Number(rawId);
    if (!Number.isFinite(id)) {
      return NextResponse.json(
        { error: "invalid_outstation_id", message: "Request id is invalid." },
        { status: 400 },
      );
    }

    const result = await resendOutstationDeparturePhotoReminder(id, access);
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: isForbiddenError(error) ? "forbidden" : "outstation_reminder_resend_failed",
        message: clientSafeErrorMessage(error, "Unable to send the reminder."),
      },
      { status: reminderStatus(error) },
    );
  }
}
