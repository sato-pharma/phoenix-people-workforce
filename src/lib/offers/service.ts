import { OFFER_BLOCK_DEFS } from "@/lib/offers/block-schema";
import {
  OFFER_BUILTIN_TEMPLATES,
  isOfferBuiltinKey,
  isOfferTemplateVariant,
  offerBuiltinTemplate,
} from "@/lib/offers/builtin-templates";
import { OFFER_DEFAULT_FONT, OFFER_DEFAULT_FONT_SIZE_PT, OFFER_DEFAULT_THEME } from "@/lib/offers/default-template";
import { parseLetterDate } from "@/lib/offers/dates";
import { OFFER_REFERENCE_PREFIX, nextOfferReference, offerTitleCode } from "@/lib/offers/reference";
import { announceAcceptedOffer } from "@/lib/offers/accepted-offer-alert";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type {
  OfferBlock,
  OfferBlockType,
  OfferFields,
  OfferJobTitle,
  OfferJobTitleInput,
  OfferRecord,
  OfferRevision,
  OfferStatus,
  OfferTemplate,
  OfferTemplateInput,
  OfferTheme,
} from "@/lib/offers/types";
import { offerRevisionCancelRefusal, offerRevisionRefusal } from "@/lib/offers/revision-rules";

/**
 * The job-offer module's data layer.
 *
 * Two rules this file exists to hold:
 *
 *   1. THE RENDERERS NEVER TOUCH THE DATABASE. Everything a letter needs arrives as a resolved
 *      `OfferFields` + template. One place a value can be wrong, one place to test, and no way for
 *      the PDF and the email to disagree about the same person's salary.
 *
 *   2. DERIVED MONEY IS NEVER STORED. Only the typed total and the cost of living that applied go
 *      in a row; basic, transport and every annual column are computed on render. A stored copy
 *      would be a second source of truth, and the day it drifted from the formula the letter's
 *      table would contradict its own headline.
 */

export class OfferSchemaMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfferSchemaMissingError";
  }
}

export class OfferNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfferNotFoundError";
  }
}

/** Postgres codes for "the migration has not been applied here yet". */
function isMissingRelation(error: { code?: string } | null): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205";
}

function assertReadable(error: { code?: string; message?: string } | null, what: string): void {
  if (!error) return;
  if (isMissingRelation(error)) {
    throw new OfferSchemaMissingError(
      `The job-offer tables are not present in this database. Run the migration for ${what}.`,
    );
  }
  throw new Error(error.message ?? `Could not read ${what}.`);
}

// ─────────────────────────────────────────────────────────────────────── blocks ──

/**
 * DERIVED from the editor's own block table, never hand-listed beside it.
 *
 * A second copy of this list is the bug it exists to prevent: add a block type, forget this line,
 * and the block seeds fine, renders fine, previews fine — and is silently dropped the first time
 * anybody presses Save, because a type this set does not know is discarded on the way in. The
 * failure appears one screen away from the change and only after a reload.
 *
 * `OFFER_BLOCK_DEFS` is the right source because a type missing from it has no editor either, so
 * the two lists were never independently true.
 */
const KNOWN_BLOCK_TYPES: ReadonlySet<string> = new Set<OfferBlockType>(
  OFFER_BLOCK_DEFS.map((def) => def.type),
);

/**
 * Validate blocks arriving from the editor before they are stored.
 *
 * A template is HTML authored by an HR-authority user and later rendered into a PDF and an email,
 * so this is not a hostile-input boundary in the usual sense — but a malformed array reaching
 * storage means every future render of that template throws, including the one that was about to
 * send somebody a job offer. Unknown types and non-object props are dropped rather than rejected,
 * so one bad block cannot cost the whole design.
 */
export function sanitizeTemplateBlocks(input: unknown): OfferBlock[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();

  return input.flatMap((raw, index): OfferBlock[] => {
    if (!raw || typeof raw !== "object") return [];
    const candidate = raw as { id?: unknown; props?: unknown; type?: unknown };
    const type = String(candidate.type ?? "");
    if (!KNOWN_BLOCK_TYPES.has(type)) return [];

    // Ids address the click target and the edit target. A duplicate would make editing one block
    // silently edit another, so a collision is renamed rather than trusted.
    let id = typeof candidate.id === "string" && candidate.id.trim() !== "" ? candidate.id.trim() : `${type}-${index}`;
    while (seen.has(id)) id = `${id}-${index}`;
    seen.add(id);

    const props =
      candidate.props && typeof candidate.props === "object" && !Array.isArray(candidate.props)
        ? (candidate.props as Record<string, unknown>)
        : {};

    return [{ id, props, type: type as OfferBlockType }];
  });
}

