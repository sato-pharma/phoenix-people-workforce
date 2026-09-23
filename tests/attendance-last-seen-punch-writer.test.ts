import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  deviceUserActivityKey,
  planDeviceUserActivity,
  type DeviceUserMapSnapshot,
} from "../src/lib/attendance/device-user-activity.ts";
import { attendanceDeviceUserKey } from "../src/lib/attendance/metrics.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT. `attendance_device_user_map.last_seen_punch_at` was maintained only for UNMAPPED
// device users. The writer was named `recordUnmappedDeviceUsers`, was handed `unmappedPunches`
// alone, and carried a `row.is_active && row.employee_hr_id` guard inside on top of that. So the
// moment HR mapped a device user and activated them, the column stopped being written — forever.
// It froze at whatever it held that day, or stayed NULL if they were mapped before they had ever
// punched unmapped.
//
// Measured on production 2026-09-23 across the 28 map rows, and the correlation is TOTAL:
//
//   verdict                  rows   mapped+active   unmapped/inactive
//   STORED IS NULL            15         15                 0
//   stored, but no punches     9          0                 9
//   DISAGREES                  3          3                 0
//   agrees                     1          1                 0
//
// Every wrong row was mapped-and-active — exactly the population the writer never saw. Every row
// it did maintain was unmapped-or-inactive. The gate was not one cause among several; it was the
// whole of it.
//
// THE FIX. The decision moves out of the route handler into `planDeviceUserActivity`, where it can
// be tested without a database, and `last_seen_punch_at` now advances for every device user in the
// batch. Only the DISCOVERY insert stays gated on the punch being unmapped.
// ─────────────────────────────────────────────────────────────────────────────

const ROUTE_URL = new URL("../app/api/attendance/raw-punches/route.ts", import.meta.url);
const MIGRATION_URL = new URL(
  "../supabase/migrations/20260923120000_backfill_device_user_last_seen_punch.sql",
  import.meta.url,
);

const DEVICE = "zkteco-main";

function punch(deviceUserId: string, punchTime: string) {
  return { deviceId: DEVICE, deviceUserId, punchTime };
}

function mapRow(id: number, deviceUserId: string, lastSeenPunchAt: string | null): DeviceUserMapSnapshot {
  return { deviceId: DEVICE, deviceUserId, id, lastSeenPunchAt };
}

function keyOf(deviceUserId: string) {
  return deviceUserActivityKey({ deviceId: DEVICE, deviceUserId });
}

