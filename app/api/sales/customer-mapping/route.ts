import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { listCustomerMapping } from "@/lib/sales/customer-mapping";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function codes(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json(
        { success: false, error: "Forbidden: Customer Mapping is restricted to the admin account." },
        { status: 403 },
      );
    }
    await assertPermission(access, "sales", "import");

    const { searchParams } = new URL(request.url);
    const data = await listCustomerMapping(
      {
        areaCodes: codes(searchParams.get("area")),
        brickCodes: codes(searchParams.get("brick")),
        distributorCodes: codes(searchParams.get("distributor")),
        fromPeriod: searchParams.get("from"),
        regionCodes: codes(searchParams.get("region")),
        search: searchParams.get("search") ?? "",
        toPeriod: searchParams.get("to"),
      },
      access.role,
    );

    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to load Customer Mapping.") },
      { status: 500 },
    );
  }
}
