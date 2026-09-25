import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import {
  ManageEngineEnrollmentInputError,
  getManageEngineEnrollmentSummary,
  readManageEngineEnrollmentQr,
  saveManageEngineEnrollmentTemplate,
} from "@/lib/devices/manageengine/enrollment";
import { manageEngineErrorResponse } from "@/lib/devices/manageengine/http";
import { hrIdForStorage } from "@/lib/hr-id";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The ManageEngine enrollment template — what a factory-fresh rep tablet scans.
 *
 * 🔴 THE PAYLOAD IS A CREDENTIAL: scanning it enrolls a tablet into the company's fleet. So the GET
 * that the page loads returns everything ABOUT the template and never the template — the name, the
 * agent package, the download host, when it was saved and by whom. The payload itself comes back
 * only from `POST { show: true }`, which a person triggers deliberately and the page drops again on
 * "Hide the code". Both verbs carry `company_devices:approve`, Super Admin only, and the write is
 * same-origin guarded and writes a REQUIRED audit row.
 *
 * WHY A TEMPLATE AT ALL. ManageEngine's REST API exposes no enrollment endpoint, so there is nothing
 * to mint per tablet: the QR is made once in their console and is the same for every tablet enrolled
 * through it. That is the whole reason this route saves a payload instead of creating one.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");
    return NextResponse.json(await getManageEngineEnrollmentSummary(), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return manageEngineErrorResponse(error, "Could not read the ManageEngine enrollment template.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    // Showing the saved code is a read, but it is a read of a credential, so it is asked for by an
    // explicit action rather than falling out of the page's ordinary load.
    if (payload.show === true) {
      return NextResponse.json(await readManageEngineEnrollmentQr(), { headers: { "cache-control": "no-store" } });
    }

    const raw = typeof payload.raw === "string" ? payload.raw : "";
    const templateName = typeof payload.templateName === "string" ? payload.templateName : null;
    if (!raw.trim()) throw new ManageEngineEnrollmentInputError("Paste the QR payload from the ManageEngine enrollment template.");

    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;

    return NextResponse.json(await saveManageEngineEnrollmentTemplate({ raw, templateName }, actor));
  } catch (error) {
    return manageEngineErrorResponse(error, "Could not save the ManageEngine enrollment template.");
  }
}
