import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { liftEmailBlock, readEmailBlocks } from "@/lib/email/suppression-admin";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who Phoenix refuses to email, and the active people with no work email. Super Admin only, in the service. */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    return NextResponse.json(await readEmailBlocks(access));
  } catch (error) {
    const apiError = toApiError(error, "Could not read the blocked emails.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json({ error: status === 403 ? "forbidden" : apiError.code, message: apiError.message }, { status });
  }
}

/** Lift one block. It deletes one row and writes a required audit entry; it sends nothing. */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as { address?: unknown };
    const view = await liftEmailBlock(access, { address: String(body.address ?? "") });
    return NextResponse.json({ ...view, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not lift the block.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
