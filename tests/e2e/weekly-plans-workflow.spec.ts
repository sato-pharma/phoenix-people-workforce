import { test, expect, type Page } from "@playwright/test";

/**
 * Full E2E workflow for the Weekly Plans module.
 *
 * Actors (real prod HR IDs, set via /api/dev-auth):
 *   A-8  Rasha Sabry            – Group Product Manager (the employee submitting)
 *   A-9  Hossam Mohamed Reda    – Marketing Manager     (A-8's direct manager)
 *   AA   Dr Anwar Gaweesh       – CEO                   (does the ceo_approve step)
 *   B-10 Omar Anwar Gawish      – Super Admin / HR      (acknowledges)
 *
 * Workflow:
 *   submit → manager_return (with comment) → resubmit → manager_approve
 *   → ceo_approve (→ final_approved) → hr_acknowledge (→ hr_acknowledged)
 *
 * Requirements:
 *   - NODE_ENV=development  (dev-auth is disabled in production)
 *   - Local dev server running on port 3000
 *
 * Run:
 *   npx playwright test tests/e2e/weekly-plans-workflow.spec.ts
 */

const BASE = "http://localhost:3000";

// Path-only constants for dev-auth `next` param (normalizeNextPath requires a leading "/")
const PORTAL_PLANS_PATH = "/employee-portals/plans";
const ADMIN_PLANS_PATH = "/admin/weekly-plans";

// Full URLs for page.goto() after auth is established
const PORTAL_PLANS = `${BASE}${PORTAL_PLANS_PATH}`;
const ADMIN_PLANS = `${BASE}${ADMIN_PLANS_PATH}`;

// Monday 7 July 2026 — well outside the current period so no period-lock conflict.
const ANCHOR_DATE = "2026-07-07";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Authenticate in the current page context by calling dev-auth. */
async function devAuth(
  page: Page,
  role: string,
  hrId: string,
  next: string,
) {
  const qs = new URLSearchParams({ hrId, next, role });
  await page.goto(`${BASE}/api/dev-auth?${qs.toString()}`, {
    waitUntil: "domcontentloaded",
  });
}

/**
 * POST JSON from inside the browser context so the Origin header is set
 * automatically (satisfies the same-origin CSRF guard).
 */
