import { NextResponse } from "next/server";
import { z } from "zod";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { assertDeductionsReadActor } from "@/lib/deductions/permissions.ts";
import { listPublicationsForMonth, publishMonth } from "@/lib/deductions/publish.ts";
import { parseJsonBody } from "@/lib/http/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Deductions workspace's Publish sends `{ monthKey }` (YYYY-MM). */
const PublishBodySchema = z.object({
  monthKey: z.string().nullish(),
});

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "approve");

    const parsed = await parseJsonBody(request, PublishBodySchema);
    if (!parsed.ok) {
      return NextResponse.json({ success: false, error: parsed.message }, { status: 400 });
    }
    const body = parsed.data;
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
    // A publication carries every published line's employee and amount. See the export route.
    assertDeductionsReadActor(access);

    const url = new URL(request.url);
    const monthKey = url.searchParams.get("monthKey");
    if (!monthKey) {
      throw new Error("Validation: monthKey query parameter is required (YYYY-MM).");
    }

    const stored = await listPublicationsForMonth(monthKey);
    // The publisher by NAME — publishedBy is an HR id (or a login), which never reaches a screen.
    const names = await namesByHrId(stored.map((publication) => publication.publishedBy));
    const publications = stored.map((publication) => ({
      ...publication,
      publishedByName: names.get(publication.publishedBy) ?? null,
    }));
    return NextResponse.json({ success: true, publications });
  } catch (error) {
    return jsonError(error, "Failed to load publications for this month.");
  }
}
