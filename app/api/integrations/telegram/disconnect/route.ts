import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { disconnectTelegram } from "@/lib/notifications/settings";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_profile", "read");
    const data = await disconnectTelegram(access);
    return NextResponse.json({ data, success: true });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const message = clientSafeErrorMessage(error, "Unable to disconnect Telegram.");
    return NextResponse.json({ error: "telegram_disconnect_failed", message }, { status: 500 });
  }
}
