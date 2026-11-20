/**
 * What the Super Admin decided on a direct order or a pharmacy stands (owner, 2026-11-20: "if I manual
 * validate this to the manager doing, he cannot override my decision. Direct orders, marketing requests").
 *
 * The refusal is the one Phoenix CRM already uses — a 403 reading "This is the system administrator's
 * decision. You have no right to override it." — and who counts as the Super Admin is read from the
 * database (`loadSuperAdminHrIds`), so a test login never locks anything and a failed read refuses
 * rather than letting the override through. Account: `docs/phoenix-crm-validation-feedback.md`,
 * "Nothing the Super Admin did is undone below him".
 */
import type { AccessContext } from "@/lib/auth/permissions";
import { assertSuperAdminDecisionStands } from "@/lib/phoenix-crm/server/super-admin-approval";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** The module's own test for the Super Admin, written inline across Direct Orders until now. */
export function isDirectOrderSuperAdmin(access: Pick<AccessContext, "role" | "scope">): boolean {
  return access.role === "Super Admin" || access.scope === "system";
}

/** Who approved each rung already approved on an order. */
export function approvedStepActors(
  steps: ReadonlyArray<{ status: string; decidedByHrId: string | null }>,
): Array<string | null> {
  return steps.filter((step) => step.status === "approved").map((step) => step.decidedByHrId);
}

/**
 * The Super Admin's rulings on one pharmacy: he confirmed it, he decided one of its claims either way
 * (approved, matched or rejected), or he ruled its orders stay held. Anybody else is refused before
 * the write that would contradict any of them; the Super Admin himself is never blocked.
 */
export async function assertPharmacyRulingStands(access: AccessContext, pharmacyId: string): Promise<void> {
  if (isDirectOrderSuperAdmin(access)) return;
  const supabase = getSupabaseAdmin();
  const [pharmacy, claims] = await Promise.all([
    supabase
      .from("direct_order_pharmacies")
      .select("verification_status, verified_by_hr_id, hold_release_ground, hold_release_decided_by_hr_id")
      .eq("id", pharmacyId)
      .maybeSingle(),
    supabase
      .from("direct_order_pharmacy_validations")
      .select("decided_by_hr_id")
      .eq("pharmacy_id", pharmacyId)
      .in("status", ["approved_new", "matched_existing", "rejected"]),
  ]);
  if (pharmacy.error) throw pharmacy.error;
  if (claims.error) throw claims.error;
  const row = (pharmacy.data ?? {}) as Record<string, unknown>;
  const actors: unknown[] = [];
  if (row.verification_status === "verified") actors.push(row.verified_by_hr_id);
  if (row.hold_release_ground === "kept_held") actors.push(row.hold_release_decided_by_hr_id);
  for (const claim of (claims.data ?? []) as Array<Record<string, unknown>>) actors.push(claim.decided_by_hr_id);
  await assertSuperAdminDecisionStands(false, actors);
}

/**
 * An order the Super Admin carried: he approved one of its rungs, or he released its pharmacy's held
 * orders into the chain. Cancelling it as a duplicate below him would undo that.
 */
export async function assertOrderCarriedBySuperAdminStands(
  access: AccessContext,
  input: { steps: ReadonlyArray<{ status: string; decidedByHrId: string | null }>; pharmacyId: string | null },
): Promise<void> {
  if (isDirectOrderSuperAdmin(access)) return;
  const actors: unknown[] = approvedStepActors(input.steps);
  if (input.pharmacyId) {
    const { data, error } = await getSupabaseAdmin()
      .from("direct_order_pharmacies")
      .select("hold_release_ground, hold_release_decided_by_hr_id")
      .eq("id", input.pharmacyId)
      .maybeSingle();
    if (error) throw error;
    const row = (data ?? {}) as Record<string, unknown>;
    if (row.hold_release_ground === "admin_released") actors.push(row.hold_release_decided_by_hr_id);
  }
  await assertSuperAdminDecisionStands(false, actors);
}
