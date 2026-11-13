import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { recordTelegramHomeCardAnswered } from "@/lib/notifications/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Records that the signed-in person answered the home page's "Connect Telegram" card — closed it, or
// connected through it — so it is never drawn for them again (owner, 13 Nov 2026: "Every home page, once").
//
// `employee_profile` READ, the permission of the connect route beside it and of the settings read that
// draws the card: whoever is shown the card can answer it. Asking for `update` here would leave a person
// who may read their settings but not change them with a card that comes back on every visit.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_profile", "read");
    await recordTelegramHomeCardAnswered(access);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const message = clientSafeErrorMessage(error, "Unable to record the Telegram card's answer.");
    return NextResponse.json({ error: "telegram_home_card_answer_failed", message }, { status: 500 });
  }
}
