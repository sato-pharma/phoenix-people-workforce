import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import {
  getHeadwindEnrollmentSummary,
  HeadwindEnrollmentError,
  revealHeadwindEnrollmentQr,
  saveHeadwindEnrollmentTemplate,
} from "@/lib/devices/headwind/enrollment";
import { headwindErrorResponse } from "@/lib/devices/headwind/http";
import { hrIdForStorage } from "@/lib/hr-id";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Headwind enrollment code — the QR a factory-fresh tablet scans.
 *
 * 🔴 GET NEVER RETURNS THE CODE. It returns whether one is held and the facts about it: which agent,
 * which server, which set of rules, whether it pins a checksum. The code itself is a credential —
 * scanning it puts a tablet into the company's fleet — so it comes back only from an explicit
 * `POST { show: true }`, which writes its own audit row for the look.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");
    return NextResponse.json(await getHeadwindEnrollmentSummary(), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return headwindErrorResponse(error, "Could not read the saved enrollment code.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;
    const headers = { "cache-control": "no-store" };

    if (payload.show === true) {
      return NextResponse.json(await revealHeadwindEnrollmentQr(actor), { headers });
    }

    const raw = typeof payload.raw === "string" ? payload.raw : "";
    if (!raw.trim()) {
      throw new HeadwindEnrollmentError("Paste the enrollment code from the Headwind console.");
    }
    const templateName = typeof payload.templateName === "string" ? payload.templateName : null;

    return NextResponse.json(await saveHeadwindEnrollmentTemplate({ raw, templateName }, actor), { headers });
  } catch (error) {
    return headwindErrorResponse(error, "Could not save the enrollment code.");
  }
}
