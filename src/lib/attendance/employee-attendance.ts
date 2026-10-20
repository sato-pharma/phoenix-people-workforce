import { getFingerprintAttendanceReport, type FingerprintPolicyDetailRow } from "@/lib/attendance/fingerprint-report";
import { getAttendanceExceptions } from "@/lib/attendance/exceptions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key";
import { isAttendanceTracked } from "@/lib/attendance/eligibility";
import { loadActiveDeviceMappedHrIds } from "@/lib/attendance/device-user-mapping";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics";
import { hrIdsMatch, normalizeHrId, normalizeHrIdForAccess, type AccessContext, type PhoenixRole } from "@/lib/auth/permissions";
import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { getEmployeeDirectory, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { isWithinManagerHierarchy } from "@/lib/workforce/hierarchy-resolver";

export type EmployeeAttendanceSummary = {
  /**
   * NOT absence. This counts days whose status is "Single punch" — the employee was at the device
   * but only one scan was recorded. A genuinely absent day produces no punch row at all, so it is
   * not in this report's rows and cannot be counted here.
   *
   * Named `absentDays` since before this note and left alone deliberately: renaming it would touch
   * every consumer for no behavioural gain. Label it honestly in the UI instead — calling a
   * single-punch day "absent" is the same class of error as the August 2026 fabricated-absence
   * defect, where an ingestion outage was reported as a 100% absence rate.
   */
  absentDays: number;
  completeDays: number;
  deductionDays: number;
  exceptionDays: number;
  lateDays: number;
  shortDays: number;
  totalRows: number;
};

export type EmployeeAttendanceData = {
  dateFrom: string;
  dateTo: string;
  pendingDisputes: number;
  rows: Array<{
    date: string;
    deductionConfirmed: boolean;
    deductionDays: string;
    firstPunch: string;
    hasException: boolean;
    lastPunch: string;
    lateMinutes: string;
    rawDate: string;
    recommendedAction: string;
    status: string;
    timeLong: string;
    // ── Added 2026-08-10 ───────────────────────────────────────────────────────────────────────
    // Every field below was ALREADY fetched by the getFingerprintAttendanceReport call in this
    // function and then thrown away: the mapper kept 10 of the report's 24 columns. Surfacing them
    // costs no extra query and no extra round trip.
    //
    // Additive and role-blind on purpose. The owner asked for a richer view for ONE person, but a
    // service that returns a different SHAPE depending on who is asking is how "granted on paper,
    // bounced in practice" bugs are born — so the data widens for every caller and only the
    // rendering differs. Consumers that do not read these keys are unaffected.
    approvedExcuse: string;
    approvedLeave: string;
    crmActivity: string;
    /** EGP. The money consequence of the row, which the day list previously showed only as days. */
    deductionValue: string;
    earlyLeaveMinutes: string;
    graceMinutes: string;
    /** Set when an approved Am/Pm-only vacation halved the required-minutes window for this day. */
    halfDayVacationPart?: "am_only" | "pm_only";
    scheduledEnd: string;
    scheduledStart: string;
    validTime: string;
    weeklyPlan: string;
  }>;
  summary: EmployeeAttendanceSummary;
  /**
   * Which attendance policy judged each day, and over what window — "why was I marked late?"
   * answered without asking HR. Already returned by the same report call; previously discarded.
   */
  policyDetails: FingerprintPolicyDetailRow[];
};

async function getHrConfirmedDeductionDates(hrId: string): Promise<Set<string>> {
  const compactHrId = compactDeductionsHrId(hrId);
  if (!compactHrId) return new Set();

  // Unified Deductions module (src/lib/deductions/). The attendance-device deductions
  // that legacy governance filed under source_module = "ATTENDANCE_DEVICE" are the
  // `fingerprint` category here. The legacy table froze after 2026-07, so reading it
  // left this badge dark for every current month; the unified table is where HR now
  // decides, so it is the only table that answers "was this day's deduction approved".
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("deductions_candidates")
    .select("dates, deductions_decisions!inner(decision_status)")
    .eq("category", "fingerprint")
    .eq("employee_hr_id_compact", compactHrId)
    .is("superseded_at", null)
    .eq("deductions_decisions.decision_status", "Approved for Payroll");

  if (error || !data) return new Set();

  const confirmed = new Set<string>();
  for (const row of data) {
    const dates = Array.isArray(row.dates) ? row.dates : [];
    for (const d of dates) {
      if (typeof d === "string") confirmed.add(d);
    }
  }
  return confirmed;
}

export async function getEmployeeAttendanceData(
  hrId: string,
  dateFrom: string,
  dateTo: string,
): Promise<EmployeeAttendanceData> {
  const [reportData, disputesData, confirmedDates] = await Promise.all([
    getFingerprintAttendanceReport({ dateFrom, dateTo, exactEmployeeHrId: hrId }),
    getAttendanceExceptions({ dateFrom, dateTo, employeeHrId: hrId, status: "pending" }),
    getHrConfirmedDeductionDates(hrId),
  ]);

  const summary: EmployeeAttendanceSummary = {
    absentDays: 0,
    completeDays: 0,
    deductionDays: 0,
    exceptionDays: 0,
    lateDays: 0,
    shortDays: 0,
    totalRows: reportData.rows.length,
  };

  const rows = reportData.rows.map((row) => {
    const s = row.status;
    if (s === "Complete") summary.completeDays++;
    else if (s === "Late" || s === "Early leave") summary.lateDays++;
    else if (s === "Short day") summary.shortDays++;
    else if (s === "Single punch") summary.absentDays++;
    if (s === "Exception") summary.exceptionDays++;

    const dd = parseFloat(row.deductionDays);
    const rawDate = row.sortKey.slice(0, 10);
    const deductionConfirmed = dd > 0 && confirmedDates.has(rawDate);
    if (deductionConfirmed) summary.deductionDays++;

    return {
      approvedExcuse: row.approvedExcuse,
      approvedLeave: row.approvedLeave,
      crmActivity: row.crmActivity,
      date: row.date,
      deductionConfirmed,
      deductionDays: row.deductionDays,
      deductionValue: row.deductionValue,
      earlyLeaveMinutes: row.earlyLeaveMinutes,
      firstPunch: row.actualFirstPunch,
      graceMinutes: row.graceMinutes,
      halfDayVacationPart: row.halfDayVacationPart,
      hasException: row.hasException ?? false,
      lastPunch: row.actualLastPunch,
      lateMinutes: row.lateMinutes,
      rawDate,
      recommendedAction: row.recommendedAction,
      scheduledEnd: row.scheduledEnd,
      scheduledStart: row.scheduledStart,
      status: row.status,
      timeLong: row.timeLong,
      validTime: row.validTime,
      weeklyPlan: row.weeklyPlan,
    };
  });

  return {
    dateFrom,
    dateTo,
    pendingDisputes: disputesData.length,
    policyDetails: reportData.policyDetails ?? [],
    rows,
    summary,
  };
}

// ─── Manager view: who may see whose fingerprint report ─────────────────────

export type AttendanceViewTarget = {
  hrId: string;
  managerHrId: string | null;
};

export type AttendanceReportTarget = {
  hrId: string;
  fullName: string;
  jobTitle: string;
};

/**
 * Roles whose attendance visibility is SELF ONLY — not their direct reports, and never the
 * company-wide bypass below.
 *
 * Finance Manager (owner instruction, 2026-08-10: "fix the attendance export so he only sees
 * himself"). He holds `attendance: ["read","export"]` and scopeForRole gives the role `"company"`,
 * so the `context.scope === "company"` arm in both functions below was silently admitting him to
 * EVERY employee's attendance — `/api/attendance/employee-fingerprint-export?hrId=<anyone>` returned
 * any one of 114 people's full 24-column punch-and-deduction workbook. Nothing in the product linked
 * there for him; it was reachable by URL alone, and it predated the modules granted the same day.
 *
 * Deliberately a SELF-ONLY list rather than just deleting the `scope === "company"` arm. Deleting it
 * would drop him to the manager fallback (self + direct reports), which would still show him the
 * attendance of the three head-office staff who report to him. The owner asked for himself and
 * nobody else, so this is the explicit carve-out that produces that — he is the one manager in the
 * system who cannot see his own team's attendance, and it needs to be visible in code that this is
 * intentional rather than an oversight.
 *
 * He keeps his OWN report in full: /workspace/fingerprint-report is bound to access.hrId and passes
 * the self check that runs before this gate.
 *
 * Note the removal is not achievable by narrowing `scope` alone: scopeForRole returned "company" for
 * exactly Super Admin, CEO and Finance Manager, and the first two are named explicitly in the
 * disjunctions below — so the scope arm existed only for him anyway. HR Operations joined that
 * scope on 2026-08-29; the scope arm was not restored, and its one-person view is a named role line.
 *
 * The HR Operations Specialist seat (`HR Administration`) joined the list on 2026-10-20. The owner:
 * she reviews attendance ONLY through her own Daily & Weekly Reports, and she never sees a salary
 * or a deduction in EGP — and this report prices every late minute and absent day. Without this
 * line she fell to the manager fallback (self + direct reports), so anyone ever placed under her
 * would have been readable. Her own report stays hers, as his does.
 */
const SELF_ONLY_ATTENDANCE_ROLES: ReadonlySet<PhoenixRole> = new Set<PhoenixRole>([
  "Finance Manager",
  "HR Administration",
]);

export function isSelfOnlyAttendanceViewer(context: Pick<AccessContext, "role">): boolean {
  return SELF_ONLY_ATTENDANCE_ROLES.has(context.role);
}

/**
 * Whether `context` may view the fingerprint/attendance report of `target`.
 *
 *  - self — always.
 *  - whole-company viewers (Super Admin, CEO, or company/system scope) — anyone.
 *  - SFE Manager / Training Manager — also whole-company: these are functional,
 *    cross-line oversight roles with real attendance permissions (SFE Manager: full
 *    CRUD; Training Manager: read) but no traditional direct-report chain to fall
 *    back on, same gap class as the Head Office line-vs-reporting-edge issue fixed
 *    elsewhere for these roles (see [[company-org-structure-head-office]]).
 *  - HR Operations — anyone, for ONE person at a time (owner ruling 2026-09-17). It approves leave
 *    and excuse requests in the Approvals Hub, whose context panel reads this check, and it already
 *    reads every employee's punches and deductions on the whole-company Fingerprint Report
 *    (canAccessFingerprintReport → employees:read). Before the ruling the panel answered 403 for
 *    every request it was asked to approve. The bulk list scoper below is deliberately NOT widened:
 *    the ruling covered the per-person view, and the bulk exports keep their existing scope.
 *  - any other manager — their DIRECT reports (target.managerHrId === caller). A manager seat's
 *    deeper subtree is admitted by assertCanViewEmployeeAttendance, which can read the directory.
 *
 * Pure + exact-match; the security boundary for the manager view. Guests / no-scope
 * are denied outright.
 */
export function canViewEmployeeAttendanceReport(
  context: AccessContext,
  target: AttendanceViewTarget,
): boolean {
  if (context.source === "guest" || context.scope === "none") return false;
  const caller = normalizeHrId(context.hrId);
  const targetHrId = normalizeHrId(target.hrId);
  if (!caller || !targetHrId) return false;

  if (hrIdsMatch(caller, targetHrId)) return true; // self

  // Self-only roles stop here — BEFORE the company bypass and before the direct-report fallback.
  // Placed after the self check above so the role keeps its own report in full. See
  // SELF_ONLY_ATTENDANCE_ROLES for why this is a role list and not a narrowing of `scope`.
  if (isSelfOnlyAttendanceViewer(context)) return false;

  // Whole-company visibility (CEO / Super Admin / system scope, plus the functional head-office
  // oversight roles that hold real attendance permissions).
  //
  // `context.scope === "company"` was removed on 2026-08-10: scopeForRole returns "company" for
  // exactly Super Admin, CEO and Finance Manager, the first two are already named on their own
  // lines, and the third must not be here at all — so the arm admitted one role by accident and
  // nobody by design.
  if (
    context.scope === "system" ||
    context.role === "Super Admin" ||
    context.role === "CEO" ||
    context.role === "SFE Manager" ||
    context.role === "Training Manager" ||
    // One person's report, for the requests HR Operations approves — see the doc comment above.
    context.role === "HR Operations"
  ) {
    return true;
  }

  // Otherwise: direct reports only.
  return hrIdsMatch(caller, target.managerHrId);
}

/**
 * Throws `Forbidden: ...` unless `context` may view `targetHrId`'s report. Resolves
 * the target's manager from the DB only when needed (i.e. not self / not company-wide),
 * so the common self path stays a single fast in-memory check.
 */
export async function assertCanViewEmployeeAttendance(
  context: AccessContext,
  targetHrId: string,
): Promise<void> {
  const caller = normalizeHrId(context.hrId);
  const target = normalizeHrId(targetHrId);
  if (!caller || !target) {
    throw new Error("Forbidden: attendance access denied.");
  }
  // Self or whole-company viewers need no employee lookup.
  if (canViewEmployeeAttendanceReport(context, { hrId: target, managerHrId: null })) {
    return;
  }
  // A manager seat (isHierarchyAttendanceViewer) reaches their whole subtree, which the pure
  // single-edge predicate below cannot express (it only ever sees the target's immediate manager).
  // Checked before the single-row lookup so the common case still costs one query at most.
  if (isHierarchyAttendanceViewer(context)) {
    const subtree = new Set(
      (await loadAttendanceSubtreeHrIds(context.hrId)).map((hrId) => normalizeAttendanceHrId(hrId) ?? hrId),
    );
    if (subtree.has(normalizeAttendanceHrId(target) ?? target)) return;
  }

  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("employees")
    .select("manager_hr_id")
    .eq("hr_id", target.toUpperCase())
    .maybeSingle();
  const managerHrId = (data as { manager_hr_id: string | null } | null)?.manager_hr_id ?? null;
  if (!canViewEmployeeAttendanceReport(context, { hrId: target, managerHrId })) {
    throw new Error(`Forbidden: ${context.role} cannot view attendance for another employee.`);
  }
}

/**
 * True when this viewer's attendance reach follows their whole management subtree rather than just
 * their direct reports — every manager seat: `hierarchy` (Regional Manager), `line` (National Sales
 * Manager, Product / Group Product / Marketing Manager) and `team` (District Manager, Manager) — see
 * scopeForRole.
 *
 * A one-level rule is wrong for them in a way that matters: an RM owns the attendance-driven
 * deduction days of every Medical Rep in their region, but those reps report to a DSM, so a
 * direct-reports-only check showed the RM only their 3 DSMs and hid all 14 reps. The same rule hid
 * every rep from a National Sales Manager and every second-level report from a head-office manager
 * (owner, 2026-10-20: "every single role that is applicable to appear in a module"). The subtree is
 * downward only, so nobody reaches a peer or a manager above him. Company-scoped seats keep their own
 * lines in the two functions that call this, and the self-only Finance Manager stops before it.
 */
export function isHierarchyAttendanceViewer(context: Pick<AccessContext, "scope">): boolean {
  return context.scope === "hierarchy" || context.scope === "line" || context.scope === "team";
}

/**
 * Raw hrIds of everyone inside `managerHrId`'s management subtree, at any depth, seat-continuity
 * aware (so a district whose DSM seat is mid-replacement is not dropped). Excludes the manager.
 */
async function loadAttendanceSubtreeHrIds(managerHrId: string | null | undefined): Promise<string[]> {
  const viewerKey = normalizeHrIdForAccess(managerHrId ?? "");
  if (!viewerKey) return [];
  const directory = await getEmployeeDirectory();
  const byCanonicalHrId = new Map<string, EmployeeDirectoryRow>();
  for (const row of directory.employees) {
    const key = normalizeHrIdForAccess(row.hrId);
    if (key) byCanonicalHrId.set(key, row);
  }
  return directory.employees
    .filter((row) =>
      isWithinManagerHierarchy({
        employee: row,
        byCanonicalHrId,
        viewerCanonicalHrId: viewerKey,
        canonicalize: normalizeHrIdForAccess,
      }),
    )
    .map((row) => row.hrId);
}

/**
 * Active reports of `managerHrId` who are attendance-tracked (device-enrolled or a field role) —
 * used to populate the manager's report selector. Returns [] when none. Terminated/resigned reports
 * are excluded. `includeSubtree` widens from direct reports to the whole management subtree, for the
 * hierarchy-scoped roles whose reach is not one level (see isHierarchyAttendanceViewer).
 */
export async function loadAttendanceDirectReports(
  managerHrId: string,
  options: { includeSubtree?: boolean } = {},
): Promise<AttendanceReportTarget[]> {
  const normalized = normalizeHrId(managerHrId);
  if (!normalized) return [];

  const supabase = getSupabaseAdmin();
  const subtreeHrIds = options.includeSubtree ? await loadAttendanceSubtreeHrIds(normalized) : null;
  const query = supabase
    .from("employees")
    .select("hr_id, full_name, nickname, job_title, employment_status, manager_hr_id");
  const { data, error } = subtreeHrIds
    ? await (subtreeHrIds.length === 0
        ? Promise.resolve({ data: [] as unknown[], error: null })
        : query.in("hr_id", subtreeHrIds.map((hrId) => hrId.toUpperCase())))
    : await query.eq("manager_hr_id", normalized.toUpperCase());
  if (error || !data) return [];

  const deviceMapped = await loadActiveDeviceMappedHrIds();
  return (data as Array<{
    hr_id: string;
    full_name: string | null;
    nickname: string | null;
    job_title: string | null;
    employment_status: string | null;
    manager_hr_id: string | null;
  }>)
    // Direct-report mode re-asserts the manager edge in memory (defence in depth against a loose
    // query). Subtree mode must NOT: those rows are matched by hrId and mostly report to a DSM, so
    // re-checking manager_hr_id against the RM would filter every one of them back out.
    .filter((row) => (subtreeHrIds ? true : hrIdsMatch(row.manager_hr_id, normalized)))
    .filter((row) => !isTerminalEmploymentStatus(row.employment_status))
    .filter((row) =>
      isAttendanceTracked({
        // The device-mapped set is keyed by normalizeAttendanceHrId (UPPERCASE);
        // match that exactly — permissions.normalizeHrId is lowercase and would miss.
        hasDeviceMapping: deviceMapped.has(normalizeAttendanceHrId(row.hr_id) ?? ""),
        jobTitle: row.job_title,
      }),
    )
    .map((row) => ({
      hrId: normalizeHrId(row.hr_id) ?? row.hr_id,
      fullName: row.full_name?.trim()
        ? resolveEmployeeDisplayName(row.full_name.trim(), row.nickname)
        : row.hr_id,
      jobTitle: row.job_title?.trim() || "",
    }))
    .sort((left, right) => left.fullName.localeCompare(right.fullName));
}

/**
 * The reports a viewer's Attendance Analytics picker offers (/employee-portals/fingerprint-analytics)
 * — exactly the people assertCanViewEmployeeAttendance admits for him, so the picker never lists a
 * name the per-person API then refuses, nor hides one it would serve. A manager seat gets his whole
 * subtree; anyone else his direct reports. Self is not included: the page adds it as "My report".
 * The self-only Finance Manager gets nobody (owner, 2026-08-10).
 */
export async function loadAttendancePickerReports(
  context: Pick<AccessContext, "hrId" | "role" | "scope">,
): Promise<AttendanceReportTarget[]> {
  if (!context.hrId || isSelfOnlyAttendanceViewer(context)) return [];
  return loadAttendanceDirectReports(context.hrId, { includeSubtree: isHierarchyAttendanceViewer(context) });
}

/**
 * hrIds `context` may see in bulk attendance exports/reports: `null` means no
 * restriction (whole company). Mirrors `canViewEmployeeAttendanceReport`'s bypass
 * (self / whole-company viewers / reports, a manager seat's whole subtree) for list-scoped callers, with ONE
 * deliberate difference: HR Operations. The owner's 2026-09-17 ruling opened any one person's
 * report to it and did not cover bulk lists, so here it keeps self + direct reports. That path
 * reads Supabase and is not unit-tested; do not "align" the two without a ruling on the lists.
 * Direct-report hrIds come back from `loadAttendanceDirectReports` normalized via
 * permissions.normalizeHrId (lowercase) — re-normalize with normalizeAttendanceHrId
 * (UPPERCASE) here since that's what fingerprint-report.ts/roster.ts compare against.
 */
export async function resolveAttendanceScopeHrIds(context: AccessContext): Promise<string[] | null> {
  if (context.source === "guest" || context.scope === "none") {
    throw new Error("Forbidden: attendance access denied.");
  }
  const selfOnlyCaller = normalizeAttendanceHrId(context.hrId);
  // Same self-only carve-out as canViewEmployeeAttendanceReport, applied to the LIST scoper so the
  // two cannot disagree on it: one decides "may I see this person", the other decides "which people
  // does this report cover", and a role held out of one but not the other is a hole. (HR Operations
  // is the one deliberate difference, and in the safe direction — see the doc comment.) Returns his own
  // HR_ID rather than null (null means "no restriction, whole company").
  if (isSelfOnlyAttendanceViewer(context)) {
    if (!selfOnlyCaller) throw new Error("Forbidden: attendance access denied.");
    return [selfOnlyCaller];
  }
  // `context.scope === "company"` removed 2026-08-10 — see the note in canViewEmployeeAttendanceReport.
  if (
    context.scope === "system" ||
    context.role === "Super Admin" ||
    context.role === "CEO" ||
    context.role === "SFE Manager" ||
    context.role === "Training Manager"
  ) {
    return null;
  }
  const caller = normalizeAttendanceHrId(context.hrId);
  if (!caller) {
    throw new Error("Forbidden: attendance access denied.");
  }
  const reports = await loadAttendanceDirectReports(caller, {
    includeSubtree: isHierarchyAttendanceViewer(context),
  });
  return [caller, ...reports.map((report) => normalizeAttendanceHrId(report.hrId) ?? report.hrId)];
}