async function apiPost(
  page: Page,
  path: string,
  body: Record<string, unknown>,
): Promise<{ data: Record<string, unknown>; success: boolean; error?: string; message?: string }> {
  return page.evaluate(
    async ({ path, body }) => {
      const res = await fetch(path, {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      return res.json();
    },
    { body, path },
  );
}

/** PATCH JSON from inside the browser context. */
async function apiPatch(
  page: Page,
  path: string,
  body: Record<string, unknown>,
): Promise<{ data: Record<string, unknown>; success: boolean; error?: string; message?: string }> {
  return page.evaluate(
    async ({ path, body }) => {
      const res = await fetch(path, {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      return res.json();
    },
    { body, path },
  );
}

/** Check whether the dev-auth endpoint is reachable (returns 404 in prod). */
async function devAuthAvailable(page: Page) {
  const res = await page.request.get(
    `${BASE}/api/dev-auth?role=Super+Admin&hrId=B-10&next=/`,
  );
  // dev-auth redirects → 200 in dev; returns 404 JSON in prod
  return res.status() !== 404;
}

/** Offset a date string by N days. */
function addDays(anchorDate: string, n: number): string {
  const d = new Date(anchorDate);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Build a minimal 5-day plan.
 * Uses only Office/Meeting/Training — activity types that require no region
 * or rep selection (Field/Double Visit trigger region validation).
 */
function buildPlanItems(anchorDate: string) {
  return [
    { activityDate: anchorDate,               activityTitle: "Office",                   activityType: "Office",   sortOrder: 0 },
    { activityDate: addDays(anchorDate, 1),   activityTitle: "Internal meeting",          activityType: "Meeting",  sortOrder: 1 },
    { activityDate: addDays(anchorDate, 2),   activityTitle: "Office",                   activityType: "Office",   sortOrder: 2 },
    { activityDate: addDays(anchorDate, 3),   activityTitle: "Training session",          activityType: "Training", sortOrder: 3 },
    { activityDate: addDays(anchorDate, 4),   activityTitle: "Office",                   activityType: "Office",   sortOrder: 4 },
  ];
}

/** Revised items after manager feedback — more detailed titles, same safe types. */
function buildRevisedPlanItems(anchorDate: string) {
  return [
    { activityDate: anchorDate,               activityTitle: "Office – Q3 planning",                         activityType: "Office",   sortOrder: 0 },
    { activityDate: addDays(anchorDate, 1),   activityTitle: "Product line review meeting",                  activityType: "Meeting",  sortOrder: 1 },
    { activityDate: addDays(anchorDate, 2),   activityTitle: "Office – competitive analysis",                activityType: "Office",   sortOrder: 2 },
    { activityDate: addDays(anchorDate, 3),   activityTitle: "Training session – new product onboarding",   activityType: "Training", sortOrder: 3 },
    { activityDate: addDays(anchorDate, 4),   activityTitle: "Office – weekly wrap-up and reporting",        activityType: "Office",   sortOrder: 4 },
  ];
}

// ─── Workflow test ────────────────────────────────────────────────────────────

test.describe("Weekly Plans – full approval workflow", () => {
  test("submit → manager_return → resubmit → manager_approve → ceo_approve → hr_acknowledge", async ({
    page,
  }) => {
    // ── Guard: skip gracefully in production builds ──────────────────────────
    const available = await devAuthAvailable(page);
    if (!available) {
      test.skip(
        true,
        "/api/dev-auth not available — test requires NODE_ENV=development.",
      );
      return;
    }

    let planId = "";

    // ── Step 1: Employee (A-8) submits the weekly plan ───────────────────────
    await test.step("A-8 submits weekly plan for week of 7 Jul 2026", async () => {
      await devAuth(page, "Group Product Manager", "A-8", PORTAL_PLANS_PATH);
      await expect(page).toHaveURL(/employee-portals\/plans/, { timeout: 15_000 });

      const result = await apiPost(page, "/api/weekly-plans", {
        anchorDate: ANCHOR_DATE,
        items: buildPlanItems(ANCHOR_DATE),
        planKind: "weekly",
        submit: true,
      });

      expect(result.success, `Plan creation failed: ${JSON.stringify(result)}`).toBe(true);
      expect(result.data.status).toBe("submitted");

      planId = result.data.id as string;
      expect(planId, "Plan ID must be returned").toBeTruthy();

      // UI: navigate to the plan and verify submitted badge
      await page.goto(`${PORTAL_PLANS}?plan=${planId}`);
      await expect(page.getByText(/submitted/i).first()).toBeVisible({ timeout: 10_000 });
    });

    // ── Step 2: Manager (A-9) returns plan for edit ──────────────────────────
    await test.step("A-9 returns plan to employee with feedback comment", async () => {
      await devAuth(page, "Marketing Manager", "A-9", PORTAL_PLANS_PATH);
      await expect(page).toHaveURL(/employee-portals\/plans/, { timeout: 15_000 });

      const result = await apiPost(page, `/api/weekly-plans/${planId}/decision`, {
        action: "manager_return",
        comment: "Please provide more specific objectives for the field visits.",
      });

      expect(result.success, `manager_return failed: ${result.message ?? result.error}`).toBe(true);
      expect(result.data.status).toBe("manager_returned");

      // UI: manager sees the plan in returned state
      await page.goto(`${PORTAL_PLANS}?plan=${planId}`);
      await expect(page.getByText(/returned/i).first()).toBeVisible({ timeout: 10_000 });
    });

    // ── Step 3: Employee (A-8) addresses feedback and resubmits ─────────────
    await test.step("A-8 revises plan and resubmits", async () => {
      await devAuth(page, "Group Product Manager", "A-8", PORTAL_PLANS_PATH);
      await expect(page).toHaveURL(/employee-portals\/plans/, { timeout: 15_000 });

      const result = await apiPatch(page, `/api/weekly-plans/${planId}`, {
        items: buildRevisedPlanItems(ANCHOR_DATE),
        submit: true,
      });

      expect(result.success, `Resubmit failed: ${result.message ?? result.error}`).toBe(true);
      expect(result.data.status).toBe("submitted");

      // UI: employee sees submitted badge again
      await page.goto(`${PORTAL_PLANS}?plan=${planId}`);
      await expect(page.getByText(/submitted/i).first()).toBeVisible({ timeout: 10_000 });
    });

    // ── Step 4: Manager (A-9) approves the revised plan ─────────────────────
    await test.step("A-9 approves the resubmitted plan", async () => {
      await devAuth(page, "Marketing Manager", "A-9", PORTAL_PLANS_PATH);
      await expect(page).toHaveURL(/employee-portals\/plans/, { timeout: 15_000 });

      const result = await apiPost(page, `/api/weekly-plans/${planId}/decision`, {
        action: "manager_approve",
      });

      expect(result.success, `manager_approve failed: ${result.message ?? result.error}`).toBe(true);
      expect(result.data.status).toBe("manager_approved");

      // UI: manager sees the plan as manager-approved
      await page.goto(`${PORTAL_PLANS}?plan=${planId}`);
      await expect(page.getByText(/manager approved/i).first()).toBeVisible({ timeout: 10_000 });
    });

    // ── Step 5: CEO (AA) gives final approval ────────────────────────────────
    await test.step("CEO (AA) gives final approval — plan reaches final_approved", async () => {
      // CEO uses the admin surface
      await devAuth(page, "CEO", "AA", ADMIN_PLANS_PATH);
      await expect(page).toHaveURL(/admin\/weekly-plans/, { timeout: 15_000 });

      const result = await apiPost(page, `/api/weekly-plans/${planId}/decision`, {
        action: "ceo_approve",
      });

      expect(result.success, `ceo_approve failed: ${result.message ?? result.error}`).toBe(true);
      // ceo_approve transitions directly to final_approved (see EMPLOYEE_PLAN_TRANSITIONS)
      expect(result.data.status).toBe("final_approved");

      // UI: plan shows as final approved in the admin workspace
      await page.goto(`${ADMIN_PLANS}?plan=${planId}`);
      await expect(page.getByText(/final approved/i).first()).toBeVisible({ timeout: 10_000 });
    });

    // ── Step 6: HR (B-10) acknowledges ──────────────────────────────────────
    await test.step("HR (B-10) acknowledges the plan — workflow complete", async () => {
      await devAuth(page, "Super Admin", "B-10", ADMIN_PLANS_PATH);
      await expect(page).toHaveURL(/admin\/weekly-plans/, { timeout: 15_000 });

      const result = await apiPost(page, `/api/weekly-plans/${planId}/acknowledge`, {
        comment: "Plan reviewed and acknowledged by HR.",
      });

      expect(result.success, `hr_acknowledge failed: ${result.message ?? result.error}`).toBe(true);
      expect(result.data.status).toBe("hr_acknowledged");

      // UI: plan shows as HR acknowledged (terminal state)
      await page.goto(`${ADMIN_PLANS}?plan=${planId}`);
      await expect(page.getByText(/hr acknowledged/i).first()).toBeVisible({ timeout: 10_000 });
    });
  });
});
