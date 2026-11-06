// Recruitment / ATS — requisitions service.
//
// A requisition wraps an existing open `position_vacancies` seat and adds the
// fields the organogram does not store (grade, salary band, headcount type,
// recruitment owner/deadline/priority). It snapshots the vacancy's org-unit ids
// so offer creation can pass them straight through to the offer engine.

import { cache } from "react";

import type { AccessContext } from "@/lib/auth/permissions";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { isReplacementRequisition, requisitionOpenBlock } from "@/lib/recruitment/requisition-open-gate";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getVacancyListRows, type VacancyReportRow } from "@/lib/reports/vacancies";
import {
  assertRecruitmentTransition,
  mapRequisition,
  newRequisitionCode,
  numberOrNull,
  recruitmentDb,
  textOrNull,
  type RequisitionDbRow,
} from "@/lib/recruitment/db";
import {
  assertCanDeleteRecruitment,
  assertCanSeeRequisition,
  filterRequisitionsForAccess,
  resolveHiringManagerScopeHrIds,
} from "@/lib/recruitment/access";
import {
  headcountTypes,
  requisitionPriorities,
  type CreateRequisitionInput,
  type HeadcountType,
  type PositionCatalogueOption,
  type RecruitmentActionKey,
  type Requisition,
  type RequisitionPriority,
} from "@/lib/recruitment/types";

const activeRequisitionStatuses = ["req_draft", "req_open", "req_published", "req_on_hold"];

async function employeeNameByHrId(): Promise<Map<string, string>> {
  const rows = await getEmployeeDirectoryRows();
  const map = new Map<string, string>();
  for (const row of rows) {
    const key = canonicalHrIdKey(row.hrId);
    if (key) map.set(key, row.displayName);
  }
  return map;
}

function enrich(requisition: Requisition, names: Map<string, string>): Requisition {
  return {
    ...requisition,
    hiringManagerName: requisition.hiringManagerHrId
      ? names.get(canonicalHrIdKey(requisition.hiringManagerHrId) ?? "") ?? null
      : null,
    recruitmentOwnerName: requisition.recruitmentOwnerHrId
      ? names.get(canonicalHrIdKey(requisition.recruitmentOwnerHrId) ?? "") ?? null
      : null,
  };
}

/**
 * Every requisition row, newest first — read ONCE per server render.
 *
 * The recruitment overview reads this twice in one render: `getRecruitmentDashboard` lists the
 * requisitions, and `listApplications` beside it lists them again for its scope check. Same table,
 * same order, no filter, so React `cache()` hands the second caller the first one's rows (an error
 * is thrown to both). Outside a render it is a plain call. Nothing mutates the rows — every caller
 * maps them into new objects.
 */
const loadAllRequisitionRows = cache(async (): Promise<RequisitionDbRow[]> => {
  // Paged to a short page by the unique `id`: the scope check on every application reads these rows,
  // so a requisition a response cap dropped would hide that requisition's applications from a viewer.
  return fetchAllRows<RequisitionDbRow>(
    () => recruitmentDb().from("ats_requisitions").select("*").order("created_at", { ascending: false }),
    "id",
  );
});

export async function listRequisitions(access: AccessContext): Promise<Requisition[]> {
  const [rows, names, scopeHrIds] = await Promise.all([
    loadAllRequisitionRows(),
    employeeNameByHrId(),
    resolveHiringManagerScopeHrIds(access),
  ]);

  const requisitions = rows.map((row) => enrich(mapRequisition(row), names));
  return filterRequisitionsForAccess(access, requisitions, scopeHrIds);
}

export async function getRequisition(access: AccessContext, id: string): Promise<Requisition | null> {
  const supabase = recruitmentDb();
  const [{ data, error }, names, scopeHrIds] = await Promise.all([
    supabase.from("ats_requisitions").select("*").eq("id", id).maybeSingle(),
    employeeNameByHrId(),
    resolveHiringManagerScopeHrIds(access),
  ]);
  if (error) throw error;
  if (!data) return null;

  const requisition = enrich(mapRequisition(data as RequisitionDbRow), names);
  assertCanSeeRequisition(access, requisition, scopeHrIds);
  return requisition;
}

// Open vacancies that do not yet have an active requisition — the create-form list.
// It reads the vacancy LIST (getVacancyListRows, open rows only), never the whole vacancy report: the
// report also builds the employee directory for its organogram, which this list never shows, and on
// 19 Oct 2026 that made the Recruitment page miss this list twice in one morning.
export async function listOpenVacanciesForRequisition(): Promise<VacancyReportRow[]> {
  const supabase = recruitmentDb();
  // Concurrently: the active-requisition read does not depend on the vacancy list, and run after
  // it, it was a second round trip waiting on the first. A failed list still throws first.
  const [openRows, data] = await Promise.all([
    getVacancyListRows({ openOnly: true }),
    // Every active requisition, paged to a short page by the unique `id`: one a response cap hid would
    // offer its seat again as if nobody had raised a requisition for it.
    fetchAllRows<RequisitionDbRow>(
      () => supabase.from("ats_requisitions").select("vacancy_id,status").in("status", activeRequisitionStatuses),
      "id",
    ),
  ]);
  const wrapped = new Set(
    data
      .map((row) => numberOrNull(row.vacancy_id))
      .filter((value): value is number => value !== null),
  );
  return openRows.filter((vacancy) => !wrapped.has(vacancy.id));
}

