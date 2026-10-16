// Recruitment / ATS — the requisition autopilot: every empty seat has an open requisition, and every
// requisition whose seat has been filled is closed as Filled, with nobody pressing anything.
//
// ── THE OWNER'S RULING (2026-10-16) ─────────────────────────────────────────────────────────────
//
// "I want all this process to be automated, opening requisition and the end-to-end cycle, I don't
// want manual work in the recruitment." Asked how, he chose, in order:
//
//   • OPENING — "Raise and open it at once." A seat that becomes empty gets a requisition that is
//     already OPEN, not a draft waiting for somebody to open it.
//   • APPROVAL — "Nothing needs approval." So this calls the same service the New Requisition form
//     calls, as the system, and the workflow registry's own rules still decide what is allowed.
//   • OWNER — Yomna Gamal, the holder of the Talent Acquisition seat (HR Resourcing). Read from the
//     role, never from her id, so the seat's next holder inherits the work without a code change.
//   • NOTICE — "No notice." Opening sends nothing; the requisition simply appears on her overview
//     and in the requisition list, which is what `createRequisition` already does.
//   • CLOSING — "Close it as Filled automatically." A requisition whose seat row reads `filled` AND
//     names who filled it is filled. Nothing is ever CANCELLED automatically — he asked for Filled,
//     and a `cancelled` row is often an import tidy-up (migration 20260805020000), not a decision.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────────────────────────
//
//   • It never opens a requisition for a PARKED seat (`isParkedSeat` in today-tasks.ts) — the
//     owner's own list of seats to leave empty until he hires into them.
//   • It never opens a replacement for somebody who is still employed. `requisitionOpenBlock` would
//     refuse the opening anyway; it is asked FIRST here so a refused seat never leaves a draft.
//   • It never touches a draft a PERSON raised. Its own drafts — `createRequisition` inserts a draft
//     and the opening is a second step, so a run that dies between the two leaves one — carry
//     `AUTOPILOT_OPEN_NOTE` and are opened on the next run, or a seat would sit "covered" for ever.
//   • It never writes the organogram. Seats are read; the skeleton is the owner's.
//
// ONE SEAT, ONE REQUISITION. `position_vacancies` is one row per vacancy EVENT, not one per seat
// (see listUnoccupiedWorkforceSeats), so a requisition raised against another row of the same seat
// still covers it. And the seat list (occupancy, `openWorkforceSeats`) and the Vacancy Report
// (`createRequisition`'s own check) can name DIFFERENT rows for one seat, so each seat is opened on
// the row the report names, or not at all.
//
// A FEW AT A TIME. Each opening costs `createRequisition` a full Vacancy Report read; the scheduler
// cuts a request at 30 s. So a run opens at most `MAX_OPENINGS_PER_RUN` and the rest wait an hour —
// the first-day backfill takes a few hours, and no run is ever cut halfway through a write.
//
// PURE PLAN, THIN RUNNER. `planRequisitionAutopilot` takes plain rows and returns what to do, so the
// rules are pinned by a test with literals; `runRequisitionAutopilot` reads the rows and acts.

import { systemAccessContext } from "@/lib/auth/permissions";
import { getEmployeeDirectory, type EmployeeDirectoryData } from "@/lib/employees/employee-directory";
import { hrIdLookupKeys, canonicalHrIdKey } from "@/lib/hr-id";
import { isParkedSeat, openWorkforceSeats } from "@/lib/hr/today-tasks";
import { resolveHrIdsForRole } from "@/lib/notifications/role-recipients";
import { textOrNull, numberOrNull, recruitmentDb } from "@/lib/recruitment/db";
import { requisitionOpenBlock } from "@/lib/recruitment/requisition-open-gate";
import { createRequisition, runRequisitionWorkflow } from "@/lib/recruitment/requisitions";
import { getVacancyReport } from "@/lib/reports/vacancies";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** Statuses in which a requisition is still recruiting, or about to — a seat holding one is covered. */
const ACTIVE_STATUSES = new Set(["req_draft", "req_open", "req_published", "req_on_hold"]);
/** Statuses the autopilot may fill from. Never a draft. */
const FILLABLE_STATUSES = new Set(["req_open", "req_published", "req_on_hold"]);

