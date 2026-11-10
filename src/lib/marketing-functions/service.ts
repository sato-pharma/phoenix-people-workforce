// Marketing Functions & Field Visit Feedback — every read and write, with the viewer narrowed first.
//
// Service role only (the migration revokes the three tables from anon and authenticated). Every caller
// is a server page or a route that has already passed `assertPermission`; this file then decides WHOSE
// rows, through scope.ts, before anything is read back to a person.

import type { AccessContext } from "@/lib/auth/permissions";
import { assertTestAccountWriteIsDryRun } from "@/lib/auth/test-dry-run";
import { visitCountBucket } from "@/lib/crm/visit-count-buckets";
import { todayInCairo } from "@/lib/date-only";
import { resolveDoubleVisitAccessScope } from "@/lib/double-visit-analytics/service";
import { getEmployeeDirectoryRows, isActiveLifecycleStatus, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { canonicalHrIdKey, hrIdForStorage, normalizeHrIdForAccess } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { monthEndDate, monthKeyOf, monthStartDate, shiftMonthKey } from "./months";
import { carryForwardItems, missingForSignature, normalizeFieldFeedbackInput, normalizeItems } from "./rules";
import {
  canEditFieldFeedback,
  canEditMonth,
  canReopenMonth,
  canStampMonth,
  canSubmitMonth,
  canViewFieldFeedback,
  isMarketingFunctionsAuthor,
  isSamePerson,
  resolveFieldFeedbackVisibility,
  resolveMonthAuthor,
  seesEveryMarketingSheet,
  type FieldFeedbackVisibility,
} from "./scope";
import { buildRepTracks, buildTeamGaps, type RepTrack, type TeamGap } from "./tracking";
import {
  MarketingFunctionsError,
  type FieldActivityLine,
  type FieldFeedback,
  type MarketingFunctionItem,
  type MarketingFunctionMonth,
  type MarketingMonthSheet,
  type RepOption,
  type RideAlongDay,
} from "./types";
import {
  isCallRating,
  isCallRemarkKey,
  isFieldActionOwner,
  isMarketingFunctionCategoryKey,
  isMarketingFunctionStatus,
  type CallRating,
  type CallRemarkKey,
  type MarketingMonthStatus,
} from "./vocabulary";

export const MONTHS_TABLE = "marketing_function_months";
export const ITEMS_TABLE = "marketing_function_items";
export const FEEDBACK_TABLE = "marketing_field_feedback";

const MONTH_COLUMNS =
  "id, author_hr_id, month, status, submitted_at, submitted_by_hr_id, reviewed_at, reviewed_by_hr_id, review_note, updated_at";
const ITEM_COLUMNS =
  "id, month_id, category_key, product, description, due_date, origin, status_mid, note_mid, status_end, note_end, sort";
const FEEDBACK_COLUMNS =
  "id, author_hr_id, visit_type, rep_hr_id, rep_job_title, rep_area, rep_line, visit_date, am_clinics, pm_clinics, pharmacies, objectives, ratings, comments, doctors_comments, recommendations, action_owners, from_crm_day, signed_at, signed_by_hr_id, updated_at";

type DbError = { code?: string | null; message?: string | null } | null | undefined;

type MonthRow = {
  id: string;
  author_hr_id: string;
  month: string;
  status: MarketingMonthStatus;
  submitted_at: string | null;
  submitted_by_hr_id: string | null;
  reviewed_at: string | null;
  reviewed_by_hr_id: string | null;
  review_note: string | null;
};

type ItemRow = {
  id: string;
  month_id: string;
  category_key: string;
  product: string | null;
  description: string;
  due_date: string | null;
  origin: string;
  status_mid: string | null;
  note_mid: string | null;
  status_end: string | null;
  note_end: string | null;
  sort: number;
};

type FeedbackRow = {
  id: string;
  author_hr_id: string;
  visit_type: string;
  rep_hr_id: string;
  rep_job_title: string | null;
  rep_area: string | null;
  rep_line: string | null;
  visit_date: string;
  am_clinics: number | null;
  pm_clinics: number | null;
  pharmacies: number | null;
  objectives: string | null;
  ratings: Record<string, unknown> | null;
  comments: string | null;
  doctors_comments: string | null;
  recommendations: string | null;
  action_owners: string[] | null;
  from_crm_day: boolean;
  signed_at: string | null;
  signed_by_hr_id: string | null;
  updated_at: string;
};

/** A deploy can reach production before its migration; that is said plainly, never as an empty sheet. */
export function isMissingTable(error: DbError): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  if (code === "PGRST205" || code === "42P01") return true;
  const message = String(error.message ?? "");
  return /marketing_(function|field)/i.test(message) && /does not exist|schema cache/i.test(message);
}

