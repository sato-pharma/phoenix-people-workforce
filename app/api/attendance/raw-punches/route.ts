import { NextResponse } from "next/server";

import {
  deviceUserActivityKey,
  planDeviceUserActivity,
  type DeviceUserMapSnapshot,
} from "@/lib/attendance/device-user-activity";
import { routeAttendancePunch } from "@/lib/attendance/metrics";
import { insertRawPunches } from "@/lib/attendance/raw-punch-batch";
import { toApiError, unauthorizedError, validationError } from "@/lib/http/api-errors";
import { requiredTokenAuthorized } from "@/lib/security/cron-auth";
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

// ONE key space. This used to be a second, byte-identical copy of the domain helper; the planner
// and this route must agree on it exactly, or `unmappedKeys` silently matches nothing and every
// discovered device user stops being recorded.
function mapKey(input: Pick<ValidatedPunch, "device_id" | "device_user_id">) {
  return deviceUserActivityKey({ deviceId: input.device_id, deviceUserId: input.device_user_id });
}


type DeviceUserRow = {
  employeeHrId: string | null;
  isActive: boolean;
  nonEmployeeLabel: string | null;
};

/** The map row as `recordDeviceUserActivity` reads it — identity, plus the column it advances. */
type DeviceUserMapRow = {
  device_id: string;
  device_user_id: string;
  id: number;
  last_seen_punch_at: string | null;
};

// A PostgREST `.in()` puts its whole list in the URL, so past a few hundred ids the
// request comes back `{ data: [], error: null }` — an empty set indistinguishable from a
// true answer. One request carries up to maxPunchesPerRequest punches and every one of
// them could name a different device user, so the list is chunked rather than trusted.
const lookupChunkSize = 50;

/**
 * Every map row for the device users in this batch — not just the ones that attribute a
 * punch. The wider read is what lets a skipped punch be told apart afterwards: a finger
 * somebody has already classified (the driver, a retired enrolment) is a deliberate skip,
 * while a finger nobody has ever named is the one worth alerting on.
 */
async function resolveDeviceUserRows(punches: ValidatedPunch[]) {
  const rows = new Map<string, DeviceUserRow>();
  const unresolved = punches.filter((punch) => !punch.employee_hr_id);
  if (unresolved.length === 0) {
    return rows;
  }

  const deviceIds = Array.from(new Set(unresolved.map((punch) => punch.device_id)));
  const deviceUserIds = Array.from(new Set(unresolved.map((punch) => punch.device_user_id)));
  const supabase = getSupabaseAdmin();

  for (let i = 0; i < deviceUserIds.length; i += lookupChunkSize) {
    const chunk = deviceUserIds.slice(i, i + lookupChunkSize);
    const { data, error } = await supabase
      .from("attendance_device_user_map")
      .select("device_id,device_user_id,employee_hr_id,is_active,non_employee_label")
      .in("device_id", deviceIds)
      .in("device_user_id", chunk);

    if (error) {
      throw error;
    }

    for (const row of (data ?? []) as Array<{
      device_id: string;
      device_user_id: string;
      employee_hr_id: string | null;
      is_active: boolean | null;
      non_employee_label: string | null;
    }>) {
      rows.set(mapKey(row), {
        employeeHrId: row.employee_hr_id,
        isActive: row.is_active === true,
        nonEmployeeLabel: compact(row.non_employee_label),
      });
    }
  }

  return rows;
}

/**
 * Only an ACTIVE row carrying an employee attributes a punch. That gate used to live in
 * the SELECT itself (`.eq("is_active", true).not("employee_hr_id", "is", null)`); the query
 * now has to return the unattributable rows too, so the gate moves here — onto the same
 * domain helper the mapping dashboard already uses, rather than a second copy of the rule.
 */
function attributedHrId(row: DeviceUserRow | undefined) {
  return routeAttendancePunch(row) === "attribute" ? row?.employeeHrId ?? null : null;
}

/**
 * Maintains `attendance_device_user_map` from a batch of punches.
 *
 * The DECISION — who gets a new row, whose `last_seen_punch_at` advances — lives in
 * `planDeviceUserActivity`, where it can be tested without a database. This function is the I/O
 * around it: read the map rows for the batch, ask for a plan, execute it.
 *
 * It used to be called `recordUnmappedDeviceUsers`, was handed only the unmapped punches, and
 * carried a `row.is_active && row.employee_hr_id` guard on top — so the column froze the moment HR
 * mapped a device user. That rule was inline in this route handler, which is why nothing caught it
 * for months. See `device-user-activity.ts` for the production measurement.
 */
