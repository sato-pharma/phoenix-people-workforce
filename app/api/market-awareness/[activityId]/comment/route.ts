import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { marketAwarenessErrorResponse } from "@/lib/market-awareness/api-response";
import { addActivityComment, listActivityComments } from "@/lib/market-awareness/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ activityId: string }> }) {
  try {
    const { activityId } = await params;
    const access = await resolveAccessContext(request);
    const comments = await listActivityComments(access, activityId);
    return NextResponse.json(
      { comments, success: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return marketAwarenessErrorResponse(error, "Could not load the conversation.");
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ activityId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const { activityId } = await params;
    const access = await resolveAccessContext(request);
    const body = await request.json();
    const comments = await addActivityComment(access, activityId, String(body.body ?? ""));
    return NextResponse.json({ comments, success: true });
  } catch (error) {
    return marketAwarenessErrorResponse(error, "Could not post that comment.");
  }
}
