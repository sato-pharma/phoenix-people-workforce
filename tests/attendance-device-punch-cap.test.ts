import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { compareByLatestPunchDesc } from "../src/lib/attendance/device-user-mapping.ts";

// ─────────────────────────────────────────────────────────────────────────────
// TWO defects, both fed by the same untrustworthy column.
//
// (1) THE 5,000-PUNCH CAP. The dashboard derived "when did this device user last punch" by pulling
//     the newest 5,000 rows of `attendance_raw_punches` into Node and folding them down to a max
//     per (device, device user). On 2026-09-23 production held 4,808 punches for 19 distinct
//     pairs: 4,808 rows shipped to produce 19 values, and 192 rows short of the cap biting.
//
//     The cap failed in the worst possible direction. The read was ordered newest-first, so the
//     rows that fell off the end were the OLDEST — which means the first device user to vanish
//     from the fold is the one who STOPPED punching. That is exactly the row this screen exists to
//     surface. And it would not have shown as stale: it would have fallen through to the stored
//     `attendance_device_user_map.last_seen_punch_at` and read as if the user had never punched.
//
// (2) THE LIST WAS ORDERED ON THE STORED COLUMN. The mapping query ordered by
//     `last_seen_punch_at desc nullsFirst:false` while the column the page DISPLAYS is recomputed.
//     Measured on production the same day, against the real max per pair:
//       * 15 pairs have punches but a NULL stored value (several punched that morning);
//       *  3 pairs disagree — device user 14 stored 2026-05-18, actual 2026-09-21;
//       *  1 pair agrees;
//       *  9 map rows carry a stored timestamp but have no surviving punches at all.
//     So `nullsFirst: false` pushed 15 of the 19 live device users to the BOTTOM of the list,
//     underneath rows with no punches at all.
//
// The fix folds the max in the database (`public.attendance_device_user_latest_punch`, one row per
// pair) and orders both lists on the resolved value. This test pins the ordering behaviourally and
// pins the structural facts that stop either defect walking back in.
// ─────────────────────────────────────────────────────────────────────────────

const MODULE_URL = new URL("../src/lib/attendance/device-user-mapping.ts", import.meta.url);
const MIGRATION_URL = new URL(
  "../supabase/migrations/20260923090000_attendance_device_user_latest_punch_view.sql",
  import.meta.url,
);
const VIEW_NAME = "attendance_device_user_latest_punch";

function row(deviceUserId: string, latestPunchAt: string | null) {
  return { deviceUserId, latestPunchAt };
}

