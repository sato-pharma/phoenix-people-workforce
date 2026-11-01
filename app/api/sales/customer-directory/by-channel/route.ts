import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadCustomerDirectoryByChannel } from "@/lib/sales/customer-directory";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Feeds the Customers tab: the same filtered Customer Directory, cut into Pharmacies and
// Stores by the customer's name. Same gate as the directory route it shares data with —
// the role check is the security boundary, not the tab being hidden in the UI.

function codes(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.role !== "SFE Manager" && access.scope !== "system") {
      return NextResponse.json(
        { success: false, error: "Forbidden: Customers is restricted to Super Admin and SFE Manager." },
        { status: 403 },
      );
    }
    await assertPermission(access, "sales", "import");

    const { searchParams } = new URL(request.url);
    const data = await loadCustomerDirectoryByChannel(
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
      { success: false, error: clientSafeErrorMessage(error, "Failed to load Customers.") },
      { status: 500 },
    );
  }
}
