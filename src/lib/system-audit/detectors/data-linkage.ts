import { resolveDeviceMappingStatus } from "@/lib/attendance/metrics";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { loadEmployeeSeatDrift, type EmployeeSeatDrift } from "@/lib/org/employee-seat-drift";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { resolveSidebarLabel } from "@/lib/system-audit/sidebar-label";
import {
  SILENT_DATA_MESSAGE,
  emptyDetectorResult,
  type AuditDetector,
  type AuditIssueInput,
  type AuditOccurrenceInput,
  type DetectorContext,
  type DetectorResult,
} from "@/lib/system-audit/types";

/**
 * RECORD LINKAGE — three places where one record should point at another and does not.
 *
 *   1. AN ACTIVE LOGIN WITH NO ACCESS PROFILE. Every `app_auth_users` row is meant to have a
 *      `user_access_profiles` row behind its `auth_user_id`; without one the person's access is
 *      decided by nothing. The rule is the one scripts/backfill-missing-access-profiles.ts repairs
 *      by — no `auth_user_id` at all, or none of the profiles carries it — narrowed to ACTIVE logins
 *      whose HR id is a real employee. A login with no employee row is a different defect, already
 *      measured by the nightly integrity check (and the break-glass Super Admin has none by rule),
 *      so it is counted as excluded here, never double-reported.
 *   2. A FINGERPRINT DEVICE USER NOBODY HAS MAPPED. `resolveDeviceMappingStatus` says "unmapped":
 *      no employee and no non-employee label, so every punch from that finger is skipped as unknown
 *      and somebody's attendance may be going nowhere. One system row per device user.
 *
 *      NOT "an employee who should be on the device and is not". No single rule for that exists:
 *      `isAttendanceTracked` (job-title based, widened by device enrolment) and the attendance
 *      roster disagree about who is tracked, and inventing a third answer here would report
 *      whichever one this file happened to pick. That gap is named in the report, not guessed at.
 *   3. A RECORD THAT DISAGREES WITH ITS SEAT. `loadEmployeeSeatDrift()` — the employee's own area,
 *      region or manager against the organogram seat they hold, the source of truth for every
 *      employee's distribution. The 15 Oct 2026 Behira rep who vanished from her own area is the
 *      shape (src/lib/org/employee-seat-drift.ts).
 *
 * All three are STATES, not events: each is found again every night until somebody fixes it, so
 * they merge `max` (never doubled) and the verifier reads `last_event_at` to tell a recurrence.
 * Each source is read on its own; one that cannot be read is NOT MEASURED, and the others still land.
 */

export const DATA_LINKAGE_DETECTOR = "data_linkage";

const ROUTES = {
  loginWithoutProfile: "/admin/access",
  attendanceUnmapped: "/attendance/device-user-mapping",
  seatDrift: "/organogram",
} as const;

const SOURCES = {
  logins: "app_auth_users + user_access_profiles",
  devices: "attendance_device_user_map",
  seats: "au_v_employee_seat_drift",
} as const;

export const DATA_LINKAGE_COVERAGE_NOTE =
  "Not measured: employees who should be enrolled on a fingerprint device and are not — isAttendanceTracked and the attendance roster disagree about who is tracked, so no single rule exists to measure it against.";

export type LoginRow = {
  login_id: string | null;
  hr_id: string | null;
  role: string | null;
  is_active: boolean | null;
  auth_user_id: string | null;
};
export type EmployeeRow = { hr_id: string | null; full_name: string | null };
export type DeviceMapRow = {
  id: string | number;
  device_id: string;
  device_user_id: string;
  employee_hr_id: string | null;
  is_active: boolean | null;
  non_employee_label: string | null;
  created_at: string | null;
};
export type LatestPunchRow = { device_id: string; device_user_id: string; latest_punch_at: string | null };

type Label = { label: string; shell: AuditOccurrenceInput["shell"] };

const DRIFT_WORDS: Record<EmployeeSeatDrift["facts"][number]["kind"], string> = {
  area: "Area",
  region: "Region",
  manager: "Manager",
};

function nothing(value: string | null): string {
  return value ?? "nothing on file";
}

