import { NextResponse } from "next/server";

import { assertPageOpenForRole } from "@/lib/auth/seat-page-fences";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import {
  createCvLifecycleShareLink,
  listCvLifecycleShareLinks,
  revokeCvLifecycleShareLink,
} from "@/lib/recruitment/cv-lifecycle-share-links";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Manage the live CV-lifecycle sheet links: list what exists, mint one, revoke one.
//
// The links themselves are served by /api/share/cv-lifecycle/[token]/feed, which is deliberately
// unauthenticated; this route is the authenticated side that mints and kills them. Both the list
// and the mutations are gated inside the domain module on `recruitment:export` — the authority to
// copy the candidate pool out of Phoenix, which is a different act from reading it inside.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    // CV Sheet Links is fenced off the Talent Acquisition seat (src/lib/auth/seat-page-fences.ts):
    // her recruitment:export exports what she sees, it does not mint a public feed of the pool.
    assertPageOpenForRole(access.role, "/recruitment/cv-lifecycle-sheet");
    const links = await listCvLifecycleShareLinks(access);
    return NextResponse.json({ links, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not load the sheet links.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    assertPageOpenForRole(access.role, "/recruitment/cv-lifecycle-sheet");
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    if (String(body.action ?? "") === "revoke") {
      await revokeCvLifecycleShareLink(access, String(body.linkId ?? ""));
      return NextResponse.json({ success: true });
    }

    const result = await createCvLifecycleShareLink(access, {
      expiresInDays: body.expiresInDays == null ? null : Number(body.expiresInDays),
      label: body.label ? String(body.label) : null,
    });
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not create the sheet link.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
