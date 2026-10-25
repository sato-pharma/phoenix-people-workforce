import { NextResponse } from "next/server";

import { generateCandidateImportTemplateWorkbook } from "@/lib/recruitment/import-template";
import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";
import { DOWNLOAD_NO_STORE_HEADERS } from "@/lib/http/download-headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function filename() {
  return `phoenix-candidate-import-template-${new Date().toISOString().slice(0, 10)}.xlsx`;
}

export async function GET(request: Request) {
  try {
    await requireRecruitmentAccess(request, "candidates", "read");
    const workbook = await generateCandidateImportTemplateWorkbook();
    const buffer = await workbook.xlsx.writeBuffer();
    return new NextResponse(buffer, {
      headers: {
        ...DOWNLOAD_NO_STORE_HEADERS,
        "Content-Disposition": `attachment; filename="${filename()}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    return recruitmentApiError(error, "Candidate template failed to generate.");
  }
}
