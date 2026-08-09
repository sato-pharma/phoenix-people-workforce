import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { generateSalesImportTemplate } from "@/lib/sales/import-template";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const buffer = await generateSalesImportTemplate();
    return new Response(buffer, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="sales-queue-upload-template.xlsx"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    const message = clientSafeErrorMessage(error, "Failed to generate template.");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
