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

import type { DocumentFieldRow, FlowAnchor } from "@/lib/hiring-pack/field-layout";
import { DOCUMENT_MARKS, isDocumentMark } from "@/lib/hiring-pack/document-marks";
import { fieldsThatFitNewArtwork } from "@/lib/hiring-pack/custom-templates";
import { validateFieldTemplate } from "@/lib/hiring-pack/field-template";
import { canonicalHrIdForDisplay } from "@/lib/hr-id";
import {
  templateVersionsFor,
  type DocumentTemplateVersion,
  type TemplateStatus,
} from "@/lib/hiring-pack/template-registry";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  asPrintableDocument,
  documentSurfaceOf,
  type PrintableDocument,
} from "@/lib/hiring-pack/document-registry";
import {
  HIRING_PACK_DOCUMENTS,
  type CustomHiringPackDocument,
  type HiringPackDocument,
} from "@/lib/hiring-pack/types";

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

/**
 * A PostgREST error is a plain object, and the shared pager throws it as it received it. Reads that
 * used to `throw new Error(error.message)` keep doing exactly that, so a caller still catches an
 * `Error` carrying the database's own words.
 */
function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : String(error);
  return new Error(message);
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
 * A row whose `source_kind` is not one this build knows is dropped rather than defaulted. The CHECK
 * constraint makes it unreachable through this application, but a hand-written row is not, and a
 * field that silently becomes a literal would print its own column name onto a government form.
 *
 * A MARK IS READ BACK FROM `value_key`, which holds the mark's NAME and not a values-map key. That
 * column is reused rather than a new one added for two reasons: the mark vocabulary is closed and
 * two words long, so a column of its own would be empty on every other row in the table; and the
 * name is validated here as well as by the CHECK, so an unknown one drops the row exactly as an
 * unreadable source does. A mark whose artwork cannot be read still prints nothing — that decision
 * belongs to render time, not to this read.
 */
