import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, errorMessageOf, toApiError } from "@/lib/http/api-errors";
import {
  deleteMarketingCoveragePreset,
  listMarketingCoveragePresets,
  parseMarketingCoverageFilterState,
  saveMarketingCoveragePreset,
} from "@/lib/marketing-requests/coverage-report-service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function presetsApiError(error: unknown) {
  if (isForbiddenError(error)) {
    return { code: "forbidden", message: clientSafeErrorMessage(error, "Forbidden."), status: 403 };
  }
  const message = errorMessageOf(error);
  const normalized = message.toLowerCase();
  if (
    normalized.includes("marketing_roi_filter_presets") ||
    normalized.includes("could not find the table") ||
    normalized.includes("could not find the column") ||
    normalized.includes("schema cache") ||
    (normalized.includes("relation") && normalized.includes("does not exist"))
  ) {
    return { code: "marketing_coverage_presets_schema_not_ready", message: "Saved presets are not available on the connected database yet.", status: 503 };
  }
  const apiError = toApiError(error, "Marketing Coverage Report presets failed.");
  return { code: apiError.code === "internal_error" ? "marketing_coverage_presets_failed" : apiError.code, message: apiError.message, status: apiError.status };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    return NextResponse.json({ presets: await listMarketingCoveragePresets(access) });
  } catch (error) {
    const { code, message, status } = presetsApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as { name?: unknown; filters?: unknown; isDefault?: unknown };
    const preset = await saveMarketingCoveragePreset(access, {
      name: String(body.name ?? ""),
      filters: parseMarketingCoverageFilterState(body.filters),
      isDefault: body.isDefault === true,
    });
    return NextResponse.json({ preset });
  } catch (error) {
    const { code, message, status } = presetsApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}

export async function DELETE(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    const id = new URL(request.url).searchParams.get("id") ?? "";
    await deleteMarketingCoveragePreset(access, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    const { code, message, status } = presetsApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}
