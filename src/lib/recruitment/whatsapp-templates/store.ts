// Recruitment / ATS — reading and writing the owner's WhatsApp message templates, and the
// append-only record of every message prepared from one.
//
// Mirrors whatsapp-question-prompts-store.ts: the same table-shaped store, the same "an admin typed
// this, so re-check it on the way in as well as on the way out" posture.

import { logError } from "@/lib/observability/log";
import { boolOrNull, numberOrNull, recruitmentDb, textOrNull } from "@/lib/recruitment/db";
import {
  templateDraftViolations,
  type TemplateDraft,
  type WhatsAppTemplate,
} from "@/lib/recruitment/whatsapp-templates/template";
import { extractVariableKeys } from "@/lib/recruitment/whatsapp-templates/variables";

const TEMPLATES_TABLE = "ats_whatsapp_message_templates";
const SENDS_TABLE = "ats_whatsapp_template_sends";

const TEMPLATE_COLUMNS = "id,name,category,body,is_active,sort_order,updated_at,updated_by_hr_id";

function mapTemplate(row: Record<string, unknown>): WhatsAppTemplate {
  const body = String(row.body ?? "");
  return {
    body,
    category: textOrNull(row.category) ?? "",
    id: String(row.id),
    isActive: boolOrNull(row.is_active) ?? true,
    name: String(row.name ?? ""),
    sortOrder: numberOrNull(row.sort_order) ?? 0,
    updatedAt: textOrNull(row.updated_at),
    updatedByHrId: textOrNull(row.updated_by_hr_id),
    // Derived here, on every read, rather than stored alongside the body. A stored copy is a second
    // source of truth that drifts the moment a body is edited by anything but this app — including
    // a hand SQL fix — and the drift shows up as a send screen asking for a field the message no
    // longer has, or worse, not asking for one it does.
    variableKeys: extractVariableKeys(body),
  };
}

/**
 * Every template, active first, then by the owner's own order, then by name.
 *
 * `includeInactive` exists because the manager screen must show a switched-off template (that is how
 * it gets switched back on) while the send screen must never offer one.
 */
export async function listWhatsAppTemplates(options: { includeInactive?: boolean } = {}): Promise<WhatsAppTemplate[]> {
  const supabase = recruitmentDb();
  let query = supabase.from(TEMPLATES_TABLE).select(TEMPLATE_COLUMNS);
  if (!options.includeInactive) query = query.eq("is_active", true);

  const { data, error } = await query.order("sort_order", { ascending: true }).order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => mapTemplate(row as Record<string, unknown>));
}

export async function getWhatsAppTemplate(id: string): Promise<WhatsAppTemplate | null> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase.from(TEMPLATES_TABLE).select(TEMPLATE_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? mapTemplate(data as Record<string, unknown>) : null;
}

/** A partial edit. Only the keys present are written — see the PATCH route for why that matters. */
export type WhatsAppTemplatePatch = Partial<TemplateDraft>;

function assertValid(draft: Partial<TemplateDraft>): void {
  const problems = templateDraftViolations(draft);
  // Joined into one sentence rather than returned as a list: this throw becomes the API's error
  // message, and the route surfaces exactly one string to the screen.
  if (problems.length > 0) throw new Error(problems.join(" "));
}