function storeError(error: DbError, doing: string): Error {
  if (isMissingTable(error)) {
    return new MarketingFunctionsError("Marketing Functions is not set up in this database yet.", 503);
  }
  return new Error(`Could not ${doing}: ${error?.message ?? "unknown error"}`);
}

function actorOf(access: AccessContext): string {
  const actor = hrIdForStorage(access.hrId) ?? access.loginId ?? null;
  if (!actor) throw new MarketingFunctionsError("Sign in again to save.", 401);
  return actor;
}

/** Every stored HR id is upper-case; a read matches both spellings an older row might carry. */
function hrIdSpellings(hrId: string): string[] {
  const stored = hrIdForStorage(hrId) ?? hrId;
  return [...new Set([stored, stored.toLowerCase(), hrId])];
}

// ─── Monthly Marketing Functions ─────────────────────────────────────────────

function toMonth(row: MonthRow, reviewerName: string | null): MarketingFunctionMonth {
  return {
    id: row.id,
    authorHrId: row.author_hr_id,
    monthKey: monthKeyOf(row.month),
    status: row.status,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    reviewedByHrId: row.reviewed_by_hr_id,
    reviewedByName: reviewerName,
    reviewNote: row.review_note,
  };
}

function toItem(row: ItemRow): MarketingFunctionItem | null {
  if (!isMarketingFunctionCategoryKey(row.category_key)) return null;
  return {
    id: row.id,
    categoryKey: row.category_key,
    product: row.product,
    description: row.description,
    dueDate: row.due_date,
    origin: row.origin === "actual" ? "actual" : "planned",
    statusMid: isMarketingFunctionStatus(row.status_mid) ? row.status_mid : null,
    noteMid: row.note_mid,
    statusEnd: isMarketingFunctionStatus(row.status_end) ? row.status_end : null,
    noteEnd: row.note_end,
  };
}

async function findMonthRow(authorHrId: string, monthKey: string): Promise<MonthRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(MONTHS_TABLE)
    .select(MONTH_COLUMNS)
    .in("author_hr_id", hrIdSpellings(authorHrId))
    .eq("month", monthStartDate(monthKey))
    .maybeSingle();
  if (error) throw storeError(error, "read the month");
  return (data ?? null) as MonthRow | null;
}

async function readItems(monthId: string): Promise<MarketingFunctionItem[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(ITEMS_TABLE)
    .select(ITEM_COLUMNS)
    .eq("month_id", monthId)
    .order("sort", { ascending: true });
  if (error) throw storeError(error, "read the month's items");
  return ((data ?? []) as ItemRow[]).map(toItem).filter((item): item is MarketingFunctionItem => item !== null);
}

/** His signed field-visit forms of the month, shown under Field Activity. */
async function readFieldActivity(authorHrId: string, monthKey: string): Promise<FieldActivityLine[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(FEEDBACK_TABLE)
    .select("id, rep_hr_id, visit_date, visit_type, signed_at")
    .in("author_hr_id", hrIdSpellings(authorHrId))
    .gte("visit_date", monthStartDate(monthKey))
    .lte("visit_date", monthEndDate(monthKey))
    .not("signed_at", "is", null)
    .order("visit_date", { ascending: true });
  if (error) throw storeError(error, "read the month's field visits");
  const rows = (data ?? []) as Array<{ id: string; rep_hr_id: string; visit_date: string; visit_type: string }>;
  const names = await namesByHrId(rows.map((row) => row.rep_hr_id));
  return rows.map((row) => ({
    id: row.id,
    visitDate: row.visit_date,
    repName: names.get(row.rep_hr_id) ?? row.rep_hr_id,
    visitType: row.visit_type === "single" ? "single" : "double",
  }));
}

