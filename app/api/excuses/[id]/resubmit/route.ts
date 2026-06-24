import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  excuseErrorMessage,
  isExcusesSchemaMissing,
  resubmitExcuseRequest,
} from "@/lib/excuses/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const access = await resolveAccessContext(request);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const result = await resubmitExcuseRequest(access, {
      excuseDate: body.excuseDate,
      excuseType: body.excuseType,
      requestId: id,
    });

    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    const message = excuseErrorMessage(error) || "Unable to resubmit excuse request.";
    if (isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:")) {
      return NextResponse.json({ error: "forbidden", message, success: false }, { status: 403 });
    }
    if (isExcusesSchemaMissing(error)) {
      return NextResponse.json({ error: "excuses_schema_missing", message, success: false }, { status: 409 });
    }
    return NextResponse.json({ error: "excuse_resubmit_failed", message, success: false }, { status: 400 });
  }
}
