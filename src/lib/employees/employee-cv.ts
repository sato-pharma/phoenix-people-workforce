/**
 * The employee's CV on the master record — storage, access, and the two ways it arrives.
 *
 * Owner instruction 2026-09-09: HR attaches a CV when a new employee is added, and the "an
 * employee was added" notice that goes to the SFE Manager carries a link he can download it from.
 *
 * ONE CURRENT CV PER EMPLOYEE, held in the private `employee-cvs` bucket and pointed at by
 * `employees.cv_path`. The shape mirrors ./employee-photo.ts, deliberately: a private bucket, a
 * path column, a batch read so a list surface answers for everyone on it in one query, and a
 * same-origin route that streams the bytes through the service-role client so no caller ever
 * names a storage object.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THERE IS A STAGING STEP, AND WHY IT IS NOT AVOIDABLE.
 *
 * The CV is chosen on the ADD-EMPLOYEE form, before the employee exists. There is nothing to
 * attach it to yet and no row to authorize against. The obvious alternative — save the employee,
 * then upload the CV to the new HR id — puts the upload AFTER the create route has already told
 * the SFE Manager, so the notice would say "no CV on file" about a person whose CV arrived a
 * second later. That is exactly the failure this feature exists to prevent, and it is silent.
 *
 * So the file is staged first (stageEmployeeCv), the create payload carries the draft id, and the
 * create route attaches it (attachStagedEmployeeCv) BEFORE the notice is composed. One order,
 * one notice, and the notice can be trusted.
 *
 * NOTHING HERE THROWS INTO THE EMPLOYEE SAVE. attachEmployeeCvOnCreate collects its failures and
 * returns them: the employee row is already written by the time it runs, and a CV that could fail
 * a save would mean a bad PDF stops HR hiring somebody.
 */

import crypto from "node:crypto";

import { canonicalHrIdKey } from "@/lib/hr-id";
import { normalizeHrId, type AccessContext, type PhoenixRole } from "@/lib/auth/permissions";
import {
  EMPLOYEE_CV_ACCEPT_ATTRIBUTE,
  EMPLOYEE_CV_TYPES_SENTENCE,
  MAX_EMPLOYEE_CV_BYTES,
  employeeCvHref,
  extensionForCvContentType,
  isAllowedCvContentType,
  type EmployeeCvSource,
} from "@/lib/employees/employee-cv-limits";
import { isUuid } from "@/lib/http/uuid";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const EMPLOYEE_CVS_BUCKET = "employee-cvs";

// Re-exported so a server caller reaches everything about CVs through this one module, while the
// values themselves live in the client-safe half — see the header of ./employee-cv-limits.ts.
export {
  EMPLOYEE_CV_ACCEPT_ATTRIBUTE,
  EMPLOYEE_CV_TYPES_SENTENCE,
  MAX_EMPLOYEE_CV_BYTES,
  employeeCvHref,
  isAllowedCvContentType,
  type EmployeeCvSource,
};

/** Where a staged file waits between being chosen on the form and the employee existing. */
const STAGING_PREFIX = "staging";

/** Entries read per call when walking the staging folder; Storage never returns more than this at once. */
const STAGING_LIST_PAGE = 1000;

export type EmployeeCvRecord = {
  contentType: string;
  fileName: string;
  sizeBytes: number | null;
  source: EmployeeCvSource;
  uploadedAt: string | null;
  uploadedByHrId: string | null;
};