// Owner-curated: positions that exist in the org catalogue but are not hired through
// the recruitment pipeline, so they must not appear in the requisition Position dropdown.
// Extend this set as the owner classifies more positions.
export const NON_RECRUITABLE_POSITION_CODES = new Set<string>(["ceo"]);

// The full catalogue of active positions — every role that can be recruited for, not only the ~3
// that happen to have a vacant seat on the organogram today. getVacancyReport() only ever surfaces
// titles that appear in vacancy rows, so this is a separate read against `positions` itself.
// Titles are returned exactly as stored (some are awkwardly cased, e.g. "Ceo", "Qppv") — the caller
// shows them verbatim. Owner-excluded codes (NON_RECRUITABLE_POSITION_CODES) are filtered out here
// so every caller of this catalogue gets the same curated list.
export async function listPositionCatalogue(): Promise<PositionCatalogueOption[]> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("positions")
    .select("id,title,code")
    .eq("is_active", true)
    .order("title");
  if (error) throw error;
  return ((data ?? []) as Array<{ id: unknown; title: unknown; code: unknown }>)
    .filter((row) => {
      const code = textOrNull(row.code);
      return !code || !NON_RECRUITABLE_POSITION_CODES.has(code.toLowerCase());
    })
    .map((row) => ({ id: numberOrNull(row.id), title: textOrNull(row.title) }))
    .filter((row): row is PositionCatalogueOption => row.id !== null && row.title !== null);
}

function normalizeHeadcountType(value: unknown, fallback: HeadcountType): HeadcountType {
  const text = textOrNull(value);
  return text && (headcountTypes as readonly string[]).includes(text) ? (text as HeadcountType) : fallback;
}

function normalizePriority(value: unknown): RequisitionPriority {
  const text = textOrNull(value);
  return text && (requisitionPriorities as readonly string[]).includes(text)
    ? (text as RequisitionPriority)
    : "normal";
}

export async function createRequisition(
  input: CreateRequisitionInput,
  access: AccessContext,
): Promise<Requisition> {
  const supabase = recruitmentDb();
  const vacancyId = numberOrNull(input.vacancyId);

  let vacancy: VacancyReportRow | null = null;
  if (vacancyId) {
    // The vacancy list, not the whole report: only the seat's own line, area and manager are read here.
    vacancy = (await getVacancyListRows()).find((row) => row.id === vacancyId) ?? null;
    if (!vacancy) throw new Error("Selected vacancy was not found.");
    if (vacancy.status !== "open") throw new Error("Selected vacancy is not open.");

    const { data: existing, error: existingError } = await supabase
      .from("ats_requisitions")
      .select("id")
      .eq("vacancy_id", vacancyId)
      .in("status", activeRequisitionStatuses)
      .limit(1);
    if (existingError) throw existingError;
    if ((existing ?? []).length > 0) {
      throw new Error("This vacancy already has an active requisition.");
    }
  }

  // A requisition with no vacancy behind it has no seat to inherit anything from, and two of those
  // inherited values are load-bearing:
  //
  //   • job_title is the only name the requisition is ever read by. Without a vacancy it comes from a
  //     typed title or a chosen catalogue position's title; with neither it falls back to "" (see the
  //     payload below), which puts a nameless row on everyone's screen.
  //   • hiring_manager_hr_id is what makes the requisition VISIBLE. canSeeRequisition
  //     (src/lib/recruitment/access.ts) scopes on hiringManagerHrId and recruitmentOwnerHrId and
  //     never on line or area — so a seatless requisition with no manager is invisible to everyone
  //     except the roles that see all of recruitment, and to the recruiter who happens to own it.
  //     The person expected to hire for it would never see the thing.
  //
  // Enforced here and not only in the form because the form is not the boundary: the POST route
  // takes both fields from the request body.
  let resolvedPositionTitle: string | null = null;
  if (!vacancy) {
    if (!textOrNull(input.hiringManagerHrId)) {
      throw new Error("Choose the hiring manager — with no vacancy behind it, nobody else can see this requisition.");
    }
    // A catalogue position gives a seatless requisition its name and a real position_id. Resolve it
    // against `positions` so a bogus id cannot slip a phantom position onto the row, and use its
    // title as the job-title fallback. This does NOT touch the organogram — position_id only tags
    // the role; the seat model (vacancy_id) is a separate thing left untouched.
    const positionId = numberOrNull(input.positionId);
    if (positionId) {
      const { data: position, error: positionError } = await supabase
        .from("positions")
        .select("id,title")
        .eq("id", positionId)
        .eq("is_active", true)
        .maybeSingle();
      if (positionError) throw positionError;
      if (!position) throw new Error("Selected position was not found.");
      resolvedPositionTitle = textOrNull((position as { title?: unknown }).title);
    }
    if (!textOrNull(input.jobTitle) && !resolvedPositionTitle) {
      throw new Error("Choose a position or type a job title, or pick an open vacancy.");
    }
  }

  const headcountType = normalizeHeadcountType(
    input.headcountType,
    vacancy?.replacementForHrId ? "replacement" : "expansion",
  );

  const payload = {
    requisition_code: newRequisitionCode(),
    vacancy_id: vacancyId,
    department_id: vacancy?.departmentId ?? null,
    line_id: vacancy?.lineId ?? null,
    area_id: vacancy?.areaId ?? null,
    team_id: vacancy?.teamId ?? null,
    position_id: vacancy?.positionId ?? numberOrNull(input.positionId) ?? null,
    job_title: textOrNull(input.jobTitle) ?? vacancy?.jobTitle ?? vacancy?.positionTitle ?? resolvedPositionTitle ?? "",
    hiring_manager_hr_id: textOrNull(input.hiringManagerHrId) ?? vacancy?.managerHrId ?? null,
    recruitment_owner_hr_id: textOrNull(input.recruitmentOwnerHrId) ?? access.hrId ?? null,
    grade: textOrNull(input.grade),
    salary_band_min: numberOrNull(input.salaryBandMin),
    salary_band_max: numberOrNull(input.salaryBandMax),
    headcount_type: headcountType,
    replacement_for_hr_id: vacancy?.replacementForHrId ?? null,
    headcount: numberOrNull(input.headcount) ?? 1,
    priority: normalizePriority(input.priority),
    recruitment_deadline: textOrNull(input.recruitmentDeadline),
    status: "req_draft",
    notes: textOrNull(input.notes),
    created_by: access.hrId ?? access.loginId ?? null,
  };

  const { data, error } = await supabase
    .from("ats_requisitions")
    .insert(payload)
    .select("*")
    .single();
  if (error) throw error;

  const names = await employeeNameByHrId();
  return enrich(mapRequisition(data as RequisitionDbRow), names);
}