export function documentFieldFromRecord(record: FieldRecord): DocumentFieldRow | null {
  const source =
    record.source_kind === "value" && record.value_key
      ? ({ kind: "value", key: record.value_key } as const)
      : record.source_kind === "literal" && record.literal_text !== null
        ? ({ kind: "literal", text: record.literal_text } as const)
        : record.source_kind === "mark" && isDocumentMark(record.value_key)
          ? ({ kind: "mark", mark: record.value_key } as const)
          : null;
  if (!source) return null;

  const align =
    record.align === "center" || record.align === "left" || record.align === "right"
      ? record.align
      : "right";

  // The stored document is NARROWED, not cast. This column holds a string, and a row naming a
  // document this build cannot print — a company template deleted from under its layout, a key
  // from a branch that never shipped — has no coordinates worth drawing. Returning null drops it,
  // which is what this function already does for a source it cannot read.
  const document = asPrintableDocument(record.document);
  if (!document) return null;

  return {
    id: record.id,
    document,
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
 * Ordered explicitly, and read in full by the shared pager. A single `.select()` stops at PostgREST's
 * 1000 rows with no marker, and a fixed `.limit()` stops sooner and just as silently, so the layout
 * is walked page by page with `id` as the tiebreak. An unordered read is worse than a capped one:
 * two renders of the same document could stack overlapping fields in different orders and print
 * differently with nothing changed. `created_at` is the order the operator added them in, which is
 * also the order they expect them to layer.
 */
export async function loadDocumentFieldLayout(
  document: PrintableDocument,
  templateVersionId: string,
): Promise<DocumentFieldRow[]> {
  const supabase = getSupabaseAdmin();
  // Rows are typed by the pager's generic, not by the client: with no generated Database type in
  // this repo the client cannot know this table. Every row is then validated by
  // `documentFieldFromRecord`, which returns null for anything it cannot draw — the type buys
  // entry to the shape, it is not trusted as proof of it.
  let records: FieldRecord[];
  try {
    records = await fetchAllRows<FieldRecord>(
      () =>
        supabase
          .from(TABLE)
          .select(COLUMNS)
          .eq("document", document)
          .eq("template_version_id", templateVersionId)
          .is("employee_hr_id", null)
          .order("created_at", { ascending: true }),
      "id",
    );
  } catch (error) {
    if (isFieldLayerMissing(error)) return [];
    throw asError(error);
  }

  const rows: DocumentFieldRow[] = [];
  for (const record of records) {
    const row = documentFieldFromRecord(record);
    if (row) rows.push(row);
  }
  return rows;
}

export type DocumentFieldWrite = {
  id?: string;
  document: PrintableDocument;
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
    // `value_key` carries the MARK NAME on a mark row — see `documentFieldFromRecord`. `src` is
    // never written: the artwork is resolved at render time so replacing the signature reaches every
    // paper that carries one, instead of leaving old placements printing the old signature.
    value_key:
      write.source.kind === "value"
        ? write.source.key
        : write.source.kind === "mark"
          ? write.source.mark
          : null,
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
  document: PrintableDocument,
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

/**
 * The gate below narrows through `asPrintableDocument`, which admits every built-in in
 * `HIRING_PACK_DOCUMENTS` and a `custom:<uuid>` company template. That list is what the table's
 * `hiring_pack_document_fields_document_known` constraint names (20260913190000), and
 * tests/hiring-pack-field-layout.test.ts holds the two level. The rejection message reads the same
 * list, so it can never name ten documents while the gate admits thirty-eight.
 *
 * The keys of uploaded templates are not knowable at build time; that is what makes them uploaded.
 * What the check still guarantees is that whatever reaches the table is a document this build can
 * print, not an arbitrary string a caller supplied.
 */
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
  const raw = input.document;
  const document = typeof raw === "string" ? asPrintableDocument(raw) : null;
  if (!document) {
    return {
      ok: false,
      message:
        `document must be one of ${HIRING_PACK_DOCUMENTS.join(", ")}, ` +
        "or a company template as custom:<uuid>.",
    };
  }

  const templateVersionId = input.templateVersionId;
  if (typeof templateVersionId !== "string" || templateVersionId.trim() === "") {
    return { ok: false, message: "templateVersionId is required." };
  }

  const align = input.align;
  if (align !== "right" && align !== "center" && align !== "left") {
    return { ok: false, message: 'align must be "right", "center" or "left".' };
  }

  // A company template is always a page surface — fixed artwork, absolute coordinates. See
  // `documentSurfaceOf`, which is the one function that answers this for both kinds.
  const surface = documentSurfaceOf(document);
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
    return { ok: false, message: "source is required: a value key, a fixed literal, or a mark." };
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
  } else if (kind === "mark") {
    const mark = (rawSource as { mark?: unknown }).mark;
    if (!isDocumentMark(mark)) {
      return { ok: false, message: `a mark field must be one of ${DOCUMENT_MARKS.join(", ")}.` };
    }
    // A MARK IS ALWAYS AN ADDITION, NEVER AN OVERRIDE, and this is where that is made true rather
    // than assumed. An override keeps the COMPILED placement's kind — `movedPlacement` in
    // field-layout.ts rewrites geometry inside the shape the default already has — so a mark
    // pointed at a compiled key would be drawn as that key's text placement, print nothing, and
    // leave an operator looking at a page with no stamp on it and no error anywhere. There is also
    // nothing sensible to override: no compiled table anywhere places a picture.
    if (defaultKey !== null) {
      return { ok: false, message: "a stamp or signature is added to a page, never used to replace a field that is already on it." };
    }
    source = { kind: "mark", mark };
  } else {
    return { ok: false, message: 'source.kind must be "value", "literal" or "mark".' };
  }

  const id = typeof input.id === "string" && input.id.trim() !== "" ? input.id : undefined;

  return {
    ok: true,
    write: {
      id,
      document,
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CARRYING A LAYOUT FORWARD TO A NEW TEMPLATE VERSION
//
// Field rows are scoped to `template_version_id`, and that scoping is deliberate: an archived
// contract has to reprint as the document that was signed, so its layout cannot be disturbed by
// work done on the current one. The cost is that the day a template is replaced — `contract-v1` to
// `contract-v2` happened on 2026-08-30, so this is not hypothetical — every rule and every added
// box written against the outgoing version stops appearing. No error, no marker: the fields are
// simply back to their compiled defaults, and nothing on any screen says why.
//
// So the editor offers to bring them over, and the offer is the whole feature. It is NEVER
// automatic, because a page document's coordinates are read off the authority's own artwork: if the
// artwork moved between versions, carrying a coordinate forward puts text in the wrong place on a
// government form. That is a decision a person makes with both versions in front of them.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** How many rows each version of one document holds — the basis of the offer. */
export type VersionFieldCount = {
  templateVersionId: string;
  version: number;
  status: TemplateStatus;
  labelEn: string;
  /** Rows on this version, counted after validation so a row nothing can draw is not offered. */
  fields: number;
};

/**
 * What the editor can offer to carry into `templateVersionId`, or null when there is nothing to say.
 *
 * OFFERED ONLY INTO AN EMPTY VERSION. Merging one layout into another produces a page that was
 * never either version's, and no screen can then show which box came from where. A version that
 * already holds work is left alone.
 */
export type CarryForwardOffer = {
  /** The version being edited — always empty, or there is no offer. */
  intoTemplateVersionId: string;
  /** The newest earlier version that holds rows. */
  fromTemplateVersionId: string;
  fromLabelEn: string;
  fromVersion: number;
  /** How many rows would be copied. */
  fields: number;
};

/**
 * Every version of one document with a count of the rows stored against it.
 *
 * One query for the document, grouped in memory. The alternative — a count per version — is a round
 * trip per archived template, and the table is small enough that reading its ids costs less than
 * asking five times.
 */
/*
 * STILL ONE OF THE TEN, and so are `carryForwardOffer` and `carryForwardDocumentFields` below.
 * All three ask `templateVersionsFor` — the COMPILED template registry — which of a document’s
 * versions exist. A company template’s versions are rows in `hiring_pack_custom_templates`, not
 * entries there, so widening these signatures would let a caller pass a template whose version
 * list comes back empty and read that as “no layout to carry”. Carrying a company template’s
 * layout onto replaced artwork is real work; it belongs with the store that knows those versions.
 */
export async function countDocumentFieldsByVersion(
  document: HiringPackDocument,
): Promise<VersionFieldCount[]> {
  const versions = templateVersionsFor(document);
  if (versions.length === 0) return [];

  const supabase = getSupabaseAdmin();
  let records: FieldRecord[];
  try {
    records = await fetchAllRows<FieldRecord>(
      () =>
        supabase.from(TABLE).select(COLUMNS).eq("document", document).is("employee_hr_id", null),
      "id",
    );
  } catch (error) {
    if (isFieldLayerMissing(error)) return versions.map((entry) => versionCount(entry, 0));
    throw asError(error);
  }

  const counts = new Map<string, number>();
  for (const record of records) {
    // Counted only if it can be drawn. Offering to carry a row the editor would drop on arrival
    // would promise seven boxes and deliver six, with nothing to say which one went missing.
    if (!documentFieldFromRecord(record)) continue;
    counts.set(record.template_version_id, (counts.get(record.template_version_id) ?? 0) + 1);
  }

  return versions.map((entry) => versionCount(entry, counts.get(entry.id) ?? 0));
}

function versionCount(entry: DocumentTemplateVersion, fields: number): VersionFieldCount {
  return {
    templateVersionId: entry.id,
    version: entry.version,
    status: entry.status,
    labelEn: entry.labelEn,
    fields,
  };
}

/**
 * The offer for one version, or null when there is nothing worth offering.
 *
 * Null in three cases, and each is a real one rather than a guard for its own sake: the version
 * being edited already holds work; no earlier version holds any; or the id is not a version of this
 * document at all.
 */
export async function carryForwardOffer(
  document: HiringPackDocument,
  templateVersionId: string,
): Promise<CarryForwardOffer | null> {
  const target = templateVersionsFor(document).find((entry) => entry.id === templateVersionId);
  if (!target) return null;

  const counts = await countDocumentFieldsByVersion(document);
  const source = pickCarryForwardSource(counts, target.version, templateVersionId);
  if (!source) return null;

  return {
    intoTemplateVersionId: templateVersionId,
    fromTemplateVersionId: source.templateVersionId,
    fromLabelEn: source.labelEn,
    fromVersion: source.version,
    fields: source.fields,
  };
}

/**
 * Which version to offer carrying from — the whole decision, separated so it can be pinned.
 *
 * THE NEWEST EARLIER VERSION THAT HOLDS ANYTHING. Not the oldest, and not the one with the most
 * rows: a layout is corrected forward over time, so the most recent work is the most correct, and
 * offering v1 when v2 also has changes would hand back a layout somebody had already improved on.
 *
 * Returns null when the target version already holds work — merging two layouts makes a page that
 * was never either version's — and when nothing earlier holds any.
 */
export function pickCarryForwardSource(
  counts: readonly VersionFieldCount[],
  targetVersion: number,
  targetVersionId: string,
): VersionFieldCount | null {
  const into = counts.find((entry) => entry.templateVersionId === targetVersionId);
  if (!into || into.fields > 0) return null;

  return (
    counts
      .filter((entry) => entry.version < targetVersion && entry.fields > 0)
      .sort((a, b) => b.version - a.version)[0] ?? null
  );
}

/**
 * Copy every field row from one template version of a document to another.
 *
 * REFUSES rather than merges when the target already holds rows, and refuses a version id belonging
 * to a different document — copying a contract's coordinates onto Form 1 would place text over a
 * government form's own boxes, and the failure would be visible only on paper.
 *
 * THE ACTOR IS RECORDED AS THE AUTHOR, not as a system migration, because deciding that the old
 * boxes still apply to new artwork IS an authoring act. Someone reading the row's history later
 * needs to see a person there.
 */
export async function carryForwardDocumentFields(
  document: HiringPackDocument,
  fromTemplateVersionId: string,
  toTemplateVersionId: string,
  actorHrId: string | null,
): Promise<number> {
  if (fromTemplateVersionId === toTemplateVersionId) {
    throw new Error("A layout cannot be carried onto the version it already belongs to.");
  }

  const versions = templateVersionsFor(document);
  const from = versions.find((entry) => entry.id === fromTemplateVersionId);
  const to = versions.find((entry) => entry.id === toTemplateVersionId);
  if (!from || !to) {
    throw new Error(
      `Both versions must belong to ${document}. Carrying a layout between documents would place ` +
        "boxes at coordinates read off a different page.",
    );
  }

  const existing = await loadDocumentFieldLayout(document, toTemplateVersionId);
  if (existing.length > 0) {
    throw new Error(
      `${to.labelEn} already has ${existing.length} field${existing.length === 1 ? "" : "s"} of its own. ` +
        "Carrying forward is offered only into a version nothing has been done to yet.",
    );
  }

  const supabase = getSupabaseAdmin();
  // Read in full: a copy that stops at a fixed row count files fewer boxes than the old version
  // holds and says nothing about the rest.
  let sourceRecords: FieldRecord[];
  try {
    sourceRecords = await fetchAllRows<FieldRecord>(
      () =>
        supabase
          .from(TABLE)
          .select(COLUMNS)
          .eq("document", document)
          .eq("template_version_id", fromTemplateVersionId)
          .is("employee_hr_id", null)
          .order("created_at", { ascending: true }),
      "id",
    );
  } catch (error) {
    throw asError(error);
  }

  const actor = actorHrId ? canonicalHrIdForDisplay(actorHrId) : null;
  const now = new Date().toISOString();
  const payload = sourceRecords
    // Same validation as the count, for the same reason: a row that cannot be drawn is not carried.
    .filter((record) => documentFieldFromRecord(record) !== null)
    .map((record) => ({
      document,
      // A NEW id, deliberately — the insert omits it. These rows are per-version by design, and
      // reusing the id would either collide or move the old version's field instead of copying it.
      template_version_id: toTemplateVersionId,
      employee_hr_id: null,
      default_key: record.default_key,
      hidden: record.hidden,
      page: record.page,
      anchor_selector: record.anchor_selector,
      anchor_dx: record.anchor_dx,
      anchor_dy: record.anchor_dy,
      x: record.x,
      y: record.y,
      w: record.w,
      h: record.h,
      align: record.align,
      font_size: record.font_size,
      source_kind: record.source_kind,
      value_key: record.value_key,
      literal_text: record.literal_text,
      created_by_hr_id: actor,
      updated_at: now,
      updated_by_hr_id: actor,
    }));

  if (payload.length === 0) return 0;

  const { data: inserted, error: insertError } = await supabase
    .from(TABLE)
    .insert(payload)
    .select("id");
  if (insertError) throw new Error(insertError.message);
  return (inserted ?? []).length;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT A FIELD USED TO SAY
//
// A save OVERWRITES. Before the history table there was no answer at all to "what did this field
// print in September", and a reset deleted every row without leaving a trace of what it deleted —
// on papers people sign.
//
// The recording is a database trigger, not code in this module, because there are four write paths
// and the reset is a bulk delete that never passes through the single-row one. A trigger is written
// once and cannot be forgotten, including by a hand-run statement during an incident, which is when
// the record matters most. This half only reads.
//
// THE TABLE MAY NOT EXIST YET, for exactly the reason the header of this file gives: its migration
// is a protected action awaiting the owner. Every read degrades to an empty history rather than
// failing, so the editor is unchanged until the day the migration lands.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const HISTORY_TABLE = "hiring_pack_document_field_history";

const HISTORY_COLUMNS =
  "id, field_id, document, template_version_id, default_key, action, hidden, page, " +
  "anchor_selector, anchor_dx, anchor_dy, x, y, w, h, align, font_size, source_kind, " +
  "value_key, literal_text, was_updated_at, was_updated_by_hr_id, changed_at, changed_by_hr_id";

type HistoryRecord = FieldRecord & {
  field_id: string;
  action: string;
  was_updated_at: string;
  was_updated_by_hr_id: string | null;
  changed_at: string;
  changed_by_hr_id: string | null;
};

/**
 * One state a field used to be in, and when it stopped being true.
 *
 * `state` is the same shape the renderer draws, so a history entry can be previewed with the same
 * code that prints the live row rather than a second, drifting description of a placement.
 */
export type FieldHistoryEntry = {
  id: string;
  fieldId: string;
  /** What happened TO this state: it was edited into something else, or the field was removed. */
  action: "update" | "delete";
  /** When it stopped being true. The trustworthy half — lead with this, not with the name. */
  changedAt: string;
  /**
   * Who superseded it. NULL on a delete by design: there is no incoming row to read an actor off,
   * and the field's last editor is not the person who deleted it.
   */
  changedByHrId: string | null;
  /** When this state was itself written — with `changedAt`, the span it was live for. */
  wasUpdatedAt: string;
  wasUpdatedByHrId: string | null;
  /** The state itself, exactly as it stood. */
  state: DocumentFieldRow;
};

/** How much a single field has been rewritten — the whole basis of the inline affordance. */
export type FieldHistorySummary = {
  /** How many superseded states this field has. */
  changes: number;
  /** When it was last rewritten. What the row shows, and what the panel orders by. */
  lastChangedAt: string;
};

/**
 * Per field, how often it has been rewritten and when it last was — for one document version.
 *
 * DELIBERATELY NOT THE FULL HISTORY. This read runs every time the panel opens, and the answer it
 * feeds is one line of text per row: "changed 12 Sep, 14:20". Two columns instead of the whole
 * previous state keeps the common path small, and the states themselves are fetched for the one
 * field somebody actually opens.
 */
export async function summariseDocumentFieldHistory(
  document: PrintableDocument,
  templateVersionId: string,
): Promise<Record<string, FieldHistorySummary>> {
  const supabase = getSupabaseAdmin();
  let stamps: HistoryStampRow[];
  try {
    stamps = await fetchAllRows<HistoryStampRow>(
      () =>
        supabase
          .from(HISTORY_TABLE)
          .select("field_id, changed_at")
          .eq("document", document)
          .eq("template_version_id", templateVersionId)
          .order("changed_at", { ascending: false }),
      "id",
    );
  } catch (error) {
    if (isFieldLayerMissing(error)) return {};
    throw asError(error);
  }

  return summariseHistoryRows(stamps);
}

/** The two columns the summary is built from. */
export type HistoryStampRow = { field_id: string; changed_at: string };

/**
 * Group change stamps by field: how many, and the latest.
 *
 * Pure and exported so the one decision here can be pinned without a database. THE LATEST IS FOUND
 * BY COMPARING, not by trusting the query's `order`. The read asks for newest first, so taking the
 * first sighting of each field would be correct today — and would keep being correct-looking on the
 * day the ordering changed, showing a field's OLDEST state as its most recent change. The row would
 * read "changed 3 Jan" beside a rule written last week, which is worse than no line at all.
 */
export function summariseHistoryRows(
  rows: readonly HistoryStampRow[],
): Record<string, FieldHistorySummary> {
  const summary: Record<string, FieldHistorySummary> = {};
  for (const row of rows) {
    const current = summary[row.field_id];
    if (!current) {
      summary[row.field_id] = { changes: 1, lastChangedAt: row.changed_at };
      continue;
    }
    current.changes += 1;
    if (row.changed_at > current.lastChangedAt) current.lastChangedAt = row.changed_at;
  }
  return summary;
}

/**
 * Every superseded state of ONE field, newest first.
 *
 * Read by id rather than by document so it answers for a field that has since been deleted — which
 * is the case the history exists for. The caller has already proved the document scope; this is the
 * detail fetch behind opening one row.
 */
export async function loadFieldHistory(fieldId: string): Promise<FieldHistoryEntry[]> {
  const supabase = getSupabaseAdmin();
  let records: HistoryRecord[];
  try {
    records = await fetchAllRows<HistoryRecord>(
      () =>
        supabase
          .from(HISTORY_TABLE)
          .select(HISTORY_COLUMNS)
          .eq("field_id", fieldId)
          .order("changed_at", { ascending: false }),
      "id",
    );
  } catch (error) {
    if (isFieldLayerMissing(error)) return [];
    throw asError(error);
  }

  const entries: FieldHistoryEntry[] = [];
  for (const record of records) {
    const entry = fieldHistoryFromRecord(record);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * One history record as an entry, or null if it describes a placement nothing can draw.
 *
 * Validated through `documentFieldFromRecord` — the same function the live layout uses — so a state
 * that would be dropped at render time is dropped here too. Showing a previous state the renderer
 * would have refused would answer "what did this print" with something that never printed.
 */
export function fieldHistoryFromRecord(record: HistoryRecord): FieldHistoryEntry | null {
  if (record.action !== "update" && record.action !== "delete") return null;
  // `id` on the history row is the history entry's own id; the state belongs to `field_id`.
  const state = documentFieldFromRecord({ ...record, id: record.field_id });
  if (!state) return null;
  return {
    id: record.id,
    fieldId: record.field_id,
    action: record.action,
    changedAt: record.changed_at,
    changedByHrId: record.changed_by_hr_id,
    wasUpdatedAt: record.was_updated_at,
    wasUpdatedByHrId: record.was_updated_by_hr_id,
    state,
  };
}

/**
 * Copy a company template's field layer onto the version that just replaced it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS AUTOMATIC WHERE `carryForwardDocumentFields` IS AN OFFER. For a built-in document a
 * new version is a new government form: the boxes may legitimately belong somewhere else, so the
 * editor asks. A company template's replacement is the owner re-uploading the SAME paper with a
 * correction on it — a typo fixed, a logo changed — and every box he placed is meant to stay where
 * he put it. Making him re-place fifty fields to correct one word would mean nobody ever corrects
 * anything, and the reason the B1 migration keys `custom:<key>` on the template rather than the
 * version was precisely to keep this possible.
 *
 * WHY IT IS A SEPARATE FUNCTION AND NOT A FLAG. `carryForwardDocumentFields` validates both version
 * ids against `templateVersionsFor` — the COMPILED registry, which cannot see a row that was
 * uploaded this morning — and refuses a target that already holds fields, because it exists to fill
 * an untouched version. Neither rule fits here, and loosening them would loosen them for the
 * built-ins too.
 *
 * A BOX ON A PAGE THE NEW ARTWORK DOES NOT HAVE IS DROPPED, AND COUNTED. If a three-page form comes
 * back as two, a field on page 3 has nowhere to land: copying it would file a row nothing can draw
 * and nothing can reach — invisible on the page and invisible in the table. Dropping it silently
 * would be the same defect. So it is dropped and reported, and the caller says so.
 *
 * ONLY THE TEMPLATE'S OWN RULES ARE COPIED — `employee_hr_id is null`. A per-employee override is a
 * one-off written for one person's paper; carrying those onto a new version would resurrect edits
 * made for people who were printed months ago.
 */
export async function copyCustomTemplateFieldLayout(input: {
  document: CustomHiringPackDocument;
  fromTemplateVersionId: string;
  toTemplateVersionId: string;
  pageCount: number;
  actorHrId: string | null;
}): Promise<{ copied: number; droppedForMissingPage: number }> {
  const { actorHrId, document, fromTemplateVersionId, pageCount, toTemplateVersionId } = input;
  if (fromTemplateVersionId === toTemplateVersionId) {
    throw new Error("A layout cannot be copied onto the version it already belongs to.");
  }

  const supabase = getSupabaseAdmin();
  // A MISSING TABLE IS "NOTHING TO COPY", not a failed replacement. The version has already been
  // created and is already current at this point; throwing here would report the whole replacement
  // as failed when the only thing missing is a field layer that never existed.
  let sourceRecords: FieldRecord[];
  try {
    sourceRecords = await fetchAllRows<FieldRecord>(
      () =>
        supabase
          .from(TABLE)
          .select(COLUMNS)
          .eq("document", document)
          .eq("template_version_id", fromTemplateVersionId)
          .is("employee_hr_id", null)
          .order("created_at", { ascending: true }),
      "id",
    );
  } catch (error) {
    if (isFieldLayerMissing(error)) return { copied: 0, droppedForMissingPage: 0 };
    throw asError(error);
  }

  const rows = sourceRecords.filter(
    // Same validation as everywhere else: a row that cannot be drawn is not carried.
    (record) => documentFieldFromRecord(record) !== null,
  );

  const { droppedForMissingPage, fits } = fieldsThatFitNewArtwork(rows, pageCount);
  if (fits.length === 0) return { copied: 0, droppedForMissingPage };

  const actor = actorHrId ? canonicalHrIdForDisplay(actorHrId) : null;
  const now = new Date().toISOString();
  const payload = fits.map((record) => ({
    document,
    // A NEW id — the insert omits it. These rows are per-version, so reusing the id would move the
    // archived version's field instead of copying it, and the old paper would stop reprinting as
    // the document it was.
    template_version_id: toTemplateVersionId,
    employee_hr_id: null,
    default_key: record.default_key,
    hidden: record.hidden,
    page: record.page,
    anchor_selector: record.anchor_selector,
    anchor_dx: record.anchor_dx,
    anchor_dy: record.anchor_dy,
    x: record.x,
    y: record.y,
    w: record.w,
    h: record.h,
    align: record.align,
    font_size: record.font_size,
    source_kind: record.source_kind,
    value_key: record.value_key,
    literal_text: record.literal_text,
    created_by_hr_id: actor,
    updated_at: now,
    updated_by_hr_id: actor,
  }));

  const { data: inserted, error: insertError } = await supabase.from(TABLE).insert(payload).select("id");
  if (insertError) throw new Error(insertError.message);
  return { copied: (inserted ?? []).length, droppedForMissingPage };
}
