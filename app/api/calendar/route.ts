import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { createCompanyCalendarEvent, getCompanyCalendarWorkspace } from "@/lib/calendar/service";
import type { CompanyCalendarEventInput } from "@/lib/calendar/logic";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(error: unknown, fallback: string) {
  const message = clientSafeErrorMessage(error, fallback);
  const forbidden = isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:");
  return NextResponse.json(
    { error: forbidden ? "forbidden" : "calendar_error", message, success: false },
    { status: forbidden ? 403 : 400 },
  );
}

function clampMonth(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 12 ? parsed : fallback;
}

function clampYear(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 2000 && parsed <= 2100 ? parsed : fallback;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const now = new Date();
    const year = clampYear(url.searchParams.get("year"), now.getUTCFullYear());
    const month = clampMonth(url.searchParams.get("month"), now.getUTCMonth() + 1);
    const workspace = await getCompanyCalendarWorkspace(access, year, month);
    return NextResponse.json({ data: workspace, success: true });
  } catch (error) {
    return jsonError(error, "Unable to load the calendar.");
  }
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as CompanyCalendarEventInput;
    const result = await createCompanyCalendarEvent(access, body);
    return NextResponse.json({ data: result, success: true });
  } catch (error) {
    return jsonError(error, "Unable to create the event.");
  }
}
