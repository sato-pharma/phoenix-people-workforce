// Recruitment — reading and writing the job titles the Job Posts page builds from
// (public.ats_job_post_titles). Mirrors whatsapp-templates/store.ts: a table-shaped store that
// re-checks on the way in what the screen already checked, because a request is not the screen.
//
// SERVER ONLY — it reaches the database through the recruitment service-role client.

import { boolOrNull, recruitmentDb, textOrNull } from "@/lib/recruitment/db";
import {
  coerceHeadline,
  coerceLines,
  titleDraftViolations,
  type JobPostTitle,
  type JobPostTitleDraft,
} from "@/lib/recruitment/job-posts/titles";

const TABLE = "ats_job_post_titles";
const COLUMNS = "id,title,department,headline,reports_to,employment,location,duties,needs,menu_name,is_active,updated_at,title_ar,description_ar";

function mapTitle(row: Record<string, unknown>): JobPostTitle {
  return {
    department: textOrNull(row.department) ?? "Human Resources",
    descriptionAr: textOrNull(row.description_ar),
    duties: coerceLines(row.duties),
    employment: textOrNull(row.employment) ?? "Full-time",
    headline: coerceHeadline(row.headline),
    id: String(row.id),
    isActive: boolOrNull(row.is_active) ?? true,
    location: textOrNull(row.location) ?? "Sheraton, Cairo",
    menuName: textOrNull(row.menu_name),
    needs: coerceLines(row.needs),
    reportsTo: textOrNull(row.reports_to),
    title: String(row.title ?? ""),
    titleAr: textOrNull(row.title_ar),
    updatedAt: textOrNull(row.updated_at),
  };
}

function toRow(draft: JobPostTitleDraft) {
  return {
    department: draft.department,
    duties: draft.duties,
    employment: draft.employment,
    headline: draft.headline,
    is_active: draft.isActive,
    location: draft.location,
    menu_name: draft.menuName,
    needs: draft.needs,
    reports_to: draft.reportsTo,
    title: draft.title,
  };
}

function assertValid(draft: JobPostTitleDraft): void {
  const problems = titleDraftViolations(draft);
  // One sentence, not a list: this throw becomes the API's message and the screen shows one string.
  if (problems.length > 0) throw new Error(problems.join(" "));
}

/** A duplicate title reads as a sentence, not as a Postgres constraint name. */
function friendly(error: { code?: string; message: string }): Error {
  if (error.code === "23505") return new Error("A job title with that name already exists.");
  return new Error(error.message);
}

/** Every title, active first, then by name. */
export async function listJobPostTitles(options: { includeInactive?: boolean } = {}): Promise<JobPostTitle[]> {
  let query = recruitmentDb().from(TABLE).select(COLUMNS);
  if (!options.includeInactive) query = query.eq("is_active", true);
  const { data, error } = await query.order("is_active", { ascending: false }).order("title", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => mapTitle(row as Record<string, unknown>));
}

export async function getJobPostTitle(id: string): Promise<JobPostTitle | null> {
  const { data, error } = await recruitmentDb().from(TABLE).select(COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? mapTitle(data as Record<string, unknown>) : null;
}

export async function createJobPostTitle(draft: JobPostTitleDraft, actorHrId: string | null): Promise<JobPostTitle> {
  assertValid(draft);
  const { data, error } = await recruitmentDb()
    .from(TABLE)
    .insert({ ...toRow(draft), created_by_hr_id: actorHrId, updated_by_hr_id: actorHrId })
    .select(COLUMNS)
    .single();
  if (error) throw friendly(error);
  return mapTitle(data as Record<string, unknown>);
}

/** A whole-row save: the editor always sends the full title, so validation sees exactly what is stored. */
export async function updateJobPostTitle(id: string, draft: JobPostTitleDraft, actorHrId: string | null): Promise<JobPostTitle> {
  assertValid(draft);
  const existing = await getJobPostTitle(id);
  if (!existing) throw new Error("That job title was not found.");
  const { data, error } = await recruitmentDb()
    .from(TABLE)
    .update({ ...toRow(draft), updated_at: new Date().toISOString(), updated_by_hr_id: actorHrId })
    .eq("id", id)
    .select(COLUMNS)
    .single();
  if (error) throw friendly(error);
  return mapTitle(data as Record<string, unknown>);
}

/** The Arabic typed in the Publish dialog, kept on the title. Its own write: a title save never touches it. */
export async function saveJobPostTitleArabic(id: string, arabic: { descriptionAr: string; titleAr: string }, actorHrId: string | null): Promise<void> {
  const { error } = await recruitmentDb()
    .from(TABLE)
    .update({ description_ar: arabic.descriptionAr, title_ar: arabic.titleAr, updated_at: new Date().toISOString(), updated_by_hr_id: actorHrId })
    .eq("id", id);
  if (error) throw friendly(error);
}
