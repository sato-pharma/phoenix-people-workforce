import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { medicalInsuranceErrorResponse, readJsonBody } from "@/lib/medical-insurance/route-helpers";
import { sendMedicalInsuranceCostLetters } from "@/lib/medical-insurance/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/medical-insurance/cost-letter/send { members: [register row ids], ccManager?: boolean, cc?: [addresses] } — emails each chosen employee
 * their own Medical Cover Statement, the statement itself in the body of the house letter with no attachment,
 * to their work email on the Employee Master (owner, 2026-11-21). Up to 20 a press; the screen batches more.
 * `ccManager` copies each employee's own direct manager; `cc` copies up to 10 typed addresses on every email.
 *
 * 🔴 It carries amounts, so it is held to medical_insurance_invoices (Super Admin only), asserted before
 * anything is read, and it is a same-origin mutation. It answers what happened to every person.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "medical_insurance_invoices", "update");
    const outcomes = await sendMedicalInsuranceCostLetters(access, await readJsonBody(request));
    return NextResponse.json({ outcomes });
  } catch (error) {
    return medicalInsuranceErrorResponse(error, "medical_insurance_cost_letter_send_failed");
  }
}
