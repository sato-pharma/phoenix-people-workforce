// THE EXPLANATION BEHIND A DISPUTE — who may confirm it, saving it, and the confirmer's answer.
//
// Owner, 2026-11-16 ("manager first then me"): an employee explains a day from the reason list
// (explain-reasons.ts) and names who can confirm it. That person — his direct manager, the manager
// above, or for a training the Training Manager — answers first, from the top of his Disputes page;
// then the Super Admin decides the case in its own module, with the answer in front of him. The
// confirmer never decides anything: a decline is information, the decision stays the Super Admin's.
//
// Every notice here is in-app and push only (a prompt to open the page, never an email).
// Server-only.

import { randomUUID } from "node:crypto";

import { writeAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { dayChargeTarget, OFFICE_CYCLE_FIRST_MONTH_KEY } from "@/lib/deductions/cycle.ts";
import { loadOnePartEmployeeCompacts } from "@/lib/deductions/cycle-population.ts";
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key.ts";
import { resolveDisputeAudience } from "@/lib/deductions/dispute-audience.ts";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { canonicalHrIdKey, hrIdLookupKeys, hrIdsMatch } from "@/lib/hr-id";
import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { afterResponse } from "@/lib/http/after-response";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { resolveSuperAdminRecipients } from "@/lib/private-calendar/notify-admin";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import {
  explainDatesPhrase,
  explainDayLabel,
  explainReason,
  explainReasonPhrase,
  explanationFacts,
  explanationSummary,
  initialConfirmationStatus,
  type DisputeExplanation,
  type ExplainCaseKind,
  type ExplainConfirmationStatus,
  type ExplainConfirmerKind,
  type ExplainReasonCode,
  type ExplanationInput,
  type ValidExplanation,
  validateExplanation,
  validateExplanationReason,
} from "./explain-reasons.ts";
import { listCaseEvents } from "./events.ts";
import { disputeCaseHref } from "./notify.ts";
import { viewerHrIdOf } from "./participants.ts";
import { monthKeyLabel, payrollMonthState } from "./payroll-month.ts";
import { isDecidedByEvents } from "./state.ts";

export type { DisputeExplanation } from "./explain-reasons.ts";

export type ExplanationConfirmer = {
  hrId: string;
  name: string;
  title: string | null;
  kind: ExplainConfirmerKind;
};


type ExplanationRow = {
  id: string;
  case_kind: ExplainCaseKind;
  case_ref: string;
  group_id: string;
  employee_hr_id: string;
  employee_name: string | null;
  reason_code: ExplainReasonCode;
  detail_text: string | null;
  dates: string[] | null;
  confirmer_hr_id: string | null;
  confirmer_name: string | null;
  confirmation_status: ExplainConfirmationStatus;
  confirmation_note: string | null;
  confirmed_at: string | null;
  created_at: string;
};

const EXPLANATION_COLUMNS =
  "id,case_kind,case_ref,group_id,employee_hr_id,employee_name,reason_code,detail_text,dates,confirmer_hr_id,confirmer_name,confirmation_status,confirmation_note,confirmed_at,created_at";

function mapExplanationRow(row: ExplanationRow): DisputeExplanation {
  return {
    caseKind: row.case_kind,
    caseRef: row.case_ref,
    confirmationNote: row.confirmation_note,
    confirmationStatus: row.confirmation_status,
    confirmedAt: row.confirmed_at,
    confirmerHrId: row.confirmer_hr_id,
    confirmerName: row.confirmer_name,
    createdAt: row.created_at,
    dates: (row.dates ?? []).map((date) => String(date).slice(0, 10)).sort(),
    detailText: row.detail_text ?? "",
    employeeHrId: row.employee_hr_id,
    employeeName: row.employee_name,
    groupId: row.group_id,
    id: row.id,
    reasonCode: row.reason_code,
  };
}

/** The reason list's own check, answered as a 400 the employee reads (never a 500). */
export function checkExplanation(input: ExplanationInput, todayIso: string): ValidExplanation {
  try {
    return validateExplanation(input, todayIso);
  } catch (error) {
    throw validationError(error instanceof Error ? error.message : "Check the explanation and try again.");
  }
}

// ── Who may confirm ─────────────────────────────────────────────────────────────────────────────

/** Active Training Managers, by name. A failed read is an empty list (the manager chain still stands). */
async function loadTrainingManagers(): Promise<Array<{ hrId: string; name: string; title: string | null }>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("app_auth_users")
    .select("hr_id")
    .eq("role", "Training Manager")
    .eq("is_active", true);
  if (error) {
    logError("Training Manager list unreadable for a dispute explanation", { error, labels: { event: "explain_training_managers_failed" } });
    return [];
  }
  const hrIds = ((data ?? []) as Array<{ hr_id: string | null }>).map((row) => String(row.hr_id ?? "").trim()).filter(Boolean);
  if (hrIds.length === 0) return [];
  const lookups = Array.from(new Set(hrIds.flatMap((hrId) => hrIdLookupKeys(hrId))));
  const { data: people, error: peopleError } = await supabase
    .from("employees")
    .select("hr_id, full_name, nickname, job_title")
    .in("hr_id", lookups);
  if (peopleError) {
    logError("Training Manager names unreadable for a dispute explanation", { error: peopleError, labels: { event: "explain_training_managers_failed" } });
    return [];
  }
  const byKey = new Map<string, { full_name: string | null; nickname: string | null; job_title: string | null }>();
  for (const row of (people ?? []) as Array<{ hr_id: string | null; full_name: string | null; nickname: string | null; job_title: string | null }>) {
    const key = canonicalHrIdKey(row.hr_id);
    if (key) byKey.set(key, row);
  }
  return hrIds.map((hrId) => {
    const row = byKey.get(canonicalHrIdKey(hrId) ?? "");
    return {
      hrId,
      name: resolveEmployeeDisplayName(String(row?.full_name ?? "").trim(), row?.nickname ?? null, hrId).trim() || "Training Manager",
      title: String(row?.job_title ?? "").trim() || "Training Manager",
    };
  });
}