export async function runAttendanceLastSeenPunchWriterTests() {
  // ── THE HEADLINE: a MAPPED device user's punch advances the column ─────────
  // This is the entire defect. Device user 14 is mapped and active, stored 2026-05-18, and punched
  // on 2026-09-21. Before the fix this produced NO write at all.
  {
    const plan = planDeviceUserActivity({
      existing: [mapRow(14, "14", "2026-05-18T06:53:43Z")],
      punches: [punch("14", "2026-09-21T12:33:41Z")],
      unmappedKeys: new Set(), // mapped: the punch was attributed, so it is NOT in the unmapped set
    });
    assert.deepEqual(
      plan.updates,
      [{ id: 14, lastSeenPunchAt: "2026-09-21T12:33:41Z" }],
      "a MAPPED device user's punch must advance last_seen_punch_at",
    );
    assert.equal(plan.inserts.length, 0, "an existing row must never be re-inserted");
  }

  // ── A mapped device user with a NULL stored value (15 of 19 on production) ──
  {
    const plan = planDeviceUserActivity({
      existing: [mapRow(37, "37", null)],
      punches: [punch("37", "2026-09-22T13:13:42Z")],
      unmappedKeys: new Set(),
    });
    assert.deepEqual(
      plan.updates,
      [{ id: 37, lastSeenPunchAt: "2026-09-22T13:13:42Z" }],
      "a NULL stored value must be filled, not skipped",
    );
  }

  // ── MONOTONIC: a replayed older punch must not drag the column backwards ───
  // A device catching up after an outage, or a re-push, replays old punches.
  {
    const plan = planDeviceUserActivity({
      existing: [mapRow(47, "47", "2026-09-22T09:00:00Z")],
      punches: [punch("47", "2026-08-25T07:00:00Z")],
      unmappedKeys: new Set(),
    });
    assert.deepEqual(plan.updates, [], "an older punch must not move last_seen_punch_at backwards");
    assert.deepEqual(plan.inserts, [], "and must not insert anything either");
  }

  // ── Equal timestamps write nothing (a re-push of the same batch) ───────────
  {
    const plan = planDeviceUserActivity({
      existing: [mapRow(47, "47", "2026-09-22T09:00:00Z")],
      punches: [punch("47", "2026-09-22T09:00:00Z")],
      unmappedKeys: new Set(),
    });
    assert.deepEqual(plan.updates, [], "an identical timestamp must produce no write");
  }

  // ── The batch is folded to the NEWEST punch per device user ────────────────
  {
    const plan = planDeviceUserActivity({
      existing: [mapRow(1, "1", null)],
      punches: [
        punch("1", "2026-09-22T08:00:00Z"),
        punch("1", "2026-09-22T17:30:00Z"),
        punch("1", "2026-09-22T12:15:00Z"),
      ],
      unmappedKeys: new Set(),
    });
    assert.deepEqual(
      plan.updates,
      [{ id: 1, lastSeenPunchAt: "2026-09-22T17:30:00Z" }],
      "the newest punch in the batch wins, whatever order they arrive in",
    );
  }

  // ── DISCOVERY is still gated on the punch being UNMAPPED ───────────────────
  {
    const plan = planDeviceUserActivity({
      existing: [],
      punches: [punch("999", "2026-09-22T08:00:00Z")],
      unmappedKeys: new Set([keyOf("999")]),
    });
    assert.deepEqual(
      plan.inserts,
      [{ deviceId: DEVICE, deviceUserId: "999", lastSeenPunchAt: "2026-09-22T08:00:00Z" }],
      "an unmapped device user nobody has seen must get a discovery row",
    );
  }

  // ── An ATTRIBUTED punch with no map row must NOT invent one ────────────────
  // Minting `employee_hr_id: null, is_active: false` for a punch that already names its employee
  // would put a phantom unmapped finger on the unknown-device-user alert.
  {
    const plan = planDeviceUserActivity({
      existing: [],
      punches: [punch("888", "2026-09-22T08:00:00Z")],
      unmappedKeys: new Set(), // attributed
    });
    assert.deepEqual(plan.inserts, [], "an attributed punch must never mint an unmapped map row");
    assert.deepEqual(plan.updates, [], "and has no row to update");
  }

  // ── The whole production shape, in one pass ────────────────────────────────
  // 1 mapped+stale, 1 mapped+null, 1 mapped+current, 1 unmapped discovery, and 1 orphan map row
  // whose device user did not punch in this batch (the 9-row population) — which must be left
  // entirely alone.
  {
    const orphan = mapRow(13, "13", "2026-04-01T06:00:00Z");
    const plan = planDeviceUserActivity({
      existing: [
        mapRow(14, "14", "2026-05-18T06:53:43Z"),
        mapRow(37, "37", null),
        mapRow(44, "44", "2026-05-25T14:01:05Z"),
        orphan,
      ],
      punches: [
        punch("14", "2026-09-21T12:33:41Z"),
        punch("37", "2026-09-22T13:13:42Z"),
        punch("44", "2026-05-25T14:01:05Z"), // unchanged
        punch("777", "2026-09-22T06:00:00Z"), // newly discovered
      ],
      unmappedKeys: new Set([keyOf("777")]),
    });

    assert.deepEqual(
      plan.updates.map((u) => u.id).sort((a, b) => a - b),
      [14, 37],
      "only the two behind rows are written; the current one and the orphan are untouched",
    );
    assert.deepEqual(plan.inserts.map((i) => i.deviceUserId), ["777"], "one discovery");
    assert.equal(
      plan.updates.some((u) => u.id === orphan.id),
      false,
      "a device user absent from the batch must never be touched — that is the 9-row population",
    );
  }

  // ── ONE key space ─────────────────────────────────────────────────────────
  // The route used to carry its own byte-identical copy. If the two ever drift, `unmappedKeys`
  // silently matches nothing and every discovery stops — with no error anywhere.
  {
    assert.equal(
      deviceUserActivityKey({ deviceId: "d", deviceUserId: "u" }),
      attendanceDeviceUserKey("d", "u"),
      "the planner's key must be the domain key, not a second copy",
    );
  }

  // ── Source: the route no longer gates the writer ──────────────────────────
  const route = readFileSync(ROUTE_URL, "utf8");

  // Declaration and call site, not a prose mention — the docstring deliberately records the old
  // name so the next reader knows what this used to do.
  assert.equal(
    /function recordUnmappedDeviceUsers\s*\(/.test(route),
    false,
    "the unmapped-only writer must no longer be declared",
  );
  assert.equal(
    /await recordUnmappedDeviceUsers\s*\(/.test(route),
    false,
    "the unmapped-only writer must no longer be called",
  );
  assert.equal(
    /if \(row\.is_active && row\.employee_hr_id\)/.test(route),
    false,
    "the mapped-and-active skip must not return",
  );
  assert.equal(
    route.includes("recordDeviceUserActivity(supabase, punches, new Set(unmappedPunches.map(mapKey)))"),
    true,
    "the writer must be handed EVERY punch, with the unmapped keys only gating discovery",
  );
  assert.equal(
    /await recordDeviceUserActivity\(/.test(route) && !/if \(unmappedPunches\.length > 0\) \{\s*\n\s*await recordDeviceUserActivity/.test(route),
    true,
    "the writer must not be called only when there are unmapped punches",
  );
  assert.equal(
    route.includes("planDeviceUserActivity({"),
    true,
    "the route must delegate the decision to the domain planner",
  );
  assert.equal(
    route.includes("deviceUserActivityKey({ deviceId: input.device_id, deviceUserId: input.device_user_id })"),
    true,
    "the route's mapKey must delegate to the one key helper, not re-implement it",
  );

  // ── Source: the backfill is monotonic and spares the orphan rows ───────────
  const migration = readFileSync(MIGRATION_URL, "utf8");
  assert.equal(
    /m\.last_seen_punch_at is null or m\.last_seen_punch_at < v\.latest_punch_at/.test(migration),
    true,
    "the backfill must only ever move the column FORWARD",
  );
  assert.equal(
    /from public\.attendance_device_user_latest_punch as v/.test(migration),
    true,
    "the backfill must read the per-pair view, joined — so rows with no punches are untouched",
  );
  assert.equal(
    /delete|truncate|set last_seen_punch_at = null/i.test(migration),
    false,
    "the backfill must never delete a row or null a timestamp",
  );

  console.log("attendance last_seen_punch_at writer: ok");
}
