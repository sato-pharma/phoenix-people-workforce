import { randomUUID } from "node:crypto";

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { assertPermission, canAccess, resolveEmployeeIdentityId, type AccessContext } from "@/lib/auth/permissions";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey, hrIdForStorage } from "@/lib/hr-id";
import { resolveSalesAccessScope } from "@/lib/sales/access-scope";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  assertVisualAidFileAllowed,
  buildVisualAidUploadPath,
  canReaderOpenVisualAid,
  isOwnVisualAidUploadPath,
  parseVisualAidDraft,
  sniffVisualAidMimeType,
  VISUAL_AID_LINES,
  VISUAL_AID_MAX_BYTES,
  VISUAL_AIDS_BUCKET,
  visualAidLinesForReader,
  visualAidMimeTypeFromPath,
  visualAidUploaderKey,
  VisualAidInputError,
  VisualAidNotFoundError,
  type VisualAidMimeType,
  type VisualAidStatus,
} from "@/lib/visual-aids/rules";

/**
 * Visual Aids — the server half. Every function asserts its permission first, then narrows below the
 * matrix: the permission says a rep may open visual aids, never whose.
 *
 * The table is read with the service-role client (RLS is on with no browser grant), so THIS file is
 * the boundary for which rows leave the server.
 */

const TABLE = "visual_aids";
const COLUMNS =
  "id,title,line_name,product_name,storage_path,mime_type,file_size_bytes,page_count,status,superseded_by,uploaded_by_hr_id,uploaded_by_login,retired_by_hr_id,retired_by_login,retired_at,created_at,updated_at";

type VisualAidRow = {
  id: string;
  title: string;
  line_name: string;
  product_name: string | null;
  storage_path: string;
  mime_type: VisualAidMimeType;
  file_size_bytes: number;
  page_count: number | null;
  status: VisualAidStatus;
  superseded_by: string | null;
  uploaded_by_hr_id: string | null;
  uploaded_by_login: string;
  retired_by_hr_id: string | null;
  retired_by_login: string | null;
  retired_at: string | null;
  created_at: string;
  updated_at: string;
};

/** What leaves the server. No storage path: a reader asks for the file by id, never by object name. */
export type VisualAid = {
  id: string;
  title: string;
  lineName: string;
  productName: string | null;
  mimeType: VisualAidMimeType;
  fileSizeBytes: number;
  pageCount: number | null;
  status: VisualAidStatus;
  supersededById: string | null;
  supersededByTitle: string | null;
  uploadedByName: string;
  uploadedAt: string;
  retiredByName: string | null;
  retiredAt: string | null;
};

export type VisualAidLibrary = {
  aids: VisualAid[];
  /** The lines this viewer's library covers — the reader's own, or every line for an uploader. */
  lines: string[];
  /** Upload, retire and replace are drawn. The routes re-check on every call. */
  canManage: boolean;
  /** Every visual-aid line, for the uploader's line picker. */
  allLines: string[];
};

type Actor = { hrId: string | null; login: string; key: string };

function actorOf(access: AccessContext): Actor {
  const hrId = hrIdForStorage(access.hrId);
  const identity = hrIdForStorage(resolveEmployeeIdentityId(access)) ?? access.loginId ?? null;
  const login = String(access.loginId ?? identity ?? access.role);
  const key = visualAidUploaderKey(identity ?? access.loginId);
  if (!key) throw new VisualAidInputError("This account has no identity to hold an upload. Sign in again and retry.");
  return { hrId, key, login };
}

async function canManage(access: AccessContext): Promise<boolean> {
  return canAccess(access, "visual_aids", "update");
}

/**
 * The lines a viewer may read. An uploader reads every line (he manages all of them); everyone else
 * reads the lines the sales access scope gives him — a rep and his district, regional and national
 * managers resolve to their ONE line; an unresolved line resolves to nothing.
 */
export async function resolveVisualAidReaderLines(access: AccessContext): Promise<string[]> {
  if (await canManage(access)) return [...VISUAL_AID_LINES];
  const scope = await resolveSalesAccessScope(access);
  return visualAidLinesForReader(scope.allowedLineNames);
}