function sourceOf(value: string | null | undefined): EmployeeCvSource {
  return value === "recruitment" ? "recruitment" : "upload";
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Who may read a CV, and who may change one.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The four seats the owner named on 2026-09-09 when asked who should be able to open the download
 * link: Super Admin, SFE Manager, HR Business Partner (`HR Advisory` is the permission key) and
 * HR Operations.
 *
 * SFE MANAGER IS THE WHOLE POINT AND IS ALSO THE ONE THAT NEEDED SAYING. He holds neither
 * `employees` nor `employee_documents` — gating this on either of those, which is what the
 * neighbouring document routes do, would have produced a link in his own notice that answers 403
 * for him and nobody else. It is the same pair as canUseAdminCrmWorkspace (Super Admin + SFE
 * Manager) widened by the two HR seats, so the link and the New Hire CRM Setup screen it sits
 * beside always agree about who may act.
 *
 * A NAMED SET RATHER THAN A PERMISSION RESOURCE, on the same reasoning as
 * companyVacationReportReaderRoles: reading one personal document and administering the employee
 * master are different privileges and must be able to diverge later without one dragging the
 * other along.
 */
// HR Advisory (the HR Business Partner) left when the owner retired the HR Business Partner seat on 2026-10-08.
//
// HR Administration (shown as HR Operations Specialist) joined on 2026-11-06, the owner's answer to
// her 403: her people_master function holds `employees:update`, so she was already attaching,
// replacing and removing CVs — including the directory's bulk upload — and could not open the file
// she had just filed, nor see on the details panel whether one was on file at all.
export const employeeCvReaderRoles = [
  "Super Admin",
  "SFE Manager",
  "HR Operations",
  "HR Administration",
] as const satisfies readonly PhoenixRole[];

const employeeCvReaderRoleSet = new Set<PhoenixRole>(employeeCvReaderRoles);

/**
 * READING ONLY. Attaching, replacing and removing a CV is an edit to the employee master record,
 * so it rides `employees:update` — Super Admin, HR Operations and HR Administration today — and the
 * routes assert it with assertPermission rather than through this predicate. So the SFE Manager can
 * read a CV and cannot change one, which is the same split the CRM setup screen already makes: he
 * records two CRM fields and nothing else.
 */
export function canDownloadEmployeeCv(access: Pick<AccessContext, "role" | "scope" | "source">): boolean {
  // An unauthenticated caller resolves to role "Employee" with source "guest" rather than to null
  // (AGENTS.md §2.1), so the guest check is the one that actually does the work here — a `role`
  // test alone would let an anonymous request through the day "Employee" joined this list.
  if (access.source === "guest") return false;
  if (access.scope === "system") return true;
  return employeeCvReaderRoleSet.has(access.role);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Reading what is on file
// ─────────────────────────────────────────────────────────────────────────────────────────────

type CvRow = {
  cv_content_type?: string | null;
  cv_file_name?: string | null;
  cv_path?: string | null;
  cv_size_bytes?: number | string | null;
  cv_source?: string | null;
  cv_uploaded_at?: string | null;
  cv_uploaded_by_hr_id?: string | null;
};

const CV_COLUMNS = "cv_path, cv_file_name, cv_content_type, cv_size_bytes, cv_source, cv_uploaded_at, cv_uploaded_by_hr_id";

function recordFromRow(row: CvRow | null | undefined): EmployeeCvRecord | null {
  if (!row?.cv_path) return null;
  const size = Number(row.cv_size_bytes ?? 0);
  return {
    contentType: row.cv_content_type || "application/octet-stream",
    fileName: row.cv_file_name || "cv.pdf",
    sizeBytes: Number.isFinite(size) && size > 0 ? size : null,
    source: sourceOf(row.cv_source),
    uploadedAt: row.cv_uploaded_at ?? null,
    uploadedByHrId: row.cv_uploaded_by_hr_id ?? null,
  };
}

async function loadCvRow(hrId: string): Promise<(CvRow & { hr_id?: string | null }) | null> {
  const key = normalizeHrId(hrId);
  if (!key) return null;
  const { data, error } = await getSupabaseAdmin()
    .from("employees")
    .select(`hr_id, ${CV_COLUMNS}`)
    // HR ids are MIXED CASE in this database, so a plain .eq under-returns (AGENTS.md §2.1).
    // `ilike` with no wildcard is an exact, case-insensitive match.
    .ilike("hr_id", key)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as (CvRow & { hr_id?: string | null }) | null) ?? null;
}

/** What is on file for one employee, or null when there is no CV. */
export async function getEmployeeCv(hrId: string | null | undefined): Promise<EmployeeCvRecord | null> {
  if (!hrId) return null;
  return recordFromRow(await loadCvRow(String(hrId)));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Who has one at all — the directory's index
// ─────────────────────────────────────────────────────────────────────────────────────────────

const CV_INDEX_TTL_MS = 60_000;

let cvIndexCache: { expiresAt: number; value: Set<string> } | null = null;
// Same in-flight dedupe as getEmployeePhotoMap: two directory loads arriving together share one
// query rather than each issuing their own.
let inFlightCvIndex: Promise<Set<string>> | null = null;

/**
 * Drop the cached index. Called from writeCvColumns — the ONE place any CV column is written — so
 * attaching, replacing, carrying across or removing a CV all show in the directory on the next
 * load rather than up to a minute later. A stale tick on the screen whose whole job is to say who
 * is MISSING a CV would send somebody chasing a document that is already on file.
 */
export function invalidateEmployeeCvIndex(): void {
  cvIndexCache = null;
}

/** The index, or null when it could not be read — a null is answered but never cached. */
async function fetchEmployeeCvIndex(): Promise<Set<string> | null> {
  const ids = new Set<string>();
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("employees")
      .select("hr_id")
      .not("cv_path", "is", null);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ hr_id: string | null }>) {
      const key = canonicalHrIdKey(row.hr_id);
      if (key) ids.add(key);
    }
  } catch {
    // Pre-migration or a transient failure. An empty set reads as "nobody has a CV", which is the
    // safe direction: the filter offers people who turn out to have one, rather than hiding people
    // who do not — the opposite would quietly shorten the list of who still needs chasing.
    // Null, so that empty answer is served to this load and never kept for the next minute.
    return null;
  }
  return ids;
}

