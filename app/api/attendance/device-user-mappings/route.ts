import { NextResponse } from "next/server";

import { getAttendanceDeviceUserMappingDashboard, saveAttendanceDeviceUserMapping } from "@/lib/attendance/device-user-mapping";
import { assertAttendanceSetupPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, toApiError, validationError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type MappingPayload = {
  deviceId?: unknown;
  deviceUserId?: unknown;
  employeeHrId?: unknown;
  isActive?: unknown;
  nonEmployeeLabel?: unknown;
};

function text(value: unknown) {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

function parsePayload(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw validationError("Mapping payload must be an object.");
  }

  const input = payload as MappingPayload;
  const deviceId = text(input.deviceId);
  const deviceUserId = text(input.deviceUserId);
  const employeeHrId = text(input.employeeHrId);

  if (!deviceId) throw validationError("deviceId is required.");
  if (!deviceUserId) throw validationError("deviceUserId is required.");
  if (typeof input.isActive !== "boolean") throw validationError("isActive must be true or false.");

  return {
    deviceId,
    deviceUserId,
    employeeHrId: employeeHrId || null,
    isActive: input.isActive,
    // Absent key stays undefined so the service omits the column and keeps any existing label.
    // Present-but-empty is a deliberate clear. See saveAttendanceDeviceUserMapping.
    nonEmployeeLabel: "nonEmployeeLabel" in input ? text(input.nonEmployeeLabel) || null : undefined,
  };
}

function apiResponse(error: unknown, fallback: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json(
      { error: "forbidden", message: clientSafeErrorMessage(error, "Forbidden.") },
      { status: 403 },
    );
  }

  const apiError = toApiError(error, fallback);
  return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertAttendanceSetupPermission(access, "read");

    return NextResponse.json(await getAttendanceDeviceUserMappingDashboard());
  } catch (error) {
    return apiResponse(error, "Attendance device user mappings failed to load.");
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertAttendanceSetupPermission(access, "update");

    await saveAttendanceDeviceUserMapping(parsePayload(await request.json()));
    return NextResponse.json(await getAttendanceDeviceUserMappingDashboard());
  } catch (error) {
    return apiResponse(error, "Attendance device user mapping failed to save.");
  }
}
