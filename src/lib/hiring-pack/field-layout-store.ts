// Reading and writing the field layer. The shapes and the merge live in `field-layout.ts`; this is
// the half that talks to the database.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE TABLE MAY NOT EXIST YET, AND EVERY READ HERE HAS TO SURVIVE THAT.
//
// `hiring_pack_document_fields` arrives in a migration, and a migration is a protected action that
// only the owner approves. So there is a window — possibly a long one — in which this code is
// deployed and the table is not there. A hiring pack that 500s because nobody has run a migration
// yet would take out the whole printing screen for a feature nobody is using.
//
// A MISSING TABLE ANSWERS `PGRST205`, NOT `42P01`. PostgREST resolves through its schema cache and
// reports a cache miss, so the obvious `42P01` guard fires never and the page 500s anyway. Both
// codes are treated as one set here, and the code is checked as well as the message: a PostgREST
// error is a plain object, not an `Error`, so a message-only test reads it as empty and returns
// false — which is the same as having no guard at all.
//
// The degraded answer is an empty layout, which is exactly right: no rows means every document
// prints its compiled default, which is what it printed before this feature existed.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { documentSurface, type DocumentFieldRow, type FlowAnchor } from "@/lib/hiring-pack/field-layout";
import { validateFieldTemplate } from "@/lib/hiring-pack/field-template";
import { canonicalHrIdForDisplay } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { HiringPackDocument } from "@/lib/hiring-pack/types";

const TABLE = "hiring_pack_document_fields";