/**
 * The canonical HR ids of everyone with a CV on file — one cached query for the whole company,
 * not another column on every directory row.
 *
 * Deliberately the same shape as getEmployeePhotoMap rather than widening the directory's own
 * SELECT: that query already reads ~90 columns per person, and `cv_path` is a storage path nothing
 * on that screen may show. This answers the only question a list asks — is there one — and the CV
 * panel still reads the file's own name for the one person somebody opens.
 *
 * HR IDS ARE MIXED CASE IN THIS DATABASE, so both sides go through canonicalHrIdKey. A raw
 * comparison silently under-matches, and here that reads as "this person has no CV".
 */
export async function getEmployeeCvHrIdSet(): Promise<Set<string>> {
  const now = Date.now();
  if (cvIndexCache && cvIndexCache.expiresAt > now) return cvIndexCache.value;

  if (!inFlightCvIndex) {
    inFlightCvIndex = fetchEmployeeCvIndex()
      .then((ids) => {
        if (!ids) return new Set<string>();
        cvIndexCache = { expiresAt: Date.now() + CV_INDEX_TTL_MS, value: ids };
        return ids;
      })
      .finally(() => {
        inFlightCvIndex = null;
      });
  }

  return inFlightCvIndex;
}

/**
 * The CV filename for each of several employees, keyed by canonical HR id — one query for the
 * whole set rather than one per person.
 *
 * Used by the new-hire notice and by the New Hire CRM Setup queue, both of which show what the CV
 * is CALLED rather than a tick: a reader decides whether to open it from the name, and the name is
 * also the only signal in the notice that the right document was attached.
 *
 * DEGRADES TO AN EMPTY MAP. Before this feature's migration reaches production the columns do not
 * exist, and a notice that failed for that would stop HR hiring anybody — the same posture the
 * whole account-setup module takes. An employee simply reads as having no CV.
 */