async function namesByIdentity(rows: VisualAidRow[]): Promise<Map<string, string>> {
  const wanted = new Set<string>();
  for (const row of rows) {
    for (const id of [row.uploaded_by_hr_id, row.retired_by_hr_id]) {
      const key = canonicalHrIdKey(id);
      if (key) wanted.add(key);
    }
  }
  const names = new Map<string, string>();
  if (wanted.size === 0) return names;
  const directory = await getEmployeeDirectory();
  for (const employee of directory.employees) {
    const key = canonicalHrIdKey(employee.hrId);
    if (key && wanted.has(key)) names.set(key, employee.displayName || employee.fullName);
  }
  return names;
}

function personName(names: Map<string, string>, hrId: string | null, login: string | null): string {
  const key = canonicalHrIdKey(hrId);
  if (key && names.has(key)) return names.get(key) as string;
  // A Super Admin account may have no employee row; say what it is rather than print an id.
  return login ? "System administrator" : "Unknown";
}

function toVisualAid(row: VisualAidRow, names: Map<string, string>, titles: Map<string, string>): VisualAid {
  return {
    id: row.id,
    title: row.title,
    lineName: row.line_name,
    productName: row.product_name,
    mimeType: row.mime_type,
    fileSizeBytes: Number(row.file_size_bytes),
    pageCount: row.page_count,
    status: row.status,
    supersededById: row.superseded_by,
    supersededByTitle: row.superseded_by ? titles.get(row.superseded_by) ?? null : null,
    uploadedByName: personName(names, row.uploaded_by_hr_id, row.uploaded_by_login),
    uploadedAt: row.created_at,
    retiredByName: row.retired_at ? personName(names, row.retired_by_hr_id, row.retired_by_login) : null,
    retiredAt: row.retired_at,
  };
}

/**
 * The library this viewer sees. A reader gets the ACTIVE aids of his own line(s) and nothing else;
 * an uploader gets every row, retired ones included, so he can see what he replaced.
 */
export async function listVisualAids(access: AccessContext): Promise<VisualAidLibrary> {
  await assertPermission(access, "visual_aids", "read");
  const manage = await canManage(access);
  const lines = await resolveVisualAidReaderLines(access);
  if (lines.length === 0) {
    return { aids: [], allLines: [...VISUAL_AID_LINES], canManage: manage, lines };
  }

  // Every aid of the viewer's lines, paged: the library is one list, and a read that stops at the
  // server's row ceiling would drop its oldest aids with no word.
  let rows: VisualAidRow[];
  try {
    rows = await fetchAllRows<VisualAidRow>(() => {
      const base = getSupabaseAdmin().from(TABLE).select(COLUMNS).in("line_name", lines);
      return (manage ? base : base.eq("status", "active")).order("created_at", { ascending: false });
    }, "id");
  } catch (error) {
    throw new Error(`Could not read the visual aids: ${error instanceof Error ? error.message : (error as { message?: string })?.message ?? String(error)}`);
  }
  // Belt and braces over the query: the same predicate the file route applies decides what a reader
  // may see, so the list can never offer an aid the viewer would then be refused.
  const visible = manage ? rows : rows.filter((row) => canReaderOpenVisualAid({ lineName: row.line_name, status: row.status }, lines));
  const names = await namesByIdentity(visible);
  const titles = new Map(rows.map((row) => [row.id, row.title]));
  return {
    aids: visible.map((row) => toVisualAid(row, names, titles)),
    allLines: [...VISUAL_AID_LINES],
    canManage: manage,
    lines,
  };
}

/**
 * Start an upload: a one-time signed URL the browser PUTs the file to, straight into the private
 * bucket. The file never passes through this app's request body, so a 40 MB flyer is not cut off by a
 * body limit; the path names its uploader, and `createVisualAid` refuses a path minted for anyone else.
 */
