import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { syncFieldWorkforceApprovedDecisions } from "@/lib/deductions-governance/connectors/field-workforce-compliance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(error: unknown, fallback: string, defaultStatus = 500) {
  if (isForbiddenError(error)) {
    return NextResponse.json(
      { success: false, message: (error as Error).message },
      { status: 403 },
    );
  }
  const message = error instanceof Error ? error.message : fallback;
  const lower = message.toLowerCase();
  if (lower.includes("not authenticated")) {
    return NextResponse.json({ success: false, message }, { status: 401 });
  }
  if (lower.includes("invalid") || lower.includes("required") || lower.includes("missing")) {
    return NextResponse.json({ success: false, message }, { status: 400 });
  }
  return NextResponse.json({ success: false, message }, { status: defaultStatus });
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "import");

    let body: { importId?: unknown; monthKey?: unknown } | null = null;
    try {
      body = await request.json();
    } catch {
      body = null;
    }

    const importId = typeof body?.importId === "string" && body.importId.trim()
      ? body.importId.trim()
      : undefined;
    const monthKey = typeof body?.monthKey === "string" && body.monthKey.trim()
      ? body.monthKey.trim()
      : undefined;

    if (!importId && !monthKey) {
      return NextResponse.json(
        {
          success: false,
          message: "Provide at least one of importId or monthKey to scope the sync.",
        },
        { status: 400 },
      );
    }

    const createdBy = access.loginId ?? "system";
    const result = await syncFieldWorkforceApprovedDecisions({
      importId,
      monthKey,
      createdBy,
    });

    await writeAuditLog({
      actorLoginId: createdBy,
      entityId: importId ?? monthKey ?? null,
      entityType: "deduction_candidate",
      newValues: {
        importId: importId ?? null,
        monthKey: monthKey ?? null,
        sourceTotal: result.sourceTotal,
        created: result.created,
        skippedExisting: result.skippedExisting,
        warnings: result.warnings.length,
      },
      summary: "Field Workforce Compliance sync executed",
    });

    return NextResponse.json({
      success: true,
      ok: true,
      sourceTotal: result.sourceTotal,
      created: result.created,
      skippedExisting: result.skippedExisting,
      warnings: result.warnings,
    });
  } catch (error) {
    return jsonError(error, "Field Workforce Compliance sync failed.");
  }
}
