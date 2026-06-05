import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  listDistributorHeaders,
  listEditableProfiles,
  resetDistributorProfile,
  saveDistributorProfile,
} from "@/lib/sales/normalizer/distributor-profile-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET: every distributor's editable column mapping (DB override or code default) + its real raw headers.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const [profiles, headers] = await Promise.all([listEditableProfiles(), listDistributorHeaders()]);
    return NextResponse.json({ success: true, data: { headers, profiles } });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Failed to load distributor profiles." }, { status: 500 });
  }
}

// PUT: save one distributor's mapping. Body: { distributorCode, fields, valueSource, regionOnly }.
export async function PUT(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const body = (await request.json()) as { distributorCode?: string; fields?: Record<string, string[]>; valueSource?: string; regionOnly?: boolean };
    if (!body.distributorCode) return NextResponse.json({ success: false, error: "distributorCode is required." }, { status: 400 });
    await saveDistributorProfile(
      body.distributorCode,
      {
        fields: body.fields ?? {},
        regionOnly: Boolean(body.regionOnly),
        valueSource: body.valueSource === "sheet" ? "sheet" : "recompute",
      },
      access.hrId || "admin",
    );
    return NextResponse.json({ success: true });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Failed to save distributor profile." }, { status: 400 });
  }
}

// DELETE: reset one distributor back to its code default. Query: ?distributor=CODE
export async function DELETE(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const code = new URL(request.url).searchParams.get("distributor") ?? "";
    if (!code) return NextResponse.json({ success: false, error: "distributor is required." }, { status: 400 });
    await resetDistributorProfile(code);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Failed to reset distributor profile." }, { status: 400 });
  }
}
