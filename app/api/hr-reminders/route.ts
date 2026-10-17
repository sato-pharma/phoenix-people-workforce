import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { reminderErrorResponse } from "@/lib/hr-reminders/http";
import { createReminder, loadReminderBoard } from "@/lib/hr-reminders/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The board: every reminder the caller may see (their own, the ones shared with them, and — for the
// HR Manager — all of them) plus the team they can share with. Visibility is decided in the service.
export async function GET(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_reminders", "read");
    return NextResponse.json(await loadReminderBoard(access));
  } catch (error) {
    return reminderErrorResponse(error, "Failed to load reminders.");
  }
}

export async function POST(request: NextRequest) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_reminders", "create");
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 60,
      scope: "hr-reminders:create",
      windowMs: 60_000,
    });

    const body = await request.json().catch(() => null);
    const reminder = await createReminder(access, body);
    return NextResponse.json({ ok: true, reminder }, { status: 201 });
  } catch (error) {
    return reminderErrorResponse(error, "Failed to save the reminder.");
  }
}
