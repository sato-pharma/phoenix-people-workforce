import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { learnFromCleanedFile } from "@/lib/sales/normalizer/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bootstrap the mapping dictionary from a previously CODED file (raw columns + Phoenix Product ID /
// Brick ID side by side, e.g. the user's existing "customer sales" master) — mines every raw → Phoenix
// pair and saves them as aliases. One upload teaches hundreds of mappings so future raw files auto-code.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const form = await request.formData();
    const file = form.get("file");
    const distributorCode = String(form.get("distributorCode") ?? "").trim();
    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: "A coded file is required." }, { status: 400 });
    }
    if (!distributorCode) {
      return NextResponse.json({ success: false, error: "Distributor is required." }, { status: 400 });
    }

    const result = await learnFromCleanedFile(distributorCode, file);
    return NextResponse.json({
      success: true,
      result,
      message: `${result.saved} mappings learned from ${result.scannedRows} rows (${result.skipped} already known, ${result.invalid} invalid).`,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to learn from the file." },
      { status: 500 },
    );
  }
}
