import { NextResponse } from "next/server";

import { hrIdForStorage } from "@/lib/hr-id";
import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { repTabletsErrorResponse } from "@/lib/devices/rep-tablets-http";
import { registerRepTabletFromUsb } from "@/lib/devices/rep-tablets-service";
import { TabletPolicyInputError } from "@/lib/devices/tablet-policy";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FIELD = 120;

function field(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, MAX_FIELD) : null;
}

/**
 * Add a tablet to the custody register from what its USB connection says about it — the serial
 * number, maker and product name the browser read through WebUSB. Answers the asset tag it now has
 * (or already had), so the page can make that tablet's one-time enrollment code straight away.
 *
 * 🔴 GATED ON `company_devices:approve`, like the rest of Rep Tablets; CSRF-checked. The register's
 * own `createDevice` writes the required audit row.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const serialNumber = field(payload?.serialNumber);
    if (!serialNumber) {
      throw new TabletPolicyInputError(
        "The tablet did not give its serial number over USB. Unlock it, choose \"File transfer\" in its USB notification, and connect again.",
      );
    }
    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;

    const registered = await registerRepTabletFromUsb(
      { imei: null, manufacturer: field(payload?.manufacturer), model: field(payload?.model), serialNumber },
      actor,
    );
    return NextResponse.json(registered, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return repTabletsErrorResponse(error, "Could not add the tablet to the custody register.");
  }
}
