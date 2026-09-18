import { NextResponse } from "next/server";

import { hrIdForStorage } from "@/lib/hr-id";
import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { DeviceIdentityCorrectionError } from "@/lib/devices/device-identity";
import {
  correctDeviceIdentity,
  deviceErrorMessage,
  getDeviceRegisterData,
  isDeviceRegisterSchemaMissing,
} from "@/lib/devices/service";
import { isDevelopment } from "@/lib/env";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Correct the serial number and IMEI of an entry already in the custody register.
 *
 * Gated on `company_devices:approve` — Super Admin only, by the owner's decision of 2026-09-18 —
 * not the `update` HR Operations holds for issuing and returning. A serial number and an IMEI are
 * what identify a device to the police, an operator and an insurer, and replacing one rewrites
 * that identity, so it sits with the same grant as Rep Tablets' own IMEI copy.
 *
 * CSRF-guarded before anything is read; the permission is asserted before the body is parsed; a
 * written reason is required; the form's own view of the entry is sent and must still be true; and
 * the service writes a required audit row, with the old values, BEFORE the entry changes.
 */
function identityApiError(error: unknown) {
  if (isForbiddenError(error)) return { message: deviceErrorMessage(error), status: 403 };
  if (isDeviceRegisterSchemaMissing(error)) {
    return {
      message: isDevelopment ? deviceErrorMessage(error) : "The device register is not ready.",
      status: 409,
    };
  }
  // The caller got it wrong — a blank reason, a malformed IMEI, a number another entry holds. The
  // sentence is written for the person who pressed Save.
  if (error instanceof DeviceIdentityCorrectionError) return { message: error.message, status: 400 };
  return { message: deviceErrorMessage(error), status: 500 };
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const payload = (await request.json().catch(() => null)) as {
      deviceId?: unknown;
      serialNumber?: unknown;
      imei?: unknown;
      reason?: unknown;
      shownSerialNumber?: unknown;
      shownImei?: unknown;
    } | null;
    const deviceId = typeof payload?.deviceId === "string" ? payload.deviceId.trim() : "";
    if (!deviceId) {
      return NextResponse.json(
        { error: "device_identity_correction_failed", message: "Which device is being corrected?" },
        { status: 400 },
      );
    }

    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;

    await correctDeviceIdentity(
      {
        deviceId,
        serialNumber: textOrNull(payload?.serialNumber),
        imei: textOrNull(payload?.imei),
        reason: textOrNull(payload?.reason) ?? "",
        // What the form showed. Missing reads as "nothing recorded", so a caller that leaves them
        // out is refused on any entry that holds a number — never waved through.
        shownSerialNumber: textOrNull(payload?.shownSerialNumber),
        shownImei: textOrNull(payload?.shownImei),
      },
      actor,
    );
    return NextResponse.json(await getDeviceRegisterData(), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const { message, status } = identityApiError(error);
    return NextResponse.json({ error: "device_identity_correction_failed", message }, { status });
  }
}
