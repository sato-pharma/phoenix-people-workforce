import { NextResponse } from "next/server";

import { hrIdForStorage } from "@/lib/hr-id";
import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { repTabletsErrorResponse } from "@/lib/devices/rep-tablets-http";
import { changeRepTabletPolicy, type PolicyChange } from "@/lib/devices/rep-tablets-service";
import { TabletPolicyInputError, isOwnerAppInstallType } from "@/lib/devices/tablet-policy";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseChange(payload: Record<string, unknown>): PolicyChange {
  if (payload.action === "save") return { action: "save" };
  if (payload.action === "add") {
    if (typeof payload.app !== "string" || !payload.app.trim()) {
      throw new TabletPolicyInputError("Paste the app's Google Play link, or its package name.");
    }
    if (!isOwnerAppInstallType(payload.installType)) {
      throw new TabletPolicyInputError("Choose whether the app is installed on every tablet or offered in the store.");
    }
    return { action: "add", app: payload.app, installType: payload.installType };
  }
  if (payload.action === "remove") {
    if (typeof payload.packageName !== "string" || !payload.packageName.trim()) {
      throw new TabletPolicyInputError("Say which app to remove.");
    }
    return { action: "remove", packageName: payload.packageName.trim() };
  }
  throw new TabletPolicyInputError("Unknown change — expected save, add or remove.");
}

/**
 * Push the rep tablet rules to Google: `save` as they are, or after adding or removing one app.
 *
 * 🔴 ONE PRESS REACHES EVERY ENROLLED TABLET. Removing an app uninstalls it from all of them, and the
 * page says so before the button is pressed. Gated on `company_devices:approve` (Super Admin only),
 * CSRF-guarded, and followed by a required audit row.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const change = parseChange(payload && typeof payload === "object" ? payload : {});
    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;

    return NextResponse.json(await changeRepTabletPolicy(change, actor));
  } catch (error) {
    return repTabletsErrorResponse(error, "Could not save the tablet rules.");
  }
}
