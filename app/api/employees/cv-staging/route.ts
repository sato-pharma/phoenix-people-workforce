import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { purgeStaleStagedCvs, readCvPayload, stageEmployeeCv } from "@/lib/employees/employee-cv";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Park a CV chosen on the Add Employee form, before the employee it belongs to exists.
 *
 * WHY THIS ROUTE EXISTS AT ALL. There is no employee row to attach the file to while the form is
 * still being filled in, and uploading it AFTER the save would land after POST /api/employees has
 * already told the SFE Manager — so his notice would say "No CV on file" about somebody whose CV
 * arrived a second later, with nothing anywhere saying so. Staging first is what lets the notice
 * be true. The full account is in the header of employee-cv.ts.
 *
 * It returns a draft id and NOTHING ELSE THE CLIENT CAN STEER. The storage path is rebuilt from
 * that id server-side when the employee is created, so a caller never names a storage object.
 *
 * Gated on `employees:update`, the same grant the Add Employee form itself requires — anyone who
 * cannot create an employee has no reason to be able to put a file in this bucket.
 */

// A 15MB scan over Egyptian mobile data is comfortably past the default handler timeout on a cold
// container, and a staged upload that dies halfway makes HR pick the file again.
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "employees", "update");

    const payload = await readCvPayload(request);
    const staged = await stageEmployeeCv({ actorHrId: access.hrId ?? null, payload });

    // Sweep yesterday's abandoned drafts on the way past, rather than adding a cron for a folder
    // that only ever holds a handful of files. NOT awaited and its failure is swallowed: a person
    // waiting to finish an Add Employee form must never be held up, or told off, by housekeeping.
    void purgeStaleStagedCvs().catch(() => undefined);

    return NextResponse.json({ ...staged, success: true }, { status: 201 });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "The CV could not be uploaded.");
    const lower = message.toLowerCase();
    const status = isForbiddenError(error)
      ? 403
      : lower.includes("larger than") || lower.includes("unsupported") || lower.includes("required") || lower.includes("empty")
        ? 400
        : 500;
    return NextResponse.json({ error: "employee_cv_stage_failed", message, success: false }, { status });
  }
}
