// Reading and writing company templates. The rules live in `custom-templates.ts`; this is the half
// that talks to the database and to storage.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE TABLES MAY NOT EXIST YET, AND EVERY READ HERE HAS TO SURVIVE THAT — the same shape as
// `field-layout-store.ts`, and for the same reason. These tables arrive in a migration, and applying
// a migration to production is a protected action only the owner approves. So there is a window in
// which this code is deployed and the tables are not there, and an HR Forms screen that 500s because
// nobody has run a migration yet would take out printing for everybody over a feature nobody is
// using. A missing table answers `PGRST205`, not `42P01` — PostgREST resolves through its schema
// cache and reports a cache miss — so both codes are treated as one set.
//
// The degraded answer is an empty list, which is exactly right: no company templates means the
// screen shows the ten built-in documents, which is what it showed before this existed.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// AN UPLOAD IS NOT ATOMIC AND CANNOT BE MADE SO, so it is made RECOVERABLE instead. Storage and
// Postgres are two systems; there is no transaction across them. The order here is row, then
// objects, then page rows, and every failure path removes what it created — because the state this
// avoids is a template that lists with no artwork, which prints a page of blank boxes over nothing
// and looks like a rendering bug rather than a failed upload.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";

import {
  isCustomTemplateGroup,
  isCustomTemplatePrintSides,
  type CustomTemplateGroup,
  type CustomTemplatePrintSides,
  buildCustomTemplatePagePath,
  CUSTOM_TEMPLATE_BUCKET,
  CUSTOM_TEMPLATE_MAX_COPIES,
  type CustomTemplateContentType,
  type CustomTemplateDraft,
} from "@/lib/hiring-pack/custom-templates";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { customDocumentFor, isUuid, type CustomHiringPackDocument } from "@/lib/hiring-pack/types";

const TEMPLATES_TABLE = "hiring_pack_custom_templates";
const PAGES_TABLE = "hiring_pack_custom_template_pages";

/** The two ways these tables can be absent, as one question. See the header. */
export function isCustomTemplateLayerMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  // 42703 IS A MISSING COLUMN, and it belongs in this set for the same reason 42P01 does: the
  // deploy reaches production before the migration is applied, so for that window the code asks for
  // columns the table does not have yet. Without it the whole HR Forms page 500s during a window
  // that is supposed to degrade to "no company templates". It does hide a mistyped column name in
  // development — but a mistyped column name shows up as an empty list on the very first run, while
  // the window this covers shows up as a broken page for everybody.
  if (code === "PGRST205" || code === "PGRST204" || code === "42P01" || code === "42703") {
    return true;
  }
  const message = (
    "message" in error ? String((error as { message?: unknown }).message ?? "") : ""
  ).toLowerCase();
  return (
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist")) ||
    (message.includes("column") && message.includes("does not exist"))
  );
}

/** One printed side, as stored. */
export type CustomTemplatePage = {
  id: string;
  templateId: string;
  pageIndex: number;
  storagePath: string;
  contentType: string;
  sizeBytes: number;
  widthPx: number;
  heightPx: number;
};

/** One VERSION of a company template, as stored. */
export type CustomTemplate = {
  /** This version's identity — and the `template_version_id` the field layer scopes to. */
  id: string;
  /** Stable across versions. `custom:<key>` is the document. */
  key: string;
  /** The document identity every other part of this module keys on. */
  document: CustomHiringPackDocument;
  name: string;
  nameAr: string | null;
  /** Which package it prints in: joining, leaving, or other. */
  group: CustomTemplateGroup;
  pageWidthPt: number;
  pageHeightPt: number;
  status: "current" | "archived";
  version: number;
  effectiveFrom: string;
  supersededOn: string | null;
  supersededBy: string | null;
  note: string | null;
  printableByRoles: string[] | null;
  /** How many copies this prints when nobody types a different number. Enforced by the print route. */
  defaultCopies: number;
  /** Whether it prints back-to-back. Shown beside Print; no web API can set a printer duplex. */
  printSides: CustomTemplatePrintSides;
  createdAt: string;
  createdByHrId: string | null;
  updatedAt: string;
  updatedByHrId: string | null;
  pages: CustomTemplatePage[];
};

