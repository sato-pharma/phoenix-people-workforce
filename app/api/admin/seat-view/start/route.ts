import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { phoenixSeatViewCookieName } from "@/lib/auth/seat-view-constants";
import { startSeatView } from "@/lib/auth/seat-view-service";
import { phoenixSessionCookieName } from "@/lib/auth/session-token";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { ApiError, clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// VIEW AS SEAT — open a read-only view of a seat (src/lib/auth/seat-view.ts). Super Admin only, on his
// own live session; a view already open is refused by the seat-view guard before this runs.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as { role?: unknown; hrId?: unknown };
    const cookieStore = await cookies();

    const { token, landingPath, maxAge } = await startSeatView({
      access,
      sessionToken: cookieStore.get(phoenixSessionCookieName)?.value,
      role: typeof body.role === "string" ? body.role : null,
      hrId: typeof body.hrId === "string" ? body.hrId : null,
    });

    cookieStore.set(phoenixSeatViewCookieName, token, {
      httpOnly: true,
      maxAge,
      path: "/",
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
    });

    return NextResponse.json({ success: true, landingPath });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: clientSafeErrorMessage(error, "You cannot open this view.") },
        { status: 403 },
      );
    }
    if (error instanceof ApiError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: "seat_view_failed", message: clientSafeErrorMessage(error, "The view could not be opened.") },
      { status: 500 },
    );
  }
}
