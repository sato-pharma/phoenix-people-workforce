import { NextResponse } from "next/server";

import { completePasswordSetup } from "@/lib/auth/password-setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await context.params;
    const payload = (await request.json().catch(() => ({}))) as {
      confirmPassword?: string;
      password?: string;
    };

    const password = String(payload.password ?? "");
    const confirmPassword = String(payload.confirmPassword ?? "");

    if (!password) {
      return NextResponse.json({ error: "missing_password", message: "Password is required." }, { status: 400 });
    }

    if (password !== confirmPassword) {
      return NextResponse.json({ error: "password_mismatch", message: "Passwords do not match." }, { status: 400 });
    }

    const result = await completePasswordSetup({ password, token });

    return NextResponse.json({ success: true, warning: result.bridgeWarning });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Password setup failed.";
    return NextResponse.json({ error: "password_setup_failed", message }, { status: 400 });
  }
}