/** The note every requisition this opens carries, so a reader — and the next run — can tell it apart. */
export const AUTOPILOT_OPEN_NOTE = "Opened automatically when the seat became empty.";
/** Openings (new or retried) per run. See "A FEW AT A TIME" above. */
export const MAX_OPENINGS_PER_RUN = 6;

/** One empty seat, on the row the Vacancy Report names for it. */
export type AutopilotSeat = {
  vacancyId: number;
  vacancyCode: string | null;
  jobTitle: string | null;
  areaName: string | null;
  lineName: string | null;
  replacementForHrId: string | null;
  /** The seat's identity across vacancy events — see `vacancySeatKey`. Null when nothing can say. */
  seatKey: string | null;
};

/** One requisition, in the few fields the plan reads. */
export type AutopilotRequisition = {
  id: string;
  code: string;
  status: string;
  vacancyId: number | null;
  jobTitle: string;
  notes?: string | null;
};

/** A seat row's own identity and status, for any vacancy id a requisition names. */
export type AutopilotVacancyRow = {
  id: number;
  status: string;
  seatKey: string | null;
  /** Who filled the seat. A `filled` status with nobody named is not evidence of a hire. */
  filledByHrId?: string | null;
};

export type AutopilotSkipReason = "parked" | "replacement_still_employed";

export type AutopilotPlan = {
  open: AutopilotSeat[];
  /** The autopilot's own drafts, left by a run that died between the insert and the opening. */
  retry: AutopilotRequisition[];
  skipped: Array<{ seat: AutopilotSeat; reason: AutopilotSkipReason }>;
  fill: AutopilotRequisition[];
};

/**
 * One seat's identity across its vacancy events.
 *
 * `seat_id` when the row carries one — the organogram's own seat — else the line, area and
 * position it sits in (a part the row lacks reads as "-", so a Head Office seat still has one),
 * else its vacancy code. Ids, never names: two events of one seat share them even when a name was
 * retyped between them.
 */
export function vacancySeatKey(row: {
  seat_id?: unknown;
  line_id?: unknown;
  area_id?: unknown;
  position_id?: unknown;
  job_title?: unknown;
  vacancy_code?: unknown;
}): string | null {
  const seatId = textOrNull(row.seat_id);
  if (seatId) return `seat:${seatId}`;
  const position = numberOrNull(row.position_id) ?? textOrNull(row.job_title)?.toLowerCase() ?? null;
  if (position !== null) {
    return `place:${numberOrNull(row.line_id) ?? "-"}|${numberOrNull(row.area_id) ?? "-"}|${position}`;
  }
  const code = textOrNull(row.vacancy_code)?.toUpperCase();
  return code ? `code:${code}` : null;
}

