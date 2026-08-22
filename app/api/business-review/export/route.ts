// Business Review — XLSX export. READ-ONLY: builds a workbook from the live review for the
// requested window. Enforces the SAME role gate as the page it exports
// (app/(admin)/business-review/page.tsx) — the page hiding a button is UX, never the security
// boundary, so the check is repeated here on the server.
import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import {
  generateReviewWorkbook,
  reviewWorkbookFileName,
  type ReviewWorkbookVariant,
} from "@/lib/business-review/excel-export";
import { DEFAULT_REVIEW_VIEW, isReviewView, type ReviewView } from "@/lib/business-review/service";
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
      return NextResponse.json({ error: "Forbidden: Business Review export" }, { status: 403 });
    }

    const params = new URL(request.url).searchParams;
    const requested = params.get("line") ?? undefined;
    const view: ReviewView = isReviewView(requested) ? requested : DEFAULT_REVIEW_VIEW;
    const variant: ReviewWorkbookVariant = params.get("variant") === "summary" ? "summary" : "full";

    // Build FIRST, then audit. The requested range may be clamped, and an audit row naming a
    // window the file does not cover is worse than no audit row — it would send anyone
    // reconstructing an incident to the wrong months. `window` here is what is in the file.
    const { workbook, window } = await generateReviewWorkbook(view, variant, {
      from: params.get("from"),
      to: params.get("to"),
    });
    const buffer = await workbook.xlsx.writeBuffer();

    // This hands a full company-performance workbook to the caller, so who pulled which scope
    // over which period needs to be reconstructable. Declared audit-required in the access
    // registry, so the write has to actually happen.
    await writeAuditLog({
      actorLoginId: resolveEmployeeIdentityId(access) ?? access.loginId ?? "system",
      entityId: `${view}:${window.from}:${window.to}:${variant}`,
      entityType: "business_review_export",
      newValues: { scope: view, variant, from: window.from, to: window.to },
      summary: `Business review exported (${view}, ${window.label}, ${variant}).`,
    });

    return new Response(buffer, {
      status: 200,
      headers: {
        "Content-Disposition": `attachment; filename="${reviewWorkbookFileName(view, variant, window)}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    logError("business-review.export failed", { error });
    return NextResponse.json({ error: "Failed to generate the export" }, { status: 500 });
  }
}
