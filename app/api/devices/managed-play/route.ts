import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { androidManagementTokenProvider } from "@/lib/devices/android-management-auth";
import {
  AndroidManagementNotConfiguredError,
  AndroidManagementRequestError,
  androidManagementConfig,
} from "@/lib/devices/android-web-app";
import {
  buildManagedPlayIframeUrl,
  createManagedPlayWebToken,
  PHOENIX_IFRAME_FEATURES,
} from "@/lib/devices/managed-play-iframe";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { trustedOriginForRedirect } from "@/lib/security/origins";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mint a managed Google Play iframe URL.
 *
 * 🔴 GATED ON `company_devices:approve`, WHICH ONLY SUPER ADMIN HOLDS. Every other action on this
 * resource is custody paperwork — HR Operations registers a tablet and records a handover. This one
 * is not paperwork: whoever opens this iframe can publish an application that force-installs itself
 * on every rep's tablet in the field. `approve` is the action that separates the two, and the
 * permission matrix already grants it to Super Admin alone, so no new resource was needed to say it.
 *
 * WHY POST FOR SOMETHING THAT READS LIKE A GET. Minting a web token is a write on Google's side, and
 * routing it through POST also puts it behind `assertSameOriginMutation` — without which any page on
 * the internet could cause the owner's browser to mint a fleet-publishing credential.
 *
 * 🔴 THE TOKEN IS NEVER LOGGED. It is a short-lived bearer credential for the whole enterprise, so
 * the URL that carries it goes to the caller and nowhere else — not into a log line, not into an
 * error message. `redactWebToken` exists for anything that ever needs to write one down.
 */
export async function POST(request: Request) {
  try {
    // 🔴 THE RETURN IS THE CHECK. `assertSameOriginMutation` does not throw — it HANDS BACK a 403
    // Response when the origin is wrong and undefined when it is right, so calling it and dropping
    // the answer leaves the route wide open while reading exactly like a guarded one. Mine did, and
    // tests/csrf-route-coverage caught it by name. Assign it and return it.
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const { enterpriseName } = androidManagementConfig();

    // Google matches the parent frame against this value, so it has to be the origin the page is
    // actually served from. `trustedOriginForRedirect` resolves it from the request but only ever
    // returns an allowlisted origin, so a forged Host header cannot point the iframe somewhere else.
    const parentFrameUrl = trustedOriginForRedirect(request);

    const token = await androidManagementTokenProvider()();
    const webToken = await createManagedPlayWebToken({
      enabledFeatures: PHOENIX_IFRAME_FEATURES,
      enterpriseName,
      parentFrameUrl,
      token,
    });

    return NextResponse.json({
      iframeUrl: buildManagedPlayIframeUrl({
        enabledFeatures: PHOENIX_IFRAME_FEATURES,
        homepage: "PRIVATE_APPS",
        webToken: webToken.value,
      }),
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    // A missing binding is a SETUP state, not a failure, and the page turns it into instructions —
    // the same 400-not-500 choice the Action1 routes make for the same reason.
    if (error instanceof AndroidManagementNotConfiguredError) {
      return NextResponse.json({ message: error.message, setupRequired: true }, { status: 400 });
    }
    if (error instanceof AndroidManagementRequestError) {
      return NextResponse.json({ message: error.message }, { status: 502 });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "Could not open managed Google Play.") },
      { status: 500 },
    );
  }
}
