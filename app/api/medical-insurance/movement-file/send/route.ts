import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { medicalInsuranceErrorResponse, readJsonBody } from "@/lib/medical-insurance/route-helpers";
import { sendLibanoMovementEmail } from "@/lib/medical-insurance/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/medical-insurance/movement-file/send { kind: "additions" | "deletions", keys, categories? } — emails
 * the ticked people's Additions or Deletions workbook, the very file POST /api/medical-insurance/movement-file
 * builds, to Libano-Suisse's policy administration, copying their account manager and the owner (owner,
 * 27 Nov 2026). The recipients are fixed in src/lib/medical-insurance/libano-movement-email.ts and never read
 * from the request. A same-origin mutation, asserted before anything is read; the register does not change.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "medical_insurance", "export");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:medical-insurance-movement-send" });
    const outcome = await sendLibanoMovementEmail(access, await readJsonBody(request));
    return NextResponse.json({ outcome });
  } catch (error) {
    return medicalInsuranceErrorResponse(error, "medical_insurance_movement_send_failed");
  }
}
