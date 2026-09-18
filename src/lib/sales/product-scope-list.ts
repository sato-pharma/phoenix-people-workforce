import { updateUserScopeOverride, type UpdateUserScopeInput } from "@/lib/auth/scope-visibility";
import { canonicalHrIdForDisplay } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { replaceWeeklyProductScope } from "@/lib/sales/weekly/access";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// One product list per person, whichever screen saves it.
//
// A Product Manager's products were kept in two places that nothing kept in step:
//   • Scope & Visibility (`app_auth_users.product_scope_override`), read by Sales Analytics,
//     marketing requests and the monthly closing download;
//   • the Weekly Sales product-scope screen (`weekly_sales_product_scope`), read by Source of Sales,
//     the portal closing, Make It Happen and Weekly Sales.
// A list set on one screen reached none of the other's surfaces — on the audit's day one Product
// Manager's Source of Sales was empty while Scope & Visibility showed him two products (Source of
// Sales audit, finding portal-sos-dashboard.ts:401). The owner's ruling, 2026-09-18: "make both
// product-scope screens save the same list". Both routes save through here, and it writes both.
//
// "No list" is the one shape both stores can hold: a null override and no weekly rows. Scope &
// Visibility's screen sends null for an empty pick, and no login on production held an empty array
// when this shipped, so an empty weekly save clears the override to null.
//
// The two writes are not one transaction. When the second fails the first has landed, so the error
// says which screen saved and asks for the save again, which writes both.
// ─────────────────────────────────────────────────────────────────────────────

type SupabaseFrom = Pick<ReturnType<typeof getSupabaseAdmin>, "from">;

function normalizeCodes(codes: readonly string[] | null | undefined): string[] {
  return [...new Set((codes ?? []).map((code) => String(code ?? "").trim().toUpperCase()).filter(Boolean))];
}

/**
 * Scope & Visibility's Save: the login's lines, sales scope and products, then the same products as
 * the person's Weekly Sales list. A login with no HR_ID has no weekly list to keep in step.
 */
export async function saveScopeVisibilityForLogin(
  input: UpdateUserScopeInput,
  actorId: string | null,
  supabase: SupabaseFrom = getSupabaseAdmin(),
): Promise<void> {
  const login = await supabase.from("app_auth_users").select("hr_id").eq("login_id", input.loginId).maybeSingle();
  if (login.error) throw login.error;

  await updateUserScopeOverride(input, supabase);

  const hrId = (login.data as { hr_id?: string | null } | null)?.hr_id ?? null;
  if (!hrId) return;
  try {
    await replaceWeeklyProductScope(hrId, normalizeCodes(input.productCodes), actorId, supabase);
  } catch (error) {
    logError("Scope & Visibility saved a product list the Weekly Sales list did not take", {
      labels: { event: "product_scope_list_weekly_write_failed", loginId: input.loginId },
      error,
    });
    throw new Error("Saved on Scope & Visibility, but the Weekly Sales product list did not update. Save again.");
  }
}

/**
 * The Weekly Sales product-scope screen's Save: the person's weekly list, then the same list on
 * Scope & Visibility. A person with no login has no Scope & Visibility list, and nothing else changes.
 */
export async function saveWeeklyProductScopeForPerson(
  hrId: string,
  productCodes: readonly string[],
  actorId: string | null,
  supabase: SupabaseFrom = getSupabaseAdmin(),
): Promise<void> {
  const codes = normalizeCodes(productCodes);
  await replaceWeeklyProductScope(hrId, codes, actorId, supabase);

  const storedHrId = canonicalHrIdForDisplay(hrId);
  if (!storedHrId) return;
  const { error } = await supabase
    .from("app_auth_users")
    .update({ product_scope_override: codes.length > 0 ? codes : null })
    .eq("hr_id", storedHrId);
  if (error) {
    logError("The Weekly Sales product list saved but Scope & Visibility did not take it", {
      labels: { event: "product_scope_list_override_write_failed", hrId: storedHrId },
      error,
    });
    throw new SalesWorkflowError(
      "scope_visibility_not_updated",
      "Saved the Weekly Sales product list, but Scope & Visibility did not update. Save again.",
      500,
    );
  }
}