/**
 * Whether a viewer holding this role may print this template.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * SECOND GATE, NEVER THE ONLY ONE. Every caller has already had to pass
 * `assertPermission(access, "employee_documents", "read")`, which is the gate the ten built-in
 * papers stand behind. This narrows that further for one uploaded template, because a company
 * template is not necessarily an HR form: somebody uploads a warning letter, or a salary
 * certificate, and it should not print for everyone who can print a contract.
 *
 * NULL MEANS "WHOEVER MAY PRINT HR FORMS", not "nobody" and not "everybody". Every template
 * uploaded before this field existed has null, and reading null as a closed door would stop four
 * live papers printing on the day this ships; reading it as open matches what the field's own
 * upload form says — leave it blank and the template follows the module's own permission.
 *
 * SUPER ADMIN IS NEVER LOCKED OUT. The list is written through a form, one careless save can name
 * a role nobody holds, and a paper that no living account can print is unrecoverable through the
 * UI that created it — the Studio's own screens sit behind the same check.
 */
export function canRolePrintCustomTemplate(
  role: string,
  printableByRoles: readonly string[] | null,
): boolean {
  if (printableByRoles === null || printableByRoles.length === 0) return true;
  if (role === "Super Admin") return true;
  return printableByRoles.includes(role);
}

type TemplateRecord = {
  id: string;
  key: string;
  name: string;
  name_ar: string | null;
  document_group: string | null;
  page_width_pt: number | string;
  page_height_pt: number | string;
  status: string;
  version: number;
  effective_from: string;
  superseded_on: string | null;
  superseded_by: string | null;
  note: string | null;
  printable_by_roles: string[] | null;
  default_copies: number | string | null;
  print_sides: string | null;
  created_at: string;
  created_by_hr_id: string | null;
  updated_at: string;
  updated_by_hr_id: string | null;
};

type PageRecord = {
  id: string;
  template_id: string;
  page_index: number;
  storage_path: string;
  content_type: string;
  size_bytes: number | string;
  width_px: number | string;
  height_px: number | string;
};

/**
 * POSTGREST RETURNS NUMERICS AS STRINGS, always, and `numeric(10, 2)` is a numeric. A page width
 * read straight out of the row is `"595.28"`, and `"595.28" / 2` is a number while
 * `"595.28" + 1` is `"595.281"` — so the coercion happens once, here, rather than at whichever
 * arithmetic happens to be reached first.
 */