/**
 * Everyone this employee may name as a confirmer: his direct manager and the one above (the same
 * chain a deduction-dispute reply copies), and every active Training Manager. A person who is both is
 * listed once, as a manager. The employee himself is never on the list.
 */
export async function listExplanationConfirmers(employeeHrId: string): Promise<ExplanationConfirmer[]> {
  const [audience, trainers] = await Promise.all([resolveDisputeAudience(employeeHrId), loadTrainingManagers()]);
  const out: ExplanationConfirmer[] = [];
  const seen = new Set<string>();
  const ownKey = canonicalHrIdKey(employeeHrId);
  if (ownKey) seen.add(ownKey);
  for (const manager of audience.managers) {
    const key = canonicalHrIdKey(manager.hrId);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ hrId: manager.hrId, kind: "manager", name: manager.name, title: manager.title });
  }
  for (const trainer of trainers) {
    const key = canonicalHrIdKey(trainer.hrId);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ hrId: trainer.hrId, kind: "training_manager", name: trainer.name, title: trainer.title });
  }
  return out;
}

/** Pure: may this confirmer confirm this reason? Exported for the test. */
export function pickConfirmer(
  options: readonly ExplanationConfirmer[],
  reasonCode: ExplainReasonCode,
  confirmerHrId: string | null,
): ExplanationConfirmer | null {
  const allowed = explainReason(reasonCode).confirmerKinds;
  if (allowed.length === 0) return null;
  const match = options.find((option) => hrIdsMatch(option.hrId, confirmerHrId));
  if (!match || !allowed.includes(match.kind)) {
    throw validationError(
      reasonCode === "training"
        ? "Choose your manager or the Training Manager to confirm this training."
        : "Choose your manager to confirm this.",
    );
  }
  return match;
}

/** The confirmer the employee chose, checked against his own list. Null for "Something else". */
export async function resolveExplanationConfirmer(
  employeeHrId: string,
  explanation: Pick<ValidExplanation, "reasonCode" | "confirmerHrId">,
): Promise<ExplanationConfirmer | null> {
  if (explainReason(explanation.reasonCode).confirmerKinds.length === 0) return null;
  const options = await listExplanationConfirmers(employeeHrId);
  return pickConfirmer(options, explanation.reasonCode, explanation.confirmerHrId);
}