export async function runAttendanceDevicePunchCapTests() {
  // ── Behaviour: newest first ────────────────────────────────────────────────
  {
    const sorted = [
      row("a", "2026-07-09T08:00:00Z"),
      row("b", "2026-09-22T06:12:00Z"),
      row("c", "2026-08-20T09:30:00Z"),
    ].sort(compareByLatestPunchDesc);
    assert.deepEqual(
      sorted.map((entry) => entry.deviceUserId),
      ["b", "c", "a"],
      "newest punch must sort first",
    );
  }

  // ── Behaviour: a device user who has NEVER punched sorts last ──────────────
  // This is the half that regressed in production: 15 of 19 live users had a NULL stored value and
  // `nullsFirst: false` on that column dropped them below rows with no punches at all.
  {
    const sorted = [
      row("never", null),
      row("stale", "2026-05-18T06:53:43Z"),
      row("fresh", "2026-09-21T12:33:41Z"),
    ].sort(compareByLatestPunchDesc);
    assert.deepEqual(
      sorted.map((entry) => entry.deviceUserId),
      ["fresh", "stale", "never"],
      "a row with no punch must sort last, never above a row that has one",
    );
  }

  // ── Behaviour: a STALE user still outranks a never-punched one ─────────────
  // The four-month-stale device user 14 must remain visible above the 9 map rows that have no
  // punches at all, because "last seen in May" is information and "never" is not.
  {
    const sorted = [row("none", null), row("may", "2026-05-18T06:53:43Z")].sort(compareByLatestPunchDesc);
    assert.equal(sorted[0].deviceUserId, "may", "a months-old punch still outranks no punch");
  }

  // ── Behaviour: the order is TOTAL ──────────────────────────────────────────
  // Ties on the punch time must break on the device user id, or rows swap places between renders.
  {
    const tied = [row("30", "2026-09-22T06:00:00Z"), row("14", "2026-09-22T06:00:00Z")];
    assert.equal(compareByLatestPunchDesc(tied[0], tied[1]) > 0, true, "tie must break on device user id");
    assert.equal(
      compareByLatestPunchDesc(tied[0], tied[1]) + compareByLatestPunchDesc(tied[1], tied[0]),
      0,
      "the comparator must be antisymmetric",
    );
    const bothNull = [row("b", null), row("a", null)].sort(compareByLatestPunchDesc);
    assert.deepEqual(
      bothNull.map((entry) => entry.deviceUserId),
      ["a", "b"],
      "two never-punched rows must still have a deterministic order",
    );
  }

  // ── Source: the cap is gone and cannot come back ───────────────────────────
  const source = readFileSync(MODULE_URL, "utf8");

  assert.equal(
    /\.limit\(\s*5000\s*\)/.test(source),
    false,
    "the 5,000-punch cap must not return",
  );
  assert.equal(
    source.includes("attendance_raw_punches"),
    false,
    "the dashboard must not scan the raw punch table — it reads the per-pair view",
  );
  assert.equal(
    source.includes(`.from("${VIEW_NAME}")`),
    true,
    `the dashboard must read public.${VIEW_NAME}`,
  );
  assert.equal(
    source.includes('.select("device_id,device_user_id,latest_punch_at")'),
    true,
    "the view read must select exactly the three columns the fold needs",
  );

  // ── Source: the display order must not go back to the stored column ────────
  assert.equal(
    /\.order\(\s*"last_seen_punch_at"/.test(source),
    false,
    "the list must not be ordered in SQL on the stale last_seen_punch_at column",
  );
  assert.equal(
    source.includes("mappings.sort(compareByLatestPunchDesc)"),
    true,
    "the mapping list must be ordered on the resolved latestPunchAt",
  );

  // ── Source: the mapping read keeps a TOTAL sort ────────────────────────────
  // Without `id` the paging/order is non-deterministic when a device repeats a user id.
  assert.equal(
    /\.order\("device_id"\)\s*\n\s*\.order\("device_user_id"\)\s*\n\s*\.order\("id"\)/.test(source),
    true,
    "the mapping read must end its order chain on id",
  );

  // ── Source: the stored column is still the last-resort fallback ────────────
  // 9 production map rows carry a stored timestamp with no surviving punches. Dropping the
  // fallback would blank them.
  assert.equal(
    source.includes("latestPunchByDeviceUser.get(key) ?? row.last_seen_punch_at ?? null"),
    true,
    "the stored column must remain the fallback for a pair with no punches left",
  );

  // ── Source: the migration ships with the code that reads it ────────────────
  const migration = readFileSync(MIGRATION_URL, "utf8");
  assert.equal(
    new RegExp(`create or replace view public\\.${VIEW_NAME}`).test(migration),
    true,
    "the view migration must create the view the dashboard reads",
  );
  assert.equal(
    /max\(p\.punch_time\)\s+as\s+latest_punch_at/.test(migration),
    true,
    "the view must expose the MAX punch time per pair",
  );
  assert.equal(
    /group by p\.device_id, p\.device_user_id/.test(migration),
    true,
    "the view must group per (device_id, device_user_id)",
  );
  assert.equal(
    new RegExp(`revoke all on public\\.${VIEW_NAME} from anon, authenticated, public`).test(migration),
    true,
    "punch times must not be readable by a browser role",
  );
  assert.equal(
    new RegExp(`grant select on public\\.${VIEW_NAME} to service_role`).test(migration),
    true,
    "the view must be granted to service_role, which is how the dashboard reads it",
  );
  assert.equal(
    /grant\s+(select\s+)?on\s+public\.attendance_device_user_latest_punch\s+to\s+(anon|authenticated)/.test(migration),
    false,
    "the view must never be granted to anon or authenticated",
  );

  console.log("attendance device punch cap: ok");
}
