// S1 Business Review — XLSX export. READ-ONLY: builds a workbook from the bundled,
// pre-verified datasets. Enforces the SAME role gate as the page it exports
// (app/(admin)/business-review-s1/page.tsx) — the page hiding a button is UX, never
// the security boundary, so the check is repeated here on the server.
import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import {
  generateS1ReviewWorkbook,
  s1WorkbookFileName,
  type S1WorkbookVariant,
} from "@/lib/business-review-s1/excel-export";
import { DEFAULT_S1_VIEW, isS1View, type S1View } from "@/lib/business-review-s1/service";
import { logError } from "@/lib/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["CEO", "SFE Manager", "Super Admin"]);

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.role) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    if (!ALLOWED_ROLES.has(access.role)) {
      return NextResponse.json({ error: "Forbidden: S1 Business Review export" }, { status: 403 });
    }

    const params = new URL(request.url).searchParams;
    const requested = params.get("line") ?? undefined;
    const view: S1View = isS1View(requested) ? requested : DEFAULT_S1_VIEW;
    const variant: S1WorkbookVariant = params.get("variant") === "summary" ? "summary" : "full";

    // Audit before serving: this hands a full company-performance workbook to the caller,
    // so who pulled which scope needs to be reconstructable. Declared audit-required in
    // the access registry, so the write has to actually happen.
    await writeAuditLog({
      actorLoginId: resolveEmployeeIdentityId(access) ?? access.loginId ?? "system",
      entityId: `${view}:${variant}`,
      entityType: "business_review_s1_export",
      newValues: { scope: view, variant },
      summary: `S1 business review exported (${view}, ${variant}).`,
    });

    const workbook = await generateS1ReviewWorkbook(view, variant);
    const buffer = await workbook.xlsx.writeBuffer();

    return new Response(buffer, {
      status: 200,
      headers: {
        "Content-Disposition": `attachment; filename="${s1WorkbookFileName(view, variant)}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    logError("business-review-s1.export failed", { error });
    return NextResponse.json({ error: "Failed to generate the export" }, { status: 500 });
  }
}