// ── The day rules every explained day passes ────────────────────────────────────────────────────

/**
 * Refuses a day whose payroll month is already final (owner: "Until payroll closes"). The day is
 * mapped to the payroll month it is CHARGED in — from October 2026 an employee paid in one part is on
 * the office cycle (22nd → 21st), so his 25 October belongs to November's payroll.
 */
export async function assertDaysStillExplainable(employeeHrId: string, dates: readonly string[]): Promise<void> {
  const compact = compactDeductionsHrId(employeeHrId);
  const needsCycle = dates.some((date) => date.slice(0, 7) >= OFFICE_CYCLE_FIRST_MONTH_KEY);
  const onePart = needsCycle && compact ? (await loadOnePartEmployeeCompacts()).has(compact) : false;
  const monthByDate = new Map<string, string>();
  for (const date of dates) monthByDate.set(date, dayChargeTarget(date, onePart).monthKey);
  const months = Array.from(new Set(monthByDate.values()));
  const states = await Promise.all(months.map(async (month) => [month, await payrollMonthState(month)] as const));
  const paid = new Set(states.filter(([, state]) => state === "paid").map(([month]) => month));
  if (paid.size === 0) return;
  const closed = dates.filter((date) => paid.has(monthByDate.get(date) ?? ""));
  const month = monthByDate.get(closed[0]) ?? "";
  throw validationError(
    `${monthKeyLabel(month)}'s payroll is already confirmed, so ${explainDatesPhrase(closed)} can no longer be explained here. If money was deducted for ${closed.length === 1 ? "that day" : "those days"}, dispute the deduction on your Deductions page.`,
  );
}

/**
 * Refuses a day this employee already explained in ANOTHER module (the same day on the calendar and
 * on a deduction dispute was two reviews of one day — measured 16 Nov 2026). `otherKinds` are the
 * modules to check against. Returns nothing; throws a sentence naming the day.
 */
export async function assertDaysNotExplainedElsewhere(input: {
  employeeHrId: string;
  dates: readonly string[];
  otherKinds: readonly ExplainCaseKind[];
}): Promise<void> {
  if (input.dates.length === 0 || input.otherKinds.length === 0) return;
  const lookups = hrIdLookupKeys(input.employeeHrId);
  if (lookups.length === 0) return;
  const { data, error } = await getSupabaseAdmin()
    .from("dispute_explanations")
    .select("case_kind, case_ref, dates")
    .in("employee_hr_id", lookups)
    .in("case_kind", [...input.otherKinds])
    .overlaps("dates", [...input.dates]);
  if (error) throw error;
  let rows = (data ?? []) as Array<{ case_kind: ExplainCaseKind; case_ref: string; dates: string[] | null }>;
  // A calendar explanation the Super Admin already decided no longer holds the day: once its payroll
  // month is confirmed, the deduction is disputed on the Deductions page, as assertDaysStillExplainable
  // tells the employee — refusing it there sent them in a circle.
  const calendarRefs = rows.filter((row) => row.case_kind === "calendar").map((row) => row.case_ref);
  if (calendarRefs.length > 0) {
    const open = await openCaseRefs("calendar", calendarRefs);
    rows = rows.filter((row) => row.case_kind !== "calendar" || open.has(row.case_ref));
  }
  if (rows.length === 0) return;
  const wanted = new Set(input.dates);
  // The earliest day hit, with the module that holds THAT day (never the first row's module).
  const hits = rows
    .flatMap((row) => (row.dates ?? []).map((date) => ({ date: String(date).slice(0, 10), kind: row.case_kind })))
    .filter((hit) => wanted.has(hit.date))
    .sort((left, right) => left.date.localeCompare(right.date));
  const first = hits[0] ?? { date: input.dates[0], kind: rows[0].case_kind };
  const where = first.kind === "calendar" ? "on your calendar" : "on a deduction dispute";
  throw conflictError(`You already explained ${explainDayLabel(first.date)} ${where}. Open it in your Disputes and add to it there.`);
}

