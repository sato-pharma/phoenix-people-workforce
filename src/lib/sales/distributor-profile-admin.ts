import { writeAuditLog } from "@/lib/admin/audit";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { writeMappingAudit } from "@/lib/sales/mapping-audit";
import { invalidateDistributorProfileCache, PROFILE_FIELDS, type ProfileFieldKey } from "@/lib/sales/normalizer/distributor-profile-store";
import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// Governed write path for the MONTHLY distributor-profile override (source_of_sales_distributor_profile).
// Service-role writes only (RLS bypassed by the admin client), so permission MUST be enforced upstream
// in the route. Validates BEFORE save, writes an audit trail, and invalidates the read cache.

const PROFILE_TABLE = "source_of_sales_distributor_profile";

export type DistributorProfileInput = {
  distributorCode: string;
  distributorName: string;
  valueSource: "recompute" | "sheet";
  regionOnly: boolean;
  fields: Record<ProfileFieldKey, string[]>;
};

function cleanCols(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((v) => String(v ?? "").trim()).filter(Boolean))];
}

// PURE validation (unit-tested): a saved profile must carry the minimum the engine needs to code rows —
// a product identifier, a quantity, and a location key; 'sheet' value source needs a value column.
export function validateDistributorProfileInput(input: DistributorProfileInput): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!normalizeCodeKey(input.distributorCode)) errors.push("Distributor code is required.");
  if (!String(input.distributorName ?? "").trim()) errors.push("Distributor name is required.");
  const has = (key: ProfileFieldKey) => cleanCols(input.fields?.[key]).length > 0;
  if (!has("productCodeColumns") && !has("productNameColumns")) errors.push("At least one Product Code or Product Name column is required.");
  if (!has("qtyColumns")) errors.push("At least one Quantity column is required.");
  if (!has("customerCodeColumns") && !has("areaIdColumns") && !has("brickIdColumns")) errors.push("A location column is required: Customer Code, Area ID, or Brick ID.");
  if (input.valueSource !== "recompute" && input.valueSource !== "sheet") errors.push("Value source must be 'recompute' or 'sheet'.");
  if (input.valueSource === "sheet" && !has("valueColumns")) errors.push("Value source 'sheet' requires at least one Value column.");
  return { ok: errors.length === 0, errors };
}

// Upsert (whole-profile override) for one distributor. Throws SalesWorkflowError(400) on invalid input.
export async function saveDistributorProfile(input: DistributorProfileInput, actor: string): Promise<{ distributorCode: string }> {
  const code = normalizeCodeKey(input.distributorCode);
  const check = validateDistributorProfileInput(input);
  if (!check.ok) throw new SalesWorkflowError("invalid_distributor_profile", check.errors.join(" "), 400);

  const row: Record<string, unknown> = {
    distributor_code: code,
    distributor_name: String(input.distributorName).trim(),
    value_source: input.valueSource,
    region_only: Boolean(input.regionOnly),
    active: true,
    updated_by: actor,
    updated_at: new Date().toISOString(),
  };
  for (const f of PROFILE_FIELDS) row[f.column] = cleanCols(input.fields?.[f.key]);

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from(PROFILE_TABLE).upsert(row, { onConflict: "distributor_code" });
  if (error) throw new SalesWorkflowError("distributor_profile_save_failed", `Could not save the profile: ${error.message}`, 500);

  await writeAuditLog({
    actorLoginId: actor,
    entityId: PROFILE_TABLE,
    entityType: "sales_import_batch",
    newValues: { distributor_code: code, distributor_name: row.distributor_name, value_source: input.valueSource, source: "distributor_profile_save" },
    summary: `Distributor profile saved — ${code} (${row.distributor_name}).`,
  });
  await writeMappingAudit({ entityType: "distributor_profile", distributorCode: code, entityKey: code, action: "edit", after: row, actor });
  invalidateDistributorProfileCache();
  return { distributorCode: code };
}

// Deactivate the override (revert this distributor to its built-in code profile).
export async function deactivateDistributorProfile(distributorCode: string, actor: string): Promise<{ distributorCode: string }> {
  const code = normalizeCodeKey(distributorCode);
  if (!code) throw new SalesWorkflowError("invalid_distributor_profile", "Distributor code is required.", 400);
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from(PROFILE_TABLE).update({ active: false, updated_by: actor, updated_at: new Date().toISOString() }).eq("distributor_code", code);
  if (error) throw new SalesWorkflowError("distributor_profile_save_failed", `Could not reset the profile: ${error.message}`, 500);
  await writeAuditLog({
    actorLoginId: actor,
    entityId: PROFILE_TABLE,
    entityType: "sales_import_batch",
    newValues: { distributor_code: code, source: "distributor_profile_reset" },
    summary: `Distributor profile reset to built-in — ${code}.`,
  });
  await writeMappingAudit({ entityType: "distributor_profile", distributorCode: code, entityKey: code, action: "delete", actor });
  invalidateDistributorProfileCache();
  return { distributorCode: code };
}