function titleKey(title: string | null | undefined): string {
  return String(title ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function isClosedSeatRow(status: string): boolean {
  const value = status.trim().toLowerCase();
  return value === "filled" || value === "cancelled";
}

/** Is this draft one the autopilot itself left behind? Only those are ever touched. */
export function isAutopilotDraft(requisition: Pick<AutopilotRequisition, "status" | "notes">): boolean {
  return requisition.status === "req_draft" && textOrNull(requisition.notes) === AUTOPILOT_OPEN_NOTE;
}

/**
 * What the autopilot should do, and nothing else.
 *
 * `replacementStatus` answers a replaced person's employment status by HR id (null when unknown) —
 * passed in, like `requisitionOpenBlock` takes it, so the rule is testable without a database.
 */
export function planRequisitionAutopilot(input: {
  seats: readonly AutopilotSeat[];
  requisitions: readonly AutopilotRequisition[];
  vacancyRows: readonly AutopilotVacancyRow[];
  replacementStatus: (hrId: string) => string | null;
}): AutopilotPlan {
  const rowsById = new Map(input.vacancyRows.map((row) => [row.id, row]));

  const coveredIds = new Set<number>();
  const coveredKeys = new Set<string>();
  // A requisition raised against NO seat still recruits for its job — REQ-2026-61D5A3, the Office
  // Coordinator, measured 2026-10-16 beside an empty Head Office Office Coordinator seat. Each one
  // covers ONE empty seat of the same title, or the first run would open a second hire for it.
  const seatlessByTitle = new Map<string, number>();
  for (const requisition of input.requisitions) {
    if (!ACTIVE_STATUSES.has(requisition.status) || requisition.vacancyId !== null) continue;
    const title = titleKey(requisition.jobTitle);
    if (title) seatlessByTitle.set(title, (seatlessByTitle.get(title) ?? 0) + 1);
  }
  for (const requisition of input.requisitions) {
    if (!ACTIVE_STATUSES.has(requisition.status) || requisition.vacancyId === null) continue;
    coveredIds.add(requisition.vacancyId);
    const row = rowsById.get(requisition.vacancyId);
    // A requisition on an OLDER event of the seat, one already filled or cancelled, covers its own
    // row and not the seat — or a seat that emptied again would never get its new requisition.
    if (row && isClosedSeatRow(row.status)) continue;
    const key = row?.seatKey ?? null;
    if (key) coveredKeys.add(key);
  }

  const plan: AutopilotPlan = { fill: [], open: [], retry: [], skipped: [] };
  const openingKeys = new Set<string>();
  for (const seat of input.seats) {
    if (coveredIds.has(seat.vacancyId)) continue;
    const key = seat.seatKey;
    if (key && (coveredKeys.has(key) || openingKeys.has(key))) continue;
    if (isParkedSeat(seat)) {
      plan.skipped.push({ reason: "parked", seat });
      continue;
    }
    const replacing = textOrNull(seat.replacementForHrId);
    const block = requisitionOpenBlock(
      { headcount: 1, headcountType: replacing ? "replacement" : "expansion", replacementForHrId: replacing },
      replacing ? input.replacementStatus(replacing) : null,
    );
    if (block) {
      plan.skipped.push({ reason: "replacement_still_employed", seat });
      continue;
    }
    // Asked AFTER the two refusals, so a seatless requisition is never spent on a seat that would
    // not have opened anyway.
    const title = titleKey(seat.jobTitle);
    const seatless = title ? (seatlessByTitle.get(title) ?? 0) : 0;
    if (title && seatless > 0) {
      seatlessByTitle.set(title, seatless - 1);
      continue;
    }
    if (key) openingKeys.add(key);
    plan.open.push(seat);
  }

  for (const requisition of input.requisitions) {
    if (isAutopilotDraft(requisition)) {
      plan.retry.push(requisition);
      continue;
    }
    if (!FILLABLE_STATUSES.has(requisition.status) || requisition.vacancyId === null) continue;
    const row = rowsById.get(requisition.vacancyId);
    if (String(row?.status ?? "").trim().toLowerCase() === "filled" && textOrNull(row?.filledByHrId)) {
      plan.fill.push(requisition);
    }
  }

  return plan;
}

export type AutopilotResult = {
  dryRun: boolean;
  ownerHrId: string | null;
  opened: Array<{ code: string; vacancyCode: string | null; jobTitle: string | null; areaName: string | null; lineName: string | null }>;
  retried: string[];
  /** Seats that will open on a later run — the per-run cap. */
  deferred: number;
  filled: string[];
  skipped: Array<{ vacancyCode: string | null; jobTitle: string | null; areaName: string | null; reason: AutopilotSkipReason | "not_in_vacancy_report" }>;
  failed: Array<{ target: string; error: string }>;
};

/**
 * The Talent Acquisition seat's current holder, spelled exactly as `employees.hr_id` stores it —
 * the requisition's owner column is a case-sensitive foreign key, and the role read upper-cases.
 * Taken from the directory this run already holds, whose `hrId` is the stored spelling.
 */
async function talentAcquisitionOwnerHrId(directory: EmployeeDirectoryData): Promise<string | null> {
  const { hrIds } = await resolveHrIdsForRole("HR Resourcing", "Requisition autopilot owner");
  const holder = [...hrIds].sort()[0];
  const holderKey = canonicalHrIdKey(holder ?? "");
  if (!holderKey) return null;
  const employee = directory.employees.find((row) => canonicalHrIdKey(row.hrId) === holderKey);
  return textOrNull(employee?.hrId) ?? null;
}

/**
 * Read, plan, act. `dryRun` returns the same report without writing anything.
 *
 * A failure on one seat never stops the others; every failure is reported, and the run throws at
 * the end when there was one, so the job's heartbeat goes red instead of a broken seat going quiet.
 */
export async function runRequisitionAutopilot(options: { dryRun?: boolean } = {}): Promise<AutopilotResult> {
  const dryRun = Boolean(options.dryRun);
  const supabase = recruitmentDb();
  const [directory, report, requisitionRead] = await Promise.all([
    getEmployeeDirectory(),
    getVacancyReport(),
    supabase.from("ats_requisitions").select("id,requisition_code,status,vacancy_id,job_title,notes"),
  ]);
  if (requisitionRead.error) throw requisitionRead.error;
  const ownerHrId = await talentAcquisitionOwnerHrId(directory);

  const requisitions: AutopilotRequisition[] = (
    (requisitionRead.data ?? []) as Array<Record<string, unknown>>
  ).map((row) => ({
    code: textOrNull(row.requisition_code) ?? String(row.id),
    id: String(row.id),
    jobTitle: textOrNull(row.job_title) ?? "",
    notes: textOrNull(row.notes),
    status: String(row.status ?? ""),
    vacancyId: numberOrNull(row.vacancy_id),
  }));

  const emptySeats = openWorkforceSeats(directory);
  const reportOpen = report.rows.filter((row) => row.status === "open");

  // ONE READ for every vacancy row anything here names — the empty seats', the report's open rows'
  // and the requisitions' — for each row's identity, status and who filled it.
  const vacancyIds = [
    ...new Set([
      ...emptySeats.map((seat) => seat.vacancyId),
      ...reportOpen.map((row) => row.id),
      ...requisitions.map((row) => row.vacancyId).filter((id): id is number => id !== null),
    ]),
  ];
  const vacancyRows: AutopilotVacancyRow[] = [];
  if (vacancyIds.length > 0) {
    const { data, error } = await getSupabaseAdmin()
      .from("position_vacancies")
      .select("id,status,vacancy_code,job_title,seat_id,line_id,area_id,position_id,filled_by_hr_id")
      .in("id", vacancyIds);
    if (error) throw error;
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const id = numberOrNull(row.id);
      if (id === null) continue;
      vacancyRows.push({
        filledByHrId: textOrNull(row.filled_by_hr_id),
        id,
        seatKey: vacancySeatKey(row),
        status: String(row.status ?? ""),
      });
    }
  }
  const seatKeyById = new Map(vacancyRows.map((row) => [row.id, row.seatKey]));
  const reportOpenIds = new Set(reportOpen.map((row) => row.id));
  const reportRowByKey = new Map<string, number>();
  for (const row of reportOpen) {
    const key = seatKeyById.get(row.id);
    if (key && !reportRowByKey.has(key)) reportRowByKey.set(key, row.id);
  }

  // Each seat on the row the Vacancy Report names for it — the one `createRequisition` accepts.
  const notInReport: AutopilotResult["skipped"] = [];
  const seats: AutopilotSeat[] = [];
  for (const seat of emptySeats) {
    const seatKey = seatKeyById.get(seat.vacancyId) ?? null;
    const reportId = reportOpenIds.has(seat.vacancyId)
      ? seat.vacancyId
      : seatKey
        ? reportRowByKey.get(seatKey)
        : undefined;
    if (reportId === undefined) {
      notInReport.push({ areaName: seat.areaName, jobTitle: seat.jobTitle, reason: "not_in_vacancy_report", vacancyCode: seat.vacancyCode });
      continue;
    }
    seats.push({
      areaName: seat.areaName,
      jobTitle: seat.jobTitle,
      lineName: seat.lineName,
      replacementForHrId: seat.replacementForHrId,
      seatKey,
      vacancyCode: seat.vacancyCode,
      vacancyId: reportId,
    });
  }

  const replacedHrIds = [...new Set(seats.map((seat) => textOrNull(seat.replacementForHrId)).filter((id): id is string => Boolean(id)))];
  const statusByKey = new Map<string, string | null>();
  if (replacedHrIds.length > 0) {
    const { data, error } = await getSupabaseAdmin()
      .from("employees")
      .select("hr_id,employment_status")
      .in("hr_id", replacedHrIds.flatMap((hrId) => hrIdLookupKeys(hrId)));
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ hr_id?: string | null; employment_status?: string | null }>) {
      const key = canonicalHrIdKey(row.hr_id ?? "");
      if (key) statusByKey.set(key, row.employment_status ?? null);
    }
  }

  const plan = planRequisitionAutopilot({
    replacementStatus: (hrId) => statusByKey.get(canonicalHrIdKey(hrId) ?? "") ?? null,
    requisitions,
    seats,
    vacancyRows,
  });

  // The cap covers retries first: a stranded draft is a seat already promised and not recruiting.
  const retries = plan.retry.slice(0, MAX_OPENINGS_PER_RUN);
  const openings = plan.open.slice(0, Math.max(0, MAX_OPENINGS_PER_RUN - retries.length));

  const result: AutopilotResult = {
    deferred: plan.open.length - openings.length + (plan.retry.length - retries.length),
    dryRun,
    failed: [],
    filled: [],
    opened: [],
    ownerHrId,
    retried: [],
    skipped: [
      ...plan.skipped.map(({ reason, seat }) => ({
        areaName: seat.areaName,
        jobTitle: seat.jobTitle,
        reason,
        vacancyCode: seat.vacancyCode,
      })),
      ...notInReport,
    ],
  };

  if (dryRun) {
    result.opened = plan.open.map((seat) => ({
      areaName: seat.areaName,
      code: "(not opened — dry run)",
      jobTitle: seat.jobTitle,
      lineName: seat.lineName,
      vacancyCode: seat.vacancyCode,
    }));
    result.retried = plan.retry.map((row) => row.code);
    result.filled = plan.fill.map((row) => row.code);
    result.deferred = 0;
    return result;
  }

  for (const requisition of retries) {
    try {
      await runRequisitionWorkflow(requisition.id, "req_open", systemAccessContext);
      result.retried.push(requisition.code);
    } catch (error) {
      result.failed.push({ error: errorText(error), target: requisition.code });
    }
  }

  // No owner, no opening: a requisition nobody owns is one nobody works, and the owner was his
  // answer. Reported as a failure, so the heartbeat goes red rather than the seats quietly waiting.
  if (openings.length > 0 && !ownerHrId) {
    result.failed.push({ error: "Nobody holds the Talent Acquisition seat (HR Resourcing).", target: "owner" });
  } else {
    for (const seat of openings) {
      try {
        const created = await createRequisition(
          { headcount: 1, notes: AUTOPILOT_OPEN_NOTE, recruitmentOwnerHrId: ownerHrId, vacancyId: seat.vacancyId },
          systemAccessContext,
        );
        await runRequisitionWorkflow(created.id, "req_open", systemAccessContext);
        result.opened.push({
          areaName: seat.areaName,
          code: created.requisitionCode,
          jobTitle: seat.jobTitle,
          lineName: seat.lineName,
          vacancyCode: seat.vacancyCode,
        });
      } catch (error) {
        result.failed.push({ error: errorText(error), target: seat.vacancyCode ?? String(seat.vacancyId) });
      }
    }
  }

  for (const requisition of plan.fill) {
    try {
      await runRequisitionWorkflow(requisition.id, "req_fill", systemAccessContext);
      result.filled.push(requisition.code);
    } catch (error) {
      result.failed.push({ error: errorText(error), target: requisition.code });
    }
  }

  if (result.failed.length > 0) {
    throw new Error(
      `Requisition autopilot: ${result.failed.length} change(s) failed — `
        + result.failed.map((entry) => `${entry.target}: ${entry.error}`).join("; ").slice(0, 600),
    );
  }
  return result;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
