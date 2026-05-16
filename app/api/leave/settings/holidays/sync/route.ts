import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  syncPublicHolidayCalendar,
  type PublicHolidayCalendarSyncInput,
  type PublicHolidayCalendarSyncResult,
} from "@/lib/leave/public-holidays-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseSyncPayload(payload: unknown): PublicHolidayCalendarSyncInput {
  if (!payload || typeof payload !== "object") return {};
  const raw = payload as Record<string, unknown>;
  const year = Number(raw.year);

  return {
    calendarId: typeof raw.calendarId === "string" ? raw.calendarId.trim() : undefined,
    country: typeof raw.country === "string" ? raw.country.trim() : undefined,
    year: Number.isFinite(year) ? year : undefined,
  };
}

function parseYearFromQuery(url: URL): number | undefined {
  const value = url.searchParams.get("year")?.trim();
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function handleSync(request: Request): Promise<NextResponse<{
  success: boolean;
  result?: PublicHolidayCalendarSyncResult;
  error?: string;
  message?: string;
}>> {
  const access = await resolveAccessContext(request);
  await assertPermission(access, "admin", "update");

  const body = await request.json().catch(() => ({}));
  const bodyInput = parseSyncPayload(body);
  const query = new URL(request.url);
  const queryYear = parseYearFromQuery(query);

  const result = await syncPublicHolidayCalendar({
    ...bodyInput,
    year: queryYear ?? bodyInput.year,
  });

  return NextResponse.json({
    success: true,
    result,
  });
}

export async function POST(request: Request) {
  try {
    return await handleSync(request);
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({
        error: "forbidden",
        message: "You do not have permission to sync leave holidays.",
        success: false,
      }, { status: 403 });
    }
    if (error instanceof Error) {
      if (error.message.includes("year must") || error.message.startsWith("Missing GOOGLE")) {
        return NextResponse.json({
          error: "holiday_sync_invalid_request",
          message: error.message,
          success: false,
        }, { status: 400 });
      }

      return NextResponse.json({
        error: "holiday_sync_failed",
        message: error.message,
        success: false,
      }, { status: 500 });
    }

    return NextResponse.json({
      error: "holiday_sync_failed",
      message: "Unable to sync national holidays.",
      success: false,
    }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return POST(request);
}
