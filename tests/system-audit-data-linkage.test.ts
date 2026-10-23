import assert from "node:assert/strict";

import {
  DATA_LINKAGE_COVERAGE_NOTE,
  DATA_LINKAGE_DETECTOR,
  buildDataLinkageFindings,
  classifyLogin,
  createDataLinkageDetector,
  type DeviceMapRow,
  type EmployeeRow,
  type LoginRow,
} from "../src/lib/system-audit/detectors/data-linkage.ts";
import type { EmployeeSeatDrift } from "../src/lib/org/employee-seat-drift.ts";
import type { FindingBatch, FindingSink } from "../src/lib/system-audit/types.ts";

/**
 * Record linkage: an active login with no access profile, a fingerprint device user mapped to
 * nobody, and an employee record that disagrees with the organogram seat it holds. Each is a STATE,
 * found again every night, so its key is stable; a login with no employee row is counted as excluded
 * (the nightly integrity check owns it), never reported twice; a source that cannot be read is NOT
 * MEASURED while the others still land.
 */

const NOW_ISO = "2026-10-23T02:00:00.000Z";
const LABEL = (route: string) => ({ label: `Label for ${route}`, shell: "admin" as const });

const EMPLOYEES = new Map<string, EmployeeRow>([
  ["b-77", { hr_id: "B-77", full_name: "Mona Adel" }],
  ["b-12", { hr_id: "B-12", full_name: "Karim Hassan" }],
]);

function login(overrides: Partial<LoginRow> = {}): LoginRow {
  return { login_id: "mona.adel", hr_id: "B-77", role: "Medical Rep", is_active: true, auth_user_id: "auth-1", ...overrides };
}

