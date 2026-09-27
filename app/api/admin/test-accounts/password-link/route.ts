import { NextResponse } from "next/server";

import { assertTestAccountAdmin, testAccountPasswordLink } from "@/lib/admin/test-accounts";
import { resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { trustedOriginForRedirect } from "@/lib/security/origins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = the one-time set-password link for a test account, returned to the Super Admin's screen to
// open himself. It is never emailed: a test account has no mailbox, and its password is his to choose.
// The origin is an allow-listed Phoenix origin, never the raw forwarded host (see the Users screen's
// own setup-link route for why).
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertTestAccountAdmin(access);
    const body = (await request.json().catch(() => null)) as { loginId?: unknown } | null;
    const link = await testAccountPasswordLink({ loginId: body?.loginId }, access, trustedOriginForRedirect(request));
    return NextResponse.json({ ...link, success: true }, { status: 201 });
  } catch (error) {
    const apiError = toApiError(error, "The password link could not be made.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
