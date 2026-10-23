import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { headwindErrorResponse } from "@/lib/devices/headwind/http";
import { HeadwindUploadError, uploadHeadwindApp, uploadHeadwindFile } from "@/lib/devices/headwind/uploads";
import { hrIdForStorage } from "@/lib/hr-id";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * 🔴 FIVE MINUTES, NOT THE DEFAULT. An APK is tens of megabytes and crosses the network twice — into
 * Phoenix and out to the Headwind box. On the platform default this times out mid-transfer and leaves
 * a part-written file in the server's staging area, which reads to the next person as a corrupt app.
 */
export const maxDuration = 300;

/**
 * Send an APK or a file up to the company's Headwind server, and optionally put it straight into a set
 * of tablet rules — which is what actually installs it.
 *
 * Multipart, so it is its own route rather than a branch of the JSON one. Fields: `file`, `kind`
 * (`app` or `file`), and optionally `configurationId`, `showIcon`, `description`, `path`.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const form = await request.formData().catch(() => null);
    if (!form) throw new HeadwindUploadError("Choose a file to send.");

    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;
    const rawConfiguration = form.get("configurationId");
    const configurationId =
      typeof rawConfiguration === "string" && rawConfiguration.trim() ? Number(rawConfiguration) : null;
    const file = form.get("file");
    const headers = { "cache-control": "no-store" };

    if (form.get("kind") === "file") {
      return NextResponse.json(
        await uploadHeadwindFile(
          {
            configurationId,
            description: typeof form.get("description") === "string" ? String(form.get("description")) : null,
            file,
            path: typeof form.get("path") === "string" ? String(form.get("path")) : null,
          },
          actor,
        ),
        { headers },
      );
    }

    return NextResponse.json(
      await uploadHeadwindApp({ configurationId, file, showIcon: form.get("showIcon") !== "false" }, actor),
      { headers },
    );
  } catch (error) {
    return headwindErrorResponse(error, "Could not send that to the Headwind server.");
  }
}
