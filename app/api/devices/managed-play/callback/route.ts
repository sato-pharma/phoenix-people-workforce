import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  createEnterprise,
  ENTERPRISE_RESULT_COOKIE,
  ENTERPRISE_RESULT_COOKIE_MAX_AGE_SECONDS,
  SIGNUP_URL_NAME_COOKIE,
} from "@/lib/devices/android-enterprise-signup";
import { androidManagementTokenProvider } from "@/lib/devices/android-management-auth";
import { ENTERPRISE_ALREADY_BOUND_MESSAGE, isAndroidManagementConfigured } from "@/lib/devices/android-web-app";
import { trustedOriginForRedirect } from "@/lib/security/origins";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Where the owner lands afterwards, whether it worked or not. */
export const MANAGED_PLAY_PAGE_PATH = "/devices/managed-play";

/**
 * Google's return leg — step 3 of the signup.
 *
 * WHY THIS IS A GET WITH NO CSRF CHECK, AND WHY THAT IS CORRECT. It is a top-level navigation that
 * Google performs, so there is no same-origin header to assert and `assertSameOriginMutation` would
 * reject the one request this route exists to serve. What protects it is that it is useless without
 * BOTH a single-use `enterpriseToken` that only Google's enrolment produces AND the signup-name
 * cookie set by this browser minutes earlier — and it still asserts the permission, so a forged
 * link cannot make a signed-in bystander complete an enrolment.
 *
 * 🔴 THE ERROR PATH MATTERS AS MUCH AS THE SUCCESS PATH. The owner has, by this point, already
 * completed Google's enrolment; the token is single-use and expires. Throwing a 500 here would lose
 * work he cannot repeat without starting the whole signup again, so every failure redirects back to
 * the page carrying a readable reason rather than answering with a JSON body he would never see.
 */
export async function GET(request: Request) {
  const origin = trustedOriginForRedirect(request);
  const pageUrl = new URL(`${origin}${MANAGED_PLAY_PAGE_PATH}`);

  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    // Refused once Phoenix is bound, the same as the signup that leads here — a callback must never
    // create a second enterprise beside the company's own.
    if (isAndroidManagementConfigured()) {
      pageUrl.searchParams.set("signupError", ENTERPRISE_ALREADY_BOUND_MESSAGE);
      return NextResponse.redirect(pageUrl);
    }

    const requestUrl = new URL(request.url);
    const enterpriseToken = requestUrl.searchParams.get("enterpriseToken")?.trim() ?? "";

    // Google appends its own error here when the owner backs out of the enrolment.
    const googleError = requestUrl.searchParams.get("error")?.trim();
    if (googleError) {
      pageUrl.searchParams.set("signupError", `Google reported: ${googleError}`);
      return NextResponse.redirect(pageUrl);
    }

    const cookieHeader = request.headers.get("cookie") ?? "";
    const signupUrlName =
      cookieHeader
        .split(";")
        .map((entry) => entry.trim())
        .find((entry) => entry.startsWith(`${SIGNUP_URL_NAME_COOKIE}=`))
        ?.slice(SIGNUP_URL_NAME_COOKIE.length + 1) ?? "";

    const token = await androidManagementTokenProvider()();
    const { enterpriseName } = await createEnterprise({
      enterpriseToken,
      signupUrlName: decodeURIComponent(signupUrlName),
      token,
    });

    const response = NextResponse.redirect(pageUrl);
    response.cookies.set(ENTERPRISE_RESULT_COOKIE, enterpriseName, {
      httpOnly: false,
      maxAge: ENTERPRISE_RESULT_COOKIE_MAX_AGE_SECONDS,
      path: "/",
      sameSite: "lax",
      secure: origin.startsWith("https://"),
    });
    // The signup name has done its job and is single-use — do not leave it for a later attempt to
    // pick up and send with a different enterpriseToken.
    response.cookies.set(SIGNUP_URL_NAME_COOKIE, "", { maxAge: 0, path: "/" });
    return response;
  } catch (error) {
    if (isForbiddenError(error)) {
      pageUrl.searchParams.set(
        "signupError",
        "That account is not allowed to bind the company's device fleet.",
      );
      return NextResponse.redirect(pageUrl);
    }
    pageUrl.searchParams.set(
      "signupError",
      clientSafeErrorMessage(error, "The Android Enterprise signup did not complete."),
    );
    return NextResponse.redirect(pageUrl);
  }
}