export async function createWhatsAppTemplate(
  draft: TemplateDraft,
  actorHrId: string | null,
): Promise<WhatsAppTemplate> {
  assertValid(draft);
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from(TEMPLATES_TABLE)
    .insert({
      body: draft.body.trim(),
      category: draft.category.trim() || null,
      created_by_hr_id: actorHrId,
      is_active: draft.isActive,
      name: draft.name.trim(),
      sort_order: draft.sortOrder,
      updated_by_hr_id: actorHrId,
    })
    .select(TEMPLATE_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return mapTemplate(data as Record<string, unknown>);
}

/**
 * A partial update — only the fields present in `patch` are written.
 *
 * Validation runs against the MERGED row, not against the patch, because the rules are about the
 * template as a whole: a patch carrying only a body cannot be judged for a missing name, and judging
 * the patch alone would let an edit that empties the body through on the grounds that it said
 * nothing about the name.
 */
export async function updateWhatsAppTemplate(
  id: string,
  patch: Partial<TemplateDraft>,
  actorHrId: string | null,
): Promise<WhatsAppTemplate> {
  const existing = await getWhatsAppTemplate(id);
  if (!existing) throw new Error("That template was not found.");

  const merged: TemplateDraft = {
    body: patch.body ?? existing.body,
    category: patch.category ?? existing.category,
    isActive: patch.isActive ?? existing.isActive,
    name: patch.name ?? existing.name,
    sortOrder: patch.sortOrder ?? existing.sortOrder,
  };
  assertValid(merged);

  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from(TEMPLATES_TABLE)
    .update({
      body: merged.body.trim(),
      category: merged.category.trim() || null,
      is_active: merged.isActive,
      name: merged.name.trim(),
      sort_order: merged.sortOrder,
      updated_at: new Date().toISOString(),
      updated_by_hr_id: actorHrId,
    })
    .eq("id", id)
    .select(TEMPLATE_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return mapTemplate(data as Record<string, unknown>);
}

export async function deleteWhatsAppTemplate(id: string): Promise<void> {
  const supabase = recruitmentDb();
  const { error } = await supabase.from(TEMPLATES_TABLE).delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/**
 * Record that a message was PREPARED and opened in WhatsApp.
 *
 * NOT "sent", and the column is named `opened_by_hr_id` so no later reader can mistake it for
 * delivery. Phoenix hands the recruiter a filled-in WhatsApp window; whether they then press send is
 * outside anything this system can observe. Every screen that shows these rows must say "prepared".
 *
 * Best-effort by design: a failed log must never stop the message opening. The recruiter is looking
 * at a candidate waiting for an interview time, and losing that to an audit-table hiccup would be
 * the wrong trade — so the failure is logged for us and swallowed for them.
 */
export async function recordTemplateSend(input: {
  templateId: string | null;
  candidateId: string | null;
  toNumber: string;
  renderedBody: string;
  variableValues: Record<string, string>;
  openedByHrId: string | null;
}): Promise<void> {
  try {
    const supabase = recruitmentDb();
    const { error } = await supabase.from(SENDS_TABLE).insert({
      candidate_id: input.candidateId,
      opened_by_hr_id: input.openedByHrId,
      rendered_body: input.renderedBody,
      template_id: input.templateId,
      to_number: input.toNumber,
      variable_values: input.variableValues,
    });
    if (error) throw new Error(error.message);
  } catch (error) {
    logError("Failed to record a prepared WhatsApp message", {
      error,
      labels: { event: "whatsapp_template_send_log_failed" },
    });
  }
}

export type PreparedMessageRow = {
  id: string;
  templateName: string | null;
  toNumber: string;
  renderedBody: string;
  openedByHrId: string | null;
  createdAt: string;
};

/** The history strip on a candidate — what has already been prepared for this person, and when. */
export async function listCandidatePreparedMessages(candidateId: string): Promise<PreparedMessageRow[]> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from(SENDS_TABLE)
    .select("id,to_number,rendered_body,opened_by_hr_id,created_at,ats_whatsapp_message_templates(name)")
    .eq("candidate_id", candidateId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);

  return (data ?? []).map((raw) => {
    const row = raw as Record<string, unknown>;
    // The embedded parent arrives as an object from PostgREST, but a stale schema cache has been
    // seen to hand it back as a one-element array. Both are read rather than one being trusted.
    const embedded = row.ats_whatsapp_message_templates;
    const parent = Array.isArray(embedded) ? embedded[0] : embedded;
    return {
      createdAt: String(row.created_at ?? ""),
      id: String(row.id),
      openedByHrId: textOrNull(row.opened_by_hr_id),
      renderedBody: String(row.rendered_body ?? ""),
      templateName: parent ? textOrNull((parent as Record<string, unknown>).name) : null,
      toNumber: String(row.to_number ?? ""),
    };
  });
}
