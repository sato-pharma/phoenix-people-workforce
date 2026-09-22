import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { jsonError } from "@/lib/conversations/route-errors";
import {
  listDirectOrderConversation,
  postDirectOrderConversationComment,
} from "@/lib/direct-orders/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ERROR_CODE = "direct_order_conversation_error";

// The direct-order conversation: anyone who can view the order can read and post here, at ANY status
// (owner rule, 2026-09-22). Every message emails the requester, cc's everyone on the order, and pings
// them in-app / Telegram / push through the shared conversation notifier.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    const { id } = await context.params;
    const result = await listDirectOrderConversation(access, id);
    return NextResponse.json({ data: result, success: true });
  } catch (error) {
    return jsonError(error, "Unable to load this order's conversation.", ERROR_CODE);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { body?: string };
    const comment = await postDirectOrderConversationComment(access, id, body.body ?? "");
    return NextResponse.json({ data: comment, success: true });
  } catch (error) {
    return jsonError(error, "Unable to post your message.", ERROR_CODE);
  }
}
