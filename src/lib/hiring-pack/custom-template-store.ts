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
  buildCustomTemplatePagePath,
  CUSTOM_TEMPLATE_BUCKET,
  type CustomTemplateContentType,
  type CustomTemplateDraft,
} from "@/lib/hiring-pack/custom-templates";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { customDocumentFor, type CustomHiringPackDocument } from "@/lib/hiring-pack/types";

const TEMPLATES_TABLE = "hiring_pack_custom_templates";
const PAGES_TABLE = "hiring_pack_custom_template_pages";

/** The two ways these tables can be absent, as one question. See the header. */
export function isCustomTemplateLayerMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  if (code === "PGRST205" || code === "PGRST204" || code === "42P01") return true;
  const message = (
    "message" in error ? String((error as { message?: unknown }).message ?? "") : ""
  ).toLowerCase();
  return (
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
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
  pageWidthPt: number;
  pageHeightPt: number;
  status: "current" | "archived";
  version: number;
  effectiveFrom: string;
  supersededOn: string | null;
  supersededBy: string | null;
  note: string | null;
  printableByRoles: string[] | null;
  createdAt: string;
  createdByHrId: string | null;
  updatedAt: string;
  updatedByHrId: string | null;
  pages: CustomTemplatePage[];
};

type TemplateRecord = {
  id: string;
  key: string;
  name: string;
  name_ar: string | null;
  page_width_pt: number | string;
  page_height_pt: number | string;
  status: string;
  version: number;
  effective_from: string;
  superseded_on: string | null;
  superseded_by: string | null;
  note: string | null;
  printable_by_roles: string[] | null;
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
    nameAr: record.name_ar,
    note: record.note,
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
  "id, key, name, name_ar, page_width_pt, page_height_pt, status, version, effective_from, superseded_on, superseded_by, note, printable_by_roles, created_at, created_by_hr_id, updated_at, updated_by_hr_id";

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
      name_ar: draft.nameAr,
      note: draft.note,
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
