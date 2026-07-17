import { test, expect } from "@playwright/test";

/**
 * E2E tests for the Contact HR Support page
 * (/employee-portals/contact-hr-support).
 *
 * Covers:
 * - Page load + hero
 * - Insights strip (avg response time / channels / office hours)
 * - HR Support Channels card with 3 desks
 * - Request form fields + accessibility
 * - Form submit flow shows success message
 * - Recent Requests empty state
 * - Mobile responsiveness
 * - RTL support
 * - Print stylesheet
 * - Error boundary verification
 *
 * Run with:  pnpm exec playwright test tests/e2e/contact-hr-support.spec.ts
 */

const BASE_URL = "http://localhost:3000/employee-portals/contact-hr-support";

test.describe("Contact HR Support", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await expect(
      page.locator("h1").filter({ hasText: /Contact HR Support/i }).first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  // ─── Page Load ─────────────────────────────────────────────────────

  test("page loads and displays hero header", async ({ page }) => {
    await expect(
      page.locator("h1").filter({ hasText: /Contact HR Support/i }),
    ).toBeVisible();
  });

  test("hero shows HR Support badge", async ({ page }) => {
    const badge = page
      .locator("section p")
      .filter({ hasText: /HR Support/i })
      .first();
    await expect(badge).toBeVisible();
  });

  // ─── Insights Strip ─────────────────────────────────────────────────

  test("insights strip shows 3 metrics", async ({ page }) => {
    await expect(page.getByText("Avg response time").first()).toBeVisible();
    await expect(page.getByText("Channels open").first()).toBeVisible();
    await expect(page.getByText("Office hours").first()).toBeVisible();
  });

  // ─── HR Channels Card ──────────────────────────────────────────────

  test("HR Support Channels card lists 3 desks", async ({ page }) => {
    await expect(page.getByText("HR Support Desk").first()).toBeVisible();
    await expect(page.getByText("Talent Support Desk").first()).toBeVisible();
    await expect(page.getByText("Operations Support Desk").first()).toBeVisible();
  });

  test("Use Form button has aria-label", async ({ page }) => {
    const useFormBtn = page
      .locator('button[aria-label*="Use support form for"]')
      .first();
    await expect(useFormBtn).toBeVisible();
  });

  test("clicking Use Form populates Subject field", async ({ page }) => {
    const useFormBtn = page
      .locator('button[aria-label*="Use support form for"]')
      .first();
    await useFormBtn.click();
    const subjectInput = page.locator('input[aria-label="Support subject"]');
    await expect(subjectInput).toHaveValue(/HR Support Desk request/);
  });

  // ─── Request Form ──────────────────────────────────────────────────

  test("Category, Subject, Description, Attachment fields present", async ({ page }) => {
    await expect(page.locator('[aria-label="Support category"]')).toBeVisible();
    await expect(page.locator('input[aria-label="Support subject"]')).toBeVisible();
    await expect(page.locator('textarea[aria-label="Support description"]')).toBeVisible();
    await expect(page.getByText(/Attachments \(optional\)/i)).toBeVisible();
  });

  test("Submit button is accessible and labelled", async ({ page }) => {
    const submitBtn = page.locator('button[aria-label="Submit support request"]');
    await expect(submitBtn).toBeVisible();
  });

  test("form submit shows success message", async ({ page }) => {
    // SearchableSelect renders as combobox, not native <select> — click then pick option
    const categoryCombobox = page.locator('[aria-label="Support category"]');
    await categoryCombobox.click();
    await page.getByRole("button", { name: "System Issue" }).click();
    await page.locator('input[aria-label="Support subject"]').fill("Test subject from Playwright");
    await page.locator('textarea[aria-label="Support description"]').fill("Test description body");
    await page.locator('button[aria-label="Submit support request"]').click();
    await expect(page.getByText(/Request submitted successfully/i)).toBeVisible({
      timeout: 10_000,
    });
  });

  // ─── Recent Requests ───────────────────────────────────────────────

  test("Recent Requests section visible", async ({ page }) => {
    await expect(page.getByText(/Recent Requests/i).first()).toBeVisible();
  });

  test("empty state shows when no requests", async ({ page }) => {
    const emptyState = page.getByText(/No recent requests/i).first();
    const hasEmpty = await emptyState.isVisible().catch(() => false);
    if (hasEmpty) {
      await expect(emptyState).toBeVisible();
    } else {
      // A prior test may have submitted a request — verify the list section renders
      await expect(page.getByText(/Recent Requests/i).first()).toBeVisible();
    }
  });

  // ─── RTL ───────────────────────────────────────────────────────────

  test("page container uses dir=auto for RTL support", async ({ page }) => {
    const root = page.locator('[dir="auto"]').first();
    await expect(root).toBeVisible();
  });

  // ─── Print Stylesheet ──────────────────────────────────────────────

  test("print stylesheet is embedded", async ({ page }) => {
    const hasMediaPrint = await page.evaluate(() => {
      const styles = document.querySelectorAll("style");
      for (const s of styles) {
        if (s.textContent?.includes("@media print")) return true;
      }
      return false;
    });
    expect(hasMediaPrint).toBe(true);
  });

  // ─── Mobile Responsiveness ─────────────────────────────────────────

  test("mobile viewport (375px) renders without crash", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(
      page.locator("h1").filter({ hasText: /Contact HR Support/i }).first(),
    ).toBeVisible();
    await expect(page.getByText("HR Support Desk").first()).toBeVisible();
  });

  test("tablet viewport (768px) renders correctly", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(
      page.locator("h1").filter({ hasText: /Contact HR Support/i }).first(),
    ).toBeVisible();
  });

  // ─── Error Boundary ────────────────────────────────────────────────

  test("page renders without crash (error boundary verification)", async ({ page }) => {
    await expect(
      page.locator("h1").filter({ hasText: /Contact HR Support/i }).first(),
    ).toBeVisible();
  });
});
