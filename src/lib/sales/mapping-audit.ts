import { getSupabaseAdmin } from "@/lib/supabase/server";

// C1 — dedicated before/after history of Sales mapping-dictionary changes
// (source_of_sales_mapping_audit). Complements the generic admin writeAuditLog with a queryable,
// per-entity trail for review + reversal. Best-effort: a failed audit insert must NEVER break the
// mutation it records (and tolerates the table being absent pre-migration).

export type MappingAuditEntityType = "customer_map" | "product_alias" | "territory_alias" | "area_alias" | "region_alias" | "distributor_profile" | "weekly_distributor_profile";

export type MappingAuditEntry = {
  entityType: MappingAuditEntityType;
  distributorCode?: string | null;
  entityKey: string;
  action: "add" | "edit" | "delete";
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  actor: string;
};

export async function writeMappingAudit(entry: MappingAuditEntry): Promise<void> {
  try {
    const supabase = getSupabaseAdmin();
    await supabase.from("source_of_sales_mapping_audit").insert({
      entity_type: entry.entityType,
      distributor_code: entry.distributorCode ?? null,
      entity_key: entry.entityKey,
      action: entry.action,
      before_json: entry.before ?? null,
      after_json: entry.after ?? null,
      actor: entry.actor,
    });
  } catch { /* audit is best-effort — never block the mutation */ }
}

export type MappingAuditRecord = {
  id: string;
  entityType: string;
  distributorCode: string | null;
  entityKey: string;
  action: string;
  actor: string;
  createdAt: string;
};

// Read the recent audit trail for the editors' history panel. Best-effort: returns [] if the table is
// absent (unapplied migration) or on any error, so the panel degrades to an empty state, never breaks.
export async function listMappingAuditEntries(filter: {
  entityType?: MappingAuditEntityType;
  distributorCode?: string | null;
  limit?: number;
}): Promise<MappingAuditRecord[]> {
  try {
    const supabase = getSupabaseAdmin();
    let query = supabase
      .from("source_of_sales_mapping_audit")
      .select("id, entity_type, distributor_code, entity_key, action, actor, created_at")
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(filter.limit ?? 50, 1), 200));
    if (filter.entityType) query = query.eq("entity_type", filter.entityType);
    if (filter.distributorCode) query = query.eq("distributor_code", filter.distributorCode);
    const { data, error } = await query;
    if (error || !data) return [];
    return data.map((row) => ({
      id: String(row.id),
      entityType: String(row.entity_type ?? ""),
      distributorCode: row.distributor_code ? String(row.distributor_code) : null,
      entityKey: String(row.entity_key ?? ""),
      action: String(row.action ?? ""),
      actor: String(row.actor ?? "system"),
      createdAt: String(row.created_at ?? ""),
    }));
  } catch {
    return [];
  }
}
