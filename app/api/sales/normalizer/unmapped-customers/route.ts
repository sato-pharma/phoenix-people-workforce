import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { listUnmappedCustomers } from "@/lib/sales/normalizer/unmapped-customers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Every customer with no active mapping, for the SoS Magic "Unmapped customers" tab. Read-only; Super Admin only,
// the same boundary as the rest of the Source Normalizer.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json({ success: false, error: "Forbidden: Source Normalizer is restricted to the admin account." }, { status: 403 });
    }
    await assertPermission(access, "sales", "import");
    return NextResponse.json({ success: true, data: await listUnmappedCustomers() });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Failed to list the unmapped customers.") }, { status: 500 });
  }
}
