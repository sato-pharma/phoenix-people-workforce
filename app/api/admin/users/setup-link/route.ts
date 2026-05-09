import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { sendPasswordSetupLink } from "@/lib/auth/password-setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "user_admin", "update");

    const payload = (await request.json().catch(() => ({}))) as {
      deliveryMode?: "copy" | "email";
      loginId?: string;
      purpose?: "reset" | "setup";
    };

    const result = await sendPasswordSetupLink({
      actorLoginId: access.loginId ?? null,
      deliveryMode: payload.deliveryMode,
      loginId: String(payload.loginId ?? ""),
      origin: new URL(request.url).origin,
      purpose: payload.purpose,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: error instanceof Error ? error.message : "Forbidden." },
        { status: 403 },
      );
    }

    const message = error instanceof Error ? error.message : "Password setup link failed.";
    return NextResponse.json({ error: "password_setup_link_failed", message }, { status: 500 });
  }
}