// ── Saving ──────────────────────────────────────────────────────────────────────────────────────

/** One explanation per case, written in one insert. Throws on failure (the caller removes the case). */
export async function insertDisputeExplanations(input: {
  caseKind: ExplainCaseKind;
  cases: ReadonlyArray<{ ref: string; dates: readonly string[] }>;
  groupId: string;
  employeeHrId: string;
  employeeName: string | null;
  explanation: ValidExplanation;
  confirmer: ExplanationConfirmer | null;
}): Promise<DisputeExplanation[]> {
  const status = initialConfirmationStatus(input.explanation.reasonCode);
  const { data, error } = await getSupabaseAdmin()
    .from("dispute_explanations")
    .insert(
      input.cases.map((entry) => ({
        case_kind: input.caseKind,
        case_ref: entry.ref,
        confirmation_status: status,
        confirmer_hr_id: input.confirmer?.hrId ?? null,
        confirmer_name: input.confirmer?.name ?? null,
        dates: [...entry.dates],
        detail_text: input.explanation.detailText,
        employee_hr_id: input.employeeHrId,
        employee_name: input.employeeName,
        group_id: input.groupId,
        reason_code: input.explanation.reasonCode,
      })),
    )
    .select(EXPLANATION_COLUMNS);
  if (error) {
    if ((error as { code?: string }).code === "23505") throw conflictError("This dispute already has an explanation.");
    throw error;
  }
  return ((data ?? []) as ExplanationRow[]).map(mapExplanationRow);
}

/** The explanation a deduction or daily-deduction dispute opens with, checked and ready to save. */
export type PreparedCaseExplanation = {
  explanation: ValidExplanation;
  confirmer: ExplanationConfirmer | null;
};

/**
 * Checks the explanation that OPENS a deduction or daily-deduction dispute (owner, 2026-11-16: the
 * same reason list as the calendar, never "why is this wrong"). The days are the deduction's own,
 * fixed by HR, so only the reason, the words and the confirmer are checked — and a day already
 * explained on the calendar or on the other deduction box is refused, so one day is never two reviews.
 * Nothing is written.
 */
export async function prepareCaseExplanation(input: {
  caseKind: Exclude<ExplainCaseKind, "calendar">;
  employeeHrId: string;
  dates: readonly string[];
  explanation: unknown;
}): Promise<PreparedCaseExplanation> {
  const raw = (input.explanation && typeof input.explanation === "object" ? input.explanation : {}) as Record<string, unknown>;
  let reason: Omit<ValidExplanation, "dates">;
  try {
    reason = validateExplanationReason({ confirmerHrId: raw.confirmerHrId, detailText: raw.detailText, reasonCode: raw.reasonCode });
  } catch (error) {
    throw validationError(error instanceof Error ? error.message : "Choose why first.");
  }
  const explanation: ValidExplanation = { ...reason, dates: [...input.dates] };
  const confirmer = await resolveExplanationConfirmer(input.employeeHrId, explanation);
  const otherKinds = (["calendar", "deduction", "daily"] as const).filter((kind) => kind !== input.caseKind);
  await assertDaysNotExplainedElsewhere({ dates: input.dates, employeeHrId: input.employeeHrId, otherKinds });
  return { confirmer, explanation };
}

/**
 * Saves a prepared explanation once its dispute row exists, and tells the confirmer. Throws on a failed
 * write — the caller removes the dispute row, so nobody reviews half a claim.
 */
export async function recordCaseExplanation(input: {
  caseKind: Exclude<ExplainCaseKind, "calendar">;
  ref: string;
  employeeHrId: string;
  employeeName: string | null;
  prepared: PreparedCaseExplanation;
}): Promise<DisputeExplanation> {
  const groupId = randomUUID();
  const [row] = await insertDisputeExplanations({
    caseKind: input.caseKind,
    cases: [{ dates: input.prepared.explanation.dates, ref: input.ref }],
    confirmer: input.prepared.confirmer,
    employeeHrId: input.employeeHrId,
    employeeName: input.employeeName,
    explanation: input.prepared.explanation,
    groupId,
  });
  if (input.prepared.confirmer) {
    await notifyExplanationConfirmer({
      caseKind: input.caseKind,
      confirmer: input.prepared.confirmer,
      dates: input.prepared.explanation.dates,
      employeeHrId: input.employeeHrId,
      employeeName: input.employeeName,
      groupId,
      reasonCode: input.prepared.explanation.reasonCode,
    });
  }
  return row;
}

