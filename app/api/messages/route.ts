import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { internalMessageError, internalMessageSignedOut, isSignedOut } from "@/lib/internal-messages/http";
import {
  listInternalMessagesForViewer,
  sendInternalMessage,
} from "@/lib/internal-messages/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SendMessageBody = {
  body?: unknown;
  recipient?: unknown;
  sendEmail?: unknown;
  subject?: unknown;
};

function stringField(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (isSignedOut(access)) return internalMessageSignedOut("messages_load_failed");
    await assertPermission(access, "internal_messages", "read");
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? "20");
    return NextResponse.json(await listInternalMessagesForViewer(access, limit));
  } catch (error) {
    return internalMessageError(error, "messages_load_failed", "Message request failed.");
  }
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    if (isSignedOut(access)) return internalMessageSignedOut("message_send_failed");
    // The boundary: the role must hold internal_messages:create, checked before anything is stored.
    // The per-sender limits and the audit row live in sendInternalMessage, beside the insert.
    await assertPermission(access, "internal_messages", "create");
    const body = (await request.json().catch(() => ({}))) as SendMessageBody;

    return NextResponse.json(
      await sendInternalMessage(access, {
        body: stringField(body.body),
        recipient: stringField(body.recipient),
        sendEmail: body.sendEmail === true,
        subject: stringField(body.subject),
      }),
      { status: 201 },
    );
  } catch (error) {
    return internalMessageError(error, "message_send_failed", "Message request failed.");
  }
}