const requisitionNextStatus: Record<string, string> = {
  req_open: "req_open",
  req_publish: "req_published",
  req_hold: "req_on_hold",
  req_resume: "req_open",
  req_fill: "req_filled",
  req_close: "req_closed",
  req_cancel: "req_cancelled",
};

export async function runRequisitionWorkflow(
  id: string,
  actionKey: RecruitmentActionKey,
  access: AccessContext,
  input: { reason?: string | null } = {},
): Promise<Requisition> {
  const requisition = await getRequisition(access, id);
  if (!requisition) throw new Error("Requisition not found.");

  const nextStatus = requisitionNextStatus[actionKey];
  if (!nextStatus) throw new Error("Unsupported requisition action.");

  await assertRecruitmentTransition({
    actionKey,
    role: access.role,
    status: requisition.status,
    reason: input.reason,
  });

  // Opening a requisition starts a real hire against real money, so it carries one check the
  // registry cannot express: the registry knows roles and from-statuses, not whether the person
  // this replaces has actually left.
  //
  // Scoped to req_open alone. Publishing, holding, resuming, filling and closing all act on a
  // requisition that already passed this, and re-running it there would refuse to CLOSE a
  // requisition whose replacement was since re-hired - blocking the tidy-up rather than the hire.
  if (actionKey === "req_open") {
    let replacementStatus: string | null = null;
    if (isReplacementRequisition(requisition.headcountType) && requisition.replacementForHrId) {
      // Casing-blind: HR ids are mixed case, and a plain .eq silently under-returns - which here
      // would read as "this person does not exist" and block a legitimate replacement.
      const keys = hrIdLookupKeys(requisition.replacementForHrId);
      if (keys.length > 0) {
        const { data } = await getSupabaseAdmin()
          .from("employees")
          .select("employment_status")
          .in("hr_id", keys)
          .maybeSingle();
        replacementStatus = (data as { employment_status?: string | null } | null)?.employment_status ?? null;
      }
    }

    const block = requisitionOpenBlock(requisition, replacementStatus);
    if (block) throw new Error(block.message);
  }

  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_requisitions")
    .update({ status: nextStatus, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;

  const names = await employeeNameByHrId();
  return enrich(mapRequisition(data as RequisitionDbRow), names);
}

// Used by the convert flow to close the requisition when a hire completes.
export async function markRequisitionFilled(id: string, access: AccessContext): Promise<void> {
  const requisition = await getRequisition(access, id);
  if (!requisition) return;
  if (requisition.status === "req_filled") return;
  if (!["req_open", "req_published", "req_on_hold"].includes(requisition.status)) return;
  await runRequisitionWorkflow(id, "req_fill", access);
}

// Hard-delete a requisition (admin cleanup; any status). Database cascades remove
// its applications, events, interviews, onboarding items, postings, and files.
export async function deleteRequisition(access: AccessContext, id: string): Promise<void> {
  assertCanDeleteRecruitment(access);
  const requisition = await getRequisition(access, id); // throws if out of scope
  if (!requisition) throw new Error("Requisition not found.");
  const supabase = recruitmentDb();
  const { error } = await supabase.from("ats_requisitions").delete().eq("id", id);
  if (error) throw error;
}
