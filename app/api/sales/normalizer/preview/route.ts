import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { recognitionErrorMessage, recognizeWorkbookParts, summarizePreview } from "@/lib/sales/normalizer/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json({ success: false, error: "Forbidden: Source Normalizer is restricted to the admin account." }, { status: 403 });
    }
    await assertPermission(access, "sales", "import");

    const form = await request.formData();
    const file = form.get("file");
    const distributorCode = String(form.get("distributorCode") ?? "");
    if (!(file instanceof File)) return NextResponse.json({ success: false, error: "No file uploaded." }, { status: 400 });
    if (!distributorCode) return NextResponse.json({ success: false, error: "Pick a distributor." }, { status: 400 });

    const normalized = await recognizeWorkbookParts(distributorCode, file);
    if (normalized.status !== "ok") {
      return NextResponse.json({ success: false, error: recognitionErrorMessage(normalized) }, { status: 422 });
    }
    // ONE PREVIEW PER DISTRIBUTOR, and each carries the RESOLVED distributor rather than the code the
    // form sent: a Phoenix-template upload arrives under a sentinel and the sheet names its own
    // distributors — one, or as many as the person put in it. Every mapping saved off a preview is
    // filed under that preview's `distributorCode`, so a customer code from one distributor can never
    // be learned against another. A distributor's own export always answers with exactly one part.
    const parts = normalized.parts.map((part) => summarizePreview(part.distributorCode, part.distributorName, part.result, normalized.products));
    return NextResponse.json({ success: true, data: { parts } });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Failed to normalize file.") }, { status: 500 });
  }
}