function toNumber(value: number | string | null): number {
  if (typeof value === "number") return value;
  const parsed = Number(value ?? Number.NaN);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * A copy count the print route can act on, whatever the row happens to hold.
 *
 * The table's own check already refuses anything outside 1–10, so this is not a second opinion about
 * what is valid — it is what to do with a row written before the column existed, where `toNumber`
 * answers 0 for the null. Zero copies renders an empty document, which reads as a broken template
 * rather than as a missing migration.
 */
function clampCopies(value: number): number {
  if (!Number.isFinite(value)) return 1;
  const whole = Math.round(value);
  if (whole < 1) return 1;
  return Math.min(whole, CUSTOM_TEMPLATE_MAX_COPIES);
}

function pageFromRecord(record: PageRecord): CustomTemplatePage {
  return {
    contentType: record.content_type,
    heightPx: Math.round(toNumber(record.height_px)),
    id: record.id,
    pageIndex: record.page_index,
    sizeBytes: Math.round(toNumber(record.size_bytes)),
    storagePath: record.storage_path,
    templateId: record.template_id,
    widthPx: Math.round(toNumber(record.width_px)),
  };
}

function templateFromRecord(record: TemplateRecord, pages: CustomTemplatePage[]): CustomTemplate {
  return {
    createdAt: record.created_at,
    createdByHrId: record.created_by_hr_id,
    document: customDocumentFor(record.key),
    effectiveFrom: record.effective_from,
    id: record.id,
    key: record.key,
    name: record.name,
    // A row written before the group column existed reads null, and `other` is what that MEANS —
    // a paper nobody has sorted yet — rather than a guess that could put it in the wrong package.
    group: isCustomTemplateGroup(record.document_group) ? record.document_group : "other",
    nameAr: record.name_ar,
    note: record.note,
    // A row written before these columns existed reads null, and one copy printed on one side is
    // exactly how every such row already printed — so the fallback restores yesterday's behaviour
    // rather than guessing at an intention nobody recorded.
    defaultCopies: clampCopies(toNumber(record.default_copies)),
    printSides: isCustomTemplatePrintSides(record.print_sides) ? record.print_sides : "single",
    pageHeightPt: toNumber(record.page_height_pt),
    pages: pages.slice().sort((a, b) => a.pageIndex - b.pageIndex),
    pageWidthPt: toNumber(record.page_width_pt),
    printableByRoles: record.printable_by_roles,
    status: record.status === "archived" ? "archived" : "current",
    supersededBy: record.superseded_by,
    supersededOn: record.superseded_on,
    updatedAt: record.updated_at,
    updatedByHrId: record.updated_by_hr_id,
    version: record.version,
  };
}

const TEMPLATE_COLUMNS =
  "id, key, name, name_ar, document_group, page_width_pt, page_height_pt, status, version, effective_from, superseded_on, superseded_by, note, printable_by_roles, default_copies, print_sides, created_at, created_by_hr_id, updated_at, updated_by_hr_id";

const PAGE_COLUMNS =
  "id, template_id, page_index, storage_path, content_type, size_bytes, width_px, height_px";

/**
 * Attach each template's pages, in ONE query rather than one per template.
 *
 * `.in()` is deliberately chunked. A PostgREST `.in()` carrying several hundred ids returns zero
 * rows and no error at all — the failure this repository has hit before — so the chunk stays well
 * under where that starts.
 */
async function pagesForTemplates(templateIds: string[]): Promise<Map<string, CustomTemplatePage[]>> {
  const byTemplate = new Map<string, CustomTemplatePage[]>();
  if (templateIds.length === 0) return byTemplate;

  const supabase = getSupabaseAdmin();
  for (let start = 0; start < templateIds.length; start += 50) {
    const chunk = templateIds.slice(start, start + 50);
    const { data, error } = await supabase
      .from(PAGES_TABLE)
      .select(PAGE_COLUMNS)
      .in("template_id", chunk)
      .order("page_index", { ascending: true });

    if (error) {
      if (isCustomTemplateLayerMissing(error)) return byTemplate;
      throw new Error(error.message);
    }

    for (const record of (data ?? []) as PageRecord[]) {
      const page = pageFromRecord(record);
      const existing = byTemplate.get(page.templateId);
      if (existing) existing.push(page);
      else byTemplate.set(page.templateId, [page]);
    }
  }
  return byTemplate;
}

/**
 * Every company template, newest first.
 *
 * CURRENT VERSIONS ONLY by default. An archived version is still printable and still holds its own
 * field rules — that is the whole point of archiving rather than deleting — but it is not something
 * anyone picks off a list to print today, and mixing the two would put three versions of the same
 * form in front of an operator with nothing to choose between them.
 */
export async function listCustomTemplates(
  options: { includeArchived?: boolean } = {},
): Promise<CustomTemplate[]> {
  const supabase = getSupabaseAdmin();
  let query = supabase.from(TEMPLATES_TABLE).select(TEMPLATE_COLUMNS);
  if (!options.includeArchived) query = query.eq("status", "current");

  const { data, error } = await query.order("created_at", { ascending: false }).limit(500);
  if (error) {
    if (isCustomTemplateLayerMissing(error)) return [];
    throw new Error(error.message);
  }

  const records = (data ?? []) as TemplateRecord[];
  const pages = await pagesForTemplates(records.map((record) => record.id));
  return records.map((record) => templateFromRecord(record, pages.get(record.id) ?? []));
}

/** Every version of one template, newest version first — the archive for one document. */
export async function listCustomTemplateVersions(templateKey: string): Promise<CustomTemplate[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(TEMPLATES_TABLE)
    .select(TEMPLATE_COLUMNS)
    .eq("key", templateKey)
    .order("version", { ascending: false });

  if (error) {
    if (isCustomTemplateLayerMissing(error)) return [];
    throw new Error(error.message);
  }

  const records = (data ?? []) as TemplateRecord[];
  const pages = await pagesForTemplates(records.map((record) => record.id));
  return records.map((record) => templateFromRecord(record, pages.get(record.id) ?? []));
}

/** The version of a template that prints today, or null if there is none. */
export async function loadCurrentCustomTemplate(templateKey: string): Promise<CustomTemplate | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(TEMPLATES_TABLE)
    .select(TEMPLATE_COLUMNS)
    .eq("key", templateKey)
    .eq("status", "current")
    .maybeSingle();

  if (error) {
    if (isCustomTemplateLayerMissing(error)) return null;
    throw new Error(error.message);
  }
  if (!data) return null;

  const record = data as TemplateRecord;
  const pages = await pagesForTemplates([record.id]);
  return templateFromRecord(record, pages.get(record.id) ?? []);
}