/** Pure: an active login whose access profile is missing, or null when it is fine or not ours. */
export function classifyLogin(
  login: LoginRow,
  profileAuthIds: ReadonlySet<string>,
  employees: ReadonlyMap<string, EmployeeRow>,
): { kind: "missing_profile"; employee: EmployeeRow; reason: string } | { kind: "no_employee_row" } | null {
  if (login.is_active !== true) return null;
  const employee = [login.hr_id, login.login_id]
    .map((candidate) => canonicalHrIdKey(candidate))
    .map((key) => (key ? employees.get(key) : undefined))
    .find((row): row is EmployeeRow => Boolean(row));
  if (!employee) return { kind: "no_employee_row" };
  if (!login.auth_user_id) {
    return { kind: "missing_profile", employee, reason: "The login has no sign-in identity, so no access profile can point at it." };
  }
  if (!profileAuthIds.has(login.auth_user_id)) {
    return { kind: "missing_profile", employee, reason: "The login has a sign-in identity but no access profile carries it." };
  }
  return null;
}

/** Pure: every finding the three sources produce. Exported for the test. */
export function buildDataLinkageFindings(input: {
  nowIso: string;
  logins: readonly LoginRow[] | null;
  profileAuthIds: ReadonlySet<string>;
  employees: ReadonlyMap<string, EmployeeRow>;
  devices: readonly DeviceMapRow[] | null;
  latestPunches: ReadonlyMap<string, string>;
  drifts: readonly EmployeeSeatDrift[] | null;
  label: (route: string) => Label;
}): { issues: AuditIssueInput[]; occurrences: AuditOccurrenceInput[]; excludedCounts: Record<string, number> } {
  const issues: AuditIssueInput[] = [];
  const occurrences: AuditOccurrenceInput[] = [];
  const excludedCounts: Record<string, number> = {};
  const base = {
    occurredAt: input.nowIso,
    occurredAtKind: "detected" as const,
    userMessage: SILENT_DATA_MESSAGE,
    isSilent: true,
    moduleLabelSource: "detector" as const,
  };

  // 1. Logins.
  if (input.logins) {
    const where = input.label(ROUTES.loginWithoutProfile);
    const rows: AuditOccurrenceInput[] = [];
    const seen = new Set<string>();
    for (const login of input.logins) {
      const verdict = classifyLogin(login, input.profileAuthIds, input.employees);
      if (!verdict) continue;
      if (verdict.kind === "no_employee_row") {
        excludedCounts.login_without_employee_row = (excludedCounts.login_without_employee_row ?? 0) + 1;
        continue;
      }
      const loginKey = String(login.login_id ?? "").trim().toLowerCase();
      const hrKey = canonicalHrIdKey(verdict.employee.hr_id);
      const dedupeKey = `link:login_without_profile:${loginKey || hrKey}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      rows.push({
        ...base,
        dedupeKey,
        signatureKey: "link:login_without_profile",
        hrKey,
        hrIdDisplay: verdict.employee.hr_id,
        employeeName: verdict.employee.full_name,
        roleAtEvent: login.role,
        moduleLabel: where.label,
        shell: where.shell,
        route: ROUTES.loginWithoutProfile,
        technicalMessage: verdict.reason,
        errorCode: "LINK-LOGIN-NO-PROFILE",
        relatedTable: "app_auth_users",
        relatedId: login.login_id,
        evidence: { hasAuthIdentity: Boolean(login.auth_user_id) },
      });
    }
    if (rows.length > 0) {
      issues.push({
        signatureKey: "link:login_without_profile",
        family: "data_linkage",
        errorCode: "LINK-LOGIN-NO-PROFILE",
        title: "Active login has no access profile",
        rootCauseLevel: "probable",
        rootCause:
          "The account was written without its profile — upsertAccessUserCore once skipped the profile when the login had no sign-in identity (repaired by scripts/backfill-missing-access-profiles.ts).",
        rootCauseEvidence: { rule: "scripts/backfill-missing-access-profiles.ts" },
        firstSeenAt: input.nowIso,
        lastSeenAt: input.nowIso,
      });
      occurrences.push(...rows);
    }
  }

  // 2. Fingerprint device users.
  if (input.devices) {
    const where = input.label(ROUTES.attendanceUnmapped);
    const rows: AuditOccurrenceInput[] = [];
    for (const device of input.devices) {
      const status = resolveDeviceMappingStatus({
        employeeHrId: device.employee_hr_id,
        isActive: device.is_active === true,
        nonEmployeeLabel: device.non_employee_label,
      });
      if (status !== "unmapped") continue;
      const lastPunch = input.latestPunches.get(`${device.device_id}\u0000${device.device_user_id}`) ?? null;
      rows.push({
        ...base,
        dedupeKey: `link:attendance_unmapped:${device.device_id}:${device.device_user_id}`,
        signatureKey: "link:attendance_unmapped",
        hrKey: null,
        moduleLabel: where.label,
        shell: where.shell,
        route: ROUTES.attendanceUnmapped,
        technicalMessage:
          `Device user ${device.device_user_id} on device ${device.device_id} is mapped to no employee and carries no ` +
          `non-employee label, so every punch from it is skipped as unknown` +
          (lastPunch ? `. Last punch ${cairoDateTime(lastPunch)} Cairo.` : ". It has no punch on record."),
        errorCode: "LINK-ATTENDANCE-UNMAPPED",
        relatedTable: "attendance_device_user_map",
        relatedId: String(device.id),
        evidence: { deviceId: device.device_id, deviceUserId: device.device_user_id, latestPunchAt: lastPunch },
      });
    }
    if (rows.length > 0) {
      issues.push({
        signatureKey: "link:attendance_unmapped",
        family: "data_linkage",
        errorCode: "LINK-ATTENDANCE-UNMAPPED",
        title: "Fingerprint device user mapped to nobody — punches skipped",
        firstSeenAt: input.nowIso,
        lastSeenAt: input.nowIso,
      });
      occurrences.push(...rows);
    }
  }

  // 3. Records that disagree with their organogram seat.
  if (input.drifts) {
    const where = input.label(ROUTES.seatDrift);
    const rows: AuditOccurrenceInput[] = [];
    const seen = new Set<string>();
    for (const drift of input.drifts) {
      const hrKey = canonicalHrIdKey(drift.hrId);
      if (!hrKey || seen.has(hrKey)) continue;
      seen.add(hrKey);
      const facts = drift.facts
        .map((fact) => `${DRIFT_WORDS[fact.kind]}: the record says ${nothing(fact.employeeValue)}, ${drift.seat} says ${nothing(fact.seatValue)}`)
        .join("; ");
      rows.push({
        ...base,
        dedupeKey: `link:seat_drift:${hrKey}`,
        signatureKey: "link:seat_drift",
        hrKey,
        hrIdDisplay: drift.hrId,
        employeeName: drift.name,
        moduleLabel: where.label,
        shell: where.shell,
        route: ROUTES.seatDrift,
        technicalMessage: `${facts}.`,
        errorCode: "LINK-SEAT-DRIFT",
        relatedTable: "employees",
        relatedId: drift.hrId,
        evidence: { kinds: drift.facts.map((fact) => fact.kind) },
      });
    }
    if (rows.length > 0) {
      issues.push({
        signatureKey: "link:seat_drift",
        family: "data_linkage",
        errorCode: "LINK-SEAT-DRIFT",
        title: "Employee record disagrees with the organogram seat they hold",
        firstSeenAt: input.nowIso,
        lastSeenAt: input.nowIso,
      });
      occurrences.push(...rows);
    }
  }

  return { issues, occurrences, excludedCounts };
}

export type DataLinkageDetectorDeps = {
  readLogins?: () => Promise<{ logins: LoginRow[]; profileAuthIds: Set<string>; employees: Map<string, EmployeeRow> }>;
  readDevices?: () => Promise<{ devices: DeviceMapRow[]; latestPunches: Map<string, string> }>;
  readDrifts?: () => Promise<EmployeeSeatDrift[]>;
  label?: (route: string) => Label;
};

async function defaultReadLogins() {
  const supabase = getSupabaseAdmin({ requestTimeoutMs: 20_000 });
  // Sequential on purpose: the sweep runs at five in the morning to spare the database, not to race it.
  const logins = await fetchAllRows<LoginRow>(
    () => supabase.from("app_auth_users").select("login_id,hr_id,role,is_active,auth_user_id").eq("is_active", true),
    "login_id",
  );
  const profiles = await fetchAllRows<{ auth_user_id: string | null }>(
    () => supabase.from("user_access_profiles").select("auth_user_id"),
    "auth_user_id",
  );
  const employees = await fetchAllRows<EmployeeRow>(() => supabase.from("employees").select("hr_id,full_name"), "hr_id");
  const byKey = new Map<string, EmployeeRow>();
  for (const employee of employees) {
    const key = canonicalHrIdKey(employee.hr_id);
    if (key) byKey.set(key, employee);
  }
  return {
    logins,
    profileAuthIds: new Set(profiles.map((profile) => profile.auth_user_id).filter((id): id is string => Boolean(id))),
    employees: byKey,
  };
}

async function defaultReadDevices() {
  const supabase = getSupabaseAdmin({ requestTimeoutMs: 20_000 });
  const devices = await fetchAllRows<DeviceMapRow>(
    () => supabase.from("attendance_device_user_map").select("id,device_id,device_user_id,employee_hr_id,is_active,non_employee_label,created_at"),
    "id",
  );
  // One row per (device, device user), folded by the database — see device-user-mapping.ts for why
  // the stored last_seen_punch_at column is not the answer.
  const punches = await fetchAllRows<LatestPunchRow>(
    () => supabase.from("attendance_device_user_latest_punch").select("device_id,device_user_id,latest_punch_at").order("device_id"),
    "device_user_id",
  );
  const latestPunches = new Map<string, string>();
  for (const punch of punches) {
    if (punch.latest_punch_at) latestPunches.set(`${punch.device_id}\u0000${punch.device_user_id}`, punch.latest_punch_at);
  }
  return { devices, latestPunches };
}

function defaultLabel(route: string): Label {
  const resolved = resolveSidebarLabel({ route });
  return { label: resolved.label, shell: resolved.shell ?? null };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "object" && error && "message" in error ? String((error as { message: unknown }).message) : String(error);
}

export function createDataLinkageDetector(deps: DataLinkageDetectorDeps = {}): AuditDetector {
  const readLogins = deps.readLogins ?? defaultReadLogins;
  const readDevices = deps.readDevices ?? defaultReadDevices;
  const readDrifts = deps.readDrifts ?? loadEmployeeSeatDrift;
  const label = deps.label ?? defaultLabel;

  return {
    id: DATA_LINKAGE_DETECTOR,
    family: "data_linkage",
    version: 1,
    async run(ctx: DetectorContext): Promise<DetectorResult> {
      const result = emptyDetectorResult();
      const nowIso = new Date(ctx.now()).toISOString();
      const errors: string[] = [];

      // One at a time, never three reads at once against a database the sweep is trying to spare.
      let logins: Awaited<ReturnType<typeof defaultReadLogins>> | null = null;
      try {
        logins = await readLogins();
      } catch (error) {
        result.unreadableSources.push(SOURCES.logins);
        errors.push(`${SOURCES.logins}: ${message(error)}`);
      }
      let devices: Awaited<ReturnType<typeof defaultReadDevices>> | null = null;
      if (ctx.now() < ctx.deadline) {
        try {
          devices = await readDevices();
        } catch (error) {
          result.unreadableSources.push(SOURCES.devices);
          errors.push(`${SOURCES.devices}: ${message(error)}`);
        }
      }
      let drifts: EmployeeSeatDrift[] | null = null;
      if (ctx.now() < ctx.deadline) {
        try {
          drifts = await readDrifts();
        } catch (error) {
          result.unreadableSources.push(SOURCES.seats);
          errors.push(`${SOURCES.seats}: ${message(error)}`);
        }
      }

      if (!logins && !devices && !drifts) {
        result.status = ctx.now() >= ctx.deadline && errors.length === 0 ? "budget_exhausted" : "errored";
        result.error = errors.join(" ") || "No source was read before the time budget ran out.";
        return result;
      }

      result.scanned = (logins?.logins.length ?? 0) + (devices?.devices.length ?? 0) + (drifts?.length ?? 0);
      const { issues, occurrences, excludedCounts } = buildDataLinkageFindings({
        nowIso,
        logins: logins?.logins ?? null,
        profileAuthIds: logins?.profileAuthIds ?? new Set(),
        employees: logins?.employees ?? new Map(),
        devices: devices?.devices ?? null,
        latestPunches: devices?.latestPunches ?? new Map(),
        drifts,
        label,
      });
      result.excludedCounts = excludedCounts;

      const watermark = { lastScanAt: nowIso };
      result.watermarkTo = watermark;
      if (issues.length > 0 || ctx.mode === "cron") {
        const written = await ctx.sink.write(DATA_LINKAGE_DETECTOR, ctx.runId, {
          issues,
          occurrences,
          merge: "max",
          cursor: ctx.mode === "cron" ? watermark : null,
        });
        result.inserted = written.inserted;
        result.updated = written.updated;
      }
      const skipped = !devices || !drifts;
      if (result.unreadableSources.length > 0 || skipped) result.status = errors.length === 0 && skipped ? "budget_exhausted" : "partial";
      if (errors.length > 0) result.error = errors.join(" ");
      result.report = {
        loginsWithoutProfile: occurrences.filter((row) => row.signatureKey === "link:login_without_profile").length,
        unmappedDeviceUsers: occurrences.filter((row) => row.signatureKey === "link:attendance_unmapped").length,
        seatDrifts: occurrences.filter((row) => row.signatureKey === "link:seat_drift").length,
        coverage: DATA_LINKAGE_COVERAGE_NOTE,
      };
      return result;
    },
  };
}

export const dataLinkageDetector = createDataLinkageDetector();