/** The explanations behind a module's cases, keyed by the case's ref. A failed read throws. */
export async function loadExplanationsByCase(
  caseKind: ExplainCaseKind,
  refs: readonly string[],
): Promise<Map<string, DisputeExplanation>> {
  const out = new Map<string, DisputeExplanation>();
  const unique = Array.from(new Set(refs.filter(Boolean)));
  for (let index = 0; index < unique.length; index += 200) {
    const slice = unique.slice(index, index + 200);
    const { data, error } = await getSupabaseAdmin()
      .from("dispute_explanations")
      .select(EXPLANATION_COLUMNS)
      .eq("case_kind", caseKind)
      .in("case_ref", slice);
    if (error) throw error;
    for (const row of (data ?? []) as ExplanationRow[]) out.set(row.case_ref, mapExplanationRow(row));
  }
  return out;
}

/**
 * The explanation behind one case, as the reviewer's facts. Best-effort: an unreadable table adds
 * nothing and is logged — the case still opens with the employee's own words in its first message.
 */
export async function explanationFactsFor(caseKind: ExplainCaseKind, ref: string): Promise<ReturnType<typeof explanationFacts>> {
  try {
    const explanation = (await loadExplanationsByCase(caseKind, [ref])).get(ref);
    return explanation ? explanationFacts(explanation) : [];
  } catch (error) {
    logError("Dispute explanation unreadable for a case", { error, labels: { caseKind, event: "explanation_facts_failed" } });
    return [];
  }
}

/** Where a confirmer opens what is waiting for him. */
export const EXPLANATION_CONFIRM_HREF = "/employee-portals/disputes#confirm";

/** The days as a person reads them ("Thu 12 Nov", "7–9 Nov and 12 Nov"), or the case when it has none. */
function daysPhrase(dates: readonly string[]): string {
  return dates.length > 0 ? explainDatesPhrase(dates) : "a deducted day";
}

/**
 * Tells the named confirmer there is something to confirm — in-app and push, never email. Runs after
 * the reply. A failed notice is logged, never thrown.
 */
export async function notifyExplanationConfirmer(input: {
  caseKind: ExplainCaseKind;
  groupId: string;
  confirmer: ExplanationConfirmer;
  employeeHrId: string;
  employeeName: string | null;
  reasonCode: ExplainReasonCode;
  dates: readonly string[];
}): Promise<void> {
  await afterResponse("dispute_explanation_notice:confirm_requested", async () => {
    const who = input.employeeName?.trim() || "An employee";
    await createSystemNotificationForRecipients(
      {
        actionUrl: EXPLANATION_CONFIRM_HREF,
        actorId: input.employeeHrId,
        channels: ["in_app", "push"],
        eventType: "dispute_explanation_confirm_requested",
        message: `${who} says they were ${explainReasonPhrase(input.reasonCode)} on ${daysPhrase(input.dates)}, and named you to confirm it. Open your Disputes page to confirm or decline.`,
        metadata: {
          authorizedRecipient: true,
          caseKind: input.caseKind,
          employeeHrId: input.employeeHrId,
          groupId: input.groupId,
          idempotencyKey: `dispute-explanation:${input.groupId}:confirm-requested`,
        },
        module: input.caseKind === "calendar" ? "private_calendar" : "deductions",
        priority: "normal",
        recordId: input.groupId,
        subjectHrId: input.employeeHrId,
        title: `Please confirm: ${who}, ${explainReason(input.reasonCode).label.toLowerCase()}`,
      },
      [input.confirmer.hrId],
    );
  });
}

// ── The confirmer's side ───────────────────────────────────────────────────────────────────────