async function recordDeviceUserActivity(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  punches: ValidatedPunch[],
  unmappedKeys: ReadonlySet<string>,
) {
  if (punches.length === 0) {
    return;
  }

  // One read for the whole batch instead of a SELECT per device user. The old shape issued a
  // `maybeSingle()` per key, which was tolerable while it only ever saw the unmapped punches and
  // is not now that it sees every one of them.
  const deviceIds = Array.from(new Set(punches.map((punch) => punch.device_id)));
  const deviceUserIds = Array.from(new Set(punches.map((punch) => punch.device_user_id)));
  const existing: DeviceUserMapSnapshot[] = [];

  for (let i = 0; i < deviceUserIds.length; i += lookupChunkSize) {
    const chunk = deviceUserIds.slice(i, i + lookupChunkSize);
    const { data, error } = await supabase
      .from("attendance_device_user_map")
      .select("id,device_id,device_user_id,last_seen_punch_at")
      .in("device_id", deviceIds)
      .in("device_user_id", chunk);

    if (error) {
      throw error;
    }

    for (const row of (data ?? []) as DeviceUserMapRow[]) {
      existing.push({
        deviceId: row.device_id,
        deviceUserId: row.device_user_id,
        id: row.id,
        lastSeenPunchAt: row.last_seen_punch_at,
      });
    }
  }

  const plan = planDeviceUserActivity({
    existing,
    punches: punches.map((punch) => ({
      deviceId: punch.device_id,
      deviceUserId: punch.device_user_id,
      punchTime: punch.punch_time,
    })),
    unmappedKeys,
  });

  for (const insert of plan.inserts) {
    const { error } = await supabase
      .from("attendance_device_user_map")
      .insert({
        device_id: insert.deviceId,
        device_user_id: insert.deviceUserId,
        employee_hr_id: null,
        is_active: false,
        last_seen_punch_at: insert.lastSeenPunchAt,
        updated_at: new Date().toISOString(),
      });

    if (error) {
      throw error;
    }
  }

  for (const update of plan.updates) {
    const { error } = await supabase
      .from("attendance_device_user_map")
      .update({
        last_seen_punch_at: update.lastSeenPunchAt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", update.id);

    if (error) {
      throw error;
    }
  }
}

async function insertPunches(punches: ValidatedPunch[]) {
  const supabase = getSupabaseAdmin();
  const deviceUserRows = await resolveDeviceUserRows(punches);
  let skippedIgnored = 0;
  let skippedUnknown = 0;
  const unknownDeviceUsers = new Set<string>();
  const unmappedPunches: ValidatedPunch[] = [];
  const toInsert: Array<{ punch: ValidatedPunch; employeeHrId: string }> = [];

  for (const punch of punches) {
    const row = deviceUserRows.get(mapKey(punch));
    const employeeHrId = punch.employee_hr_id ?? attributedHrId(row);
    if (!employeeHrId) {
      unmappedPunches.push(punch);
      if (routeAttendancePunch(row) === "skip_unknown") {
        skippedUnknown += 1;
        unknownDeviceUsers.add(punch.device_user_id);
      } else {
        skippedIgnored += 1;
      }
      continue;
    }
    toInsert.push({ punch, employeeHrId });
  }

  // Up to 250 punches per database call, not one call per punch: the agent re-sends punches the table
  // already holds, and 10,461 single calls in 17 minutes (18 Oct 2026) were part of what slowed
  // production. The helper falls back to one call per punch, at low concurrency, if a batch fails, so
  // a failure is still reported against the punch's own index. Both functions end in ON CONFLICT DO
  // NOTHING, so a re-pushed punch is a duplicate, never an error.
  const { inserted, duplicate, failures } = await insertRawPunches(
    toInsert.map(({ punch, employeeHrId }) => ({
      inputIndex: punch.input_index,
      row: {
        device_id: punch.device_id,
        device_user_id: punch.device_user_id,
        employee_hr_id: employeeHrId,
        punch_time: punch.punch_time,
        punch_type: punch.punch_type,
        verify_mode: punch.verify_mode,
        raw_payload: punch.raw_payload ?? {},
        source_run_id: punch.source_run_id,
      },
    })),
    (functionName, args) => supabase.rpc(functionName, args),
  );

  // EVERY punch, not just the unmapped ones. `last_seen_punch_at` is meant to say when this
  // device user was last at the door; handing this only `unmappedPunches` is what froze the
  // column for every employee HR had actually mapped. The unmapped keys still ride along,
  // because only they may CREATE a row.
  await recordDeviceUserActivity(supabase, punches, new Set(unmappedPunches.map(mapKey)));

  return {
    duplicate,
    failed: failures.length,
    failures,
    inserted,
    // `skipped` stays the total so existing readers keep working. The split beside it is
    // what can actually go quiet: skippedIgnored never falls to zero (the driver and the
    // retired enrolments punch forever), so a single total can never read as healthy.
    skipped: skippedIgnored + skippedUnknown,
    skippedIgnored,
    skippedUnknown,
    unknownDeviceUsers: Array.from(unknownDeviceUsers).sort(),
  };
}

export async function POST(request: Request) {
  try {
    // No dev bypass, deliberately: an unset ATTENDANCE_AGENT_TOKEN is a misconfiguration, not an
    // invitation, so requiredTokenAuthorized throws 500 rather than returning false.
    const authorized = requiredTokenAuthorized(
      request,
      process.env.ATTENDANCE_AGENT_TOKEN,
      "attendance_agent_token_missing",
      "ATTENDANCE_AGENT_TOKEN is required.",
    );
    if (!authorized) {
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
      : {
        duplicate: 0,
        failed: 0,
        failures: [],
        inserted: 0,
        skipped: 0,
        skippedIgnored: 0,
        skippedUnknown: 0,
        unknownDeviceUsers: [] as string[],
      };

    const failures = [...validationFailures, ...result.failures];
    return NextResponse.json({
      duplicate: result.duplicate,
      failed: failures.length,
      failures,
      inserted: result.inserted,
      received: rawPunches.length,
      skipped: result.skipped,
      skippedIgnored: result.skippedIgnored,
      skippedUnknown: result.skippedUnknown,
      unknownDeviceUsers: result.unknownDeviceUsers,
    });
  } catch (error) {
    const apiError = toApiError(error, "Attendance raw punch ingestion failed.");
    return NextResponse.json(
      { error: apiError.code, message: apiError.message },
      { status: apiError.status },
    );
  }
}
