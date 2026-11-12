import { NextResponse } from "next/server";

import { completePasswordSetup } from "@/lib/auth/password-setup";
import {
  isNativeFormSubmission,
  passwordSetupReturnPath,
  type PasswordSetupNoScriptErrorCode,
} from "@/lib/auth/password-setup-no-script";
import { SIGN_IN_AFTER_SETUP_PARAM, SIGN_IN_AFTER_SETUP_VALUE } from "@/lib/auth/temporary-password";
import {
  assertApiRateLimit,
  isApiRateLimitError,
  rateLimitIdentity,
} from "@/lib/security/api-rate-limit";
import { trustedOriginForRedirect } from "@/lib/security/origins";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Two callers. The screen's script posts JSON and reads a JSON answer, as it always has. A browser whose
 * scripts never ran (Safari before 16.4 cannot parse Next.js's own runtime — src/lib/auth/password-setup-no-script.ts)
 * posts the form natively, and is answered with a 303 back to the screen, carrying `saved` or a fixed error code.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const nativeForm = isNativeFormSubmission(request.headers.get("content-type"));
  const signInAfter = new URL(request.url).searchParams.get(SIGN_IN_AFTER_SETUP_PARAM) === SIGN_IN_AFTER_SETUP_VALUE;
  let token = "";

  const backToScreen = (error: PasswordSetupNoScriptErrorCode) =>
    NextResponse.redirect(
      new URL(passwordSetupReturnPath(token, { error, signInAfter }), trustedOriginForRedirect(request)),
      303,
    );

  try {
    token = (await context.params).token;
    try {
      await assertApiRateLimit({
        identifier: rateLimitIdentity({ request, token }),
        limit: 10,
        scope: "auth:password_setup",
        windowMs: 15 * 60 * 1000,
      });
    } catch (error) {
      if (!isApiRateLimitError(error)) throw error;
      if (nativeForm) return backToScreen("rate_limited");
      return NextResponse.json(
        {
          error: "rate_limited",
          message: "Too many password setup attempts. Please try again later.",
          retryAfterSeconds: error.retryAfterSeconds,
        },
        { status: 429 },
      );
    }

    let password: string;
    let confirmPassword: string;
    if (nativeForm) {
      const form = await request.formData().catch(() => null);
      password = String(form?.get("password") ?? "");
      confirmPassword = String(form?.get("confirmPassword") ?? "");
    } else {
      const payload = (await request.json().catch(() => ({}))) as {
        confirmPassword?: string;
        password?: string;
      };
      password = String(payload.password ?? "");
      confirmPassword = String(payload.confirmPassword ?? "");
    }

    if (!password) {
      if (nativeForm) return backToScreen("missing_password");
      return NextResponse.json({ error: "missing_password", message: "Password is required." }, { status: 400 });
    }

    if (password !== confirmPassword) {
      if (nativeForm) return backToScreen("password_mismatch");
      return NextResponse.json({ error: "password_mismatch", message: "Passwords do not match." }, { status: 400 });
    }

    // The same floor completePasswordSetup enforces, checked here only so a native post can name it with a
    // fixed code; the JSON caller still gets the service's own words.
    if (nativeForm && password.trim().length < 8) return backToScreen("too_short");

    const result = await completePasswordSetup({ password, token });

    if (nativeForm) {
      return NextResponse.redirect(
        new URL(passwordSetupReturnPath(token, { saved: true }), trustedOriginForRedirect(request)),
        303,
      );
    }
    return NextResponse.json({ success: true, warning: result.bridgeWarning });
  } catch (error) {
    if (nativeForm && token) return backToScreen("password_setup_failed");
    const message = clientSafeErrorMessage(error, "Password setup failed.");
    return NextResponse.json({ error: "password_setup_failed", message }, { status: 400 });
  }
}
