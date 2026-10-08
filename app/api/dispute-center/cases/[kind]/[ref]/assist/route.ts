import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { listDisputeAssistEntries, runDisputeAssist } from "@/lib/dispute-center/assist.ts";
import { disputeCenterError } from "@/lib/dispute-center/http.ts";
import { isDisputeCaseKind } from "@/lib/dispute-center/types.ts";
import { validationError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The briefing reads the whole case and thinks about it; the Vercel-era default would cut it off.
export const maxDuration = 300;

// THE CASE BRIEFING and its questions. Super Admin only — his own answer to who may use it. Every
// statement names the records it rests on, and any statement whose figures are not in those records
// is dropped before the answer is returned (dispute-center/assist-verify.ts).
export async function GET(request: Request, context: { params: Promise<{ kind: string; ref: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    const { kind, ref } = await context.params;
    if (!isDisputeCaseKind(kind)) throw validationError("That kind of dispute does not exist.");
    const entries = await listDisputeAssistEntries(access, { kind, ref: decodeURIComponent(ref) });
    return NextResponse.json({ entries, success: true });
  } catch (error) {
    return disputeCenterError(error, "Unable to load what was written about this case.");
  }
}

export async function POST(request: Request, context: { params: Promise<{ kind: string; ref: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const { kind, ref } = await context.params;
    if (!isDisputeCaseKind(kind)) throw validationError("That kind of dispute does not exist.");
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const answer = await runDisputeAssist(access, {
      kind,
      question: typeof body.question === "string" && body.question.trim() ? body.question : null,
      ref: decodeURIComponent(ref),
    });
    return NextResponse.json({ answer, success: true });
  } catch (error) {
    return disputeCenterError(error, "Unable to read this case right now.");
  }
}
