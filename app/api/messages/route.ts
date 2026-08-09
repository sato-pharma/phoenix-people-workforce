import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  listInternalMessagesForViewer,
  sendInternalMessage,
} from "@/lib/internal-messages/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

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

function messageError(error: unknown) {
  const message = clientSafeErrorMessage(error, "Message request failed.");
  const unauthenticated = message.toLowerCase().includes("authentication is required");
  return {
    message,
    status: unauthenticated ? 401 : 400,
  };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? "20");
    return NextResponse.json(await listInternalMessagesForViewer(access, limit));
  } catch (error) {
    const { message, status } = messageError(error);
    return NextResponse.json({ error: "messages_load_failed", message }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
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
    const { message, status } = messageError(error);
    return NextResponse.json({ error: "message_send_failed", message }, { status });
  }
}
