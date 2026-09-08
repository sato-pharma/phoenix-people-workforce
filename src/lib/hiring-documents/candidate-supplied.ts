// Which documents a person brings in themselves — the live answer, read from the checklist HR
// actually maintains rather than from a copy typed into a message template.
//
// WHY THIS IS NOT "EVERY ACTIVE DEFINITION". `hiring_document_definitions` is the WHOLE personnel
// file, joining and leaving both. Measured on production 2026-09-08: 16 slots, of which 7 are papers
// the person supplies and 8 are papers the COMPANY generates for them to sign — the employment
// contract, the confidentiality undertaking, social insurance Form 1 and Form 6, the resignation
// request, the mutual-termination agreement, and the two clearances.
//
// Six of those eight are EXIT paperwork. So a "document request" built from every active row would
// message somebody who has just accepted a job and ask them to bring their own resignation request
// and their own end-of-service clearance. It would be grammatical, it would look like a working
// feature, and nobody would notice until a new hire replied asking what was going on.
//
// THE FILTER IS "NO COMPANY PAPER FILES HERE", and it has two halves because the link is stored in
// two directions (see 20260904234000_hiring_document_definitions_name_their_paper.sql):
//
//   • `hiring_pack_document` — the seven built-in papers, pinned on the definition itself.
//   • `hiring_pack_custom_templates.files_under_document_id` — company templates point the other
//     way, because there are unboundedly many of them.
//
// The second half matches nothing today (zero custom templates on production, 2026-09-08) and is
// here anyway: the day somebody uploads a company template and files it under a slot, that slot
// stops being something to ask a candidate for, and a filter that only knew about the first half
// would go on asking for it with no error anywhere.
//
// NEVER MATCHED ON THE NAME. `name` is admin-editable free text — the migration above says so at
// length and chose a column for exactly this reason. Reading "Signed" as a prefix meaning
// company-generated would work this afternoon and break on the first rename.

import { getSupabaseAdmin } from "@/lib/supabase/server";

/** One checklist slot, as much of it as this question needs. */
export type DocumentSlot = {
  id: string;
  name: string | null;
  /** Non-null when a built-in company paper files into this slot. */
  hiringPackDocument?: string | null;
};

/** The bullet character the owner's own templates are written with. */
export const DOCUMENT_BULLET = "\u2022";

/**
 * The pure half: given the slots and the ids that company templates file under, which names does a
 * person supply themselves?
 *
 * Separated from the read so the rule can be tested against real row shapes rather than pinned by a
 * regex over this file. ORDER IS THE CALLER'S — the reader sorts by `display_order` then `name`, the
 * same two keys the Hiring Documents dashboard sorts by, so the message lists them in the order the
 * checklist shows them and the two never disagree.
 */
export function selectCandidateSuppliedNames(slots: DocumentSlot[], filedUnderDocumentIds: Iterable<string>): string[] {
  const filedUnder = new Set(filedUnderDocumentIds);
  return slots
    .filter((slot) => !slot.hiringPackDocument && !filedUnder.has(slot.id))
    .map((slot) => slot.name?.trim() ?? "")
    .filter(Boolean);
}

/**
 * The list as one block of text, ready to drop into a message.
 *
 * Returns "" for an empty list rather than a heading with nothing under it, so `renderTemplate`
 * reports the placeholder MISSING and the send is refused — the same refuse-rather-than-guess rule
 * every other auto-filled field follows.
 */
export function formatDocumentList(names: string[]): string {
  if (names.length === 0) return "";
  return names.map((name) => `${DOCUMENT_BULLET} ${name}`).join("\n");
}

type DefinitionRow = { hiring_pack_document: string | null; id: string; name: string | null };
type CustomTemplateRow = { files_under_document_id: string | null };

/**
 * The documents a candidate or new hire supplies themselves, live from the checklist.
 *
 * Returns `[]` — never throws — when the read fails. Every caller treats an empty list as "I do not
 * know what to ask for", which is a refused send, not a message with an empty bullet list in it.
 */
export async function listCandidateSuppliedDocumentNames(): Promise<string[]> {
  try {
    const supabase = getSupabaseAdmin();

    const [definitions, customTemplates] = await Promise.all([
      supabase
        .from("hiring_document_definitions")
        .select("id,name,hiring_pack_document")
        .eq("is_active", true)
        .order("display_order", { ascending: true })
        .order("name", { ascending: true }),
      supabase
        .from("hiring_pack_custom_templates")
        .select("files_under_document_id")
        .not("files_under_document_id", "is", null),
    ]);

    if (definitions.error) throw new Error(definitions.error.message);
    // A custom-template read that fails must NOT silently widen the list — that is the direction
    // that puts a company paper into a candidate's message. Treat it as fatal and return nothing,
    // so the send screen asks a human instead of guessing.
    if (customTemplates.error) throw new Error(customTemplates.error.message);

    const filedUnder = ((customTemplates.data ?? []) as CustomTemplateRow[])
      .map((row) => row.files_under_document_id)
      .filter((id): id is string => Boolean(id));

    const slots = ((definitions.data ?? []) as DefinitionRow[]).map((row) => ({
      hiringPackDocument: row.hiring_pack_document,
      id: row.id,
      name: row.name,
    }));

    return selectCandidateSuppliedNames(slots, filedUnder);
  } catch {
    return [];
  }
}

/** The live list as one block of text. See `formatDocumentList` for the empty case. */
export async function candidateSuppliedDocumentList(): Promise<string> {
  return formatDocumentList(await listCandidateSuppliedDocumentNames());
}
