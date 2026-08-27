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
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type {
  OfferBlock,
  OfferBlockType,
  OfferFields,
  OfferJobTitle,
  OfferJobTitleInput,
  OfferRecord,
  OfferStatus,
  OfferTemplate,
  OfferTemplateInput,
  OfferTheme,
} from "@/lib/offers/types";

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
  candidate_email: string;
  candidate_name: string;
  contract_term: string | null;
  cost_of_living: number | string | null;
  created_at: string | null;
  created_by: string | null;
  date_of_issue: string | null;
  id: string;
  reference: string | null;
  reports_to: string | null;
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
};

function toOffer(row: OfferRow): OfferRecord {
  const snapshot = row.template_snapshot as
    | { blocks?: unknown; fontFamily?: unknown; fontSizePt?: unknown; theme?: unknown; variant?: unknown }
    | null;

  return {
    candidateEmail: row.candidate_email,
    candidateName: row.candidate_name,
    contractTerm: row.contract_term ?? "",
    costOfLiving: Number(row.cost_of_living) || 0,
    createdAt: row.created_at,
    createdBy: row.created_by,
    dateOfIssue: row.date_of_issue ?? "",
    id: row.id,
    reference: row.reference ?? "",
    reportsTo: row.reports_to ?? "",
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
    validUntil: row.valid_until ?? "",
  };
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
  fields: OfferFields & { templateId?: string | null },
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
        status: "draft",
        template_id: templateId,
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
  fields: Partial<OfferFields> & { templateId?: string | null },
): Promise<OfferRecord> {
  const current = await getOffer(id);
  // A sent offer is a document the candidate already holds. Editing it would make Phoenix's copy
  // disagree with theirs, silently — withdraw and reissue instead.
  if (current.status !== "draft") {
    throw new Error("This offer has already been sent and can no longer be edited. Withdraw it and create a new one.");
  }

  const patch = toRow(fields);
  if (fields.templateId !== undefined) patch.template_id = fields.templateId;
  if (Object.keys(patch).length === 0) return current;

  const db = getSupabaseAdmin();
  const { data, error } = await db.from("offers").update(patch).eq("id", id).select("*").maybeSingle();
  assertReadable(error, "offers");
  if (!data) throw new OfferNotFoundError("That offer does not exist.");
  return toOffer(data as OfferRow);
}

/**
 * Freeze the template onto the offer and mark it sent.
 *
 * The snapshot is the point. Once an offer has gone out, editing the template it used must not
 * change what Phoenix believes was sent — the candidate holds a PDF, and that PDF is the offer.
 *
 * The `.eq("status", "draft")` in the WHERE clause is a precondition, not decoration: two clicks
 * on Send, or a retry after a timeout, would otherwise each mark it sent and each move `sent_at`.
 * A zero-row result here means somebody else already sent it.
 */
export async function markOfferSent(
  id: string,
  template: Pick<OfferTemplate, "blocks" | "fontFamily" | "fontSizePt" | "theme" | "variant">,
  sentBy: string | null,
): Promise<OfferRecord> {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("offers")
    .update({
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
    .eq("status", "draft")
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
  return toOffer(data as OfferRow);
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
