import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import {
  saveWeeklyNormalizerMappings,
  type WeeklyNormalizeBranchMapping,
  type WeeklyNormalizeProductMapping,
} from "@/lib/sales/weekly/normalizer";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Commit the operator's picks into the two live weekly dictionaries (product aliases +
// branch->region map) — the same ones every weekly upload reads.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "update");
    const actorId = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";

    const body = (await request.json().catch(() => ({}))) as {
      distributorCode?: string;
      products?: WeeklyNormalizeProductMapping[];
      branches?: WeeklyNormalizeBranchMapping[];
    };
    const distributorCode = String(body.distributorCode ?? "").trim();
    if (!distributorCode) {
      return NextResponse.json({ success: false, error: "Pick a distributor." }, { status: 400 });
    }
    const products = Array.isArray(body.products) ? body.products : [];
    const branches = Array.isArray(body.branches) ? body.branches : [];
    if (products.length === 0 && branches.length === 0) {
      return NextResponse.json({ success: false, error: "Pick at least one Phoenix code to save." }, { status: 400 });
    }

    const data = await saveWeeklyNormalizerMappings({ distributorCode, actorId, products, branches });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Save failed.") }, { status: 500 });
  }
}
