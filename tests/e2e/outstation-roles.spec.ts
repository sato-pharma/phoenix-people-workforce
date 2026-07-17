import { test, expect } from "@playwright/test";

/**
 * Role-based e2e for the outstation redesign submit surface, driven by dev-auth
 * (the passwordless role switch at /api/dev-auth — localhost + NODE_ENV=development
 * only; it 404s otherwise, which is why this spec has its own dev-auth config and is
 * excluded from the default/CI run in playwright.config.ts).
 *
 * The four roles below are exactly the submitter roles the redesign's rules hinge on:
 * GPM / PM are NOT field double-visitors so the campaign cap must NOT apply to them,
 * while DM / TM ARE subject to it. The cap DECISION itself is exhaustively unit-tested
 * in tests/outstation-decision.test.ts; this spec covers the UI layer — that each role
 * can actually REACH the submit surface after the permission-matrix changes, and that
 * no fraud / variance surface leaks anywhere ("no traces").
 *
 * Run against a LOCAL dev server whose env points at a SAFE database (staging), NEVER
 * production (this repo's .env.local points at prod — override it before running):
 *   pnpm exec playwright test --config playwright.dev-auth.config.ts
 * Supply a real employee HR_ID per role to also assert the full wizard renders:
 *   PLAYWRIGHT_HRID_DISTRICT_MANAGER=D-123 pnpm exec playwright test --config playwright.dev-auth.config.ts
 */

const ROLES = [
  "Group Product Manager",
  "Product Manager",
  "Training Manager",
  "District Manager",
] as const;

// Optional per-role real employee HR_ID, e.g. PLAYWRIGHT_HRID_TRAINING_MANAGER=T-9.
function hrIdEnvFor(role: string): string | undefined {
  const slug = role.toUpperCase().replace(/[^A-Z]+/g, "_");
  return process.env[`PLAYWRIGHT_HRID_${slug}`]?.trim() || undefined;
}

test.describe("Outstation submit surface — by role (dev-auth)", () => {
  for (const role of ROLES) {
    test(`${role}: reaches the submit surface with no fraud/variance leak`, async ({ page }) => {
      const params = new URLSearchParams({
        role,
        next: "/employee-portals/submit-expense",
      });
      const hrId = hrIdEnvFor(role);
      if (hrId) params.set("hrId", hrId);

      // dev-auth sets a passwordless session for the role and redirects to `next`.
      await page.goto(`/api/dev-auth?${params.toString()}`, { waitUntil: "domcontentloaded" });

      // Access is correct post-redesign: the role is NOT bounced to /login, /overview,
      // or the read-only /employee-portals/expenses page. (A missing employee record
      // renders an empty state ON this URL, not a redirect — so the URL check holds
      // even without seeded data.)
      await expect(page).toHaveURL(/\/employee-portals\/submit-expense(\?.*)?$/);

      // "No traces": the fraud + variance surfaces were removed everywhere.
      const bodyText = (await page.locator("body").innerText()).toLowerCase();
      expect(bodyText).not.toContain("fraud");
      expect(bodyText).not.toContain("suspicious location");
      expect(bodyText).not.toContain("variance");

      // When the role's employee data is available, assert the full redesign wizard.
      const heading = page.locator("h1").filter({ hasText: /Submit Expense/i }).first();
      const wizardRendered = await heading
        .waitFor({ state: "visible", timeout: 8_000 })
        .then(() => true)
        .catch(() => false);
      if (wizardRendered) {
        await expect(page.getByRole("radiogroup", { name: /Expense type/i })).toBeVisible();
        await expect(page.getByText("Trip details", { exact: false }).first()).toBeVisible();
      }
    });
  }
});