export async function startVisualAidUpload(
  access: AccessContext,
  input: { contentType?: unknown; size?: unknown },
): Promise<{ path: string; signedUrl: string; token: string }> {
  await assertPermission(access, "visual_aids", "create");
  const mimeType = assertVisualAidFileAllowed({
    contentType: typeof input.contentType === "string" ? input.contentType : "",
    size: Number(input.size),
  });
  const actor = actorOf(access);
  const path = buildVisualAidUploadPath({ mimeType, uploadId: randomUUID(), uploaderKey: actor.key });
  const { data, error } = await getSupabaseAdmin().storage.from(VISUAL_AIDS_BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new Error(error?.message ?? "Could not start the upload.");
  return { path, signedUrl: data.signedUrl, token: data.token };
}

/**
 * Read back what the browser put in the bucket and prove it is what it claims: the uploader's own
 * path, a size inside the limit, and bytes that really are a PDF, a JPG or a PNG of the type the
 * path was minted for.
 */
async function verifyUploadedFile(path: string, actor: Actor): Promise<{ mimeType: VisualAidMimeType; size: number }> {
  if (!isOwnVisualAidUploadPath(path, actor.key)) {
    throw new VisualAidInputError("That upload does not belong to this account. Choose the file again.");
  }
  const { data, error } = await getSupabaseAdmin().storage.from(VISUAL_AIDS_BUCKET).download(path);
  if (error || !data) throw new VisualAidInputError("The file did not finish uploading. Choose it again.");
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > VISUAL_AID_MAX_BYTES) {
    await removeUpload(path);
    throw new VisualAidInputError("That file is empty or larger than 50 MB. Choose another file.");
  }
  const sniffed = sniffVisualAidMimeType(bytes.subarray(0, 16));
  if (!sniffed || sniffed !== visualAidMimeTypeFromPath(path)) {
    await removeUpload(path);
    throw new VisualAidInputError("That file is not a readable PDF, JPG or PNG. Export it again and upload the new copy.");
  }
  return { mimeType: sniffed, size: bytes.byteLength };
}

async function removeUpload(path: string) {
  await getSupabaseAdmin().storage.from(VISUAL_AIDS_BUCKET).remove([path]).catch(() => undefined);
}

async function insertAid(
  draft: ReturnType<typeof parseVisualAidDraft>,
  file: { path: string; mimeType: VisualAidMimeType; size: number },
  actor: Actor,
): Promise<VisualAidRow> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .insert({
      file_size_bytes: file.size,
      line_name: draft.lineName,
      mime_type: file.mimeType,
      // A picture is one page; a PDF's count comes from the uploader's own render of it.
      page_count: file.mimeType === "application/pdf" ? draft.pageCount : 1,
      product_name: draft.productName,
      status: "active",
      storage_path: file.path,
      title: draft.title,
      uploaded_by_hr_id: actor.hrId,
      uploaded_by_login: actor.login,
    })
    .select(COLUMNS)
    .single();
  if (error || !data) {
    await removeUpload(file.path);
    throw new Error(`Could not save the visual aid: ${error?.message ?? "no row returned"}`);
  }
  return data as VisualAidRow;
}

export async function createVisualAid(
  access: AccessContext,
  input: { storagePath?: unknown; title?: unknown; lineName?: unknown; productName?: unknown; pageCount?: unknown },
): Promise<{ id: string }> {
  await assertPermission(access, "visual_aids", "create");
  const actor = actorOf(access);
  const draft = parseVisualAidDraft(input);
  const path = typeof input.storagePath === "string" ? input.storagePath.trim() : "";
  const file = await verifyUploadedFile(path, actor);
  const row = await insertAid(draft, { ...file, path }, actor);

  await writeRequiredAuditLog({
    actorLoginId: actor.login,
    entityId: row.id,
    entityType: "visual_aid",
    newValues: { lineName: row.line_name, pageCount: row.page_count, productName: row.product_name, status: row.status, title: row.title },
    oldValues: null,
    summary: `Uploaded the visual aid "${row.title}" for the ${row.line_name} line`,
  });
  return { id: row.id };
}

async function loadRow(id: string): Promise<VisualAidRow> {
  const trimmed = String(id ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(trimmed)) throw new VisualAidNotFoundError();
  const { data, error } = await getSupabaseAdmin().from(TABLE).select(COLUMNS).eq("id", trimmed).maybeSingle();
  if (error) throw new Error(`Could not read the visual aid: ${error.message}`);
  if (!data) throw new VisualAidNotFoundError();
  return data as VisualAidRow;
}

/**
 * Retire: hidden from every rep at once, kept in the bucket and the table. Never a delete. Only an
 * ACTIVE row retires, and the precondition is in the UPDATE itself, so two people pressing the button
 * together write one retirement, not two.
 */
