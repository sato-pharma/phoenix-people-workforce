import { getSupabaseAdmin } from "@/lib/supabase/server";

// C1 — dedicated before/after history of Sales mapping-dictionary changes
// (source_of_sales_mapping_audit). Complements the generic admin writeAuditLog with a queryable,
// per-entity trail for review + reversal. Best-effort: a failed audit insert must NEVER break the
// mutation it records (and tolerates the table being absent pre-migration).

export type MappingAuditEntityType = "customer_map" | "product_alias" | "territory_alias" | "area_alias" | "region_alias";

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