/** Keep only real colour values — a stray key would emit a broken CSS custom property. */
export function sanitizeTheme(input: unknown): OfferTheme {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const allowed = Object.keys(OFFER_DEFAULT_THEME);
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!allowed.includes(key)) continue;
    const colour = String(value ?? "").trim();
    if (/^#[0-9a-f]{3,8}$/i.test(colour) || /^rgba?\([\d\s.,%]+\)$/i.test(colour)) {
      out[key] = colour;
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────── templates ──

type TemplateRow = {
  blocks: unknown;
  builtin_key: string | null;
  created_at: string | null;
  created_by: string | null;
  font_family: string | null;
  font_size_pt: number | string | null;
  id: string;
  is_default: boolean | null;
  name: string;
  theme: unknown;
  updated_at: string | null;
  variant: string | null;
};

function toTemplate(row: TemplateRow): OfferTemplate {
  return {
    blocks: sanitizeTemplateBlocks(row.blocks),
    builtinKey: isOfferBuiltinKey(row.builtin_key) ? row.builtin_key : null,
    createdAt: row.created_at,
    createdBy: row.created_by,
    fontFamily: row.font_family || OFFER_DEFAULT_FONT,
    fontSizePt: Number(row.font_size_pt) || OFFER_DEFAULT_FONT_SIZE_PT,
    id: row.id,
    isDefault: row.is_default === true,
    name: row.name,
    theme: sanitizeTheme(row.theme),
    updatedAt: row.updated_at,
    // An unknown value falls back to the plain skin rather than throwing. A template whose variant
    // somebody has hand-edited in SQL should still render — as the base design, visibly wrong in a
    // way that is obvious and fixable, not as a 500 on the offers page.
    variant: isOfferTemplateVariant(row.variant) ? row.variant : "classic",
  };
}

/**
 * Guarantee every design that ships with the module exists, and return them.
 *
 * Seeded here rather than in SQL on purpose: the block structure lives beside the renderer that
 * reads it, and a duplicate copy in a migration would drift from it the first time either changed.
 * It also means Restore keeps working forever — a built-in is regenerated from code, not recovered
 * from a row somebody may have deleted.
 *
 * Rows are matched by `builtin_key`, never by name, so renaming "SATO Executive Offer" in the
 * designer does not orphan it and cause a duplicate to be seeded alongside it on the next request.
 */
export async function ensureBuiltinTemplates(): Promise<OfferTemplate[]> {
  const db = getSupabaseAdmin();

  const existing = await db.from("offer_templates").select("*").not("builtin_key", "is", null);
  assertReadable(existing.error, "offer_templates");
  const present = new Set(((existing.data ?? []) as TemplateRow[]).map((row) => row.builtin_key ?? ""));
  const missing = OFFER_BUILTIN_TEMPLATES.filter((entry) => !present.has(entry.key));
  if (missing.length === 0) return ((existing.data ?? []) as TemplateRow[]).map(toTemplate);

  // `is_default` is claimed by a seeded design only when NOTHING already holds it. The partial
  // unique index makes a second default a conflict, and an owner who has pointed new offers at his
  // own design must not have that quietly taken back the next time a built-in is seeded.
  const claimed = await db.from("offer_templates").select("id").eq("is_default", true).limit(1);
  assertReadable(claimed.error, "offer_templates");
  let defaultHeld = (claimed.data ?? []).length > 0;
  let firstFailure: string | null = null;

  for (const entry of missing) {
    const takeDefault = entry.seedAsDefault && !defaultHeld;
    const inserted = await db.from("offer_templates").insert({
      blocks: entry.blocks(),
      builtin_key: entry.key,
      created_by: "system",
      font_family: entry.fontFamily,
      font_size_pt: entry.fontSizePt,
      is_default: takeDefault,
      name: entry.name,
      theme: entry.theme,
      variant: entry.variant,
    });

    if (inserted.error) {
      if (firstFailure === null) firstFailure = inserted.error.message;
      continue;
    }
    if (takeDefault) defaultHeld = true;
  }

  const after = await db.from("offer_templates").select("*").not("builtin_key", "is", null);
  assertReadable(after.error, "offer_templates");
  const templates = ((after.data ?? []) as TemplateRow[]).map(toTemplate);

  // A parallel request seeding the same design is a unique-key conflict, not a failure — the row it
  // wanted is there either way, which is what the re-read proves. Anything still missing means the
  // insert failed for a real reason, and that must not be swallowed into a half-seeded library.
  if (firstFailure !== null && !OFFER_BUILTIN_TEMPLATES.every((e) => templates.some((t) => t.builtinKey === e.key))) {
    throw new Error(firstFailure);
  }
  return templates;
}

/**
 * The design a new offer opens on, and the one used when an offer names no template.
 *
 * Falls back down a chain rather than throwing: the flagged default, then the classic built-in,
 * then whatever exists. An offer with no template at all is the one outcome that must not happen —
 * it would mean a candidate receiving a blank letter.
 */
export async function defaultOfferTemplate(): Promise<OfferTemplate> {
  const templates = await listOfferTemplates();
  const chosen =
    templates.find((template) => template.isDefault) ??
    templates.find((template) => template.builtinKey === "classic") ??
    templates[0];
  if (!chosen) throw new OfferNotFoundError("No offer template exists.");
  return chosen;
}

export async function listOfferTemplates(): Promise<OfferTemplate[]> {
  await ensureBuiltinTemplates();
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("offer_templates")
    .select("*")
    .order("is_default", { ascending: false })
    .order("name", { ascending: true });

  assertReadable(error, "offer_templates");
  return (data ?? []).map((row) => toTemplate(row as TemplateRow));
}

export async function getOfferTemplate(id: string): Promise<OfferTemplate> {
  const db = getSupabaseAdmin();
  const { data, error } = await db.from("offer_templates").select("*").eq("id", id).maybeSingle();
  assertReadable(error, "offer_templates");
  if (!data) throw new OfferNotFoundError("That offer template does not exist.");
  return toTemplate(data as TemplateRow);
}

export async function createOfferTemplate(
  input: OfferTemplateInput,
  createdBy: string | null,
): Promise<OfferTemplate> {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("offer_templates")
    .insert({
      blocks: sanitizeTemplateBlocks(input.blocks),
      created_by: createdBy,
      font_family: input.fontFamily || OFFER_DEFAULT_FONT,
      font_size_pt: input.fontSizePt || OFFER_DEFAULT_FONT_SIZE_PT,
      // Never on create, in either column. A new template is somebody's own design: it is not a
      // built-in (so Restore must never overwrite it) and it does not seize the default (so saving
      // a draft cannot silently redirect every offer HR sends next).
      builtin_key: null,
      is_default: false,
      name: input.name.trim() || "Untitled template",
      theme: sanitizeTheme(input.theme),
      variant: isOfferTemplateVariant(input.variant) ? input.variant : "classic",
    })
    .select("*")
    .single();

  assertReadable(error, "offer_templates");
  return toTemplate(data as TemplateRow);
}

export async function updateOfferTemplate(
  id: string,
  input: Partial<OfferTemplateInput>,
): Promise<OfferTemplate> {
  const db = getSupabaseAdmin();

  // Every field is OPTIONAL and only written when present. Writing a `?? null` for an absent key
  // is how an optional field becomes a silent erase — renaming a template would blank its blocks.
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name.trim() || "Untitled template";
  if (input.blocks !== undefined) patch.blocks = sanitizeTemplateBlocks(input.blocks);
  if (input.theme !== undefined) patch.theme = sanitizeTheme(input.theme);
  if (input.fontFamily !== undefined) patch.font_family = input.fontFamily || OFFER_DEFAULT_FONT;
  if (input.fontSizePt !== undefined) patch.font_size_pt = input.fontSizePt || OFFER_DEFAULT_FONT_SIZE_PT;
  if (input.variant !== undefined) patch.variant = isOfferTemplateVariant(input.variant) ? input.variant : "classic";

  if (Object.keys(patch).length === 0) return getOfferTemplate(id);

  const { data, error } = await db.from("offer_templates").update(patch).eq("id", id).select("*").maybeSingle();
  assertReadable(error, "offer_templates");
  if (!data) throw new OfferNotFoundError("That offer template does not exist.");
  return toTemplate(data as TemplateRow);
}

/**
 * Point new offers at a template.
 *
 * Two writes, in this order, because `offer_templates_one_default` is a PARTIAL UNIQUE index over
 * the rows where `is_default` is true. Setting the new one first would collide with the old one and
 * fail; clearing first means the worst case is a moment with no default, which `defaultOfferTemplate`
 * already falls through.
 */
export async function setDefaultOfferTemplate(id: string): Promise<OfferTemplate> {
  const template = await getOfferTemplate(id);
  if (template.isDefault) return template;

  const db = getSupabaseAdmin();
  const cleared = await db.from("offer_templates").update({ is_default: false }).eq("is_default", true);
  assertReadable(cleared.error, "offer_templates");

  // Written directly rather than through `updateOfferTemplate`, whose whole contract is that it
  // never touches a field the caller did not name — `is_default` is not one of its fields.
  const { data, error } = await db
    .from("offer_templates")
    .update({ is_default: true })
    .eq("id", id)
    .select("*")
    .maybeSingle();

  assertReadable(error, "offer_templates");
  if (!data) throw new OfferNotFoundError("That offer template does not exist.");
  return toTemplate(data as TemplateRow);
}

/**
 * Delete a template.
 *
 * A built-in is refused. It is one of the owner's own uploaded letters and the thing every other
 * template is a departure from; losing it would mean losing a design nobody can reconstruct by
 * hand. (The seeder would rebuild it, but only after a confusing gap, and any edit made to it
 * would be gone.) Restore is the button for "I have made a mess of this one".
 */
export async function deleteOfferTemplate(id: string): Promise<void> {
  const template = await getOfferTemplate(id);
  if (template.builtinKey !== null) {
    throw new Error(
      `"${template.name}" is a built-in design and cannot be deleted. Duplicate it and edit the copy, or use Restore to put it back as it shipped.`,
    );
  }
  if (template.isDefault) {
    throw new Error("This template is the one new offers open on. Make another template the default first.");
  }

  const db = getSupabaseAdmin();
  const { error } = await db.from("offer_templates").delete().eq("id", id);
  assertReadable(error, "offer_templates");
}

/** Put one built-in design back exactly as it ships, discarding every edit made to it. */
export async function restoreBuiltinTemplate(key: string): Promise<OfferTemplate> {
  const builtin = offerBuiltinTemplate(key);
  if (!builtin) throw new OfferNotFoundError("That is not one of the built-in designs.");

  const templates = await ensureBuiltinTemplates();
  const current = templates.find((template) => template.builtinKey === builtin.key);
  if (!current) throw new OfferNotFoundError("That built-in design could not be seeded.");

  return updateOfferTemplate(current.id, {
    blocks: builtin.blocks(),
    fontFamily: builtin.fontFamily,
    fontSizePt: builtin.fontSizePt,
    name: builtin.name,
    theme: builtin.theme,
    variant: builtin.variant,
  });
}

// ────────────────────────────────────────────────────────────────── job titles ──

type JobTitleRow = {
  active: boolean | null;
  contract_term: string | null;
  cost_of_living: number | string | null;
  id: string;
  reports_to: string | null;
  role_summary?: string | null;
  template_id?: string | null;
  title: string;
};

function toJobTitle(row: JobTitleRow): OfferJobTitle {
  return {
    active: row.active !== false,
    contractTerm: row.contract_term,
    costOfLiving: Number(row.cost_of_living) || 0,
    id: row.id,
    reportsTo: row.reports_to,
    // Optional on the row for the same reason `template_id` is, below: an environment that has not
    // had the role-summary migration applied returns no such key, and `undefined` must read as "this
    // position has no wording of its own" — which prints the standard sentence, never a gap.
    roleSummary: row.role_summary ?? null,
    // Optional on the row, not required: a build that reaches an environment where migration
    // 20260827160000 has not run yet reads `select("*")` without the column, and an `undefined`
    // must land as an unbound title rather than reaching a `<select>` as a dead value.
    templateId: row.template_id ?? null,
    title: row.title,
  };
}

/**
 * "" and undefined both mean "no preference"; anything else is a template id.
 *
 * The empty string is the case that matters. The picker's "Use the default template" option
 * carries `value=""`, so choosing it posts `""` — and Postgres answers an empty string in a uuid
 * column with `22P02 invalid input syntax`, a 500 raised by the most ordinary action on the screen.
 */
function toTemplateId(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed === "" ? null : trimmed;
}

/**
 * A cleared role paragraph stores NULL, not an empty string.
 *
 * The two would render identically today — `offerRoleSummary` answers both with the standard
 * sentence — but only one of them reads as "nobody has worded this position" to the next person to
 * query this table, and a column that holds both for the same meaning is how a later `is null`
 * check quietly misses half the rows.
 */
function toRoleSummary(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed === "" ? null : trimmed;
}

export async function listOfferJobTitles(): Promise<OfferJobTitle[]> {
  const db = getSupabaseAdmin();
  const { data, error } = await db.from("offer_job_titles").select("*").order("title", { ascending: true });
  assertReadable(error, "offer_job_titles");
  return (data ?? []).map((row) => toJobTitle(row as JobTitleRow));
}

export async function createOfferJobTitle(input: OfferJobTitleInput): Promise<OfferJobTitle> {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("offer_job_titles")
    .insert({
      active: input.active !== false,
      contract_term: input.contractTerm ?? null,
      cost_of_living: Math.max(0, Number(input.costOfLiving) || 0),
      reports_to: input.reportsTo ?? null,
      role_summary: toRoleSummary(input.roleSummary),
      template_id: toTemplateId(input.templateId),
      title: input.title.trim(),
    })
    .select("*")
    .single();

  if (error?.code === "23505") {
    throw new Error(`"${input.title.trim()}" is already in the job-title list.`);
  }
  if (error?.code === "23503") throw new Error("That letter template no longer exists.");
  assertReadable(error, "offer_job_titles");
  return toJobTitle(data as JobTitleRow);
}

export async function updateOfferJobTitle(
  id: string,
  input: Partial<OfferJobTitleInput>,
): Promise<OfferJobTitle> {
  const db = getSupabaseAdmin();

  // Optional-field discipline again: an absent key must be OMITTED, not written as null.
  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title.trim();
  if (input.costOfLiving !== undefined) patch.cost_of_living = Math.max(0, Number(input.costOfLiving) || 0);
  if (input.reportsTo !== undefined) patch.reports_to = input.reportsTo;
  if (input.contractTerm !== undefined) patch.contract_term = input.contractTerm;
  if (input.roleSummary !== undefined) patch.role_summary = toRoleSummary(input.roleSummary);
  if (input.templateId !== undefined) patch.template_id = toTemplateId(input.templateId);
  if (input.active !== undefined) patch.active = input.active;

  if (Object.keys(patch).length === 0) {
    const current = await listOfferJobTitles();
    const found = current.find((t) => t.id === id);
    if (!found) throw new OfferNotFoundError("That job title does not exist.");
    return found;
  }

  const { data, error } = await db.from("offer_job_titles").update(patch).eq("id", id).select("*").maybeSingle();
  if (error?.code === "23505") throw new Error("Another job title already uses that name.");
  if (error?.code === "23503") throw new Error("That letter template no longer exists.");
  assertReadable(error, "offer_job_titles");
  if (!data) throw new OfferNotFoundError("That job title does not exist.");
  return toJobTitle(data as JobTitleRow);
}

export async function deleteOfferJobTitle(id: string): Promise<void> {
  const db = getSupabaseAdmin();
  const { error } = await db.from("offer_job_titles").delete().eq("id", id);
  assertReadable(error, "offer_job_titles");
}

/**
 * The cost of living for a title, matched case- and whitespace-insensitively.
 *
 * Returns null for an unlisted title rather than 0. Zero would look like a valid answer and would
 * INFLATE basic and transport — the whole package would be split as though no cost-of-living
 * allowance existed, on a document somebody signs. A null makes the caller decide.
 */
export function findJobTitle(titles: OfferJobTitle[], name: string): OfferJobTitle | null {
  const needle = name.trim().toLowerCase();
  return titles.find((t) => t.title.trim().toLowerCase() === needle) ?? null;
}

/**
 * The letter design bound to a title, matched the same way its cost of living is.
 *
 * Null for an unbound title, an unlisted one, or a blank one — and deliberately NOT the default
 * template's id. Writing the default's id onto the offer would pin today's default forever; a null
 * keeps following whichever template holds the flag at the moment the letter is rendered, which is
 * what "no preference" has always meant here.
 *
 * Swallows a read failure into null rather than throwing. This runs inside offer creation, and a
 * catalogue that cannot be read is not a reason to refuse to write an offer — it is a reason to
 * fall back to the default design, which is where every offer started before bindings existed.
 */
export async function lookupOfferTemplateIdForTitle(title: string): Promise<string | null> {
  if (!title.trim()) return null;
  try {
    return findJobTitle(await listOfferJobTitles(), title)?.templateId ?? null;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────── offers ──

type OfferRow = {
  // Optional, like every column added after the module shipped: a database without the joining-form
  // migration returns no such keys, and that must read as "not answered through the form".
  accepted_at?: string | null;
  accepted_via?: string | null;
  // Optional: the HR Manager's approval columns (20261110190002). Absent reads as "no approval on record".
  approval_requested_at?: string | null;
  approval_requested_by?: string | null;
  approval_return_reason?: string | null;
  approval_returned_at?: string | null;
  approval_returned_by?: string | null;
  approved_at?: string | null;
  approved_by?: string | null;
  employee_hr_id?: string | null;
  // Optional: `select("*")` against a database that has not had 20260928225001 applied returns no
  // such key, and that must read as "nobody copied", not throw.
  bcc_recipients?: string[] | null;
  candidate_email: string;
  candidate_name: string;
  cc_recipients?: string[] | null;
  contract_term: string | null;
  cost_of_living: number | string | null;
  created_at: string | null;
  created_by: string | null;
  date_of_issue: string | null;
  // Optional: HR's message and the update columns (20261110195450). Absent reads as "no message, never updated".
  email_message?: string | null;
  id: string;
  reference: string | null;
  revised_at?: string | null;
  revised_by?: string | null;
  revision?: number | string | null;
  revision_history?: unknown;
  reports_to: string | null;
  // Optional for the same reason as the copy lists above: an environment without the role-summary
  // migration returns no such key, and that must read as "the standard paragraph", not throw.
  role_summary?: string | null;
  salutation_name: string | null;
  sent_at: string | null;
  sent_by: string | null;
  start_date: string | null;
  status: string;
  template_id: string | null;
  template_snapshot: unknown;
  territory: string | null;
  title: string;
  total_monthly: number | string | null;
  valid_until: string | null;
  // Optional for the same reason as the copy lists above: a database without 20260929161030
  // applied returns no such key, and that must read as "no seat chosen" rather than throw.
  vacancy_id?: number | string | null;
};

function toOffer(row: OfferRow): OfferRecord {
  const snapshot = row.template_snapshot as
    | { blocks?: unknown; fontFamily?: unknown; fontSizePt?: unknown; theme?: unknown; variant?: unknown }
    | null;

  return {
    acceptedAt: row.accepted_at ?? null,
    acceptedVia: row.accepted_via === "candidate_form" || row.accepted_via === "hr" ? row.accepted_via : null,
    approval: {
      approvedAt: row.approved_at ?? null,
      approvedBy: row.approved_by ?? null,
      requestedAt: row.approval_requested_at ?? null,
      requestedBy: row.approval_requested_by ?? null,
      returnedAt: row.approval_returned_at ?? null,
      returnedBy: row.approval_returned_by ?? null,
      returnReason: row.approval_return_reason ?? null,
    },
    bccRecipients: Array.isArray(row.bcc_recipients) ? row.bcc_recipients : [],
    candidateEmail: row.candidate_email,
    candidateName: row.candidate_name,
    ccRecipients: Array.isArray(row.cc_recipients) ? row.cc_recipients : [],
    contractTerm: row.contract_term ?? "",
    costOfLiving: Number(row.cost_of_living) || 0,
    createdAt: row.created_at,
    createdBy: row.created_by,
    dateOfIssue: row.date_of_issue ?? "",
    emailMessage: row.email_message ?? "",
    employeeHrId: row.employee_hr_id?.trim() || null,
    id: row.id,
    reference: row.reference ?? "",
    revisedAt: row.revised_at ?? null,
    revisedBy: row.revised_by ?? null,
    revision: Math.max(0, Math.trunc(Number(row.revision) || 0)),
    revisionHistory: Array.isArray(row.revision_history) ? (row.revision_history as OfferRevision[]) : [],
    reportsTo: row.reports_to ?? "",
    roleSummary: row.role_summary ?? "",
    salutationName: row.salutation_name ?? "",
    sentAt: row.sent_at,
    sentBy: row.sent_by,
    startDate: row.start_date ?? "",
    status: row.status as OfferStatus,
    templateId: row.template_id,
    templateSnapshot: snapshot
      ? {
          blocks: sanitizeTemplateBlocks(snapshot.blocks),
          fontFamily: String(snapshot.fontFamily || OFFER_DEFAULT_FONT),
          fontSizePt: Number(snapshot.fontSizePt) || OFFER_DEFAULT_FONT_SIZE_PT,
          theme: sanitizeTheme(snapshot.theme),
          variant: isOfferTemplateVariant(snapshot.variant) ? snapshot.variant : "classic",
        }
      : null,
    territory: row.territory ?? "",
    title: row.title,
    totalMonthly: Number(row.total_monthly) || 0,
    // `Number(null)` is 0 and `Number("")` is 0, and 0 is not a vacancy id — it would be read as a
    // seat that does not exist rather than as no seat at all. Only a finite positive number counts.
    vacancyId: offerVacancyId(row.vacancy_id),
    validUntil: row.valid_until ?? "",
  };
}

/** A stored vacancy pointer, or null. Bigint arrives as a string often enough to matter here. */
function offerVacancyId(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function listOffers(limit = 200): Promise<OfferRecord[]> {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("offers")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  assertReadable(error, "offers");
  return (data ?? []).map((row) => toOffer(row as OfferRow));
}

/**
 * The newest DRAFT letter already on file for this job title and this candidate email, or null.
 *
 * Asked of the database by email, never found in `listOffers`: that list is only the newest 200
 * letters, so a draft older than that was invisible here and the same candidate was given a second
 * letter, with a second reference number, for the same job. The email narrows the read in SQL (a
 * contains-match that tolerates stray spaces and any case, with LIKE's own characters escaped); the
 * exact comparison of both fields is done here, so the SQL can only ever over-read, never miss one.
 * Paged to the last row, because the answer must not depend on how many letters one email has.
 */
export async function findDraftOfferFor(title: string, candidateEmail: string): Promise<OfferRecord | null> {
  const wantedEmail = candidateEmail.trim().toLowerCase();
  if (!wantedEmail || !title.trim()) return null;

  const db = getSupabaseAdmin();
  let rows: OfferRow[];
  try {
    rows = await fetchAllRows<OfferRow>(
      () =>
        db
          .from("offers")
          .select("*")
          .eq("status", "draft")
          .ilike("candidate_email", offerEmailLikePattern(wantedEmail))
          .order("created_at", { ascending: false }),
      "id",
    );
  } catch (error) {
    assertReadable(error as { code?: string; message?: string }, "offers");
    throw error;
  }

  const match = pickDraftOfferRow(rows, title, candidateEmail);
  return match ? toOffer(match) : null;
}

/**
 * A contains-match for an email address that ignores case and tolerates stray spaces, with LIKE's own
 * characters (`\`, `%`, `_`) escaped with its default escape character, so an address with an underscore
 * in it is read literally. It can only over-read; `pickDraftOfferRow` makes the exact call.
 */
export function offerEmailLikePattern(email: string): string {
  const escaped = email.trim().toLowerCase().replace(/[\\%_]/g, (character) => `\\${character}`);
  return `%${escaped}%`;
}

/** The first row, in the order given (newest first), whose title and email both match exactly, ignoring case and edge spaces. */
export function pickDraftOfferRow<T extends { candidate_email: string; title: string }>(
  rows: readonly T[],
  title: string,
  candidateEmail: string,
): T | undefined {
  const wantedEmail = candidateEmail.trim().toLowerCase();
  const wantedTitle = title.trim().toLowerCase();
  if (!wantedEmail || !wantedTitle) return undefined;
  return rows.find(
    (row) => row.candidate_email.trim().toLowerCase() === wantedEmail && row.title.trim().toLowerCase() === wantedTitle,
  );
}

export async function getOffer(id: string): Promise<OfferRecord> {
  const db = getSupabaseAdmin();
  const { data, error } = await db.from("offers").select("*").eq("id", id).maybeSingle();
  assertReadable(error, "offers");
  if (!data) throw new OfferNotFoundError("That offer does not exist.");
  return toOffer(data as OfferRow);
}

function toRow(fields: Partial<OfferFields>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (fields.candidateName !== undefined) patch.candidate_name = fields.candidateName.trim();
  if (fields.salutationName !== undefined) patch.salutation_name = fields.salutationName.trim();
  if (fields.candidateEmail !== undefined) patch.candidate_email = fields.candidateEmail.trim();
  if (fields.title !== undefined) patch.title = fields.title.trim();
  if (fields.territory !== undefined) patch.territory = fields.territory;
  if (fields.reportsTo !== undefined) patch.reports_to = fields.reportsTo;
  if (fields.roleSummary !== undefined) patch.role_summary = fields.roleSummary.trim();
  if (fields.startDate !== undefined) patch.start_date = fields.startDate;
  if (fields.contractTerm !== undefined) patch.contract_term = fields.contractTerm;
  if (fields.reference !== undefined) patch.reference = fields.reference;
  if (fields.dateOfIssue !== undefined) patch.date_of_issue = fields.dateOfIssue;
  if (fields.validUntil !== undefined) patch.valid_until = fields.validUntil;
  if (fields.totalMonthly !== undefined) patch.total_monthly = Math.max(0, Number(fields.totalMonthly) || 0);
  if (fields.costOfLiving !== undefined) patch.cost_of_living = Math.max(0, Number(fields.costOfLiving) || 0);
  return patch;
}

/**
 * The next free reference for a title in a year, read from what is already on file.
 *
 * Fetches only the references that could possibly matter — this title's code, this year — rather
 * than the whole table. `listOffers` caps at 200 rows and orders by date, so counting from it
 * would start skipping numbers the moment the 201st offer existed, and would do so silently.
 *
 * A read failure here returns the first number rather than throwing. The alternative is an offer
 * that cannot be created because its reference could not be counted, and a reference is a filing
 * convenience — it must never be the reason a candidate does not get their letter. The unique
 * index is what actually guarantees the number is not already taken.
 */
export async function allocateOfferReference(title: string, year: number): Promise<string> {
  const db = getSupabaseAdmin();
  const prefix = `${OFFER_REFERENCE_PREFIX}-${offerTitleCode(title)}-${year}-`;

  const { data, error } = await db.from("offers").select("reference").like("reference", `${prefix}%`);

  if (error) return nextOfferReference(title, year, []);
  return nextOfferReference(title, year, (data ?? []).map((row) => String((row as { reference: string | null }).reference ?? "")));
}

/** Postgres' unique-violation code. Two offers reached for the same number in the same instant. */
const UNIQUE_VIOLATION = "23505";

export async function createOffer(
  fields: OfferFields & { emailMessage?: string | null; templateId?: string | null; vacancyId?: number | null },
  createdBy: string | null,
): Promise<OfferRecord> {
  const db = getSupabaseAdmin();

  // The title's own design, when the caller named no template. The composer always names one, so
  // this is for everything else that can create an offer — and without it the per-title binding
  // would be a convenience in one screen rather than a property of the title, which is what it was
  // asked to be. A title with no binding still resolves to null, and null still means "the
  // default", exactly as before.
  const templateId = toTemplateId(fields.templateId) ?? (await lookupOfferTemplateIdForTitle(fields.title));

  // Only when the caller left it blank. A reference typed by hand is a deliberate act — somebody
  // continuing a run from a paper file, or reissuing under an agreed number — and overwriting it
  // with a generated one would quietly discard that decision.
  const generating = fields.reference.trim() === "";
  // The year the LETTER is dated, not the year the row is written — an offer dated 31 December and
  // saved after midnight belongs to the run its own date names. Falls back to now only when the
  // letter carries no readable date at all.
  const issued = parseLetterDate(fields.dateOfIssue);
  const year = issued ? Number(issued.slice(0, 4)) : new Date().getUTCFullYear();

  // Two attempts, not a loop. The second reads the highest number again, which now includes
  // whatever the other writer just committed, so it can only collide again if a third offer landed
  // in the same instant — and at that point a clear error beats spinning.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reference = generating ? await allocateOfferReference(fields.title, year) : fields.reference;

    const { data, error } = await db
      .from("offers")
      .insert({
        ...toRow({ ...fields, reference }),
        created_by: createdBy,
        // Only when one was written: an insert that names the column fails on a database without it.
        ...(fields.emailMessage ? { email_message: fields.emailMessage } : {}),
        status: "draft",
        template_id: templateId,
        vacancy_id: offerVacancyId(fields.vacancyId),
      })
      .select("*")
      .single();

    if (error?.code === UNIQUE_VIOLATION) {
      if (generating && attempt === 0) continue;
      throw new Error(
        `The reference ${reference} is already used by another offer. Clear the reference box to have a new one allocated.`,
      );
    }

    assertReadable(error, "offers");
    return toOffer(data as OfferRow);
  }

  // Unreachable: the loop either returns or throws. Present so the function has one exit type.
  throw new Error("Could not allocate a reference for this offer. Try again.");
}

export async function updateOffer(
  id: string,
  fields: Partial<OfferFields> & { emailMessage?: string | null; templateId?: string | null; vacancyId?: number | null },
  options: { canApprove?: boolean } = {},
): Promise<OfferRecord> {
  const current = await getOffer(id);
  // An offer waiting for the HR Manager is HIS to edit (owner, 2026-11-10: "I have the option to edit
  // anything in the offer") and nobody else's — Talent Acquisition changing it under him would make
  // what he approves differ from what he read.
  const editable = current.status === "draft" || (current.status === "pending_approval" && options.canApprove === true);
  if (!editable) {
    throw new Error(offerEditRefusal(current.status));
  }

  const patch = toRow(fields);
  if (fields.templateId !== undefined) patch.template_id = fields.templateId;
  // Same optional-field discipline as everywhere else in this file: an absent key is OMITTED, not
  // written as null. An explicit null IS meaningful here — it is how a seat is un-chosen — so the
  // `undefined` check is what tells the two apart.
  if (fields.vacancyId !== undefined) patch.vacancy_id = offerVacancyId(fields.vacancyId);
  // HR's message for the email (owner, 2026-11-10). Only written when it changed, so a database without
  // the column still saves every other edit as long as nobody has typed a message.
  if (fields.emailMessage !== undefined && (fields.emailMessage ?? "") !== (current.emailMessage ?? "")) {
    patch.email_message = fields.emailMessage || null;
  }
  if (Object.keys(patch).length === 0) return current;

  const db = getSupabaseAdmin();
  const { data, error } = await db.from("offers").update(patch).eq("id", id).select("*").maybeSingle();
  assertReadable(error, "offers");
  if (!data) throw new OfferNotFoundError("That offer does not exist.");
  return toOffer(data as OfferRow);
}

/** Why an offer of this status cannot be edited by this person. */
export function offerEditRefusal(status: OfferStatus): string {
  if (status === "pending_approval") {
    return "This offer is waiting for the HR Manager's approval. Only the HR Manager can edit it now, or reject it back to draft.";
  }
  // A sent offer is a document the candidate already holds. Editing it would make Phoenix's copy
  // disagree with theirs, silently — so a change goes through Update offer, which keeps the version
  // that went out and sends the candidate the new one (owner, 2026-11-10).
  return "This offer has already been sent and can no longer be edited here. Use Update offer to change it and send the candidate the updated offer.";
}

/**
 * Talent Acquisition's Send: park the draft for the HR Manager (owner, 2026-11-10). Nothing is
 * emailed. The copies typed on the screen are kept on the row so his Approve and send uses them.
 * Conditional on `draft`, so a double press or a stale tab cannot re-stamp a request already waiting.
 */
export async function markOfferPendingApproval(
  id: string,
  requestedBy: string | null,
  copies: { bcc: string[]; cc: string[] },
): Promise<OfferRecord> {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("offers")
    .update({
      approval_requested_at: new Date().toISOString(),
      approval_requested_by: requestedBy,
      // A fresh request clears the last rejection, so the row never shows an old reason as current.
      approval_return_reason: null,
      approval_returned_at: null,
      approval_returned_by: null,
      bcc_recipients: copies.bcc,
      cc_recipients: copies.cc,
      status: "pending_approval",
    })
    .eq("id", id)
    .eq("status", "draft")
    .select("*")
    .maybeSingle();

  assertReadable(error, "offers");
  if (!data) throw new Error("This offer is no longer a draft — it may already be waiting for approval or sent.");
  return toOffer(data as OfferRow);
}

/**
 * The HR Manager's Reject: the offer goes back to draft, unsent, with his reason for Talent
 * Acquisition. Conditional on `pending_approval`, so it can never pull back an offer already sent.
 */
export async function returnOfferToDraft(id: string, returnedBy: string | null, reason: string): Promise<OfferRecord> {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("offers")
    .update({
      approval_return_reason: reason.trim() || null,
      approval_returned_at: new Date().toISOString(),
      approval_returned_by: returnedBy,
      status: "draft",
    })
    .eq("id", id)
    .eq("status", "pending_approval")
    .select("*")
    .maybeSingle();

  assertReadable(error, "offers");
  if (!data) throw new Error("This offer is not waiting for approval any more — it may already have been sent or rejected.");
  return toOffer(data as OfferRow);
}

/**
 * "Update offer" (owner, 2026-11-10: "i may need to update a job offer"). The version that went out is
 * frozen into `revision_history` — its terms, its letter, who sent and approved it — and the SAME row
 * returns to draft with `revision` raised by one, ready to edit and send again through the ordinary Send
 * (so Talent Acquisition's update waits for the HR Manager like any send).
 *
 * Conditional on the status AND the revision it read, so two presses, or two people, cannot each freeze
 * a copy: the second finds the row moved and is refused.
 */
export async function startOfferRevision(id: string, by: string | null): Promise<OfferRecord> {
  const current = await getOffer(id);
  const refusal = offerRevisionRefusal(current);
  if (refusal) throw new Error(refusal);

  const revision = current.revision ?? 0;
  const entry: OfferRevision = {
    approvedAt: current.approval?.approvedAt ?? null,
    approvedBy: current.approval?.approvedBy ?? null,
    bcc: current.bccRecipients,
    cc: current.ccRecipients,
    emailMessage: current.emailMessage?.trim() || null,
    fields: {
      candidateEmail: current.candidateEmail,
      candidateName: current.candidateName,
      contractTerm: current.contractTerm,
      costOfLiving: current.costOfLiving,
      dateOfIssue: current.dateOfIssue,
      reference: current.reference,
      reportsTo: current.reportsTo,
      roleSummary: current.roleSummary,
      salutationName: current.salutationName,
      startDate: current.startDate,
      territory: current.territory,
      title: current.title,
      totalMonthly: current.totalMonthly,
      validUntil: current.validUntil,
    },
    requestedBy: current.approval?.requestedBy ?? null,
    revision,
    sentAt: current.sentAt,
    sentBy: current.sentBy,
    supersededAt: new Date().toISOString(),
    supersededBy: by,
    templateId: current.templateId,
    templateSnapshot: current.templateSnapshot,
    vacancyId: current.vacancyId,
  };

  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("offers")
    .update({
      // A fresh approval cycle: the last request and rejection belong to the version just frozen.
      approval_requested_at: null,
      approval_requested_by: null,
      approval_return_reason: null,
      approval_returned_at: null,
      approval_returned_by: null,
      revised_at: entry.supersededAt,
      revised_by: by,
      revision: revision + 1,
      revision_history: [...(current.revisionHistory ?? []), entry],
      status: "draft",
    })
    .eq("id", id)
    .eq("status", "sent")
    .eq("revision", revision)
    .select("*")
    .maybeSingle();

  assertReadable(error, "offers");
  if (!data) throw new Error("This offer changed while you were looking at it — it may already be being updated, or answered. Reload and try again.");
  return toOffer(data as OfferRow);
}

/**
 * "Cancel update": the version that went out comes back exactly as it was — terms, letter, who sent it
 * and when, the copies and the message — and the row is `sent` again, so the candidate's link opens it.
 * Whatever was typed into the update is discarded. Conditional like the start, for the same reason.
 */
export async function cancelOfferRevision(id: string): Promise<OfferRecord> {
  const current = await getOffer(id);
  const refusal = offerRevisionCancelRefusal(current);
  if (refusal) throw new Error(refusal);

  const history = current.revisionHistory ?? [];
  const previous = history[history.length - 1];
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("offers")
    .update({
      ...toRow(previous.fields),
      approval_requested_at: null,
      approval_requested_by: previous.requestedBy,
      approval_return_reason: null,
      approval_returned_at: null,
      approval_returned_by: null,
      approved_at: previous.approvedAt,
      approved_by: previous.approvedBy,
      bcc_recipients: previous.bcc ?? [],
      cc_recipients: previous.cc ?? [],
      email_message: previous.emailMessage,
      revised_at: null,
      revised_by: null,
      revision: previous.revision,
      revision_history: history.slice(0, -1),
      sent_at: previous.sentAt,
      sent_by: previous.sentBy,
      status: "sent",
      template_id: previous.templateId,
      template_snapshot: previous.templateSnapshot,
      vacancy_id: offerVacancyId(previous.vacancyId),
    })
    .eq("id", id)
    .eq("status", "draft")
    .eq("revision", current.revision ?? 0)
    .select("*")
    .maybeSingle();

  assertReadable(error, "offers");
  if (!data) throw new Error("This offer changed while you were looking at it — the update may already have been sent. Reload and try again.");
  return toOffer(data as OfferRow);
}

/**
 * Freeze the template onto the offer and mark it sent.
 *
 * The snapshot is the point. Once an offer has gone out, editing the template it used must not
 * change what Phoenix believes was sent — the candidate holds a PDF, and that PDF is the offer.
 *
 * The status filter in the WHERE clause (a draft, or an offer waiting for the HR Manager) is a
 * precondition, not decoration: two clicks on Send, or a retry after a timeout, would otherwise each
 * mark it sent and each move `sent_at`. A zero-row result here means somebody else already sent it.
 *
 * Who was copied is written in the same UPDATE (owner, 2026-09-28: "show who was copied on each
 * offer in the offers list"). One statement, so a sent offer can never exist without its copy list,
 * and a draft never carries one.
 */
export async function markOfferSent(
  id: string,
  template: Pick<OfferTemplate, "blocks" | "fontFamily" | "fontSizePt" | "theme" | "variant">,
  sentBy: string | null,
  copies: { bcc: string[]; cc: string[] } = { bcc: [], cc: [] },
  approvedBy: string | null = sentBy,
): Promise<OfferRecord> {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("offers")
    .update({
      // Only the HR Manager sends (owner, 2026-11-10), so the send IS the approval.
      approved_at: new Date().toISOString(),
      approved_by: approvedBy,
      bcc_recipients: copies.bcc,
      cc_recipients: copies.cc,
      sent_at: new Date().toISOString(),
      sent_by: sentBy,
      status: "sent",
      template_snapshot: {
        blocks: template.blocks,
        fontFamily: template.fontFamily,
        fontSizePt: template.fontSizePt,
        theme: template.theme,
        variant: template.variant,
      },
    })
    .eq("id", id)
    .in("status", ["draft", "pending_approval"])
    .select("*")
    .maybeSingle();

  assertReadable(error, "offers");
  if (!data) throw new Error("This offer is no longer a draft — it may already have been sent.");
  return toOffer(data as OfferRow);
}

export async function setOfferStatus(id: string, status: OfferStatus): Promise<OfferRecord> {
  const db = getSupabaseAdmin();
  const { data, error } = await db.from("offers").update({ status }).eq("id", id).select("*").maybeSingle();
  assertReadable(error, "offers");
  if (!data) throw new OfferNotFoundError("That offer does not exist.");
  const offer = toOffer(data as OfferRow);
  // An accepted offer means a candidate is ready to be seated — tell whoever hires (owner,
  // 2026-10-02). Idempotent per offer id and swallows its own failures, so it can never block the
  // status write; a correction that re-marks the same offer accepted does not fire a second alert.
  if (offer.status === "accepted") {
    await announceAcceptedOffer(offer);
  }
  return offer;
}

// ─────────────────────────────────────────────────────────── the joining form ──

/** How long a submit holds the offer before another may try — far longer than a hire takes to write. */
const JOINING_CLAIM_MINUTES = 10;

/**
 * Take the offer for ONE joining-form submit, or return false when another submit holds it or has
 * already finished. A conditional UPDATE is the lock: two presses of Submit a second apart race on
 * this row, exactly one wins, and the loser never reaches the employee insert — so a double-tap can
 * never make two employee records for one person.
 */
export async function claimOfferForJoiningForm(id: string): Promise<boolean> {
  const db = getSupabaseAdmin();
  const staleBefore = new Date(Date.now() - JOINING_CLAIM_MINUTES * 60_000).toISOString();
  const { data, error } = await db
    .from("offers")
    .update({ joining_claimed_at: new Date().toISOString() })
    .eq("id", id)
    .is("employee_hr_id", null)
    .in("status", ["sent", "accepted"])
    .or(`joining_claimed_at.is.null,joining_claimed_at.lt."${staleBefore}"`)
    .select("id")
    .maybeSingle();
  assertReadable(error, "offers");
  return Boolean(data);
}

/** Give the claim back after a submit that failed before any record was written, so he can try again. */
export async function releaseOfferJoiningClaim(id: string): Promise<void> {
  const db = getSupabaseAdmin();
  await db.from("offers").update({ joining_claimed_at: null }).eq("id", id).is("employee_hr_id", null);
}

/**
 * The acceptance, written once the employee record exists: the offer is accepted, by the form, at
 * this moment, and points at the record it produced. Then the same alert HR's own "Accepted" button
 * fires (`announceAcceptedOffer`, in-app + push + Telegram, never email, idempotent per offer).
 */
export async function stampOfferAcceptedByJoiningForm(
  id: string,
  hire: { hrId: string; idPhotosFiled?: boolean; seated?: boolean; workEmail: string | null },
): Promise<OfferRecord> {
  const employeeHrId = hire.hrId;
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("offers")
    .update({
      accepted_at: new Date().toISOString(),
      accepted_via: "candidate_form",
      employee_hr_id: employeeHrId,
      status: "accepted",
    })
    .eq("id", id)
    .select("*")
    .maybeSingle();
  assertReadable(error, "offers");
  if (!data) throw new OfferNotFoundError("That offer does not exist.");
  const offer = toOffer(data as OfferRow);
  await announceAcceptedOffer(offer, hire);
  return offer;
}

/**
 * HR's own Add Employee, started from an ACCEPTED letter: point the letter at the record that was
 * made from it.
 *
 * WHY THIS EXISTS. The joining form stamps `employee_hr_id` (above); HR's door never did. Of the 26
 * accepted letters on production on 2026-10-14, 24 had been hand-recorded and only 2 pointed at an
 * employee, so "Offer to join" read 2 of 26 while 21 of those people were already on the Employee
 * Master. The Talent Acquisition dashboard then reported the offers and the hires as two unrelated
 * stories (owner, 2026-10-14: "extremely wrong data").
 *
 * CONDITIONAL, NEVER AN OVERWRITE. It writes only to a letter that is accepted and not yet linked,
 * so a second save, a stale tab, or a form opened from the wrong letter cannot repoint a letter that
 * already names somebody. Returns null when nothing matched — the hire is already written by the
 * time this runs, so "no letter to link" is an answer, not an error.
 */
export async function stampOfferHiredByHr(id: string, hrId: string): Promise<OfferRecord | null> {
  const employeeHrId = String(hrId ?? "").trim();
  if (!employeeHrId) return null;
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("offers")
    .update({ employee_hr_id: employeeHrId })
    .eq("id", id)
    .eq("status", "accepted")
    .is("employee_hr_id", null)
    .select("*")
    .maybeSingle();
  assertReadable(error, "offers");
  return data ? toOffer(data as OfferRow) : null;
}

/**
 * The person who accepted this letter backed out after being hired ("declined offer"): the letter
 * stops saying accepted.
 *
 * Keyed on the EMPLOYEE the letter points at, never on a name or an address — the same rule that
 * keeps every offer-to-person link in this module an explicit pointer. A letter that was
 * hand-recorded before the pointer existed is not found here, which is why
 * `stampOfferHiredByHr` and the joining form's stamp matter. Returns the letters it changed.
 */
export async function declineAcceptedOffersForEmployee(hrId: string): Promise<OfferRecord[]> {
  const keys = hrIdLookupKeys(hrId);
  if (keys.length === 0) return [];
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("offers")
    .update({ status: "declined" })
    .in("employee_hr_id", keys)
    .eq("status", "accepted")
    .select("*");
  assertReadable(error, "offers");
  return ((data ?? []) as OfferRow[]).map(toOffer);
}

export function offerErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Something went wrong with the offer.";
}

export function isOfferSchemaMissing(error: unknown): boolean {
  return error instanceof OfferSchemaMissingError;
}

export function isOfferNotFound(error: unknown): boolean {
  return error instanceof OfferNotFoundError;
}
