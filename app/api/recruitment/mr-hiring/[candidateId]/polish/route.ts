import { NextResponse } from "next/server";

import { assertSameOriginMutation, readJsonObject, recruitmentApiError, recruitmentProblem } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { isUuid } from "@/lib/http/uuid";
import { isMrPolishKind, MrPolishError, polishMrSpokenWords } from "@/lib/recruitment/mr-hiring/polish";
import { assertMayPolishMrWords } from "@/lib/recruitment/mr-hiring/server";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The words a manager just said into a Medical Rep hiring comment box, back as professional English (owner,
// 8 Nov 2026: "it fix the spelling and the grammar … rephrase it into professional corporate language").
// A POST because it calls a paid service, not because it writes anything: nothing is saved and nothing is
// decided — the text goes back into the box the speaker is editing, saved by the Save he was going to press.
// Only someone who reads this candidate's journey and can write on it (`assertMayPolishMrWords`).
//
//   POST { kind: "result" | "recommendation" | "booking", spoken } → { text }
export async function POST(request: Request, { params }: { params: Promise<{ candidateId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) return recruitmentProblem("Sign in again.", 401);
    const { candidateId } = await params;
    if (!isUuid(candidateId)) return recruitmentProblem("Candidate not found.", 404);
    await assertCandidateVisible(access, candidateId);
    await assertMayPolishMrWords(access, candidateId);

    const body = await readJsonObject(request);
    const kind = isMrPolishKind(body.kind) ? body.kind : "result";
    const spoken = typeof body.spoken === "string" ? body.spoken : "";
    const { text } = await polishMrSpokenWords({ kind, spoken });
    return NextResponse.json({ success: true, text });
  } catch (error) {
    if (error instanceof MrPolishError) {
      return recruitmentProblem(error.message, error.code === "polish_rate_limited" ? 429 : 400, { code: error.code });
    }
    return recruitmentApiError(error, "Your words were kept as you said them.");
  }
}
