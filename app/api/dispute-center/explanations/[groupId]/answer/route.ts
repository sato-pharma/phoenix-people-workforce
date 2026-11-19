import { NextResponse } from "next/server";
import { z } from "zod";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { answerExplanationGroup } from "@/lib/dispute-center/explanations";
import { toApiError, validationError } from "@/lib/http/api-errors";
import { parseJsonBody } from "@/lib/http/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The explanation confirm queue sends `{ answer, note }` — "confirmed" or "declined", and the
 * confirmer's note ("" when blank). The answer is checked below with the route's own words; whether
 * this caller is the person named is checked inside answerExplanationGroup.
 */
const AnswerBodySchema = z.object({
  answer: z.string().nullish(),
  note: z.string().nullish(),
});

// The named confirmer confirms or declines one explanation. Only the person named may answer — the
// domain helper compares the session's HR id with the confirmer on the record.
export async function POST(request: Request, { params }: { params: Promise<{ groupId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { groupId } = await params;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "read");
    const parsed = await parseJsonBody(request, AnswerBodySchema);
    if (!parsed.ok) throw validationError(parsed.message);
    const body = parsed.data;
    const answer = body.answer === "confirmed" || body.answer === "declined" ? body.answer : null;
    if (!answer) throw validationError("answer must be 'confirmed' or 'declined'.");
    const result = await answerExplanationGroup(access, { answer, groupId, note: typeof body.note === "string" ? body.note : null });
    return NextResponse.json({ data: result, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Unable to save your answer.");
    return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
  }
}
