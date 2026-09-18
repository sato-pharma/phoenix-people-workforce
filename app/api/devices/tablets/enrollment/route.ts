import { NextResponse } from "next/server";

import { hrIdForStorage } from "@/lib/hr-id";
import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { repTabletsErrorResponse } from "@/lib/devices/rep-tablets-http";
import { createRepTabletEnrollment } from "@/lib/devices/rep-tablets-service";
import { DEFAULT_ENROLLMENT_VALIDITY, isEnrollmentValidity } from "@/lib/devices/tablet-enrollment";
import { TabletPolicyInputError } from "@/lib/devices/tablet-policy";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Make an enrollment code — the QR a factory-fresh tablet scans, and the typed code behind it.
 *
 * 🔴 THE RESPONSE CARRIES A CREDENTIAL. Until it expires, the code enrols a device into the
 * company's fleet, so it goes back to this caller only: never logged, never in the audit row, and
 * `no-store` so no cache between here and the browser keeps a copy. Minting one is a write on
 * Google's side, which is also why this is a CSRF-guarded POST rather than a GET.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const payload = (await request.json().catch(() => ({}))) as {
      registerDeviceId?: unknown;
      validFor?: unknown;
    };
    const validFor = payload?.validFor ?? DEFAULT_ENROLLMENT_VALIDITY;
    if (!isEnrollmentValidity(validFor)) {
      throw new TabletPolicyInputError("Choose how long the code stays usable: 1 hour, 24 hours or 7 days.");
    }
    const registerDeviceId =
      typeof payload?.registerDeviceId === "string" && payload.registerDeviceId.trim()
        ? payload.registerDeviceId.trim()
        : null;
    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;

    const enrollment = await createRepTabletEnrollment({ registerDeviceId, validFor }, actor);
    return NextResponse.json(enrollment, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return repTabletsErrorResponse(error, "Could not make an enrollment code.");
  }
}