export async function getEmployeeCvFileNames(
  hrIds: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const wanted = hrIds
    .map((hrId) => String(hrId ?? "").trim())
    .filter((hrId) => hrId.length > 0);
  if (wanted.length === 0) return names;

  try {
    // `.in()` matches EXACTLY, and HR ids are mixed case in this database — so this is correct
    // only because every caller passes ids read out of the database itself (directory rows, or the
    // hr_id the upsert returned), never a hand-typed one. The result map is keyed canonically, so
    // the CASE-INSENSITIVE half of the problem is handled where lookups happen.
    //
    // Chunked at 50: a PostgREST `.in()` carrying several hundred ids returns ZERO rows and no
    // error (AGENTS.md §2.1). A new-hire batch is one or two people, so this never chunks in
    // practice — it is here so that the day an import announces two hundred, it still answers.
    for (let index = 0; index < wanted.length; index += 50) {
      const chunk = wanted.slice(index, index + 50);
      const { data, error } = await getSupabaseAdmin()
        .from("employees")
        .select("hr_id, cv_file_name")
        .in("hr_id", chunk)
        .not("cv_path", "is", null);
      if (error) throw error;
      for (const row of (data ?? []) as Array<{ cv_file_name: string | null; hr_id: string | null }>) {
        const key = canonicalHrIdKey(row.hr_id);
        const name = String(row.cv_file_name ?? "").trim();
        if (key && name) names.set(key, name);
      }
    }
  } catch {
    return new Map();
  }

  return names;
}

/** Streams the stored bytes back, or null when there is no CV (or the object has gone). */
export async function streamEmployeeCv(
  hrId: string,
): Promise<{ bytes: Buffer; contentType: string; fileName: string } | null> {
  const row = await loadCvRow(hrId);
  const record = recordFromRow(row);
  if (!row?.cv_path || !record) return null;

  const { data, error } = await getSupabaseAdmin().storage.from(EMPLOYEE_CVS_BUCKET).download(row.cv_path);
  if (error || !data) return null;

  return {
    bytes: Buffer.from(await data.arrayBuffer()),
    contentType: record.contentType,
    fileName: record.fileName,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Putting one on the record
// ─────────────────────────────────────────────────────────────────────────────────────────────

function sanitizeStorageName(name: string, contentType: string): string {
  const cleaned = String(name ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned && /\.[a-zA-Z0-9]{2,5}$/.test(cleaned)) return cleaned.slice(0, 120);
  return `${(cleaned || "cv").slice(0, 110)}.${extensionForCvContentType(contentType)}`;
}

/**
 * The name the download is saved as. Kept SEPARATE from the storage name above, which is
 * sanitized to ASCII: an Arabic CV filename survives here and would not survive there, and the
 * owner's no-truncation rule means the person's own name must reach them intact.
 */
function displayFileName(name: string, contentType: string): string {
  const trimmed = String(name ?? "").trim();
  if (trimmed && /\.[a-zA-Z0-9]{2,5}$/.test(trimmed)) return trimmed.slice(0, 180);
  return `${(trimmed || "CV").slice(0, 170)}.${extensionForCvContentType(contentType)}`;
}

export type EmployeeCvPayload = {
  bytes: Buffer;
  contentType: string;
  fileName: string;
};

/** Validates a chosen file, throwing the sentence the person should read. */
function assertValidCvPayload(payload: Pick<EmployeeCvPayload, "bytes" | "contentType">): void {
  if (!isAllowedCvContentType(payload.contentType)) {
    throw new Error(`Unsupported file type. A CV must be ${EMPLOYEE_CV_TYPES_SENTENCE}.`);
  }
  if (payload.bytes.length === 0) {
    throw new Error("The chosen file is empty.");
  }
  if (payload.bytes.length > MAX_EMPLOYEE_CV_BYTES) {
    throw new Error("That file is larger than 15 MB.");
  }
}

/** Reads and validates a multipart `file` field. */
export async function readCvPayload(request: Request): Promise<EmployeeCvPayload> {
  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new Error("A CV file is required.");
  }
  const payload: EmployeeCvPayload = {
    bytes: Buffer.from(await file.arrayBuffer()),
    // A browser leaves `type` empty for a file it cannot classify; naming it here produces the
    // "must be a PDF, Word document…" sentence rather than an empty-MIME storage complaint.
    contentType: (file.type || "").toLowerCase(),
    fileName: file.name || "CV",
  };
  assertValidCvPayload(payload);
  return payload;
}

async function putObject(path: string, payload: EmployeeCvPayload): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .storage.from(EMPLOYEE_CVS_BUCKET)
    .upload(path, payload.bytes, {
      cacheControl: "3600",
      contentType: payload.contentType,
      upsert: true,
    });
  if (error) throw new Error(`Unable to store the CV: ${error.message}`);
}

