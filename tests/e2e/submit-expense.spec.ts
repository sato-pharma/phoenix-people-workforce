import { test, expect } from "@playwright/test";

/**
 * E2E tests for the Submit Expense page (/employee-portals/submit-expense).
 *
 * Owner request 2026-10-22: the page is a step form like Report It and Log a visit in Phoenix CRM —
 * every step says what to do in it and what comes next — and Submit Expense and Expense Submissions
 * are ONE page: the form, then My claims under it.
 *
 * Covers:
 * - Page load + hero
 * - The step rail (Trip, Destination, Evidence, Amounts, Review & submit) and its instruction line
 * - The action bar under the thumb, and what it says when a step is incomplete
 * - A Meeting or Other expense drops the Destination step
 * - My claims on the same page
 * - Mobile responsiveness (375px, 768px, 1280px) with no horizontal scroll
 * - RTL support, print stylesheet
 *
 * Run with:  pnpm exec playwright test tests/e2e/submit-expense.spec.ts
 */

const BASE_URL = `${process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000"}/employee-portals/submit-expense`;

test.describe("Submit Expense", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await expect(
      page.locator("h1").filter({ hasText: /Submit Expense/i }).first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  // ─── Page Load ─────────────────────────────────────────────────────

  test("page loads and displays hero header", async ({ page }) => {
    await expect(
      page.locator("h1").filter({ hasText: /Submit Expense/i }),
    ).toBeVisible();
  });

  test("hero shows EXPENSES badge", async ({ page }) => {
    const badge = page
      .locator("section p")
      .filter({ hasText: /EXPENSES/ })
      .first();
    await expect(badge).toBeVisible();
  });

  // ─── The step form ─────────────────────────────────────────────────

  test("the step rail names every step of a trip", async ({ page }) => {
    const rail = page.locator('[aria-label="Form steps"]').first();
    await expect(rail).toBeVisible();
    for (const step of ["Trip", "Destination", "Evidence", "Amounts", "Review & submit"]) {
      await expect(rail.getByText(step, { exact: true }).first()).toBeVisible();
    }
  });

  test("the first step says what to do in it", async ({ page }) => {
    await expect(
      page.getByText("Choose the expense type, the dates you were away and how you travelled.").first(),
    ).toBeVisible();
  });

  test("the action bar is on screen with Next", async ({ page }) => {
    const bar = page.locator('[aria-label="Submit expense action bar"]').first();
    await expect(bar).toBeVisible();
    await expect(bar.getByRole("button", { name: /Next/ })).toBeVisible();
  });

  test("Next on an incomplete step says what is still needed", async ({ page }) => {
    const bar = page.locator('[aria-label="Submit expense action bar"]').first();
    await bar.getByRole("button", { name: /Next/ }).click();
    await expect(bar.getByText("Still needed")).toBeVisible();
    await expect(bar.getByText("Choose the From date.")).toBeVisible();
  });

  test("expense type options can be selected by direct click", async ({ page }) => {
    const expenseTypeGroup = page.getByRole("radiogroup", { name: /Expense type/i });
    await expect(expenseTypeGroup).toBeVisible();

    const meetingOption = expenseTypeGroup.getByRole("radio", { name: "Meeting" });
    await meetingOption.click();
    await expect(meetingOption).toHaveAttribute("aria-checked", "true");
  });

  test("a Meeting expense has no Destination step", async ({ page }) => {
    const expenseTypeGroup = page.getByRole("radiogroup", { name: /Expense type/i });
    await expenseTypeGroup.getByRole("radio", { name: "Meeting" }).click();
    const rail = page.locator('[aria-label="Form steps"]').first();
    await expect(rail.getByText("Destination", { exact: true })).toHaveCount(0);
    await expect(rail.getByText("Invoice", { exact: true }).first()).toBeVisible();
  });

  test("trip date inputs are rendered", async ({ page }) => {
    await expect(page.getByLabel("Trip start date")).toBeVisible();
    await expect(page.getByLabel("Trip end date")).toBeVisible();
  });

  // ─── My claims, on the same page ───────────────────────────────────

  test("My claims sits under the form", async ({ page }) => {
    const claims = page.locator('section[aria-label="My claims"]').first();
    await expect(claims).toBeAttached();
    await expect(claims.getByRole("heading", { name: "My claims" })).toBeVisible();
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

  for (const [width, height] of [
    [375, 812],
    [768, 1024],
    [1280, 800],
  ] as const) {
    test(`${width}px renders the form and the action bar with no horizontal scroll`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await expect(
        page.locator("h1").filter({ hasText: /Submit Expense/i }),
      ).toBeVisible();
      await expect(page.locator('[aria-label="Submit expense action bar"]').first()).toBeVisible();
      const overflow = await page.evaluate(() => {
        const main = document.querySelector("main") ?? document.body;
        return main.scrollWidth - main.clientWidth;
      });
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
});