/** One explanation sent for several days (or one), as the confirmer reads it. */
export type ExplanationGroup = {
  groupId: string;
  caseKind: ExplainCaseKind;
  employeeHrId: string;
  employeeName: string | null;
  reasonCode: ExplainReasonCode;
  summary: string;
  detailText: string;
  dates: string[];
  createdAt: string;
};

/** Pure: fold explanation rows into one entry per group, oldest first. Exported for the test. */
export function groupExplanations(rows: readonly DisputeExplanation[]): ExplanationGroup[] {
  const byGroup = new Map<string, ExplanationGroup>();
  for (const row of rows) {
    const existing = byGroup.get(row.groupId);
    if (existing) {
      existing.dates = Array.from(new Set([...existing.dates, ...row.dates])).sort();
      if (row.createdAt < existing.createdAt) existing.createdAt = row.createdAt;
      continue;
    }
    byGroup.set(row.groupId, {
      caseKind: row.caseKind,
      createdAt: row.createdAt,
      dates: [...row.dates],
      detailText: row.detailText,
      employeeHrId: row.employeeHrId,
      employeeName: row.employeeName,
      groupId: row.groupId,
      reasonCode: row.reasonCode,
      summary: explanationSummary({ detailText: null, reasonCode: row.reasonCode }),
    });
  }
  return Array.from(byGroup.values()).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/**
 * The cases among `refs` still waiting for the Super Admin. A decided case needs no confirmation: its
 * explanation leaves the confirmer's list and can no longer be answered. A calendar or daily dispute
 * keeps its state on its own row; a monthly deduction dispute keeps it in its case events.
 */
async function openCaseRefs(caseKind: ExplainCaseKind, refs: readonly string[]): Promise<Set<string>> {
  const unique = Array.from(new Set(refs.filter(Boolean)));
  const open = new Set<string>();
  if (unique.length === 0) return open;
  if (caseKind === "deduction") {
    const events = await listCaseEvents("deduction", unique);
    for (const ref of unique) if (!isDecidedByEvents(events.get(ref) ?? [])) open.add(ref);
    return open;
  }
  const table = caseKind === "calendar" ? "private_calendar_data_disputes" : "daily_deductions_disputes";
  const openStatus = caseKind === "calendar" ? "pending_review" : "open";
  for (let index = 0; index < unique.length; index += 200) {
    const { data, error } = await getSupabaseAdmin()
      .from(table)
      .select("id")
      .in("id", unique.slice(index, index + 200))
      .eq("status", openStatus);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ id: string }>) open.add(String(row.id));
  }
  return open;
}

/** Only the explanations whose case is still open, each kind asked once. */
async function withOpenCases(rows: readonly DisputeExplanation[]): Promise<DisputeExplanation[]> {
  const kinds = Array.from(new Set(rows.map((row) => row.caseKind)));
  const openByKind = new Map(
    await Promise.all(
      kinds.map(async (kind) => [kind, await openCaseRefs(kind, rows.filter((row) => row.caseKind === kind).map((row) => row.caseRef))] as const),
    ),
  );
  return rows.filter((row) => openByKind.get(row.caseKind)?.has(row.caseRef));
}

/** What is waiting for the viewer to confirm. Empty for anyone nobody named. */
export async function listExplanationGroupsAwaitingViewer(access: AccessContext): Promise<ExplanationGroup[]> {
  const hrId = viewerHrIdOf(access);
  const lookups = hrIdLookupKeys(hrId);
  if (lookups.length === 0) return [];
  // Read whole, THEN cut to the open cases: a decision on a day the confirmer never answered leaves its row awaiting for
  // ever, so a row cap taken before withOpenCases filled with old decided rows and hid newer live requests behind them.
  const awaiting = await fetchAllRows<ExplanationRow>(
    () =>
      getSupabaseAdmin()
        .from("dispute_explanations")
        .select(EXPLANATION_COLUMNS)
        .in("confirmer_hr_id", lookups)
        .eq("confirmation_status", "awaiting")
        .order("created_at", { ascending: true }),
    "id",
  );
  return groupExplanations(await withOpenCases(awaiting.map(mapExplanationRow)));
}

