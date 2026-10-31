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

// The section headings below are matched by NAME, never by level. The 2026-10-27 personnel-record
// layout (#6606) made the numbered chapters the <h2>s and moved every section title to <h3>; these
// journeys still asked for level 2, so both profile journeys failed every run from 2026-10-28 while
// the page was fine — and the "never shown to a Medical Rep" check below passed whatever the page
// showed, because no level-2 heading by that name could exist any more. No chapter title
// (Leadership, Results, Field work, Development, Cost) shares a section's name, so each name
// still matches one heading.

test("Employee 360 directory loads", async ({ page }, testInfo) => {
  await runJourney(
    page,
    testInfo,
    { id: "employee-360-directory", name: "Employee 360 directory loads", route: "/employee-360", role: "Super Admin" },
    async (page) => {
      // The placeholder is templated per tab — `Search ${meta.label.toLowerCase()} by name, …`
      // (employee-search-list.tsx:260) — so match only the stable tail. "job title" left the
      // placeholder when the Job title dropdown became role tabs; it is still free-text
      // searchable (the search haystack still includes jobTitle).
      await expect(page.getByPlaceholder(/by name, HR ID, line, area or manager/i)).toBeVisible();
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
      // The Job title filter dropdown no longer exists — FILTERS is now Line/Area/Manager only
      // (employee-search-list.tsx:49-52) and role selection moved to tabs. The chip text comes
      // from EMPLOYEE_360_ROLE_META[...].tab in src/lib/employee-360/roles.ts, NOT .label.
      await page.getByRole("button", { name: /Medical Reps/i }).click();

      const firstProfileLink = page.locator('a[href^="/employee-360/"]').first();
      await expect(firstProfileLink).toBeVisible();
      await Promise.all([page.waitForURL(/\/employee-360\/.+/), firstProfileLink.click()]);

      await expect(page.getByRole("heading", { name: /Visits & Coverage/i })).toBeVisible();
      await expect(page.getByText(SCHEMA_ERROR_TEXT)).toHaveCount(0);
      // Business rule: Medical Reps never see the Expenses & Outstation section — at ANY heading level.
      await expect(page.getByRole("heading", { name: /Expenses & Outstation/i })).toHaveCount(0);
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
      // District managers are in the traveling-manager allowlist (DM/RM/NSM/TM/PM/GPM) — exactly
      // the role whose profile crashed under the renamed table. Note the tab chip is abbreviated
      // to "District Mgrs" while the header label is "District Managers"; line 235 renders .tab.
      await page.getByRole("button", { name: /District Mgrs/i }).click();

      const firstProfileLink = page.locator('a[href^="/employee-360/"]').first();
      await expect(firstProfileLink).toBeVisible();
      await Promise.all([page.waitForURL(/\/employee-360\/.+/), firstProfileLink.click()]);

      // That section's heading is role-conditional — employee-360-view.tsx's `ownVisitsPart` renders
      // `isLeader ? "Own Field Presence" : "Visits & Coverage"`. A district manager is a leader,
      // so asserting the rep wording here could never pass. Same section, different label.
      await expect(page.getByRole("heading", { name: /Own Field Presence/i })).toBeVisible();
      await expect(page.getByText(SCHEMA_ERROR_TEXT)).toHaveCount(0);
      // Leaders only (DM/RM/NSM/PM/TM) — `expensesPart` in employee-360-view.tsx. This is the
      // assertion the whole journey exists for.
      await expect(page.getByRole("heading", { name: /Expenses & Outstation/i })).toBeVisible();
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
