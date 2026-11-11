import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  isContractRecommendationError,
  submitManagerRecommendation,
} from "@/lib/contracts/manager-recommendation";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A manager records "renew" / "do not renew" on an employee's contract renewal.
 *
 * Deliberately NOT under /api/contracts/**, whose blanket demands contracts:update — the managers who
 * answer the reminder hold no contracts grant at all. Every role holds employee_profile:read, and the
 * real decision is the record-level one inside submitManagerRecommendation: the caller must be above
 * the employee in the reporting line (src/lib/contracts/manager-recommendation.ts).
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_profile", "read");

    const body = await request.json().catch(() => null);
    const context = await submitManagerRecommendation(access, body);
    return NextResponse.json({ context, success: true });
  } catch (error) {
    if (isContractRecommendationError(error)) {
      return NextResponse.json({ error: error.message, success: false }, { status: error.status });
    }
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "You cannot record this recommendation.", success: false }, { status: 403 });
    }
    return NextResponse.json(
      { error: clientSafeErrorMessage(error, "The recommendation could not be saved."), success: false },
      { status: 500 },
    );
  }
}
