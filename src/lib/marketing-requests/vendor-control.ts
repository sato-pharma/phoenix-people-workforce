import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { assertRealSessionForDecision } from "@/lib/auth/preview-session-guard";
import type { AccessContext } from "@/lib/auth/permissions";
import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Allow or hide a marketing vendor (owner, 2026-11-03).
 *
 * The pharmacy sync creates a vendor it has never seen as hidden, until he allows it. Allowing one shows
 * it in the Vendor picker, and the next nightly sync loads the codes the Sales map holds for it. Hiding
 * one takes it out of the picker and deletes nothing. A vendor with customers live on it cannot be hidden:
 * the marketing screens name a vendor from the shown ones only, so its links would read "Unknown distributor".
 *
 * A vendor merged into another can never be allowed: the Sales map still names it, so its codes would load
 * back under the old name and undo the merge. The database refuses it too.
 *
 * Super Admin only, on the page his alone (`assertMarketingAdminPageAccess({ systemAdministratorOnly })`).
 */

export type MarketingVendorControlRow = {
  active: boolean;
  codesLoaded: number;
  codesWaiting: number;
  customersLinked: number;
  id: number;
  mergedIntoName: string | null;
  name: string;
};

type DistributorRow = {
  active: boolean;
  display_name: string;
  id: number;
  merged_into_distributor_id: number | null;
};

type CountRow = {
  codes_loaded: number | string;
  codes_waiting: number | string;
  customers_linked: number | string;
  vendor_id: number | string;
};

const COLUMNS = "id, display_name, active, merged_into_distributor_id";

function assertVendorControlAccess(access: AccessContext): void {
  if (access.role !== "Super Admin") throw forbiddenError("Forbidden: allowing or hiding a vendor is Super Admin only.");
}

/** Pure: the rows the panel shows, shown vendors first, each group by name. */
export function buildVendorControlRows(distributors: readonly DistributorRow[], counts: readonly CountRow[]): MarketingVendorControlRow[] {
  const nameById = new Map(distributors.map((row) => [Number(row.id), row.display_name]));
  const countById = new Map(counts.map((row) => [Number(row.vendor_id), row]));
  return distributors
    .map((row) => {
      const count = countById.get(Number(row.id));
      return {
        active: row.active,
        codesLoaded: Number(count?.codes_loaded ?? 0),
        codesWaiting: Number(count?.codes_waiting ?? 0),
        customersLinked: Number(count?.customers_linked ?? 0),
        id: Number(row.id),
        mergedIntoName:
          row.merged_into_distributor_id === null ? null : nameById.get(Number(row.merged_into_distributor_id)) ?? "another vendor",
        name: row.display_name,
      };
    })
    .sort((left, right) => Number(right.active) - Number(left.active) || left.name.localeCompare(right.name));
}

/** A failed read throws, so the panel says it could not read and never shows a vendor with zero codes. */
export async function listMarketingVendors(access: AccessContext): Promise<MarketingVendorControlRow[]> {
  assertVendorControlAccess(access);
  const supabase = getSupabaseAdmin();
  const [distributors, counts] = await Promise.all([
    supabase.from("marketing_distributors").select(COLUMNS).order("display_name"),
    supabase.rpc("phx_marketing_vendor_code_counts"),
  ]);
  if (distributors.error) throw distributors.error;
  if (counts.error) throw counts.error;
  return buildVendorControlRows((distributors.data ?? []) as DistributorRow[], (counts.data ?? []) as CountRow[]);
}

export async function setMarketingVendorActive(
  access: AccessContext,
  input: { active: boolean; vendorId: number },
): Promise<MarketingVendorControlRow[]> {
  assertVendorControlAccess(access);
  assertRealSessionForDecision(access, "allow or hide a vendor");
  if (!Number.isInteger(input.vendorId) || input.vendorId <= 0) throw validationError("Name the vendor.");
  if (typeof input.active !== "boolean") throw validationError("Say whether the vendor is allowed or hidden.");

  const supabase = getSupabaseAdmin();
  const read = await supabase.from("marketing_distributors").select(COLUMNS).eq("id", input.vendorId).maybeSingle();
  if (read.error) throw read.error;
  const vendor = read.data as DistributorRow | null;
  if (!vendor) throw notFoundError("That vendor does not exist.");
  if (input.active && vendor.merged_into_distributor_id !== null) {
    throw conflictError(`${vendor.display_name} was merged into another vendor. Allowing it would load its codes back and undo the merge.`);
  }
  if (vendor.active === input.active) return listMarketingVendors(access);
  if (!input.active) {
    const counts = await supabase.rpc("phx_marketing_vendor_code_counts");
    if (counts.error) throw counts.error;
    const linked = Number(((counts.data ?? []) as CountRow[]).find((row) => Number(row.vendor_id) === input.vendorId)?.customers_linked ?? 0);
    if (linked > 0) {
      throw conflictError(`${linked} customer(s) are linked through ${vendor.display_name}. Hiding it would show them as "Unknown distributor", so it stays shown.`);
    }
  }

  const write = await supabase
    .from("marketing_distributors")
    .update({ active: input.active, updated_at: new Date().toISOString() })
    .eq("id", input.vendorId);
  if (write.error) throw write.error;

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityId: String(input.vendorId),
    entityType: "marketing_control",
    newValues: { active: input.active },
    oldValues: { active: vendor.active },
    summary: `Marketing vendor "${vendor.display_name}" was ${input.active ? "allowed" : "hidden"}.`,
  });
  return listMarketingVendors(access);
}
