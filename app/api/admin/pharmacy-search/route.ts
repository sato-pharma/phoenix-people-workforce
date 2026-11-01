import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertPharmacySearchAccess } from "@/lib/pharmacy-search/access";
import { pharmacySearchApiError } from "@/lib/pharmacy-search/api-error";
import { searchPharmacies } from "@/lib/pharmacy-search/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Search every pharmacy in the database by name, code, address or distributor. Read-only. */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPharmacySearchAccess(access);

    const query = new URL(request.url).searchParams.get("q") ?? "";
    return NextResponse.json(await searchPharmacies(query, access));
  } catch (error) {
    const { code, message, status } = pharmacySearchApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}
