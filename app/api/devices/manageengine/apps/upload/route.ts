import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { ManageEngineAppInputError, uploadManageEngineApp } from "@/lib/devices/manageengine/apps";
import { manageEngineErrorResponse } from "@/lib/devices/manageengine/http";
import { hrIdForStorage } from "@/lib/hr-id";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** An APK is tens of megabytes and the whole file is read before it is forwarded — well past a default. */
export const maxDuration = 300;

/**
 * Add an APK to the company app repository in ManageEngine.
 *
 * 🔴 IT IS A WRITE, SO IT CARRIES THE SAME GUARD AS THE REST OF THIS PAGE — `company_devices:approve`
 * (Super Admin only), same-origin, and a REQUIRED audit row written by the service naming the app and
 * the file. It reaches NO tablet: an app in the repository is an app that CAN be sent, and sending it
 * is the per-tablet Apps section with its own audit row.
 *
 * 🔴 THE BODY IS MULTIPART, WHICH IS WHY THIS ROUTE IS ITS OWN FILE. The sibling route dispatches
 * three JSON changes on one POST; a file cannot ride in that shape without base64-ing an APK through
 * a JSON string, which would inflate it by a third and hold the whole thing twice in memory. The file
 * is read here and handed to the service as bytes; the service, not this route, decides what
 * ManageEngine is told.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const form = await request.formData().catch(() => null);
    if (!form) throw new ManageEngineAppInputError("Nothing was uploaded. Choose the APK file and try again.");

    const file = form.get("file");
    if (!(file instanceof File)) throw new ManageEngineAppInputError("Choose the APK file to add.");

    const appNameField = form.get("appName");
    const descriptionField = form.get("description");

    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;

    const result = await uploadManageEngineApp(
      {
        appName: typeof appNameField === "string" ? appNameField : null,
        bytes: new Uint8Array(await file.arrayBuffer()),
        description: typeof descriptionField === "string" ? descriptionField : null,
        fileName: file.name,
      },
      actor,
    );

    return NextResponse.json(result);
  } catch (error) {
    return manageEngineErrorResponse(error, "Could not add that app to the company repository.");
  }
}