async function retireRow(row: VisualAidRow, actor: Actor, supersededBy: string | null): Promise<boolean> {
  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .update({
      retired_at: now,
      retired_by_hr_id: actor.hrId,
      retired_by_login: actor.login,
      status: "retired",
      superseded_by: supersededBy,
      updated_at: now,
    })
    .eq("id", row.id)
    .eq("status", "active")
    .select("id");
  if (error) throw new Error(`Could not retire the visual aid: ${error.message}`);
  return (data ?? []).length === 1;
}

export async function retireVisualAid(access: AccessContext, id: string): Promise<void> {
  await assertPermission(access, "visual_aids", "update");
  const actor = actorOf(access);
  const row = await loadRow(id);
  if (row.status !== "active") throw new VisualAidInputError("That visual aid is already retired.");
  if (!(await retireRow(row, actor, null))) throw new VisualAidInputError("That visual aid is already retired.");

  await writeRequiredAuditLog({
    actorLoginId: actor.login,
    entityId: row.id,
    entityType: "visual_aid",
    newValues: { status: "retired" },
    oldValues: { status: row.status },
    summary: `Retired the visual aid "${row.title}" — reps on the ${row.line_name} line no longer see it`,
  });
}

/**
 * Replace: a newer version goes live and the old one retires pointing at it. Title, line and product
 * carry over unless the uploader typed new ones. If the old row cannot be retired (someone retired it
 * a moment earlier), the new row is withdrawn again so the library never holds two live versions.
 */
export async function replaceVisualAid(
  access: AccessContext,
  id: string,
  input: { storagePath?: unknown; title?: unknown; lineName?: unknown; productName?: unknown; pageCount?: unknown },
): Promise<{ id: string }> {
  await assertPermission(access, "visual_aids", "update");
  const actor = actorOf(access);
  const old = await loadRow(id);
  if (old.status !== "active") throw new VisualAidInputError("Only a live visual aid can be replaced. Upload this one as new.");

  const draft = parseVisualAidDraft({
    lineName: typeof input.lineName === "string" && input.lineName.trim() ? input.lineName : old.line_name,
    pageCount: input.pageCount,
    productName: input.productName === undefined ? old.product_name : input.productName,
    title: typeof input.title === "string" && input.title.trim() ? input.title : old.title,
  });
  const path = typeof input.storagePath === "string" ? input.storagePath.trim() : "";
  const file = await verifyUploadedFile(path, actor);
  const created = await insertAid(draft, { ...file, path }, actor);

  if (!(await retireRow(old, actor, created.id))) {
    // Withdrawing a row this same call inserted a moment ago — never an aid anyone has seen.
    await getSupabaseAdmin().from(TABLE).delete().eq("id", created.id);
    await removeUpload(path);
    throw new VisualAidInputError("That visual aid was retired while you were uploading. Upload the new version as new.");
  }

  await writeRequiredAuditLog({
    actorLoginId: actor.login,
    entityId: old.id,
    entityType: "visual_aid",
    newValues: { replacedBy: created.id, status: "retired", title: created.title, lineName: created.line_name },
    oldValues: { status: old.status, title: old.title, lineName: old.line_name },
    summary: `Replaced the visual aid "${old.title}" with a newer version, "${created.title}"`,
  });
  return { id: created.id };
}

/**
 * The file itself, for the viewer. A reader may open an ACTIVE aid of his own line only — anything
 * else answers "not available", the same answer as an id that does not exist, so the route never
 * confirms what another line holds. An uploader may open any row, retired ones included.
 */
export async function openVisualAidFile(
  access: AccessContext,
  id: string,
): Promise<{ body: ReadableStream<Uint8Array>; mimeType: VisualAidMimeType; size: number }> {
  await assertPermission(access, "visual_aids", "read");
  const row = await loadRow(id);
  if (!(await canManage(access))) {
    const lines = await resolveVisualAidReaderLines(access);
    if (!canReaderOpenVisualAid({ lineName: row.line_name, status: row.status }, lines)) {
      throw new VisualAidNotFoundError();
    }
  }
  const { data, error } = await getSupabaseAdmin().storage.from(VISUAL_AIDS_BUCKET).download(row.storage_path);
  if (error || !data) throw new VisualAidNotFoundError("The file for this visual aid could not be read. Ask Marketing to upload it again.");
  return { body: data.stream() as ReadableStream<Uint8Array>, mimeType: row.mime_type, size: data.size };
}
