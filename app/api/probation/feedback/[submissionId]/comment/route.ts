import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { addFollowUpComment } from "@/lib/probation/feedback-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ submissionId: string }> },
) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "probation", "read");

    const { submissionId } = await params;
    const body = await request.json();
    const { commentText } = body as { commentText?: string };

    if (!commentText?.trim()) {
      return NextResponse.json({ error: "commentText is required." }, { status: 400 });
    }

    const comment = await addFollowUpComment(access, submissionId, commentText);
    return NextResponse.json({ comment }, { status: 201 });
  } catch (err) {
    if (isForbiddenError(err)) return NextResponse.json({ error: String(err) }, { status: 403 });
    if (err instanceof Error && err.message.includes("Forbidden")) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