/** One specific version, by its own id — which is the `template_version_id` the field layer uses. */
export async function loadCustomTemplateVersion(id: string): Promise<CustomTemplate | null> {
  // A non-uuid is NOT FOUND, not an error. Postgres raises 22P02 for a malformed uuid against a
  // uuid column, which surfaces as a 500 on a route whose honest answer is 404 — and this id comes
  // from a query string.
  if (!isUuid(id)) return null;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(TEMPLATES_TABLE)
    .select(TEMPLATE_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    if (isCustomTemplateLayerMissing(error)) return null;
    throw new Error(error.message);
  }
  if (!data) return null;

  const record = data as TemplateRecord;
  const pages = await pagesForTemplates([record.id]);
  return templateFromRecord(record, pages.get(record.id) ?? []);
}

/**
 * One page and the template version it belongs to, resolved from the page id alone.
 *
 * This is what the artwork route reads. It takes a PAGE ID and answers with the storage path,
 * rather than taking a path — so no caller ever names a storage object, and a request cannot reach
 * an object in this bucket that is not a page of a real template.
 */
export async function loadCustomTemplatePage(
  pageId: string,
): Promise<{ page: CustomTemplatePage; template: CustomTemplate } | null> {
  // Same reason as above: this id is a path segment, and a malformed one is a 404.
  if (!isUuid(pageId)) return null;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(PAGES_TABLE)
    .select(PAGE_COLUMNS)
    .eq("id", pageId)
    .maybeSingle();

  if (error) {
    if (isCustomTemplateLayerMissing(error)) return null;
    throw new Error(error.message);
  }
  if (!data) return null;

  const page = pageFromRecord(data as PageRecord);
  const template = await loadCustomTemplateVersion(page.templateId);
  if (!template) return null;
  return { page, template };
}

/** The bytes of one stored page, for the server to stream on. */
export async function downloadCustomTemplatePage(storagePath: string): Promise<Buffer> {
  const { data, error } = await getSupabaseAdmin()
    .storage.from(CUSTOM_TEMPLATE_BUCKET)
    .download(storagePath);

  if (error || !data) {
    throw new Error(`Unable to read the template artwork: ${error?.message ?? "file not found"}`);
  }
  return Buffer.from(await data.arrayBuffer());
}

/** Remove objects, tolerating the ones already gone. The rollback path, and B6's discard. */
async function removeCustomTemplateObjects(paths: string[]) {
  const wanted = paths.filter(Boolean);
  if (wanted.length === 0) return;
  await getSupabaseAdmin().storage.from(CUSTOM_TEMPLATE_BUCKET).remove(wanted);
}

export type CustomTemplatePageBytes = {
  contentType: CustomTemplateContentType;
  bytes: Buffer;
};

/**
 * Store a new company template: the row, then the artwork, then the page rows.
 *
 * ROW FIRST, and that ordering is the point. The storage path is built from the template's `key`
 * and `version`, and both are decided by the database — `key` defaults to a fresh uuid, `version`
 * to 1. Uploading first would mean inventing a key in the application and hoping the insert agreed
 * with it; a mismatch there would leave every object filed under a key no row points at, which is
 * unreachable and indistinguishable from an empty bucket.
 *
 * The row is deleted on any failure, and that delete is ALLOWED because the row is `current`. The
 * archive trigger refuses to delete an `archived` version only — a rule about superseded papers,
 * not about failed uploads.
 */
