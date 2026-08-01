import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { listCandidatesForMonth } from "@/lib/deductions/service.ts";
import { deductionsCategories, type DeductionsCategory } from "@/lib/deductions/types.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "read");

    const url = new URL(request.url);
    const monthKey = url.searchParams.get("monthKey");
    if (!monthKey) {
      throw new Error("Validation: monthKey query parameter is required (YYYY-MM).");
    }
    const categoryParam = url.searchParams.get("category");
    const category =
      categoryParam && (deductionsCategories as readonly string[]).includes(categoryParam)
        ? (categoryParam as DeductionsCategory)
        : undefined;

    const candidates = await listCandidatesForMonth({ monthKey, category });
    return NextResponse.json({ success: true, candidates });
  } catch (error) {
    return jsonError(error, "Failed to load deduction candidates.");
  }
}
