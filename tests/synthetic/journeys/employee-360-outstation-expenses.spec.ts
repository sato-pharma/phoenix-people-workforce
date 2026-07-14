import { test, expect } from "@playwright/test";

import { runJourney } from "../helpers/run-journey";

// Regression coverage for the 2026-07-13 payroll_expenses -> outstation_expenses
// rename (PR #1061): every one of these journeys hits a query that broke
// silently for a day because nothing in this suite touched Employee 360 or
// Outstation Expenses. Each check asserts on real page content, not just
// navigation/network status — the original bug rendered its error message
// inline in the page (server-caught, 200 status), so a status-code-only check
// would have missed it exactly like the incident did.

const SCHEMA_ERROR_TEXT = /could not find the table|schema cache|schema not ready/i;

test("Employee 360 directory loads", async ({ page }, testInfo) => {
  await runJourney(
    page,
    testInfo,
    { id: "employee-360-directory", name: "Employee 360 directory loads", route: "/employee-360", role: "Super Admin" },
    async (page) => {
      await expect(page.getByPlaceholder(/Search by name, HR ID, job title, line, area or manager/i)).toBeVisible();
      await expect(page.getByText(SCHEMA_ERROR_TEXT)).toHaveCount(0);
    },
  );
});

test("Employee 360 Medical Rep profile loads with expenses correctly hidden", async ({ page }, testInfo) => {
  await runJourney(
    page,
    testInfo,
    {
      id: "employee-360-medical-rep-profile",
      name: "Employee 360 Medical Rep profile loads with expenses correctly hidden",
      route: "/employee-360",
      role: "Super Admin",
    },
    async (page) => {
      await page.getByRole("button", { name: /Filters/i }).click();
      // The select's accessible name reflects its current value ("All job titles"),
      // not the micro-label span above it, so target it via the wrapping <label>'s
      // text instead of getByLabel (verified against the live DOM).
      await page.locator('label:has-text("Job title") select').selectOption("Medical Representative");

      const firstProfileLink = page.locator('a[href^="/employee-360/"]').first();
      await expect(firstProfileLink).toBeVisible();
      await Promise.all([page.waitForURL(/\/employee-360\/.+/), firstProfileLink.click()]);

      await expect(page.getByRole("heading", { level: 2, name: /Visits & Coverage/i })).toBeVisible();
      await expect(page.getByText(SCHEMA_ERROR_TEXT)).toHaveCount(0);
      // Business rule: Medical Reps never see the Expenses & Outstation section.
      await expect(page.getByRole("heading", { level: 2, name: /Expenses & Outstation/i })).toHaveCount(0);
    },
  );
});

test("Employee 360 manager profile shows expenses without a schema error", async ({ page }, testInfo) => {
  await runJourney(
    page,
    testInfo,
    {
      id: "employee-360-manager-profile",
      name: "Employee 360 manager profile shows expenses without a schema error",
      route: "/employee-360",
      role: "Super Admin",
    },
    async (page) => {
      await page.getByRole("button", { name: /Filters/i }).click();
      // District Sales Manager is in the traveling-manager allowlist (DM/RM/NSM/TM/PM/GPM) —
      // this is exactly the role whose profile crashed under the renamed table.
      await page.locator('label:has-text("Job title") select').selectOption("District Sales Manager");

      const firstProfileLink = page.locator('a[href^="/employee-360/"]').first();
      await expect(firstProfileLink).toBeVisible();
      await Promise.all([page.waitForURL(/\/employee-360\/.+/), firstProfileLink.click()]);

      await expect(page.getByRole("heading", { level: 2, name: /Visits & Coverage/i })).toBeVisible();
      await expect(page.getByText(SCHEMA_ERROR_TEXT)).toHaveCount(0);
      await expect(page.getByRole("heading", { level: 2, name: /Expenses & Outstation/i })).toBeVisible();
    },
  );
});

test("Outstation Expenses admin page loads real data", async ({ page }, testInfo) => {
  await runJourney(
    page,
    testInfo,
    {
      id: "outstation-expenses-admin",
      name: "Outstation Expenses admin page loads real data",
      route: "/admin/outstation/expenses",
      role: "Super Admin",
    },
    async (page) => {
      await expect(page.getByText(SCHEMA_ERROR_TEXT)).toHaveCount(0);

      // The expenses table is populated client-side from
      // /api/admin/outstation/expenses — assert the API itself succeeds and
      // returns real rows, which is the exact call that broke under the old
      // table name (Promise.all in getPhoenixAdminStats and the allSettled
      // pattern elsewhere can both mask a query failure from the DOM alone).
      const apiResult = await page.evaluate(async () => {
        const res = await fetch("/api/admin/outstation/expenses", { credentials: "include" });
        const body = await res.json().catch(() => null);
        return { status: res.status, ok: res.ok, hasExpenses: Array.isArray(body?.expenses), error: body?.error ?? null };
      });
      expect(apiResult.status).toBe(200);
      expect(apiResult.ok).toBe(true);
      expect(apiResult.hasExpenses).toBe(true);
      expect(apiResult.error).toBeNull();
    },
  );
});
