import { NextResponse } from "next/server";

import { completePasswordSetup } from "@/lib/auth/password-setup";
import { checkRateLimit, clientIp } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  try {
    const ip = clientIp(request.headers);
    const { limited } = checkRateLimit(`password-setup:${ip}`, {
      maxRequests: 5,
      windowMs: 15 * 60 * 1000,
    });
    if (limited) {
      return NextResponse.json(
        { error: "rate_limited", message: "Too many requests. Please try again later." },
        { status: 429 },
      );
    }

    const { token } = await context.params;

    if (!TOKEN_RE.test(token)) {
      return NextResponse.json({ error: "invalid_token", message: "Password setup link is invalid." }, { status: 400 });
    }

    const payload = (await request.json().catch(() => ({}))) as {
      confirmPassword?: string;
      password?: string;
    };

    const password = String(payload.password ?? "");
    const confirmPassword = String(payload.confirmPassword ?? "");

    if (!password) {
      return NextResponse.json({ error: "missing_password", message: "Password is required." }, { status: 400 });
    }

    if (password.length < PASSWORD_MIN) {
      return NextResponse.json({ error: "password_too_short", message: `Password must be at least ${PASSWORD_MIN} characters.` }, { status: 400 });
    }

    if (password.length > PASSWORD_MAX) {
      return NextResponse.json({ error: "password_too_long", message: `Password must be ${PASSWORD_MAX} characters or fewer.` }, { status: 400 });
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
