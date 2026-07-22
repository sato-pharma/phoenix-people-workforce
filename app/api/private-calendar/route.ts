import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getPrivateCalendarWorkspace } from "@/lib/private-calendar/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  const forbidden = isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:");
  return NextResponse.json(
    { error: forbidden ? "forbidden" : "private_calendar_error", message, success: false },
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
    const employeeHrId = url.searchParams.get("employeeHrId");
    const viewMode = url.searchParams.get("view");
    const actualOnly = url.searchParams.get("actualOnly") === "1";
    const workspace = await getPrivateCalendarWorkspace({ access, actualOnly, employeeHrId, month, viewMode, year });
    return NextResponse.json({ data: workspace, success: true });
  } catch (error) {
    return jsonError(error, "Unable to load the private calendar.");
  }
}