/** The two ways this table can be absent, as one question. See the header. */
export function isFieldLayerMissing(error: unknown): boolean {
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

export type FieldRecord = {
  id: string;
  document: string;
  template_version_id: string;
  employee_hr_id: string | null;
  default_key: string | null;
  hidden: boolean;
  page: number | null;
  anchor_selector: string | null;
  anchor_dx: number | string | null;
  anchor_dy: number | string | null;
  x: number | string;
  y: number | string;
  w: number | string;
  h: number | string;
  align: string;
  font_size: number | string;
  source_kind: string;
  value_key: string | null;
  literal_text: string | null;
  updated_at: string;
  updated_by_hr_id: string | null;
};

/** Postgres `numeric` comes back as a STRING through PostgREST, and `"12" + 1` is `"121"`. */
function num(value: number | string | null | undefined, fallback: number): number {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function anchorOf(record: FieldRecord): FlowAnchor | null {
  if (!record.anchor_selector) return null;
  return {
    selector: record.anchor_selector,
    dx: num(record.anchor_dx, 0),
    dy: num(record.anchor_dy, 0),
  };
}

/**
 * One stored record as the renderer's own shape.
 *
 * A row whose `source_kind` is neither known value is dropped rather than defaulted. The CHECK
 * constraint makes it unreachable through this application, but a hand-written row is not, and a
 * field that silently becomes a literal would print its own column name onto a government form.
 */
export function documentFieldFromRecord(record: FieldRecord): DocumentFieldRow | null {
  const source =
    record.source_kind === "value" && record.value_key
      ? ({ kind: "value", key: record.value_key } as const)
      : record.source_kind === "literal" && record.literal_text !== null
        ? ({ kind: "literal", text: record.literal_text } as const)
        : null;
  if (!source) return null;

  const align =
    record.align === "center" || record.align === "left" || record.align === "right"
      ? record.align
      : "right";

  return {
    id: record.id,
    document: record.document as HiringPackDocument,
    templateVersionId: record.template_version_id,
    defaultKey: record.default_key,
    hidden: record.hidden === true,
    page: record.page === null ? null : Number(record.page),
    anchor: anchorOf(record),
    x: num(record.x, 0),
    y: num(record.y, 0),
    w: num(record.w, 0),
    h: num(record.h, 0),
    align,
    size: num(record.font_size, 9),
    source,
    updatedAt: record.updated_at,
    updatedByHrId: record.updated_by_hr_id,
  };
}

const COLUMNS =
  "id, document, template_version_id, employee_hr_id, default_key, hidden, page, " +
  "anchor_selector, anchor_dx, anchor_dy, x, y, w, h, align, font_size, source_kind, " +
  "value_key, literal_text, updated_at, updated_by_hr_id";

/**
 * The layout for one document at one template version.
 *
 * Ordered explicitly. An unbounded `.select()` stops at 1000 rows with no marker, and while a layout
 * that large would already be a mistake, an unordered read is worse than a capped one: two renders
 * of the same document could stack overlapping fields in different orders and print differently
 * with nothing changed. `created_at` is the order the operator added them in, which is also the
 * order they expect them to layer.
 */
export async function loadDocumentFieldLayout(
  document: HiringPackDocument,
  templateVersionId: string,
): Promise<DocumentFieldRow[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(TABLE)
    .select(COLUMNS)
    .eq("document", document)
    .eq("template_version_id", templateVersionId)
    .is("employee_hr_id", null)
    .order("created_at", { ascending: true })
    .limit(500);

  if (error) {
    if (isFieldLayerMissing(error)) return [];
    throw new Error(error.message);
  }

  const rows: DocumentFieldRow[] = [];
  // Through `unknown` deliberately: with no generated Database type in this repo the client cannot
  // know this table, so it infers GenericStringError and rejects a direct cast. Every row is then
  // validated by `documentFieldFromRecord`, which returns null for anything it cannot draw — the
  // cast buys entry to the shape, it is not trusted as proof of it.
  for (const record of (data ?? []) as unknown as FieldRecord[]) {
    const row = documentFieldFromRecord(record);
    if (row) rows.push(row);
  }
  return rows;
}

export type DocumentFieldWrite = {
  id?: string;
  document: HiringPackDocument;
  templateVersionId: string;
  defaultKey: string | null;
  hidden: boolean;
  page: number | null;
  anchor: FlowAnchor | null;
  x: number;
  y: number;
  w: number;
  h: number;
  align: "right" | "center" | "left";
  size: number;
  source: DocumentFieldRow["source"];
};

/**
 * Create or update one field.
 *
 * The actor comes from the caller's own session and is never read off the request body — the same
 * rule the rest of this module follows, and the reason `updated_by_hr_id` on this table can be
 * trusted where the one on `employees` famously cannot.
 */
export async function saveDocumentField(
  write: DocumentFieldWrite,
  actorHrId: string | null,
): Promise<DocumentFieldRow> {
  const supabase = getSupabaseAdmin();
  const actor = actorHrId ? canonicalHrIdForDisplay(actorHrId) : null;
  const payload = {
    document: write.document,
    template_version_id: write.templateVersionId,
    employee_hr_id: null,
    default_key: write.defaultKey,
    hidden: write.hidden,
    page: write.page,
    anchor_selector: write.anchor?.selector ?? null,
    anchor_dx: write.anchor?.dx ?? null,
    anchor_dy: write.anchor?.dy ?? null,
    x: write.x,
    y: write.y,
    w: write.w,
    h: write.h,
    align: write.align,
    font_size: write.size,
    source_kind: write.source.kind,
    value_key: write.source.kind === "value" ? write.source.key : null,
    literal_text: write.source.kind === "literal" ? write.source.text : null,
    updated_at: new Date().toISOString(),
    updated_by_hr_id: actor,
  };

  const query = write.id
    ? supabase.from(TABLE).update(payload).eq("id", write.id)
    : supabase.from(TABLE).insert({ ...payload, created_by_hr_id: actor });

  const { data, error } = await query.select(COLUMNS).single();
  if (error) throw new Error(error.message);
  const row = documentFieldFromRecord(data as unknown as FieldRecord);
  if (!row) throw new Error("The field was saved but came back in a shape this screen cannot draw.");
  return row;
}

/** Delete one field. An added field goes; an override goes back to its compiled default. */
export async function deleteDocumentField(id: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from(TABLE).delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/**
 * Reset one document to its compiled layout.
 *
 * Scoped to the template VERSION, not the document. Resetting today's contract must not delete the
 * layout of the archived one — that layout is part of how a signed contract reprints as the document
 * that was signed, and it is not the caller's to discard.
 */
export async function resetDocumentFieldLayout(
  document: HiringPackDocument,
  templateVersionId: string,
): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(TABLE)
    .delete()
    .eq("document", document)
    .eq("template_version_id", templateVersionId)
    .is("employee_hr_id", null)
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length;
}

/** What a client can send when it wants to place or move a field. Loosely typed on purpose — this
 *  is the one function that has to survive a malformed request without throwing. */
export type DocumentFieldWriteInput = {
  id?: unknown;
  document?: unknown;
  templateVersionId?: unknown;
  defaultKey?: unknown;
  hidden?: unknown;
  page?: unknown;
  anchor?: unknown;
  x?: unknown;
  y?: unknown;
  w?: unknown;
  h?: unknown;
  align?: unknown;
  size?: unknown;
  source?: unknown;
};

const KNOWN_DOCUMENTS = new Set<HiringPackDocument>([
  "contract",
  "form1",
  "workerDataForm",
  "custodyLaptop",
  "custodyMobile",
  "form6",
  "resignation",
  "mutualTermination",
  "clearanceEmployee",
  "clearanceCompany",
]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The API boundary's own gate, mirroring every CHECK constraint on the table by hand.
 *
 * Mirrored rather than shared because a database constraint cannot be imported — this is the part
 * that turns a violation into a message someone dragging a box can act on, instead of a 500 with a
 * Postgres constraint name in it. Anything this function accepts, the table also accepts; anything
 * it rejects, the table would have rejected too, just later and less legibly.
 */
export function parseDocumentFieldWrite(
  input: DocumentFieldWriteInput,
): { ok: true; write: DocumentFieldWrite } | { ok: false; message: string } {
  const document = input.document;
  if (typeof document !== "string" || !KNOWN_DOCUMENTS.has(document as HiringPackDocument)) {
    return { ok: false, message: `document must be one of ${Array.from(KNOWN_DOCUMENTS).join(", ")}.` };
  }

  const templateVersionId = input.templateVersionId;
  if (typeof templateVersionId !== "string" || templateVersionId.trim() === "") {
    return { ok: false, message: "templateVersionId is required." };
  }

  const align = input.align;
  if (align !== "right" && align !== "center" && align !== "left") {
    return { ok: false, message: 'align must be "right", "center" or "left".' };
  }

  const surface = documentSurface(document as HiringPackDocument);
  const rawPage = input.page;
  const rawAnchor = input.anchor;
  let page: number | null = null;
  let anchor: FlowAnchor | null = null;

  if (surface === "page") {
    if (!isFiniteNumber(rawPage) || rawPage < 1 || !Number.isInteger(rawPage)) {
      return { ok: false, message: "page must be a whole number of 1 or more on a page-surface document." };
    }
    if (rawAnchor !== null && rawAnchor !== undefined) {
      return { ok: false, message: "a page-surface field cannot also carry an anchor." };
    }
    page = rawPage;
  } else {
    if (rawPage !== null && rawPage !== undefined) {
      return { ok: false, message: "a flow-surface field cannot also carry a page number." };
    }
    if (
      typeof rawAnchor !== "object" ||
      rawAnchor === null ||
      typeof (rawAnchor as { selector?: unknown }).selector !== "string" ||
      (rawAnchor as { selector: string }).selector.trim() === "" ||
      !isFiniteNumber((rawAnchor as { dx?: unknown }).dx) ||
      !isFiniteNumber((rawAnchor as { dy?: unknown }).dy)
    ) {
      return {
        ok: false,
        message: "a flow-surface field needs an anchor: { selector, dx, dy }.",
      };
    }
    const a = rawAnchor as { selector: string; dx: number; dy: number };
    anchor = { selector: a.selector, dx: a.dx, dy: a.dy };
  }

  if (!isFiniteNumber(input.w) || input.w <= 0 || !isFiniteNumber(input.h) || input.h <= 0) {
    return { ok: false, message: "w and h must be positive numbers — a box with no size prints nothing." };
  }
  if (!isFiniteNumber(input.size) || input.size <= 0) {
    return { ok: false, message: "size must be a positive number." };
  }
  const x = isFiniteNumber(input.x) ? input.x : 0;
  const y = isFiniteNumber(input.y) ? input.y : 0;

  const defaultKey =
    input.defaultKey === null || input.defaultKey === undefined
      ? null
      : typeof input.defaultKey === "string" && input.defaultKey.trim() !== ""
        ? input.defaultKey
        : undefined;
  if (defaultKey === undefined) {
    return { ok: false, message: "defaultKey must be a non-empty string or null." };
  }

  const hidden = input.hidden === true;
  if (hidden && defaultKey === null) {
    return { ok: false, message: "only an override can be hidden — an added field is deleted, not hidden." };
  }

  const rawSource = input.source;
  if (typeof rawSource !== "object" || rawSource === null) {
    return { ok: false, message: "source is required: a value key or a fixed literal." };
  }
  const kind = (rawSource as { kind?: unknown }).kind;
  let source: DocumentFieldRow["source"];
  if (kind === "value") {
    const key = (rawSource as { key?: unknown }).key;
    if (typeof key !== "string" || key.trim() === "") {
      return { ok: false, message: "a value field needs a non-empty key." };
    }
    source = { kind: "value", key };
  } else if (kind === "literal") {
    const text = (rawSource as { text?: unknown }).text;
    if (typeof text !== "string") {
      return { ok: false, message: "a literal field needs text (an empty string is fine)." };
    }
    // SHAPE ONLY, AND DELIBERATELY NOT THE KEY NAMES. A literal may carry `{{key}}` placeholders,
    // and a half-written one — `{{employeeName}` — matches no placeholder at all, so without this it
    // would print its own braces onto a signed document. That is refused here, where a person is
    // present to be told.
    //
    // WHICH KEYS EXIST IS A PER-DOCUMENT QUESTION AND THIS FUNCTION CANNOT ANSWER IT. A page
    // document places camelCase record keys, a flow document fills UPPER_SNAKE tokens that are not
    // in `PAPER_FIELD_BINDINGS` at all, and checking against that table here would refuse
    // `{{COMPANY_NAME}}` on a contract — a key that resolves perfectly. The editor checks the name
    // against the document's own live inventory before it ever gets here; and whatever slips past
    // both, `resolveFieldTemplate` blanks the whole field rather than printing a brace.
    const templateError = validateFieldTemplate(text);
    if (templateError) {
      return { ok: false, message: templateError };
    }
    source = { kind: "literal", text };
  } else {
    return { ok: false, message: 'source.kind must be "value" or "literal".' };
  }

  const id = typeof input.id === "string" && input.id.trim() !== "" ? input.id : undefined;

  return {
    ok: true,
    write: {
      id,
      document: document as HiringPackDocument,
      templateVersionId,
      defaultKey,
      hidden,
      page,
      anchor,
      x,
      y,
      w: input.w,
      h: input.h,
      align,
      size: input.size,
      source,
    },
  };
}
