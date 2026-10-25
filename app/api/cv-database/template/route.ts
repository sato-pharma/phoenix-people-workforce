import { NextResponse } from "next/server";

import { assertPermission, isHrAuthorityRole } from "@/lib/auth/permissions";
import { assertPageOpenForRole } from "@/lib/auth/seat-page-fences";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { generateCvDatabaseTemplateWorkbook } from "@/lib/cv/cv-template";
import { clientSafeErrorMessage, toApiError } from "@/lib/http/api-errors";
import { DOWNLOAD_NO_STORE_HEADERS } from "@/lib/http/download-headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function filename() {
  return `phoenix-cv-database-template-${new Date().toISOString().slice(0, 10)}.xlsx`;
}

function apiResponse(error: unknown, fallback: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json(
      { error: "forbidden", message: clientSafeErrorMessage(error, "Forbidden.") },
      { status: 403 },
    );
  }

  const apiError = toApiError(error, fallback);
  return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!isHrAuthorityRole(access.role)) {
      throw new Error(`Forbidden: ${access.role} cannot read cv_database.`);
    }
    // recruitment:read — the same gate the page carries, moved with it on 2026-09-01. This route
    // hands back the blank CV intake template, a recruiting artefact; leaving it on vacancies:read
    // would have left an authenticated download open to a seat whose page had just been closed.
    await assertPermission(access, "recruitment", "read");
    // The CV Database is fenced off the Talent Acquisition seat (src/lib/auth/seat-page-fences.ts).
    assertPageOpenForRole(access.role, "/cv-database");

    const workbook = await generateCvDatabaseTemplateWorkbook();
    const buffer = await workbook.xlsx.writeBuffer();

    return new NextResponse(buffer, {
      headers: {
        ...DOWNLOAD_NO_STORE_HEADERS,
        "Content-Disposition": `attachment; filename="${filename()}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    return apiResponse(error, "CV database template failed to generate.");
  }
}
