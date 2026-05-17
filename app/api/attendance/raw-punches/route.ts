import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";

import { ApiError, toApiError, unauthorizedError, validationError } from "@/lib/http/api-errors";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const maxPunchesPerRequest = 1000;

type RawPunchInput = Record<string, unknown>;

type ValidatedPunch = {
  device_id: string;
  device_user_id: string;
  employee_hr_id: string | null;
  punch_time: string;
  punch_type: string | null;
  verify_mode: string | null;
  raw_payload: unknown;
  source_run_id: string | null;
};

type PunchFailure = {
  index: number;
  message: string;
};

function compact(value: unknown) {
  const text = typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
  return text.length > 0 ? text : null;
}

function normalizeHrId(value: unknown) {
  return compact(value)?.toUpperCase() ?? null;
}

function field(input: RawPunchInput, snakeKey: string, camelKey: string) {
  return input[snakeKey] ?? input[camelKey];
}

function parsePunchTime(value: unknown) {
  const text = compact(value);
  if (!text) {
    throw validationError("punch_time is required.");
  }

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw validationError("punch_time must be a valid date-time value.");
  }

  return date.toISOString();
}

function getPunches(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (payload && typeof payload === "object" && Array.isArray((payload as { punches?: unknown }).punches)) {
    return (payload as { punches: unknown[] }).punches;
  }

  throw validationError("Request body must be an array of punches or an object with a punches array.");
}

function validatePunch(input: unknown): ValidatedPunch {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw validationError("Each punch must be an object.");
  }

  const raw = input as RawPunchInput;
  const deviceId = compact(field(raw, "device_id", "deviceId"));
  const deviceUserId = compact(field(raw, "device_user_id", "deviceUserId"));

  if (!deviceId) {
    throw validationError("device_id is required.");
  }

  if (!deviceUserId) {
    throw validationError("device_user_id is required.");
  }

  const rawPayload = raw.raw_payload ?? raw.rawPayload ?? raw;

  return {
    device_id: deviceId,
    device_user_id: deviceUserId,
    employee_hr_id: normalizeHrId(field(raw, "employee_hr_id", "employeeHrId")),
    punch_time: parsePunchTime(field(raw, "punch_time", "punchTime")),
    punch_type: compact(field(raw, "punch_type", "punchType")),
    verify_mode: compact(field(raw, "verify_mode", "verifyMode")),
    raw_payload: rawPayload ?? {},
    source_run_id: compact(field(raw, "source_run_id", "sourceRunId")),
  };
}

function isAuthorized(request: Request) {
  const expected = process.env.ATTENDANCE_AGENT_TOKEN?.trim();
  if (!expected) {
    throw new ApiError(500, "attendance_agent_token_missing", "ATTENDANCE_AGENT_TOKEN is required.");
  }

  const authorization = request.headers.get("authorization") ?? "";
  const actual = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (!actual) return false;

  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function mapKey(input: Pick<ValidatedPunch, "device_id" | "device_user_id">) {
  return `${input.device_id}\u0000${input.device_user_id}`;
}

async function resolveMappedHrIds(punches: ValidatedPunch[]) {
  const unresolved = punches.filter((punch) => !punch.employee_hr_id);
  if (unresolved.length === 0) {
    return new Map<string, string>();
  }

  const deviceIds = Array.from(new Set(unresolved.map((punch) => punch.device_id)));
  const deviceUserIds = Array.from(new Set(unresolved.map((punch) => punch.device_user_id)));
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_device_user_map")
    .select("device_id,device_user_id,employee_hr_id")
    .eq("is_active", true)
    .in("device_id", deviceIds)
    .in("device_user_id", deviceUserIds);

  if (error) {
    throw error;
  }

  return new Map(
    ((data ?? []) as Array<{ device_id: string; device_user_id: string; employee_hr_id: string }>).map((row) => [
      mapKey(row),
      row.employee_hr_id,
    ]),
  );
}

async function insertPunches(punches: ValidatedPunch[]) {
  const supabase = getSupabaseAdmin();
  const mappedHrIds = await resolveMappedHrIds(punches);
  const failures: PunchFailure[] = [];
  let inserted = 0;
  let duplicate = 0;

  for (const [index, punch] of punches.entries()) {
    const row = {
      ...punch,
      employee_hr_id: punch.employee_hr_id ?? mappedHrIds.get(mapKey(punch)) ?? null,
      ingested_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("attendance_raw_punches")
      .insert(row)
      .select("id");

    if (error) {
      if (error.code === "23505") {
        duplicate += 1;
        continue;
      }

      failures.push({ index, message: error.message });
      continue;
    }

    if ((data ?? []).length > 0) {
      inserted += 1;
    } else {
      duplicate += 1;
    }
  }

  return { duplicate, failed: failures.length, failures, inserted };
}

export async function POST(request: Request) {
  try {
    if (!isAuthorized(request)) {
      throw unauthorizedError("Attendance agent token is invalid.");
    }

    const rawPunches = getPunches(await request.json());
    if (rawPunches.length === 0) {
      throw validationError("At least one punch is required.");
    }
    if (rawPunches.length > maxPunchesPerRequest) {
      throw validationError(`At most ${maxPunchesPerRequest} punches can be ingested per request.`);
    }

    const validated: ValidatedPunch[] = [];
    const validationFailures: PunchFailure[] = [];

    rawPunches.forEach((rawPunch, index) => {
      try {
        validated.push(validatePunch(rawPunch));
      } catch (error) {
        const apiError = toApiError(error, "Punch validation failed.");
        validationFailures.push({ index, message: apiError.message });
      }
    });

    const result = validated.length > 0
      ? await insertPunches(validated)
      : { duplicate: 0, failed: 0, failures: [], inserted: 0 };

    const failures = [...validationFailures, ...result.failures];
    return NextResponse.json({
      duplicate: result.duplicate,
      failed: failures.length,
      failures,
      inserted: result.inserted,
      received: rawPunches.length,
    });
  } catch (error) {
    const apiError = toApiError(error, "Attendance raw punch ingestion failed.");
    return NextResponse.json(
      { error: apiError.code, message: apiError.message },
      { status: apiError.status },
    );
  }
}
