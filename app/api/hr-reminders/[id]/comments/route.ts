import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { reminderErrorResponse } from "@/lib/hr-reminders/http";
import { addReminderComment, listReminderComments } from "@/lib/hr-reminders/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The conversation under one reminder, oldest first. Anyone who can see the reminder can read it.
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_reminders", "read");
    const { id } = await context.params;
    return NextResponse.json({ comments: await listReminderComments(access, id) });
  } catch (error) {
    return reminderErrorResponse(error, "Failed to load the conversation.");
  }
}

// Anyone who can see a reminder can comment on it — the HR Manager on every one — and anyone can
// answer a comment by naming it in `replyToId`. Comments are never edited.
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_reminders", "create");
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 60,
      scope: "hr-reminders:comment",
      windowMs: 60_000,
    });

    const { id } = await context.params;
    const body = await request.json().catch(() => null);
    const comment = await addReminderComment(access, id, body);
    return NextResponse.json({ ok: true, comment }, { status: 201 });
  } catch (error) {
    return reminderErrorResponse(error, "Failed to send the comment.");
  }
}
