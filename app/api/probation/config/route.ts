import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  getProbationConfig,
  saveProbationConfig,
  ProbationConfigValidationError,
  type ProbationConfigInput,
} from "@/lib/probation/intelligence/config";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read the current probation config (admin editor). Gated at probation:update (Super-Admin bar).
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "probation", "update");
    const config = await getProbationConfig();
    return NextResponse.json({ config }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    return NextResponse.json({ error: clientSafeErrorMessage(error, "The probation settings could not be read.") }, { status: 500 });
  }
}

// Save the probation config. Validates, upserts the singleton, audits, and clears the cache.
export async function PATCH(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "probation", "update");

    const body = (await request.json()) as ProbationConfigInput;
    const config = await saveProbationConfig(body, { loginId: access.loginId, hrId: access.hrId });
    return NextResponse.json({ config });
  } catch (error) {
    if (error instanceof ProbationConfigValidationError) {
      return NextResponse.json({ error: error.message, issues: error.issues }, { status: 400 });
    }
    if (isForbiddenError(error)) return NextResponse.json({ error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    return NextResponse.json({ error: String((error as { message?: unknown })?.message ?? error) }, { status: 500 });
  }
}
