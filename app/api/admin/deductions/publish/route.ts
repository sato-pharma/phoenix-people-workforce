import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { listPublicationsForMonth, publishMonth } from "@/lib/deductions/publish.ts";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PublishBody = {
  monthKey?: unknown;
};

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "approve");

    const body = (await request.json()) as PublishBody;
    if (typeof body.monthKey !== "string" || !body.monthKey.trim()) {
      throw new Error("Validation: monthKey is required (YYYY-MM).");
    }

    const result = await publishMonth({ monthKey: body.monthKey, actor: access });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return jsonError(error, "Failed to publish deductions for this month.");
  }
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "read");

    const url = new URL(request.url);
    const monthKey = url.searchParams.get("monthKey");
    if (!monthKey) {
      throw new Error("Validation: monthKey query parameter is required (YYYY-MM).");
    }

    const publications = await listPublicationsForMonth(monthKey);
    return NextResponse.json({ success: true, publications });
  } catch (error) {
    return jsonError(error, "Failed to load publications for this month.");
  }
}
