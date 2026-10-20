import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { phoenixSeatViewCookieName } from "@/lib/auth/seat-view-constants";
import { endSeatView } from "@/lib/auth/seat-view-service";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// VIEW AS SEAT — leave the view. The ONE write a seat view may send (seat-view.ts `seatViewMayRun`).
// It always clears the cookie, whatever else happens: leaving must never fail.
export async function POST(request: Request) {
  const csrf = assertSameOriginMutation(request);
  if (csrf) return csrf;

  try {
    const access = await resolveAccessContext(request);
    await endSeatView(access);
  } catch {
    // Best effort — the audit row is the only thing that can fail here, and the exit still happens.
  }

  const cookieStore = await cookies();
  cookieStore.set(phoenixSeatViewCookieName, "", {
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
  });

  return NextResponse.json({ success: true });
}
