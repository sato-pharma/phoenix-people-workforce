import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, errorMessageOf, toApiError } from "@/lib/http/api-errors";
import {
  uploadMarketingFinanceEvidence,
  type MarketingFinanceEvidenceType,
} from "@/lib/marketing-requests/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isFormFile(value: FormDataEntryValue | null): value is File {
  return value instanceof File && value.size > 0;
}

function marketingFinanceEvidenceApiError(error: unknown) {
  if (isForbiddenError(error)) {
    return {
      code: "forbidden",
      message: clientSafeErrorMessage(error, "Forbidden."),
      status: 403,
    };
  }

  const message = errorMessageOf(error);
  const normalized = message.toLowerCase();
  if (
    normalized.includes("marketing_request_finance_requirements") ||
    normalized.includes("money_transfer_proof") ||
    normalized.includes("schema cache") ||
    normalized.includes("marketing-finance-evidence") ||
    (normalized.includes("relation") && normalized.includes("does not exist"))
  ) {
    return {
      code: "marketing_finance_evidence_schema_not_ready",
      message: "Marketing finance evidence schema/storage is not applied to the connected database yet.",
      status: 503,
    };
  }

  const apiError = toApiError(error, "Marketing finance evidence upload failed.");
  return {
    code: apiError.code === "internal_error" ? "marketing_finance_evidence_failed" : apiError.code,
    message: apiError.message,
    status: apiError.status,
  };
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    const formData = await request.formData();
    const file = formData.get("file");
    if (!isFormFile(file)) {
      return NextResponse.json({
        error: "missing_file",
        message: "Evidence file is required.",
      }, { status: 400 });
    }

    const row = await uploadMarketingFinanceEvidence({
      access,
      evidenceType: String(formData.get("evidenceType") ?? "") as MarketingFinanceEvidenceType,
      file,
      requestId: String(formData.get("requestId") ?? ""),
    });

    return NextResponse.json({ row });
  } catch (error) {
    const { code, message, status } = marketingFinanceEvidenceApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}