/** Where the Super Admin decides the case: the calendar inbox, or the case itself in the Dispute Center. */
function reviewerHrefFor(kind: ExplainCaseKind, ref: string): string {
  if (kind === "calendar") return "/admin/private-calendar-disputes";
  return disputeCaseHref(kind, ref, "reviewer");
}

/**
 * The confirmer answers one group: "confirmed" (it happened) or "declined" (it did not, or not as
 * described). Only the person named may answer, and only once. The Super Admin is told after, because
 * it is his to decide now (owner: "manager first then me").
 */
export async function answerExplanationGroup(
  access: AccessContext,
  input: { groupId: string; answer: "confirmed" | "declined"; note?: string | null },
): Promise<{ answered: number }> {
  const hrId = viewerHrIdOf(access);
  if (!hrId) throw forbiddenError("Your employee profile is not linked. Contact HR.");
  if (input.answer !== "confirmed" && input.answer !== "declined") throw validationError("Confirm or decline.");
  const note = String(input.note ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (input.answer === "declined" && !note) throw validationError("Say in a few words what was not as described.");

  const supabase = getSupabaseAdmin();
  const { data: rows, error } = await supabase
    .from("dispute_explanations")
    .select(EXPLANATION_COLUMNS)
    .eq("group_id", input.groupId);
  if (error) throw error;
  const group = ((rows ?? []) as ExplanationRow[]).map(mapExplanationRow);
  if (group.length === 0) throw notFoundError("That explanation no longer exists.");
  if (!hrIdsMatch(group[0].confirmerHrId, hrId)) throw forbiddenError("Only the person named to confirm this can answer it.");
  const awaiting = group.filter((row) => row.confirmationStatus === "awaiting");
  if (awaiting.length === 0) throw conflictError("You already answered this.");
  const open = await withOpenCases(awaiting);
  if (open.length === 0) throw conflictError("This was already decided, so it no longer needs your answer.");

  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await supabase
    .from("dispute_explanations")
    .update({ confirmation_note: note || null, confirmation_status: input.answer, confirmed_at: now, updated_at: now })
    .in("id", open.map((row) => row.id))
    .eq("confirmation_status", "awaiting")
    .select("id");
  if (updateError) throw updateError;
  const answered = (updated ?? []).length;
  if (answered === 0) throw conflictError("You already answered this.");

  const first = open[0];
  const dates = Array.from(new Set(open.flatMap((row) => row.dates))).sort();
  await writeAuditLog({
    actorLoginId: access.loginId ?? hrId,
    entityId: input.groupId,
    entityType: "dispute_explanation",
    newValues: { answer: input.answer, caseKind: first.caseKind, dates, note: note || null, rows: answered },
    summary: `Dispute explanation ${input.answer} by the named confirmer`,
  });

  await afterResponse("dispute_explanation_notice:answered", async () => {
    const admins = await resolveSuperAdminRecipients();
    const confirmerName = first.confirmerName ?? "The confirmer";
    const who = first.employeeName ?? "an employee";
    await createSystemNotificationForRecipients(
      {
        actionUrl: reviewerHrefFor(first.caseKind, first.caseRef),
        actorId: hrId,
        channels: ["in_app", "push"],
        eventType: "dispute_explanation_answered",
        message: `${confirmerName} ${input.answer === "confirmed" ? "confirmed" : "did not confirm"} that ${who} was ${explainReasonPhrase(first.reasonCode)} on ${daysPhrase(dates)}.${note ? ` Note: ${note}` : ""} It is ready for your decision.`,
        metadata: {
          authorizedRecipient: true,
          caseKind: first.caseKind,
          employeeHrId: first.employeeHrId,
          groupId: input.groupId,
          idempotencyKey: `dispute-explanation:${input.groupId}:answered`,
        },
        module: first.caseKind === "calendar" ? "private_calendar" : "deductions",
        priority: "normal",
        recordId: input.groupId,
        subjectHrId: first.employeeHrId,
        title: `${input.answer === "confirmed" ? "Confirmed" : "Not confirmed"}: ${who}, ${explainReason(first.reasonCode).label.toLowerCase()}`,
      },
      admins.map((admin) => admin.hrId),
    );
  });

  return { answered };
}