async function removeObjects(paths: Array<string | null | undefined>): Promise<void> {
  const wanted = paths.filter((path): path is string => Boolean(path));
  if (wanted.length === 0) return;
  await getSupabaseAdmin().storage.from(EMPLOYEE_CVS_BUCKET).remove(wanted).catch(() => {});
}

async function writeCvColumns(
  hrId: string,
  values: {
    contentType: string | null;
    fileName: string | null;
    path: string | null;
    sizeBytes: number | null;
    source: EmployeeCvSource | null;
    uploadedByHrId: string | null;
  },
): Promise<void> {
  const key = normalizeHrId(hrId);
  if (!key) throw new Error("An employee HR ID is required.");
  const { error } = await getSupabaseAdmin()
    .from("employees")
    .update({
      cv_content_type: values.contentType,
      cv_file_name: values.fileName,
      cv_path: values.path,
      cv_size_bytes: values.sizeBytes,
      cv_source: values.source,
      cv_uploaded_at: values.path ? new Date().toISOString() : null,
      cv_uploaded_by_hr_id: values.uploadedByHrId,
    })
    .ilike("hr_id", key);
  if (error) throw error;
  // Every CV change in the system passes through here — attach, replace, carry across, remove —
  // so this is the one place that can keep the directory's index honest. Invalidating after the
  // write rather than before it means a concurrent read cannot refill the cache from the old row.
  invalidateEmployeeCvIndex();
}

/**
 * Attach (or replace) an employee's CV.
 *
 * The previous object is removed AFTER the row points at the new one. The other order leaves a
 * window where the column names an object that no longer exists, and the download in that window
 * fails rather than serving the old CV — which is the wrong way round for a file somebody may be
 * reading at that moment.
 */
export async function setEmployeeCv(input: {
  actorHrId?: string | null;
  hrId: string;
  payload: EmployeeCvPayload;
  source?: EmployeeCvSource;
}): Promise<EmployeeCvRecord> {
  assertValidCvPayload(input.payload);
  const key = normalizeHrId(input.hrId);
  if (!key) throw new Error("An employee HR ID is required.");

  const existing = await loadCvRow(input.hrId);
  if (!existing) throw new Error(`Employee ${input.hrId} was not found.`);

  const path = `employee/${key}/${crypto.randomUUID()}/${sanitizeStorageName(input.payload.fileName, input.payload.contentType)}`;
  await putObject(path, input.payload);

  const fileName = displayFileName(input.payload.fileName, input.payload.contentType);
  try {
    await writeCvColumns(input.hrId, {
      contentType: input.payload.contentType,
      fileName,
      path,
      sizeBytes: input.payload.bytes.length,
      source: input.source ?? "upload",
      uploadedByHrId: input.actorHrId ?? null,
    });
  } catch (error) {
    // The row did not take the new path, so the object just written is unreachable. Remove it
    // rather than leaving a private bucket accumulating files nothing points at.
    await removeObjects([path]);
    throw error;
  }

  await removeObjects([existing.cv_path]);

  return {
    contentType: input.payload.contentType,
    fileName,
    sizeBytes: input.payload.bytes.length,
    source: input.source ?? "upload",
    uploadedAt: new Date().toISOString(),
    uploadedByHrId: input.actorHrId ?? null,
  };
}

