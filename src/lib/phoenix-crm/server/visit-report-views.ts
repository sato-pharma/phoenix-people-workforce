/**
 * Phoenix CRM — the Visit report's saved views: a reader's own named choices of fields, kept on the server
 * so they follow the reader to any device (owner, 2026-10-16: "make a save view for someone to save his fav
 * choices"; asked in chat, he chose "Only its owner" and "Fields only").
 *
 * 🔴 ONLY ITS OWNER. Every read, save and delete is keyed on the viewer's own canonical HR id and on whether
 * the login is a test persona — a test login carries the HR id of the real person it mirrors, so without
 * `is_test` the two would share one list. Nothing here takes an owner as an argument, so no reader, the
 * Super Admin included, can list or remove anybody else's view.
 *
 * 🔴 A VIEW HOLDS FIELD KEYS AND NOTHING ELSE, cleaned against the reader's sight on the way in AND on the way
 * out: a view saved before a field moved above a district manager's sight still never offers it to one.
 *
 * Gated exactly as the report is (`canReadVisitReport`), and refused with the same 404.
 */

import { notFoundError, validationError } from "@/lib/http/api-errors";
import { canReadVisitReport, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { visitReportTierOf } from "@/lib/phoenix-crm/server/visit-report";
import {
  VISIT_REPORT_SAVED_VIEWS_MAX,
  VISIT_REPORT_VIEW_NAME_MAX,
  cleanVisitReportViewName,
  resolveVisitReportSelection,
  type VisitReportReaderTier,
  type VisitReportSavedView,
} from "@/lib/phoenix-crm/visit-report-fields";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const TABLE = "phoenix_crm_visit_report_views";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ViewRow = { id: string; name: string; fields: string[] | null };

/** Whose views these are — the viewer, and only the viewer. A 404 for anybody the report itself refuses. */
function ownerOf(viewer: PhoenixCrmViewer): { ownerHrId: string; isTest: boolean } {
  if (!canReadVisitReport(viewer)) throw notFoundError("Not found.");
  return { isTest: viewer.isTestPersona === true, ownerHrId: viewer.hrId };
}

function shape(row: ViewRow, tier: VisitReportReaderTier): VisitReportSavedView {
  return {
    fields: resolveVisitReportSelection(row.fields ?? [], tier).map((field) => field.key),
    id: row.id,
    name: row.name,
  };
}

export async function listVisitReportViews(viewer: PhoenixCrmViewer): Promise<VisitReportSavedView[]> {
  const { isTest, ownerHrId } = ownerOf(viewer);
  const tier = visitReportTierOf(viewer);
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("id, name, fields")
    .eq("owner_hr_id", ownerHrId)
    .eq("is_test", isTest)
    .order("name", { ascending: true })
    .limit(VISIT_REPORT_SAVED_VIEWS_MAX);
  if (error) throw error;
  return ((data ?? []) as ViewRow[]).map((row) => shape(row, tier));
}

/**
 * Saves the ticked fields under a name. The same name again REPLACES that view, so "save" never makes a
 * near-duplicate; a new name past the cap is refused with a sentence, never by dropping an older view.
 */
export async function saveVisitReportView(viewer: PhoenixCrmViewer, input: { name: unknown; fields: unknown }): Promise<VisitReportSavedView> {
  const { isTest, ownerHrId } = ownerOf(viewer);
  const tier = visitReportTierOf(viewer);
  const name = cleanVisitReportViewName(input.name);
  if (!name) throw validationError(`Give the view a name of up to ${VISIT_REPORT_VIEW_NAME_MAX} characters.`);
  const fields = resolveVisitReportSelection(Array.isArray(input.fields) ? input.fields : [], tier).map((field) => field.key);
  if (fields.length === 0) throw validationError("Tick at least one field before saving a view.");

  const supabase = getSupabaseAdmin();
  const existing = await supabase.from(TABLE).select("name").eq("owner_hr_id", ownerHrId).eq("is_test", isTest);
  if (existing.error) throw existing.error;
  const names = ((existing.data ?? []) as Array<{ name: string }>).map((row) => row.name);
  if (!names.includes(name) && names.length >= VISIT_REPORT_SAVED_VIEWS_MAX) {
    throw validationError(`You can keep up to ${VISIT_REPORT_SAVED_VIEWS_MAX} saved views. Delete one first.`);
  }

  const { data, error } = await supabase
    .from(TABLE)
    .upsert(
      { fields, is_test: isTest, name, owner_hr_id: ownerHrId, updated_at: new Date().toISOString() },
      { onConflict: "owner_hr_id,is_test,name" },
    )
    .select("id, name, fields")
    .single();
  if (error) throw error;
  return shape(data as ViewRow, tier);
}

/** Deletes one of the viewer's own views; another person's id matches nothing and answers the same 404. */
export async function deleteVisitReportView(viewer: PhoenixCrmViewer, id: unknown): Promise<{ id: string; name: string }> {
  const { isTest, ownerHrId } = ownerOf(viewer);
  const clean = typeof id === "string" ? id.trim() : "";
  if (!UUID.test(clean)) throw validationError("Choose a saved view to delete.");
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .delete()
    .eq("id", clean)
    .eq("owner_hr_id", ownerHrId)
    .eq("is_test", isTest)
    .select("id, name");
  if (error) throw error;
  const deleted = ((data ?? []) as Array<{ id: string; name: string }>)[0];
  if (!deleted) throw notFoundError("That saved view is not there any more. Reload the page.");
  return deleted;
}