/** The Product Managers a reviewer can pick: everyone active on that title, plus anyone with a sheet. */
export async function listMarketingAuthors(access: AccessContext): Promise<RepOption[]> {
  if (!seesEveryMarketingSheet(access)) return [];
  const directory = await getEmployeeDirectoryRows({ includeInactive: true });
  const { data } = await getSupabaseAdmin().from(MONTHS_TABLE).select("author_hr_id").limit(1000);
  const withSheet = new Set(((data ?? []) as Array<{ author_hr_id: string }>).map((row) => canonicalHrIdKey(row.author_hr_id)));
  return directory
    .filter(
      (employee) =>
        withSheet.has(canonicalHrIdKey(employee.hrId)) ||
        (employee.jobTitle === "Product Manager" && isActiveLifecycleStatus(employee.employmentStatus)),
    )
    .map((employee) => ({
      hrId: employee.hrId,
      name: employee.displayName,
      jobTitle: employee.jobTitle,
      area: employee.areaName,
      line: employee.lineName,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The sheet a viewer opens. A Product Manager always gets his own. A reader names an author; with no
 * author named, the first Product Manager is chosen by the page, so this returns null for "pick one".
 */
export async function loadMonthSheet(
  access: AccessContext,
  input: { authorHrId?: string | null; monthKey: string },
): Promise<MarketingMonthSheet | null> {
  const authorHrId = resolveMonthAuthor(access, input.authorHrId);
  if (!authorHrId) return null;

  const row = await findMonthRow(authorHrId, input.monthKey);
  const [items, fieldActivity, names] = await Promise.all([
    row ? readItems(row.id) : Promise.resolve([]),
    readFieldActivity(authorHrId, input.monthKey),
    namesByHrId([authorHrId, row?.reviewed_by_hr_id ?? null]),
  ]);
  const status = row?.status ?? null;
  const subject = { authorHrId, status };
  const nextMonthStart = monthStartDate(shiftMonthKey(input.monthKey, 1));

  return {
    monthKey: input.monthKey,
    authorHrId,
    authorName: names.get(authorHrId) ?? authorHrId,
    month: row ? toMonth(row, names.get(row.reviewed_by_hr_id) ?? null) : null,
    items,
    fieldActivity,
    canEdit: canEditMonth(access, subject),
    canSubmit: canSubmitMonth(access, { ...subject, itemCount: items.length }),
    canReview: canStampMonth(access, subject),
    canReopen: canReopenMonth(access, subject),
    canCarryForward:
      isMarketingFunctionsAuthor(access) &&
      isSamePerson(access.hrId, authorHrId) &&
      carryForwardItems(items, nextMonthStart).length > 0,
  };
}

async function ensureOwnDraftMonth(access: AccessContext, monthKey: string): Promise<MonthRow> {
  if (!isMarketingFunctionsAuthor(access)) {
    throw new MarketingFunctionsError("Only a Product Manager fills the Monthly Marketing Functions sheet.", 403);
  }
  const author = actorOf(access);
  const existing = await findMonthRow(author, monthKey);
  if (existing) {
    if (!canEditMonth(access, { authorHrId: existing.author_hr_id, status: existing.status })) {
      throw new MarketingFunctionsError(
        existing.status === "reviewed"
          ? "This month has been reviewed and is locked. Ask for it to be reopened to change it."
          : "This month has been submitted for review. Ask for it to be reopened to change it.",
        409,
      );
    }
    return existing;
  }
  const { data, error } = await getSupabaseAdmin()
    .from(MONTHS_TABLE)
    .insert({ author_hr_id: author, month: monthStartDate(monthKey), status: "draft" })
    .select(MONTH_COLUMNS)
    .single();
  if (error) throw storeError(error, "start the month");
  return data as MonthRow;
}

async function replaceItems(monthId: string, items: readonly MarketingFunctionItem[]): Promise<void> {
  const db = getSupabaseAdmin();
  const { error: deleteError } = await db.from(ITEMS_TABLE).delete().eq("month_id", monthId);
  if (deleteError) throw storeError(deleteError, "save the month");
  if (items.length === 0) return;
  const rows = items.map((item, index) => ({
    month_id: monthId,
    category_key: item.categoryKey,
    product: item.product,
    description: item.description,
    due_date: item.dueDate,
    origin: item.origin,
    status_mid: item.statusMid,
    note_mid: item.noteMid,
    status_end: item.statusEnd,
    note_end: item.noteEnd,
    sort: index,
  }));
  const { error } = await db.from(ITEMS_TABLE).insert(rows);
  if (error) throw storeError(error, "save the month");
}

async function touchMonth(monthId: string, patch: Record<string, unknown> = {}): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from(MONTHS_TABLE)
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", monthId);
  if (error) throw storeError(error, "save the month");
}

/** Saves the whole sheet of one month: the items as they stand on his screen, in their order. */
export async function saveMonthItems(access: AccessContext, input: { monthKey: string; items: unknown }): Promise<void> {
  await assertTestAccountWriteIsDryRun(access);
  const items = normalizeItems(input.items);
  const month = await ensureOwnDraftMonth(access, input.monthKey);
  await replaceItems(month.id, items);
  await touchMonth(month.id);
}

export async function submitMonth(access: AccessContext, monthKey: string): Promise<MonthRow> {
  await assertTestAccountWriteIsDryRun(access);
  const month = await ensureOwnDraftMonth(access, monthKey);
  const items = await readItems(month.id);
  if (!canSubmitMonth(access, { authorHrId: month.author_hr_id, status: month.status, itemCount: items.length })) {
    throw new MarketingFunctionsError("Add at least one item before you submit the month.", 409);
  }
  const now = new Date().toISOString();
  await touchMonth(month.id, { status: "submitted", submitted_at: now, submitted_by_hr_id: actorOf(access) });
  return { ...month, status: "submitted", submitted_at: now };
}

async function getMonthById(monthId: string): Promise<MonthRow | null> {
  const { data, error } = await getSupabaseAdmin().from(MONTHS_TABLE).select(MONTH_COLUMNS).eq("id", monthId).maybeSingle();
  if (error) throw storeError(error, "read the month");
  return (data ?? null) as MonthRow | null;
}

/** The reviewer's two moves: stamp a submitted month Reviewed (it locks), or reopen it for its author. */
export async function reviewMonth(
  access: AccessContext,
  input: { monthId: string; decision: "review" | "reopen"; note: string | null },
): Promise<MonthRow> {
  await assertTestAccountWriteIsDryRun(access);
  const month = await getMonthById(input.monthId);
  if (!month) throw new MarketingFunctionsError("That month does not exist.", 404);
  const subject = { authorHrId: month.author_hr_id, status: month.status };
  const note = input.note?.trim().slice(0, 2000) || null;

  if (input.decision === "review") {
    if (!canStampMonth(access, subject)) {
      throw new MarketingFunctionsError("Only a submitted month can be marked Reviewed.", 409);
    }
    const now = new Date().toISOString();
    await touchMonth(month.id, { status: "reviewed", reviewed_at: now, reviewed_by_hr_id: actorOf(access), review_note: note });
    return { ...month, status: "reviewed", reviewed_at: now, review_note: note };
  }

  if (!canReopenMonth(access, subject)) {
    throw new MarketingFunctionsError("This month is already open for its Product Manager.", 409);
  }
  await touchMonth(month.id, {
    status: "draft",
    submitted_at: null,
    submitted_by_hr_id: null,
    reviewed_at: null,
    reviewed_by_hr_id: null,
    review_note: note,
  });
  return { ...month, status: "draft", review_note: note };
}

/** Copies every unfinished item of this month into next month's draft, after anything already there. */
export async function carryForwardMonth(access: AccessContext, monthKey: string): Promise<{ copied: number; nextMonthKey: string }> {
  await assertTestAccountWriteIsDryRun(access);
  if (!isMarketingFunctionsAuthor(access)) {
    throw new MarketingFunctionsError("Only a Product Manager carries their own items forward.", 403);
  }
  const current = await findMonthRow(actorOf(access), monthKey);
  if (!current) throw new MarketingFunctionsError("This month has no items yet.", 404);
  const nextMonthKey = shiftMonthKey(monthKey, 1);
  const carried = carryForwardItems(await readItems(current.id), monthStartDate(nextMonthKey));
  if (carried.length === 0) return { copied: 0, nextMonthKey };

  const next = await ensureOwnDraftMonth(access, nextMonthKey);
  const existing = await readItems(next.id);
  const already = new Set(existing.map((item) => `${item.categoryKey}|${item.description.toLowerCase()}`));
  const fresh = carried.filter((item) => !already.has(`${item.categoryKey}|${item.description.toLowerCase()}`));
  await replaceItems(next.id, [...existing, ...fresh]);
  await touchMonth(next.id);
  return { copied: fresh.length, nextMonthKey };
}

// ─── Marketing Field Visit Feedback ──────────────────────────────────────────

function parseRatings(raw: Record<string, unknown> | null): Partial<Record<CallRemarkKey, CallRating>> {
  const ratings: Partial<Record<CallRemarkKey, CallRating>> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (isCallRemarkKey(key) && isCallRating(value)) ratings[key] = value;
  }
  return ratings;
}

function toFeedback(row: FeedbackRow, names: { get(hrId: string | null | undefined): string | null }): FieldFeedback {
  return {
    id: row.id,
    authorHrId: row.author_hr_id,
    authorName: names.get(row.author_hr_id) ?? row.author_hr_id,
    visitType: row.visit_type === "single" ? "single" : "double",
    repHrId: row.rep_hr_id,
    repName: names.get(row.rep_hr_id) ?? row.rep_hr_id,
    repJobTitle: row.rep_job_title,
    repArea: row.rep_area,
    repLine: row.rep_line,
    visitDate: row.visit_date,
    amClinics: row.am_clinics,
    pmClinics: row.pm_clinics,
    pharmacies: row.pharmacies,
    objectives: row.objectives,
    ratings: parseRatings(row.ratings),
    comments: row.comments,
    doctorsComments: row.doctors_comments,
    recommendations: row.recommendations,
    actionOwners: (row.action_owners ?? []).filter(isFieldActionOwner),
    fromCrmDay: row.from_crm_day,
    signedAt: row.signed_at,
    signedByName: row.signed_by_hr_id ? names.get(row.signed_by_hr_id) ?? row.signed_by_hr_id : null,
    updatedAt: row.updated_at,
  };
}

/** The National Sales Manager's own reps: the same downward scope his Double Visit board reads. */
async function lineRepKeysFor(access: AccessContext): Promise<Set<string>> {
  const directory = await getEmployeeDirectoryRows({ includeInactive: true });
  const scope = resolveDoubleVisitAccessScope(access, directory);
  if (scope.all) return new Set(directory.map((employee) => canonicalHrIdKey(employee.hrId)).filter((key): key is string => Boolean(key)));
  const keys = new Set<string>();
  for (const employee of directory) {
    const accessKey = normalizeHrIdForAccess(employee.hrId);
    const canonical = canonicalHrIdKey(employee.hrId);
    if (accessKey && canonical && scope.allowedHrIds.has(accessKey)) keys.add(canonical);
  }
  return keys;
}

export async function fieldFeedbackVisibility(access: AccessContext): Promise<FieldFeedbackVisibility> {
  const needsLine = access.role === "National Sales Manager";
  return resolveFieldFeedbackVisibility(access, needsLine ? await lineRepKeysFor(access) : null);
}

export async function listFieldFeedback(access: AccessContext, input: { limit?: number } = {}): Promise<FieldFeedback[]> {
  const visibility = await fieldFeedbackVisibility(access);
  if (visibility.kind === "none") return [];
  let query = getSupabaseAdmin().from(FEEDBACK_TABLE).select(FEEDBACK_COLUMNS);
  if (visibility.kind === "author") query = query.in("author_hr_id", hrIdSpellings(visibility.hrId));
  else query = query.not("signed_at", "is", null);
  const { data, error } = await query
    .order("visit_date", { ascending: false })
    .limit(Math.min(Math.max(input.limit ?? 1000, 1), 2000));
  if (error) throw storeError(error, "read the field visit feedback");
  const rows = ((data ?? []) as FeedbackRow[]).filter((row) =>
    canViewFieldFeedback(visibility, { authorHrId: row.author_hr_id, repHrId: row.rep_hr_id, signedAt: row.signed_at }),
  );
  const names = await namesByHrId(rows.flatMap((row) => [row.author_hr_id, row.rep_hr_id, row.signed_by_hr_id]));
  return rows.map((row) => toFeedback(row, names));
}

export async function getFieldFeedback(access: AccessContext, id: string): Promise<FieldFeedback | null> {
  const { data, error } = await getSupabaseAdmin().from(FEEDBACK_TABLE).select(FEEDBACK_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw storeError(error, "read the form");
  const row = (data ?? null) as FeedbackRow | null;
  if (!row) return null;
  const visibility = await fieldFeedbackVisibility(access);
  if (!canViewFieldFeedback(visibility, { authorHrId: row.author_hr_id, repHrId: row.rep_hr_id, signedAt: row.signed_at })) {
    return null;
  }
  const names = await namesByHrId([row.author_hr_id, row.rep_hr_id, row.signed_by_hr_id]);
  return toFeedback(row, names);
}

function repOption(employee: EmployeeDirectoryRow): RepOption {
  return {
    hrId: employee.hrId,
    name: employee.displayName,
    jobTitle: employee.jobTitle,
    area: employee.areaName,
    line: employee.lineName,
  };
}

/** Her form accompanies a Medical Representative; a district manager can be the one visited too. */
const ACCOMPANIED_TITLES = new Set([
  "Medical Representative",
  "Senior Medical Representative",
  "District Sales Manager",
  "Senior District Manager",
]);

/** The people a Product Manager can name as the accompanied person: the active field force. */
export async function listAccompaniedPeople(access: AccessContext): Promise<RepOption[]> {
  if (!isMarketingFunctionsAuthor(access)) return [];
  const directory = await getEmployeeDirectoryRows();
  return directory
    .filter((employee) => isActiveLifecycleStatus(employee.employmentStatus) && !isSamePerson(employee.hrId, access.hrId))
    .filter((employee) => ACCOMPANIED_TITLES.has(employee.jobTitle ?? ""))
    .map(repOption)
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** His logged Phoenix CRM days with a rep, newest first: the start of a form. */
export async function listRideAlongDays(access: AccessContext, input: { days?: number } = {}): Promise<RideAlongDay[]> {
  if (!isMarketingFunctionsAuthor(access)) return [];
  const me = hrIdForStorage(access.hrId)!;
  const today = todayInCairo();
  const from = new Date(`${today}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - Math.min(Math.max(input.days ?? 60, 1), 180));

  const { data, error } = await getSupabaseAdmin()
    .from("crm_visits_unified")
    .select("visit_date, agent_hr_id, ampm, speciality, comment, visit_type, visit_type_description, source, crm_visit_id")
    .overlaps("companion_hr_ids", hrIdSpellings(me))
    .gte("visit_date", from.toISOString().slice(0, 10))
    .lte("visit_date", today)
    .order("visit_date", { ascending: false })
    .limit(2000);
  if (error) throw new Error(`Could not read your field days: ${error.message}`);

  type VisitRow = {
    visit_date: string;
    agent_hr_id: string | null;
    ampm: string | null;
    speciality: string | null;
    comment: string | null;
    visit_type: number | null;
    visit_type_description: string | null;
    source: string | null;
    crm_visit_id: number | null;
  };
  const byDay = new Map<string, { visitDate: string; repHrId: string; am: number; pm: number; pharmacies: number }>();
  for (const row of (data ?? []) as VisitRow[]) {
    const repHrId = hrIdForStorage(row.agent_hr_id);
    if (!repHrId) continue;
    const key = `${row.visit_date}|${repHrId}`;
    const day = byDay.get(key) ?? { visitDate: row.visit_date, repHrId, am: 0, pm: 0, pharmacies: 0 };
    const bucket = visitCountBucket(row);
    if (bucket === "AM") day.am += 1;
    else if (bucket === "PM") day.pm += 1;
    else day.pharmacies += 1;
    byDay.set(key, day);
  }

  const directory = await getEmployeeDirectoryRows({ includeInactive: true });
  const byKey = new Map(directory.map((employee) => [canonicalHrIdKey(employee.hrId), employee]));
  const filed = await getSupabaseAdmin()
    .from(FEEDBACK_TABLE)
    .select("rep_hr_id, visit_date")
    .in("author_hr_id", hrIdSpellings(me))
    .gte("visit_date", from.toISOString().slice(0, 10));
  const filedKeys = new Set(
    ((filed.data ?? []) as Array<{ rep_hr_id: string; visit_date: string }>).map(
      (row) => `${row.visit_date}|${canonicalHrIdKey(row.rep_hr_id)}`,
    ),
  );

  return [...byDay.values()].map((day) => {
    const employee = byKey.get(canonicalHrIdKey(day.repHrId));
    return {
      visitDate: day.visitDate,
      repHrId: day.repHrId,
      repName: employee?.displayName ?? day.repHrId,
      repJobTitle: employee?.jobTitle ?? null,
      repArea: employee?.areaName ?? null,
      repLine: employee?.lineName ?? null,
      // He went WITH the rep, which her form calls a Double visit; Single is a visit he made alone.
      visitType: "double" as const,
      amClinics: day.am,
      pmClinics: day.pm,
      pharmacies: day.pharmacies,
      alreadyFiled: filedKeys.has(`${day.visitDate}|${canonicalHrIdKey(day.repHrId)}`),
    };
  });
}

/** Saves a form, and signs it when asked. A signed form is locked. */
export async function saveFieldFeedback(
  access: AccessContext,
  input: { form: unknown; sign: boolean },
): Promise<{ id: string; signed: boolean }> {
  await assertTestAccountWriteIsDryRun(access);
  if (!isMarketingFunctionsAuthor(access)) {
    throw new MarketingFunctionsError("Only a Product Manager fills the Marketing Field Visit Feedback.", 403);
  }
  let form;
  try {
    form = normalizeFieldFeedbackInput(input.form);
  } catch (error) {
    throw new MarketingFunctionsError((error as Error).message, 400);
  }
  if (input.sign) {
    const missing = missingForSignature(form);
    if (missing.length > 0) throw new MarketingFunctionsError(missing.join(" "), 400);
  }
  if (form.visitDate > todayInCairo()) {
    throw new MarketingFunctionsError("The date of the visit cannot be in the future.", 400);
  }

  const author = actorOf(access);
  const db = getSupabaseAdmin();
  if (form.id) {
    const { data, error } = await db.from(FEEDBACK_TABLE).select("id, author_hr_id, signed_at").eq("id", form.id).maybeSingle();
    if (error) throw storeError(error, "read the form");
    const existing = data as { id: string; author_hr_id: string; signed_at: string | null } | null;
    if (!existing) throw new MarketingFunctionsError("That form does not exist.", 404);
    if (!canEditFieldFeedback(access, { authorHrId: existing.author_hr_id, signedAt: existing.signed_at })) {
      throw new MarketingFunctionsError("This form is signed and locked.", 409);
    }
  }

  const directory = await getEmployeeDirectoryRows({ includeInactive: true });
  const rep = directory.find((employee) => isSamePerson(employee.hrId, form.repHrId));
  if (!rep) throw new MarketingFunctionsError("The accompanied person is not on the employee list.", 400);

  const now = new Date().toISOString();
  const row = {
    author_hr_id: author,
    visit_type: form.visitType,
    rep_hr_id: hrIdForStorage(rep.hrId),
    rep_job_title: rep.jobTitle,
    rep_area: rep.areaName,
    rep_line: rep.lineName,
    visit_date: form.visitDate,
    am_clinics: form.amClinics,
    pm_clinics: form.pmClinics,
    pharmacies: form.pharmacies,
    objectives: form.objectives,
    ratings: form.ratings,
    comments: form.comments,
    doctors_comments: form.doctorsComments,
    recommendations: form.recommendations,
    action_owners: form.actionOwners,
    from_crm_day: form.fromCrmDay,
    signed_at: input.sign ? now : null,
    signed_by_hr_id: input.sign ? author : null,
    updated_at: now,
  };

  if (form.id) {
    const { error } = await db.from(FEEDBACK_TABLE).update(row).eq("id", form.id).is("signed_at", null);
    if (error) throw storeError(error, "save the form");
    return { id: form.id, signed: input.sign };
  }
  const { data, error } = await db.from(FEEDBACK_TABLE).insert(row).select("id").single();
  if (error) throw storeError(error, "save the form");
  return { id: (data as { id: string }).id, signed: input.sign };
}

/** The board's two views from one read: the forms this viewer may see, and the rep tracking built from
 * the signed ones. The portal and the admin page both call this, so the two can never disagree. */
export async function loadFieldFeedbackBoard(
  access: AccessContext,
): Promise<{ forms: FieldFeedback[]; tracks: RepTrack[]; teamGaps: TeamGap[] }> {
  const forms = await listFieldFeedback(access);
  const tracks = buildRepTracks(
    forms.map((form) => ({
      id: form.id,
      ratings: form.ratings,
      repArea: form.repArea,
      repHrId: form.repHrId,
      repName: form.repName,
      signedAt: form.signedAt,
      visitDate: form.visitDate,
    })),
  );
  return { forms, teamGaps: buildTeamGaps(tracks), tracks };
}
