import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { listAutoReplies } from "@/lib/recruitment/inbound/whatsapp-auto-replies-catalogue";
import { saveAutoReply } from "@/lib/recruitment/inbound/whatsapp-auto-replies-store";
import { assertScreeningQuestionsAccess } from "@/lib/recruitment/inbound/whatsapp-screening-questions-admin";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The editor for the automatic WhatsApp replies the bot sends BY ITSELF — the ask-for-a-file reply,
 * the send-it-as-a-document reply, the too-large reply, and the first and last lines of the closing
 * summary.
 *
 * Third sibling of /api/admin/question-prompts (the six built-in questions) and
 * /api/admin/screening-questions (the extra ones), behind the SAME gate — `recruitment:update`
 * falling back to `admin:update`, asserted here on every verb. The sidebar hiding a link is UX; this
 * is the boundary.
 *
 * WHAT IS WRITABLE: the words. Not WHEN a reply is sent, and not the summary lines the closing
 * message prints between its first and last line — those are written from what the applicant
 * actually answered. The key is checked against the code catalogue on THIS side, so a client cannot
 * invent a reply key that would sit in the table overriding nothing.
 */

function failure(error: unknown, code: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const message = clientSafeErrorMessage(error, "The WhatsApp auto-replies could not be updated.");
  return NextResponse.json({ error: code, message }, { status: 400 });
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertScreeningQuestionsAccess(access);

    return NextResponse.json({ replies: await listAutoReplies() });
  } catch (error) {
    return failure(error, "whatsapp_auto_replies_read_failed");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertScreeningQuestionsAccess(access);

    const body = (await request.json()) as { key?: string; bodyText?: string };
    const key = String(body.key ?? "").trim();
    if (!key) {
      return NextResponse.json({ error: "key is required" }, { status: 400 });
    }

    // A blank bodyText is the RESET gesture, handled inside saveAutoReply: the row is dropped and the
    // reply goes back to its code default, rather than being saved as an empty message that would
    // reach a real applicant as silence. The screen also sends blank when the box has been typed
    // back to the default word for word, so no copy of a default is ever stored.
    await saveAutoReply({
      actorHrId: access.hrId ?? null,
      bodyText: String(body.bodyText ?? ""),
      key,
    });

    return NextResponse.json({ replies: await listAutoReplies() });
  } catch (error) {
    return failure(error, "whatsapp_auto_reply_save_failed");
  }
}
