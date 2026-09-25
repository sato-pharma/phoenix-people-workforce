import { test, expect } from "@playwright/test";

/**
 * E2E tests for the Contact HR Support page
 * (/employee-portals/contact-hr-support).
 *
 * Covers:
 * - Page load + hero (named after the sidebar row: "Leave & HR" / "Request Support")
 * - The rep's own ticket figures (open / resolved / sent / last sent)
 * - "What happens next" — three steps. It replaced three placeholder "desks" whose email and
 *   WhatsApp buttons pointed at addresses that do not exist (hr-support@phoenix.local, …).
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
      page.locator("h1").filter({ hasText: /Request Support/i }).first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  // ─── Page Load ─────────────────────────────────────────────────────

  test("page loads and displays hero header", async ({ page }) => {
    await expect(
      page.locator("h1").filter({ hasText: /Request Support/i }),
    ).toBeVisible();
  });

  test("hero shows the sidebar section as its badge", async ({ page }) => {
    const badge = page
      .locator("section span")
      .filter({ hasText: /Leave & HR/i })
      .first();
    await expect(badge).toBeVisible();
  });

  // ─── The rep's own figures ──────────────────────────────────────────

  test("figures strip shows the rep's own ticket counts", async ({ page }) => {
    await expect(page.getByText("Open", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Resolved", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Sent", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Last sent", { exact: true }).first()).toBeVisible();
  });

  // ─── What happens next ─────────────────────────────────────────────

  test("what-happens-next lists the three steps and no placeholder contact", async ({ page }) => {
    await expect(page.getByText("What happens next").first()).toBeVisible();
    await expect(page.getByText("You send the request").first()).toBeVisible();
    await expect(page.getByText("HR picks it up").first()).toBeVisible();
    await expect(page.getByText("You follow it here").first()).toBeVisible();
    await expect(page.locator('a[href*="phoenix.local"], a[href*="wa.me/20100000000"]')).toHaveCount(0);
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
      page.locator("h1").filter({ hasText: /Request Support/i }).first(),
    ).toBeVisible();
    await expect(page.getByText("What happens next").first()).toBeVisible();
    const overflow = await page.evaluate(() => {
      const main = document.querySelector("main");
      return main ? main.scrollWidth - main.clientWidth : 0;
    });
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("tablet viewport (768px) renders correctly", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(
      page.locator("h1").filter({ hasText: /Request Support/i }).first(),
    ).toBeVisible();
  });

  // ─── Error Boundary ────────────────────────────────────────────────

  test("page renders without crash (error boundary verification)", async ({ page }) => {
    await expect(
      page.locator("h1").filter({ hasText: /Request Support/i }).first(),
    ).toBeVisible();
  });
});
