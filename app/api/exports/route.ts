import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { generateProbationPdf, generateProbationWorkbook } from "@/lib/probation/export";
import { getProbationRows, isProbationSchemaMissing, probationErrorMessage } from "@/lib/probation/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fileDate() {
  return new Date().toISOString().slice(0, 10);
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const report = url.searchParams.get("report");
    const format = (url.searchParams.get("format") || "xlsx").toLowerCase();

    if (report !== "probation") {
      return NextResponse.json({ error: "Unsupported export report." }, { status: 400 });
    }

    const access = await resolveAccessContext(request);
    await assertPermission(access, "probation", "export");
    const rows = await getProbationRows();

    if (format === "xlsx") {
      return new Response(await generateProbationWorkbook(rows), {
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="phoenix-probation-${fileDate()}.xlsx"`,
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      });
    }

    if (format === "pdf") {
      return new Response(generateProbationPdf(rows), {
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="phoenix-probation-${fileDate()}.pdf"`,
          "Content-Type": "application/pdf",
        },
      });
    }

    return NextResponse.json({ error: "Unsupported export format." }, { status: 400 });
  } catch (error) {
    const message = probationErrorMessage(error);
    if (isForbiddenError(error)) return NextResponse.json({ error: message }, { status: 403 });
    if (isProbationSchemaMissing(error)) {
      return NextResponse.json({ error: "Probation workflow schema is not ready." }, { status: 409 });
    }
    return NextResponse.json({ error: message || "Unable to export probation report." }, { status: 500 });
  }
}
