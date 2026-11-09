import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import {
  enrollmentConfigurationId,
  getHeadwindEnrollmentState,
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
 * The Headwind enrollment codes — the QR a factory-fresh tablet scans, one per set of tablet rules.
 *
 * 🔴 GET NEVER RETURNS A CODE. It returns, for each set of rules, whether a code is held and the facts
 * about it: which agent, from which link, which server, which rules, whether it pins a checksum, and
 * why it would be refused today if it would. A code itself is a credential — scanning it puts a
 * tablet into the company's fleet — so it comes back only from an explicit
 * `POST { show: true, configurationId }`, which writes its own audit row for the look.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");
    return NextResponse.json(await getHeadwindEnrollmentState(), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return headwindErrorResponse(error, "Could not read the saved enrollment codes.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    // A body of `null`, a list or a bare string is not a request — read as empty, so it is refused
    // in words below rather than crashing on a property read.
    const body: unknown = await request.json().catch(() => null);
    const payload: Record<string, unknown> =
      body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;
    const headers = { "cache-control": "no-store" };
    const configurationId = enrollmentConfigurationId(payload.configurationId);

    if (payload.show === true) {
      return NextResponse.json(await revealHeadwindEnrollmentQr(configurationId, actor), { headers });
    }

    const raw = typeof payload.raw === "string" ? payload.raw : "";
    if (!raw.trim()) {
      throw new HeadwindEnrollmentError("Paste the enrollment code from the Headwind console.");
    }
    const templateName = typeof payload.templateName === "string" ? payload.templateName : null;

    return NextResponse.json(
      await saveHeadwindEnrollmentTemplate({ configurationId, raw, templateName }, actor),
      { headers },
    );
  } catch (error) {
    return headwindErrorResponse(error, "Could not save the enrollment code.");
  }
}
