import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { addDeductionsComment, findDeductionsCandidateOwner } from "@/lib/deductions/comments.ts";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(error: unknown, fallback: string, defaultStatus = 500) {
  if (error instanceof SyntaxError) {
    return NextResponse.json({ success: false, message: "The request body is not valid JSON." }, { status: 400 });
  }
  if (isForbiddenError(error)) {
    return NextResponse.json({ success: false, message: (error as Error).message }, { status: 403 });
  }
  const message = clientSafeErrorMessage(error, fallback);
  const lower = message.toLowerCase();
  if (lower.includes("not authenticated")) return NextResponse.json({ success: false, message }, { status: 401 });
  if (lower.includes("forbidden")) return NextResponse.json({ success: false, message }, { status: 403 });
  // Matched on the sentences the comment service writes, never on the word "comment" alone: the
  // route's own fallback ("Failed to save deduction comment.") contains it, so every unexpected
  // server failure used to answer 400 and never reached monitoring.
  if (message !== fallback && (lower.includes("required") || lower.includes("cannot exceed") || lower.includes("only after"))) {
    return NextResponse.json({ success: false, message }, { status: 400 });
  }
  if (lower.includes("not found")) return NextResponse.json({ success: false, message }, { status: 404 });
  return NextResponse.json({ success: false, message }, { status: defaultStatus });
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_profile", "read");
    const body = await request.json();
    const candidateId = String(body.candidateId ?? "").trim();
    if (!candidateId) {
      return NextResponse.json({ success: false, message: "candidateId is required." }, { status: 400 });
    }
    // Every candidateId now belongs to the unified Deductions module — the legacy
    // governance ledger was retired in the C6 cutover (2026-08-30). addDeductionsComment
    // re-validates ownership and the "only after publication" gate itself; the pre-check
    // here just yields a clean 404 for an id that is not a unified candidate at all.
    const ownsCandidate = await findDeductionsCandidateOwner(candidateId);
    if (!ownsCandidate) {
      return NextResponse.json({ success: false, message: "Deduction not found." }, { status: 404 });
    }
    const comment = await addDeductionsComment({ access, body: String(body.body ?? ""), candidateId });
    return NextResponse.json({ success: true, comment });
  } catch (error) {
    return jsonError(error, "Failed to save deduction comment.");
  }
}
