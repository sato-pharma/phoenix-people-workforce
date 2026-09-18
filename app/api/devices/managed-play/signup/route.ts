import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  createEnterpriseSignupUrl,
  SIGNUP_URL_NAME_COOKIE,
  SIGNUP_URL_NAME_COOKIE_MAX_AGE_SECONDS,
} from "@/lib/devices/android-enterprise-signup";
import { androidManagementTokenProvider } from "@/lib/devices/android-management-auth";
import { AndroidManagementRequestError } from "@/lib/devices/android-web-app";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { trustedOriginForRedirect } from "@/lib/security/origins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const ENTERPRISE_CALLBACK_PATH = "/api/devices/managed-play/callback";

/**
 * Start the Android Enterprise signup — step 1 of the three in `android-enterprise-signup.ts`.
 *
 * 🔴 Gated on `company_devices:approve`, Super Admin only, for a stronger reason than the iframe
 * route: whoever completes this flow decides which Google account permanently OWNS the company's
 * device fleet, and that binding cannot be moved afterwards.
 *
 * The signup URL's name comes back here and is needed again at the callback, which Google's redirect
 * does not carry — so it is parked in an httpOnly cookie. `sameSite: "lax"` is load-bearing and not
 * a default worth tightening: the callback is a top-level navigation originating on Google's domain,
 * and a `strict` cookie is not sent on one, so the last step would fail every time.
 */
export async function POST(request: Request) {
  try {
    assertSameOriginMutation(request);

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const origin = trustedOriginForRedirect(request);
    const token = await androidManagementTokenProvider()();
    const signup = await createEnterpriseSignupUrl({
      callbackUrl: `${origin}${ENTERPRISE_CALLBACK_PATH}`,
      token,
    });

    const response = NextResponse.json({ signupUrl: signup.url });
    response.cookies.set(SIGNUP_URL_NAME_COOKIE, signup.name, {
      httpOnly: true,
      maxAge: SIGNUP_URL_NAME_COOKIE_MAX_AGE_SECONDS,
      path: "/",
      sameSite: "lax",
      secure: origin.startsWith("https://"),
    });
    return response;
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    if (error instanceof AndroidManagementRequestError) {
      return NextResponse.json({ message: error.message }, { status: 502 });
    }
    return NextResponse.json(
      {
        message:
          error instanceof Error ? error.message : "Could not start the Android Enterprise signup.",
      },
      { status: 500 },
    );
  }
}