/** Removes the CV from the record and deletes the stored file. */
export async function clearEmployeeCv(hrId: string): Promise<void> {
  const existing = await loadCvRow(hrId);
  await writeCvColumns(hrId, {
    contentType: null,
    fileName: null,
    path: null,
    sizeBytes: null,
    source: null,
    uploadedByHrId: null,
  });
  await removeObjects([existing?.cv_path]);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The staging step — a CV chosen before the employee exists
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type StagedEmployeeCv = { draftId: string; fileName: string; sizeBytes: number };

/**
 * Park a chosen CV until the employee it belongs to exists.
 *
 * The returned draft id is a UUID we generated and is the ONLY thing the client sends back. The
 * storage path is rebuilt from it server-side, so a caller can never name an object — the same
 * containment the download route uses in the other direction.
 */
export async function stageEmployeeCv(input: {
  actorHrId?: string | null;
  payload: EmployeeCvPayload;
}): Promise<StagedEmployeeCv> {
  assertValidCvPayload(input.payload);
  const draftId = crypto.randomUUID();
  const fileName = displayFileName(input.payload.fileName, input.payload.contentType);
  await putObject(stagingPathFor(draftId, input.payload.contentType), input.payload);
  return { draftId, fileName, sizeBytes: input.payload.bytes.length };
}

function stagingPathFor(draftId: string, contentType: string): string {
  return `${STAGING_PREFIX}/${draftId}.${extensionForCvContentType(contentType)}`;
}

/**
 * Find a staged object by draft id without being told its extension.
 *
 * The client sends back only the id, so the extension has to be recovered. Listing the staging
 * prefix and matching the id is one round trip and cannot be fooled by a crafted path, which
 * asking the caller for the filename would be.
 */
async function findStagedPath(draftId: string): Promise<{ contentType: string; path: string } | null> {
  // Draft ids are ours, not a caller's string — `isUuid` from @/lib/http/uuid rather than a regex
  // written here, so there is one answer to "is this a uuid" in the codebase.
  if (!isUuid(draftId)) return null;
  const { data, error } = await getSupabaseAdmin()
    .storage.from(EMPLOYEE_CVS_BUCKET)
    .list(STAGING_PREFIX, { limit: 100, search: draftId });
  if (error || !Array.isArray(data)) return null;
  const match = data.find((entry) => String(entry.name ?? "").startsWith(draftId));
  if (!match) return null;
  const contentType =
    (match.metadata as { mimetype?: string } | null | undefined)?.mimetype ?? "application/octet-stream";
  return { contentType, path: `${STAGING_PREFIX}/${match.name}` };
}

/**
 * Move a staged CV onto a real employee.
 *
 * `move`, not download-and-re-upload: the bytes never come back through this process, so a 15MB
 * scan costs nothing but a metadata call, and there is no window where two copies exist.
 */
export async function attachStagedEmployeeCv(input: {
  actorHrId?: string | null;
  draftId: string;
  fileName?: string | null;
  hrId: string;
}): Promise<EmployeeCvRecord | null> {
  const key = normalizeHrId(input.hrId);
  if (!key) throw new Error("An employee HR ID is required.");
  const staged = await findStagedPath(input.draftId);
  if (!staged) return null;

  const existing = await loadCvRow(input.hrId);
  if (!existing) throw new Error(`Employee ${input.hrId} was not found.`);

  const fileName = displayFileName(input.fileName ?? "CV", staged.contentType);
  const destination = `employee/${key}/${crypto.randomUUID()}/${sanitizeStorageName(fileName, staged.contentType)}`;

  const { error: moveError } = await getSupabaseAdmin()
    .storage.from(EMPLOYEE_CVS_BUCKET)
    .move(staged.path, destination);
  if (moveError) throw new Error(`Unable to file the CV: ${moveError.message}`);

  let sizeBytes: number | null = null;
  const { data: listed } = await getSupabaseAdmin()
    .storage.from(EMPLOYEE_CVS_BUCKET)
    .list(destination.split("/").slice(0, -1).join("/"), { limit: 1 });
  const size = Number((listed?.[0]?.metadata as { size?: number } | null | undefined)?.size ?? 0);
  if (Number.isFinite(size) && size > 0) sizeBytes = size;

  await writeCvColumns(input.hrId, {
    contentType: staged.contentType,
    fileName,
    path: destination,
    sizeBytes,
    source: "upload",
    uploadedByHrId: input.actorHrId ?? null,
  });
  await removeObjects([existing.cv_path]);

  return {
    contentType: staged.contentType,
    fileName,
    sizeBytes,
    source: "upload",
    uploadedAt: new Date().toISOString(),
    uploadedByHrId: input.actorHrId ?? null,
  };
}

/** Drops staged files older than a day, so an abandoned add-employee form leaves nothing behind. */
export async function purgeStaleStagedCvs(olderThanMs = 24 * 60 * 60 * 1000): Promise<number> {
  const cutoff = Date.now() - olderThanMs;
  const stale: string[] = [];
  // Storage answers at most one page per call, so the folder is walked by offset until a short page.
  for (let offset = 0; ; offset += STAGING_LIST_PAGE) {
    const { data, error } = await getSupabaseAdmin()
      .storage.from(EMPLOYEE_CVS_BUCKET)
      .list(STAGING_PREFIX, { limit: STAGING_LIST_PAGE, offset, sortBy: { column: "name", order: "asc" } });
    if (error || !Array.isArray(data)) return 0;
    for (const entry of data) {
      const at = Date.parse(String(entry.created_at ?? ""));
      if (Number.isFinite(at) && at < cutoff) stale.push(`${STAGING_PREFIX}/${entry.name}`);
    }
    if (data.length < STAGING_LIST_PAGE) break;
  }
  if (stale.length === 0) return 0;
  await removeObjects(stale);
  return stale.length;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The other way a CV arrives — carried over from the candidate record
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Copy the CV the candidate actually sent us onto the employee record they became.
 *
 * Candidate CVs live in the `recruitment-files` bucket with their path in `ats_files.drive_file_id`
 * (the column name is historical — Supabase Storage is the backend, Drive is the owner's mirror;
 * see recruitment/drive-cv-mirror.ts). Copying them means HR uploads nothing for anyone hired
 * through the pipeline, which is most people.
 *
 * A COPY, NOT A REFERENCE. The employee's CV must not stop existing because a candidate record
 * was merged, re-filed or deleted — `ats_files` cascades on candidate deletion, and the employee
 * outlives the application by years.
 *
 * Returns null rather than throwing when there is nothing to copy: an application with no CV on
 * it is ordinary (a walk-in, a referral), not an error in a hire.
 */
export async function copyCandidateCvToEmployee(input: {
  actorHrId?: string | null;
  applicationId?: string | null;
  candidateId?: string | null;
  hrId: string;
}): Promise<EmployeeCvRecord | null> {
  const supabase = getSupabaseAdmin();

  let candidateId = String(input.candidateId ?? "").trim() || null;
  const applicationId = String(input.applicationId ?? "").trim() || null;
  if (!candidateId && applicationId) {
    const { data } = await supabase
      .from("ats_applications")
      .select("candidate_id")
      .eq("id", applicationId)
      .limit(1)
      .maybeSingle();
    candidateId = (data as { candidate_id?: string | null } | null)?.candidate_id ?? null;
  }
  if (!candidateId) return null;

  // Newest CV first. A candidate who sends an updated CV gets a new `ats_files` row rather than an
  // edit to the old one (drive-cv-mirror.ts: one copy per distinct file), so "the latest" is the
  // one they most recently sent and the one recruitment screened last.
  const { data: fileRow } = await supabase
    .from("ats_files")
    .select("drive_file_id, file_name, mime_type")
    .eq("candidate_id", candidateId)
    .eq("kind", "cv")
    .not("drive_file_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const storagePath = (fileRow as { drive_file_id?: string | null } | null)?.drive_file_id ?? null;
  if (!storagePath) return null;

  const { data: blob, error } = await supabase.storage.from("recruitment-files").download(storagePath);
  if (error || !blob) return null;

  const bytes = Buffer.from(await blob.arrayBuffer());
  const declared = String((fileRow as { mime_type?: string | null }).mime_type ?? "").toLowerCase();
  // A recruitment CV predates this bucket's allow-list, so its recorded type can be something the
  // list does not carry (or nothing at all). Fall back to what the stored object reports, then to
  // PDF — refusing to carry a real CV across because a years-old row has an empty mime_type would
  // be the wrong answer.
  const contentType = isAllowedCvContentType(declared)
    ? declared
    : isAllowedCvContentType(blob.type)
      ? blob.type.toLowerCase()
      : "application/pdf";

  return setEmployeeCv({
    actorHrId: input.actorHrId ?? null,
    hrId: input.hrId,
    payload: {
      bytes,
      contentType,
      fileName: String((fileRow as { file_name?: string | null }).file_name ?? "").trim() || "CV",
    },
    source: "recruitment",
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The create path
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type EmployeeCvCreateResult = {
  attached: boolean;
  fileName: string | null;
  source: EmployeeCvSource | null;
  warnings: string[];
};

/**
 * Put a CV on a brand-new employee, from whichever of the two sources the create carried.
 *
 * CALLED BEFORE THE NEW-HIRE NOTICE IS COMPOSED, and that ordering is the point — see the header.
 *
 * A staged upload WINS over the recruitment copy when both are present: the staged file is what
 * the person at the keyboard just chose for this hire, and the candidate CV is what the system
 * already held. Choosing the other way would silently discard a deliberate act.
 *
 * SWALLOWS ITS OWN FAILURES. The employee row is already written when this runs.
 */
export async function attachEmployeeCvOnCreate(input: {
  actorHrId?: string | null;
  applicationId?: string | null;
  /** The candidate "Mark as hired" opened the form for — a hire with no application behind it. */
  candidateId?: string | null;
  cvDraftFileName?: string | null;
  cvDraftId?: string | null;
  hrId: string;
}): Promise<EmployeeCvCreateResult> {
  const warnings: string[] = [];
  const draftId = String(input.cvDraftId ?? "").trim();

  if (draftId) {
    try {
      const attached = await attachStagedEmployeeCv({
        actorHrId: input.actorHrId ?? null,
        draftId,
        fileName: input.cvDraftFileName ?? null,
        hrId: input.hrId,
      });
      if (attached) return { attached: true, fileName: attached.fileName, source: attached.source, warnings };
      warnings.push("The chosen CV could not be found when the employee was saved, so nothing was attached.");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(`The CV could not be attached: ${detail}`.slice(0, 200));
      logError("A new hire's CV could not be attached", {
        labels: { event: "employee_cv_attach_failed" },
        error: error instanceof Error ? error : new Error(detail),
      });
    }
  }

  // An application names its candidate; a hire from the recruitment workspace names the candidate
  // directly, because most people there never had an application row. Either finds the same file.
  if (input.applicationId || input.candidateId) {
    try {
      const copied = await copyCandidateCvToEmployee({
        actorHrId: input.actorHrId ?? null,
        applicationId: input.applicationId ?? null,
        candidateId: input.applicationId ? null : (input.candidateId ?? null),
        hrId: input.hrId,
      });
      if (copied) return { attached: true, fileName: copied.fileName, source: copied.source, warnings };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(`The candidate's CV could not be copied across: ${detail}`.slice(0, 200));
      logError("A new hire's candidate CV could not be copied to the employee record", {
        labels: { event: "employee_cv_recruitment_copy_failed" },
        error: error instanceof Error ? error : new Error(detail),
      });
    }
  }

  return { attached: false, fileName: null, source: null, warnings };
}