export async function createCustomTemplate(input: {
  draft: CustomTemplateDraft;
  pages: CustomTemplatePageBytes[];
  actorHrId: string | null;
}): Promise<CustomTemplate> {
  const { actorHrId, draft, pages } = input;
  if (pages.length !== draft.pages.length) {
    throw new Error("The template's page details and its images do not match. Try the upload again.");
  }

  const supabase = getSupabaseAdmin();
  const { data: inserted, error: insertError } = await supabase
    .from(TEMPLATES_TABLE)
    .insert({
      created_by_hr_id: actorHrId,
      name: draft.name,
      document_group: draft.group,
      name_ar: draft.nameAr,
      note: draft.note,
      default_copies: draft.defaultCopies,
      print_sides: draft.printSides,
      page_height_pt: draft.pageHeightPt,
      page_width_pt: draft.pageWidthPt,
      printable_by_roles: draft.printableByRoles,
      updated_by_hr_id: actorHrId,
    })
    .select(TEMPLATE_COLUMNS)
    .single();

  if (insertError || !inserted) {
    throw new Error(insertError?.message ?? "Could not create the template.");
  }
  const record = inserted as TemplateRecord;

  const stored: string[] = [];
  try {
    const pageRows = [];
    for (let index = 0; index < pages.length; index += 1) {
      const detail = draft.pages[index];
      const file = pages[index];
      const storagePath = buildCustomTemplatePagePath({
        contentType: file.contentType,
        pageIndex: index,
        templateKey: record.key,
        unique: randomUUID(),
        version: record.version,
      });

      const { error: uploadError } = await supabase.storage
        .from(CUSTOM_TEMPLATE_BUCKET)
        .upload(storagePath, file.bytes, {
          cacheControl: "31536000",
          contentType: file.contentType,
          // False, always. Every path carries its own random segment, so a collision here means two
          // uploads raced for one object — which must fail loudly rather than quietly replace the
          // artwork of a template somebody is already printing.
          upsert: false,
        });
      if (uploadError) {
        throw new Error(`Page ${index + 1} could not be stored: ${uploadError.message}`);
      }
      stored.push(storagePath);

      pageRows.push({
        content_type: file.contentType,
        height_px: detail.heightPx,
        page_index: index,
        size_bytes: detail.sizeBytes,
        storage_path: storagePath,
        template_id: record.id,
        width_px: detail.widthPx,
      });
    }

    const { error: pagesError } = await supabase.from(PAGES_TABLE).insert(pageRows);
    if (pagesError) throw new Error(pagesError.message);
  } catch (cause) {
    await removeCustomTemplateObjects(stored);
    await supabase.from(TEMPLATES_TABLE).delete().eq("id", record.id);
    throw cause instanceof Error ? cause : new Error("Could not store the template.");
  }

  const loaded = await loadCustomTemplateVersion(record.id);
  if (!loaded) throw new Error("The template was stored but could not be read back.");
  return loaded;
}

/**
 * Replace a company template's artwork: the next version becomes current, the old one is archived.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE OLD VERSION KEEPS EVERYTHING — its artwork objects, its page rows, its field rules, and a
 * working print link. That is the whole point of archiving rather than overwriting: a paper somebody
 * signed in August has to reprint in December as the document they signed, not as today's artwork
 * with today's boxes on it. Nothing here deletes anything belonging to the version it supersedes.
 *
 * ORDER: objects, then one database call. That is the opposite of `createCustomTemplate` and the
 * difference is not arbitrary — there the key and version are decided by the insert, so no path can
 * be built until the row exists. Here both are already known, so the artwork goes up first and is
 * deleted again if the transaction refuses, leaving nothing behind. Doing it the other way would
 * risk committing a CURRENT version whose artwork never arrived, which replaces a working paper with
 * a blank one.
 *
 * THE ROW WORK IS ONE `plpgsql` CALL because it cannot be anything else. Archiving needs the new
 * version's id, the new row cannot exist while the old one is current, and the foreign key that
 * reconciles those two is deferred to COMMIT — so there is no ordering of separate PostgREST calls
 * that passes. `20260904223000_hiring_pack_replace_a_custom_template.sql` carries the full account.
 */
