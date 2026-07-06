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
  input_index: number;
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

function validatePunch(input: unknown, index: number): ValidatedPunch {
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
    input_index: index,
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
    .not("employee_hr_id", "is", null)
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

async function recordUnmappedDeviceUsers(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  punches: ValidatedPunch[],
) {
  const latestByDeviceUser = new Map<string, ValidatedPunch>();

  punches.forEach((punch) => {
    const key = mapKey(punch);
    const current = latestByDeviceUser.get(key);
    if (!current || punch.punch_time > current.punch_time) {
      latestByDeviceUser.set(key, punch);
    }
  });

  for (const punch of latestByDeviceUser.values()) {
    const { data: existing, error: existingError } = await supabase
      .from("attendance_device_user_map")
      .select("id,is_active,employee_hr_id,last_seen_punch_at")
      .eq("device_id", punch.device_id)
      .eq("device_user_id", punch.device_user_id)
      .maybeSingle();

    if (existingError) {
      throw existingError;
    }

    const row = existing as { id: number; is_active: boolean; employee_hr_id: string | null; last_seen_punch_at: string | null } | null;
    if (!row) {
      const { error } = await supabase
        .from("attendance_device_user_map")
        .insert({
          device_id: punch.device_id,
          device_user_id: punch.device_user_id,
          employee_hr_id: null,
          is_active: false,
          last_seen_punch_at: punch.punch_time,
          updated_at: new Date().toISOString(),
        });

      if (error) {
        throw error;
      }
      continue;
    }

    if (row.is_active && row.employee_hr_id) {
      continue;
    }

    if (!row.last_seen_punch_at || punch.punch_time > row.last_seen_punch_at) {
      const { error } = await supabase
        .from("attendance_device_user_map")
        .update({
          last_seen_punch_at: punch.punch_time,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);

      if (error) {
        throw error;
      }
    }
  }
}

const insertConcurrency = 50;

async function insertPunches(punches: ValidatedPunch[]) {
  const supabase = getSupabaseAdmin();
  const mappedHrIds = await resolveMappedHrIds(punches);
  const failures: PunchFailure[] = [];
  let inserted = 0;
  let duplicate = 0;
  let skipped = 0;
  const unmappedPunches: ValidatedPunch[] = [];
  const toInsert: Array<{ punch: ValidatedPunch; employeeHrId: string }> = [];

  for (const punch of punches) {
    const employeeHrId = punch.employee_hr_id ?? mappedHrIds.get(mapKey(punch)) ?? null;
    if (!employeeHrId) {
      unmappedPunches.push(punch);
      skipped += 1;
      continue;
    }
    toInsert.push({ punch, employeeHrId });
  }

  // Each row is independent (the DB function's own ON CONFLICT DO NOTHING makes it safe to
  // race) — chunked concurrency instead of one RPC at a time is what keeps a full
  // maxPunchesPerRequest batch from taking minutes.
  for (let i = 0; i < toInsert.length; i += insertConcurrency) {
    const chunk = toInsert.slice(i, i + insertConcurrency);
    const results = await Promise.all(
      chunk.map(async ({ punch, employeeHrId }) => {
        const { input_index, ...punchRow } = punch;
        // Conflict-tolerant insert. The DB function uses ON CONFLICT DO NOTHING so
        // re-pushed punches are silently ignored at the database level (no 23505
        // ERROR logged). Returns the new id, or null when the punch already existed.
        const { data, error } = await supabase.rpc("phx_insert_attendance_raw_punch", {
          p_device_id: punchRow.device_id,
          p_device_user_id: punchRow.device_user_id,
          p_employee_hr_id: employeeHrId,
          p_punch_time: punchRow.punch_time,
          p_punch_type: punchRow.punch_type,
          p_verify_mode: punchRow.verify_mode,
          p_raw_payload: punchRow.raw_payload ?? {},
          p_source_run_id: punchRow.source_run_id,
        });
        return { data, error, input_index };
      }),
    );

    for (const result of results) {
      if (result.error) {
        // Defensive: a unique violation should no longer surface here, but if the
        // function is ever briefly unavailable, still treat it as a duplicate
        // rather than a hard failure.
        if (result.error.code === "23505") {
          duplicate += 1;
          continue;
        }

        failures.push({ index: result.input_index, message: result.error.message });
        continue;
      }

      if (result.data == null) {
        duplicate += 1;
      } else {
        inserted += 1;
      }
    }
  }

  if (unmappedPunches.length > 0) {
    await recordUnmappedDeviceUsers(supabase, unmappedPunches);
  }

  return { duplicate, failed: failures.length, failures, inserted, skipped };
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
        validated.push(validatePunch(rawPunch, index));
      } catch (error) {
        const apiError = toApiError(error, "Punch validation failed.");
        validationFailures.push({ index, message: apiError.message });
      }
    });

    const result = validated.length > 0
      ? await insertPunches(validated)
      : { duplicate: 0, failed: 0, failures: [], inserted: 0, skipped: 0 };

    const failures = [...validationFailures, ...result.failures];
    return NextResponse.json({
      duplicate: result.duplicate,
      failed: failures.length,
      failures,
      inserted: result.inserted,
      received: rawPunches.length,
      skipped: result.skipped,
    });
  } catch (error) {
    const apiError = toApiError(error, "Attendance raw punch ingestion failed.");
    return NextResponse.json(
      { error: apiError.code, message: apiError.message },
      { status: apiError.status },
    );
  }
}
