import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  createExcuseRequest,
  excuseErrorMessage,
  getExcuseWorkspace,
  isExcusesSchemaMissing,
} from "@/lib/excuses/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const workspace = await getExcuseWorkspace(access);
    return NextResponse.json({ success: true, workspace });
  } catch (error) {
    const message = excuseErrorMessage(error) || "Unable to load excuses.";
    if (isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:")) {
      return NextResponse.json({ error: "forbidden", message, success: false }, { status: 403 });
    }
    if (isExcusesSchemaMissing(error)) {
      return NextResponse.json({ error: "excuses_schema_missing", message, success: false }, { status: 409 });
    }
    return NextResponse.json({ error: "excuses_load_failed", message, success: false }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const body = await request.json();
    const result = await createExcuseRequest(
      access,
      {
        excuseDate: body.excuseDate,
        excuseType: body.excuseType,
      },
      { baseUrl: new URL(request.url).origin },
    );

    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    const message = excuseErrorMessage(error) || "Unable to submit excuse request.";
    if (isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:")) {
      return NextResponse.json({ error: "forbidden", message, success: false }, { status: 403 });
    }
    if (isExcusesSchemaMissing(error)) {
      return NextResponse.json({ error: "excuses_schema_missing", message, success: false }, { status: 409 });
    }
    return NextResponse.json({ error: "excuse_request_failed", message, success: false }, { status: 400 });
  }
}