export async function replaceCustomTemplateArtwork(input: {
  templateKey: string;
  draft: CustomTemplateDraft;
  pages: CustomTemplatePageBytes[];
  actorHrId: string | null;
}): Promise<{ template: CustomTemplate; archivedVersionId: string; previousVersion: number }> {
  const { actorHrId, draft, pages, templateKey } = input;
  if (pages.length !== draft.pages.length) {
    throw new Error("The template's page details and its images do not match. Try the upload again.");
  }
  if (pages.length === 0) {
    throw new Error("A new version needs at least one page.");
  }

  const current = await loadCurrentCustomTemplate(templateKey);
  if (!current) {
    throw new Error(
      "That template has no version printing today, so there is nothing to replace. Upload it as a new template instead.",
    );
  }

  const supabase = getSupabaseAdmin();
  const nextVersion = current.version + 1;
  const stored: string[] = [];

  try {
    const pageRows: Array<Record<string, number | string>> = [];
    for (let index = 0; index < pages.length; index += 1) {
      const detail = draft.pages[index];
      const file = pages[index];
      // The version in the path is what this upload EXPECTS to become. If another session replaced
      // the same template in the meantime the function below refuses, and these objects are removed
      // in the catch — so a stale number here never reaches a row. The path also carries a random
      // segment, so it cannot collide with anything whatever the number says.
      const storagePath = buildCustomTemplatePagePath({
        contentType: file.contentType,
        pageIndex: index,
        templateKey,
        unique: randomUUID(),
        version: nextVersion,
      });

      const { error: uploadError } = await supabase.storage
        .from(CUSTOM_TEMPLATE_BUCKET)
        .upload(storagePath, file.bytes, {
          cacheControl: "31536000",
          contentType: file.contentType,
          upsert: false,
        });
      if (uploadError) {
        throw new Error(`Page ${index + 1} could not be stored: ${uploadError.message}`);
      }
      stored.push(storagePath);

      pageRows.push({
        content_type: file.contentType,
        height_px: detail.heightPx,
        page_index: index,
        size_bytes: detail.sizeBytes,
        storage_path: storagePath,
        width_px: detail.widthPx,
      });
    }

    const { data, error } = await supabase.rpc("hiring_pack_replace_custom_template", {
      p_actor_hr_id: actorHrId,
      p_default_copies: draft.defaultCopies,
      p_group: draft.group,
      p_key: templateKey,
      p_name: draft.name,
      p_name_ar: draft.nameAr,
      p_note: draft.note,
      p_page_height_pt: draft.pageHeightPt,
      p_page_width_pt: draft.pageWidthPt,
      p_pages: pageRows,
      p_print_sides: draft.printSides,
      p_printable_by_roles: draft.printableByRoles,
    });
    if (error) throw new Error(error.message);

    // A `returns table` function answers as an ARRAY of rows through PostgREST, even at one row.
    const row = (Array.isArray(data) ? data[0] : data) as
      | { archived_version_id?: string; new_version_id?: string }
      | null
      | undefined;
    const newVersionId = row?.new_version_id;
    if (!newVersionId) {
      throw new Error("The new version was not created. Nothing was changed.");
    }

    const loaded = await loadCustomTemplateVersion(newVersionId);
    if (!loaded) throw new Error("The new version was stored but could not be read back.");
    return {
      archivedVersionId: row?.archived_version_id ?? current.id,
      previousVersion: current.version,
      template: loaded,
    };
  } catch (cause) {
    // ONLY THE OBJECTS THIS CALL UPLOADED. The transaction either committed both the row and its
    // pages or neither, so there is no row to undo — and nothing here touches the version being
    // replaced, whose artwork is exactly what has to survive.
    await removeCustomTemplateObjects(stored);
    throw cause instanceof Error ? cause : new Error("Could not replace the template.");
  }
}