function device(overrides: Partial<DeviceMapRow> = {}): DeviceMapRow {
  return {
    id: 1,
    device_id: "DEV-CAIRO",
    device_user_id: "41",
    employee_hr_id: null,
    is_active: true,
    non_employee_label: null,
    created_at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

const DRIFT: EmployeeSeatDrift = {
  hrId: "B-12",
  name: "Karim Hassan",
  seat: "the Behira 1 Medical Representative seat",
  facts: [{ kind: "area", employeeValue: null, seatValue: "Behira 1" }],
};

function testClassifyLogin() {
  const profiles = new Set(["auth-1"]);
  assert.equal(classifyLogin(login(), profiles, EMPLOYEES), null, "A login with its profile is fine");
  assert.equal(classifyLogin(login({ is_active: false, auth_user_id: null }), profiles, EMPLOYEES), null, "An inactive login is not judged");
  assert.deepEqual(classifyLogin(login({ hr_id: "B-999", login_id: "ghost" }), profiles, EMPLOYEES), { kind: "no_employee_row" });
  assert.equal(classifyLogin(login({ auth_user_id: null }), profiles, EMPLOYEES)?.kind, "missing_profile", "No sign-in identity means no profile can point at it");
  assert.equal(classifyLogin(login({ auth_user_id: "auth-2" }), profiles, EMPLOYEES)?.kind, "missing_profile", "An identity no profile carries");
  assert.equal(
    classifyLogin(login({ hr_id: null, login_id: "b-77" }), profiles, EMPLOYEES),
    null,
    "A login whose id IS the HR id still finds its employee",
  );
}

function testFindings() {
  const built = buildDataLinkageFindings({
    nowIso: NOW_ISO,
    logins: [
      login({ auth_user_id: "auth-2" }),
      // The same login listed twice must not repeat a key in one batch.
      login({ auth_user_id: "auth-2" }),
      login({ login_id: "ghost", hr_id: "B-999" }),
      login({ login_id: "ghost-2", hr_id: "B-998" }),
    ],
    profileAuthIds: new Set(["auth-1"]),
    employees: EMPLOYEES,
    devices: [
      device(),
      device({ id: 2, device_user_id: "42", employee_hr_id: "B-77" }),
      device({ id: 3, device_user_id: "43", non_employee_label: "Cleaner" }),
    ],
    latestPunches: new Map([["DEV-CAIRO\u000041", "2026-10-22T05:30:00.000Z"]]),
    drifts: [DRIFT, DRIFT],
    label: LABEL,
  });

  assert.deepEqual(built.excludedCounts, { login_without_employee_row: 2 }, "A login with no employee row is counted as excluded, never reported");
  assert.deepEqual(
    built.issues.map((issue) => issue.signatureKey),
    ["link:login_without_profile", "link:attendance_unmapped", "link:seat_drift"],
  );
  const keys = built.occurrences.map((row) => row.dedupeKey);
  assert.deepEqual(keys, ["link:login_without_profile:mona.adel", "link:attendance_unmapped:DEV-CAIRO:41", "link:seat_drift:b-12"], "One stable row per state");

  const [missing, unmapped, drift] = built.occurrences;
  assert.equal(missing.hrKey, "b-77");
  assert.equal(missing.employeeName, "Mona Adel");
  assert.equal(missing.route, "/admin/access");
  assert.equal(unmapped.hrKey, null, "An unmapped device user belongs to nobody yet");
  assert.match(String(unmapped.technicalMessage), /skipped as unknown\. Last punch .* Cairo\./, "It says what happens to the punches and when the last one came");
  assert.equal(drift.employeeName, "Karim Hassan");
  assert.equal(
    drift.technicalMessage,
    "Area: the record says nothing on file, the Behira 1 Medical Representative seat says Behira 1.",
    "The drift is written in names, both sides",
  );
  for (const row of built.occurrences) {
    assert.equal(row.isSilent, true);
    assert.equal(row.occurredAtKind, "detected");
  }

  const nothingWrong = buildDataLinkageFindings({
    nowIso: NOW_ISO,
    logins: [login()],
    profileAuthIds: new Set(["auth-1"]),
    employees: EMPLOYEES,
    devices: [device({ employee_hr_id: "B-77" })],
    latestPunches: new Map(),
    drifts: [],
    label: LABEL,
  });
  assert.deepEqual(nothingWrong.issues, [], "A clean night writes no issue");
}

function recordingSink() {
  const writes: Array<{ detector: string; batch: FindingBatch }> = [];
  const sink: FindingSink = {
    kind: "database",
    async write(detector, _runId, batch) {
      writes.push({ detector, batch });
      return { issues: batch.issues.length, inserted: batch.occurrences.length, updated: 0 };
    },
    async readCursor() {
      return null;
    },
  };
  return { sink, writes };
}

async function testDetector() {
  const now = () => Date.parse(NOW_ISO);
  const calls: string[] = [];
  const oneUnreadable = createDataLinkageDetector({
    readLogins: async () => {
      calls.push("logins");
      throw new Error("permission denied");
    },
    readDevices: async () => {
      calls.push("devices");
      return { devices: [device()], latestPunches: new Map() };
    },
    readDrifts: async () => {
      calls.push("drifts");
      return [DRIFT];
    },
    label: LABEL,
  });
  const cron = recordingSink();
  const result = await oneUnreadable.run({ mode: "cron", deadline: now() + 60_000, sink: cron.sink, runId: "r", now });
  assert.deepEqual(calls, ["logins", "devices", "drifts"], "The sources are read one at a time, in order");
  assert.equal(result.status, "partial", "One source unreadable is a partial night, never a clean one");
  assert.deepEqual(result.unreadableSources, ["app_auth_users + user_access_profiles"]);
  assert.equal(cron.writes[0].detector, DATA_LINKAGE_DETECTOR);
  assert.equal(cron.writes[0].batch.merge, "max", "A state found again is never doubled");
  assert.equal(cron.writes[0].batch.occurrences.length, 2, "The other sources still land");
  assert.equal(result.report?.coverage, DATA_LINKAGE_COVERAGE_NOTE, "Every run names what it cannot measure");

  const allDown = createDataLinkageDetector({
    readLogins: async () => {
      throw new Error("a");
    },
    readDevices: async () => {
      throw new Error("b");
    },
    readDrifts: async () => {
      throw new Error("c");
    },
    label: LABEL,
  });
  const none = recordingSink();
  const errored = await allDown.run({ mode: "cron", deadline: now() + 60_000, sink: none.sink, runId: "r", now });
  assert.equal(errored.status, "errored", "No source read is no answer at all");
  assert.equal(none.writes.length, 0, "…and nothing is written, the watermark included");

  // Out of time after the first read: the rest are skipped, said as budget_exhausted.
  let clock = now();
  const slow = createDataLinkageDetector({
    readLogins: async () => {
      clock += 120_000;
      return { logins: [], profileAuthIds: new Set<string>(), employees: new Map<string, EmployeeRow>() };
    },
    readDevices: async () => {
      throw new Error("must not be called");
    },
    readDrifts: async () => {
      throw new Error("must not be called");
    },
    label: LABEL,
  });
  const late = await slow.run({ mode: "cron", deadline: now() + 60_000, sink: recordingSink().sink, runId: "r", now: () => clock });
  assert.equal(late.status, "budget_exhausted", "A source skipped for time is said to be skipped, never a pass");
}

export async function runSystemAuditDataLinkageTests() {
  testClassifyLogin();
  testFindings();
  await testDetector();
}
