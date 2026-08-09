import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { upsertMonthlyTargets, type TargetInputRow } from "@/lib/sales/monthly-targets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/sales/targets/save  (JSON) — on-screen grid edits.
//   { period, line, rows: [{ areaCode, productCode, targetValue, targetUnits }] }
// Same map-or-reject validation + upsert as the file path.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const body = (await request.json().catch(() => null)) as
      | { period?: unknown; line?: unknown; rows?: unknown }
      | null;
    const period = String(body?.period ?? "").trim();
    const line = String(body?.line ?? "").trim();
    const rawRows = Array.isArray(body?.rows) ? body?.rows : [];
    if (!period || !line) {
      return NextResponse.json({ success: false, error: "period and line are required." }, { status: 400 });
    }

    const rows: TargetInputRow[] = rawRows.map((raw, index) => {
      const record = (raw ?? {}) as Record<string, unknown>;
      const toNum = (value: unknown): number | null => {
        if (value == null || value === "") return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      };
      return {
        rowNumber: index + 1,
        period,
        line,
        area: String(record.areaCode ?? "").trim(),
        product: String(record.productCode ?? "").trim(),
        targetUnits: toNum(record.targetUnits),
        targetValue: toNum(record.targetValue),
      };
    });

    if (rows.length === 0) {
      return NextResponse.json({ success: true, upserted: 0, errors: [] });
    }

    const { upserted, errors } = await upsertMonthlyTargets({
      rows,
      actorHrId: access.hrId ?? access.loginId ?? null,
      source: "grid",
    });
    return NextResponse.json({ success: true, upserted, errors });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Failed to save targets.") }, { status: 500 });
  }
}
