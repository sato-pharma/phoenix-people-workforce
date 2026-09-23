import { attendanceDeviceUserKey } from "@/lib/attendance/metrics";

/**
 * What a batch of punches should do to `attendance_device_user_map`.
 *
 * This is the decision half of the punch ingest, separated from the I/O so it can be tested
 * without a database — the rule it encodes was wrong in production for months and nothing could
 * catch it, because it lived inline in a route handler.
 *
 * TWO JOBS WITH DIFFERENT SCOPES, and conflating them is precisely what broke the column:
 *
 *   1. DISCOVERY — a device user nobody has mapped gets a row, so HR can find them on the mapping
 *      screen. Only an UNMAPPED punch may do this. A punch that already carries its own
 *      `employee_hr_id` must never mint a row claiming nobody owns that finger.
 *   2. LAST SEEN — `last_seen_punch_at` advances for EVERY device user in the batch, mapped or not.
 *
 * WHY (2) IS NO LONGER GATED. The ingest used to hand its writer only the unmapped punches, with a
 * `row.is_active && row.employee_hr_id` guard inside for good measure. So the moment HR mapped a
 * device user and activated them, the column stopped being written — forever. It froze at whatever
 * it held that day, or stayed NULL if they were mapped before they ever punched unmapped.
 *
 * Measured on production 2026-09-23 across the 28 map rows, and the correlation is total: of the 18
 * rows whose stored value was WRONG (15 NULL despite having punches, 3 stale — device user 14 held
 * 2026-05-18 against an actual 2026-09-21), ALL 18 were mapped-and-active; of the 9 rows the writer
 * did maintain, ALL 9 were unmapped-or-inactive. The gate was not one cause among several. It was
 * the whole of it.
 */

/** One device user's newest punch in this batch. */
export type DeviceUserPunch = {
  deviceId: string;
  deviceUserId: string;
  punchTime: string;
};

/** An existing `attendance_device_user_map` row, as the planner needs to see it. */
export type DeviceUserMapSnapshot = {
  deviceId: string;
  deviceUserId: string;
  id: number;
  lastSeenPunchAt: string | null;
};

export type DeviceUserActivityPlan = {
  /** New map rows for device users nobody has mapped yet. */
  inserts: Array<{ deviceId: string; deviceUserId: string; lastSeenPunchAt: string }>;
  /** `last_seen_punch_at` advances, for mapped and unmapped rows alike. */
  updates: Array<{ id: number; lastSeenPunchAt: string }>;
};

/** The one key space for a (device, device user) pair. The ingest route delegates to this. */
export function deviceUserActivityKey(input: { deviceId: string; deviceUserId: string }) {
  return attendanceDeviceUserKey(input.deviceId, input.deviceUserId);
}

/**
 * Folds a batch to the newest punch per device user and decides what to write.
 *
 * `unmappedKeys` holds the keys of punches this batch could NOT attribute to an employee — the
 * only ones permitted to create a row.
 */
export function planDeviceUserActivity(input: {
  existing: readonly DeviceUserMapSnapshot[];
  punches: readonly DeviceUserPunch[];
  unmappedKeys: ReadonlySet<string>;
}): DeviceUserActivityPlan {
  const { existing, punches, unmappedKeys } = input;

  // Newest punch per device user. A batch may carry many punches for one finger, and may carry
  // them in any order.
  const latestByKey = new Map<string, DeviceUserPunch>();
  for (const punch of punches) {
    if (!punch.punchTime) continue;
    const key = deviceUserActivityKey(punch);
    const current = latestByKey.get(key);
    if (!current || punch.punchTime > current.punchTime) {
      latestByKey.set(key, punch);
    }
  }

  const existingByKey = new Map<string, DeviceUserMapSnapshot>();
  for (const row of existing) {
    existingByKey.set(deviceUserActivityKey(row), row);
  }

  const plan: DeviceUserActivityPlan = { inserts: [], updates: [] };

  for (const [key, punch] of latestByKey) {
    const row = existingByKey.get(key);

    if (!row) {
      // Discovery, and only for a punch nobody could attribute. An attributed punch with no map
      // row is not a discovery: minting one would invent an unmapped finger and put a phantom on
      // the unknown-device-user alert.
      if (!unmappedKeys.has(key)) continue;
      plan.inserts.push({
        deviceId: punch.deviceId,
        deviceUserId: punch.deviceUserId,
        lastSeenPunchAt: punch.punchTime,
      });
      continue;
    }

    // Monotonic. A batch replaying older punches — a re-push, a device catching up after an
    // outage — must never drag the column backwards.
    if (!row.lastSeenPunchAt || punch.punchTime > row.lastSeenPunchAt) {
      plan.updates.push({ id: row.id, lastSeenPunchAt: punch.punchTime });
    }
  }

  return plan;
}
