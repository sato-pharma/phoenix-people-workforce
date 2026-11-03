import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { assertDailyDeductionsReadActor } from "@/lib/daily-deductions/permissions.ts";
import { getActiveDailyPublication, getDailyPublicationLines } from "@/lib/daily-deductions/service.ts";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The one active (published, not superseded) snapshot and its lines, or null. */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "read");
    assertDailyDeductionsReadActor(access);

    const publication = await getActiveDailyPublication();
    if (!publication) {
      return NextResponse.json({ success: true, publication: null, lines: [] });
    }
    const storedLines = await getDailyPublicationLines(publication.id);
    const names = await namesByHrId(storedLines.map((line) => line.employeeHrId));
    const lines = storedLines.map((line) => ({
      ...line,
      employeeName: names.get(line.employeeHrId) ?? line.employeeName,
    }));
    return NextResponse.json({ success: true, publication, lines });
  } catch (error) {
    return jsonError(error, "Failed to load the active daily deductions tally.");
  }
}
